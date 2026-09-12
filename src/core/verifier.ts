/**
 * src/core/verifier.ts — 辅助验收引擎（Generator-Verifier 双 Agent 架构）
 *
 * 设计目标：子 Agent 自报"已完成"不算完成，必须由**独立验收环节**用真实证据复核。
 * 验收维度（按任务类型自动选择，可叠加）：
 *   1. code     — 抽取回答中的 Python 代码，在隔离沙箱真实重跑，核对"宣称输出 vs 实际 stdout"
 *   2. artifact — 抽取回答中宣称产出的文件路径，核对是否真实落盘、非空、可读
 *   3. media    — 视频/音频取真实元信息 + 抽帧，检测静帧/黑帧冒充，OCR/ASR 与任务文案比对
 *   4. source   — 抽取引用链接，真实 HTTP 探测可达性，并回抓正文核对关键数字
 *   5. llm      — 换一个模型做交叉语义复核（严格 JSON 判定），避免"自说自话"
 *
 * 能力降级：任一依赖缺失（ffmpeg / tesseract / ASR / 视觉模型 / 网络）不阻断验收，
 * 但必须在裁决的 degraded 字段中如实声明，禁止把"没验"伪装成"验过了"。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT, runSandboxed, runLocal, runTool, type SandboxResult } from './sandbox.js';
import type { ModelPool } from './modelPool.js';

// ─────────────────────────── 类型定义 ───────────────────────────

export type VerifyMode = 'code' | 'artifact' | 'media' | 'source' | 'llm';

export interface VerifyIssue {
  level: 'block' | 'warn';
  code: string;
  detail: string;
}

export interface VerifyVerdict {
  /** 是否通过（无 block 级问题且语义复核未判负） */
  ok: boolean;
  /** 0-100 置信分 */
  score: number;
  /** 实际执行的验收维度 */
  modes: VerifyMode[];
  issues: VerifyIssue[];
  /** 正向证据（工具实测所得，可直接展示给用户） */
  evidence: string[];
  /** 能力缺失声明（哪些维度没验成、为什么） */
  degraded: string[];
  /** 给子 Agent 的返修指令（可直接注入下一轮） */
  retry_hint: string;
  duration_ms: number;
  summary: string;
}

export interface VerifyCapabilities {
  ffmpeg: string | null;
  ffprobe: string | null;
  tesseract: string | null;
  /** 是否有可用的 Python OCR 后端（rapidocr-onnxruntime，免系统依赖） */
  ocrPy: boolean;
  asr: { kind: 'whisper-cli' | 'faster-whisper' | 'none'; cmd: string | null };
  /** 是否有可用于语义复核的模型 Key */
  llm: boolean;
  network: boolean | null;
  notes: string[];
}

export type VerifyProgressFn = (evt: {
  type: 'verify';
  agent: string;
  stage: string;
  detail: string;
}) => void;

export interface VerifyOptions {
  agent: string;
  task: string;
  answer: string;
  pool?: ModelPool | null;
  onProgress?: VerifyProgressFn;
  /** 关闭 LLM 语义复核（默认开启，无 Key 时自动跳过） */
  llmReview?: boolean;
  /** 单次验收总超时（毫秒），默认 150s */
  timeoutMs?: number;
}

// ─────────────────────────── 基础工具 ───────────────────────────

interface ShResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** 安全执行外部命令：永不抛异常 */
function sh(cmd: string, args: string[], timeoutMs = 20000): Promise<ShResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        resolve({
          ok: !e,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
        });
      },
    );
  });
}

/** 全局 fetch 的安全取用（不依赖 DOM/undici 类型声明） */
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: string },
) => Promise<{ ok: boolean; status: number; url: string; headers: { get(k: string): string | null }; text(): Promise<string> }>;

function httpFetch(): FetchLike | null {
  const f = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  return typeof f === 'function' ? f : null;
}

function md5(buf: Buffer | string): string {
  return createHash('md5').update(buf).digest('hex');
}

function sha(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
}

/** 内存临时目录（验收中间产物，任务结束即清） */
function mkTempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `xsverify_${tag}_`));
  return dir;
}

function rmTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─────────────────────────── 能力探测 ───────────────────────────

const FFMPEG_CANDIDATES = () => [
  'ffmpeg',
  path.join(PROJECT_ROOT, 'bin', 'ffmpeg'),
  path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
];
const TESSERACT_CANDIDATES = () => [
  'tesseract',
  path.join(PROJECT_ROOT, 'bin', 'tesseract'),
  path.join(os.homedir(), '.local', 'bin', 'tesseract'),
  '/usr/bin/tesseract',
  '/usr/local/bin/tesseract',
];

async function probeBinary(candidates: string[], args: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    const r = await sh(c, args, 8000);
    if (r.ok) return c;
  }
  return null;
}

let _caps: VerifyCapabilities | null = null;

let _ocrPyCache: boolean | null = null;

/** 探测 Python OCR 后端（rapidocr-onnxruntime）：不依赖系统 tesseract，wheels 自带中文模型 */
async function probePythonOcr(): Promise<boolean> {
  if (_ocrPyCache !== null) return _ocrPyCache;
  const r = await sh('python3', ['-c', 'from rapidocr_onnxruntime import RapidOCR; print("ok")'], 90000);
  _ocrPyCache = r.ok && r.stdout.includes('ok');
  return _ocrPyCache;
}

/** 探测验收依赖能力（带缓存） */
export async function detectCapabilities(force = false, pool?: ModelPool | null): Promise<VerifyCapabilities> {
  if (_caps && !force && !pool) return _caps;

  const notes: string[] = [];
  const ffmpeg = await probeBinary(FFMPEG_CANDIDATES(), ['-version']);
  const ffprobe = ffmpeg ? await probeBinary([ffmpeg.replace(/ffmpeg$/, 'ffprobe'), 'ffprobe'], ['-version']) : null;
  if (!ffmpeg) notes.push('ffmpeg 缺失：视频抽帧/静帧检测/音频转写全部无法执行，媒体验收降级');

  const tesseract = await probeBinary(TESSERACT_CANDIDATES(), ['--version']);
  const ocrPy = tesseract ? false : await probePythonOcr();
  if (!tesseract && !ocrPy) notes.push('OCR 后端（tesseract/rapidocr）均缺失：画面文字不可识别，画面-文案比对无法执行');
  else if (!tesseract) notes.push('tesseract 缺失，已回退 Python rapidocr 做画面 OCR');

  let asr: VerifyCapabilities['asr'] = { kind: 'none', cmd: null };
  const whisperCli = await probeBinary(['whisper', path.join(os.homedir(), '.local', 'bin', 'whisper')], ['--help']);
  if (whisperCli) {
    asr = { kind: 'whisper-cli', cmd: whisperCli };
  } else {
    const py = await sh('python3', ['-c', 'import faster_whisper; print("ok")'], 15000);
    if (py.ok && py.stdout.includes('ok')) asr = { kind: 'faster-whisper', cmd: 'python3' };
  }
  if (asr.kind === 'none') notes.push('ASR 缺失：音频语音内容无法转写，仅做画面侧比对');

  const hasKey = Boolean(pool && (pool.apiKey || [...pool.allModels.keys()].some((k) => pool.modelHasKey(k))));
  if (!hasKey) notes.push('无可用模型 Key：跳过跨模型语义复核（llm 维度）');

  const net = await probeNetwork();

  _caps = { ffmpeg, ffprobe, tesseract, ocrPy, asr, llm: hasKey, network: net, notes };
  return _caps;
}

export function resetCapabilities(): void {
  _caps = null;
  _ocrPyCache = null;
}

let _netCache: boolean | null = null;
async function probeNetwork(): Promise<boolean | null> {
  if (_netCache !== null) return _netCache;
  const f = httpFetch();
  if (!f) {
    _netCache = null;
    return null;
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await f('https://www.bing.com/', { method: 'HEAD', signal: ctl.signal });
    clearTimeout(t);
    _netCache = r.status < 500;
  } catch {
    _netCache = false;
  }
  return _netCache;
}

// ─────────────────────────── 回答内容抽取 ───────────────────────────

export interface CodeBlock {
  lang: string;
  code: string;
}

/** 抽取回答中的代码块（仅取可执行的 Python） */
export function extractCodeBlocks(answer: string, agent = ''): CodeBlock[] {
  const out: CodeBlock[] = [];
  const re = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const lang = (m[1] || '').toLowerCase();
    const code = m[2];
    if (!code.trim()) continue;
    if (['python', 'py', 'python3'].includes(lang)) out.push({ lang: lang || 'python', code });
    else if (!lang && agent === '代码Agent') out.push({ lang: 'python', code });
  }
  return out;
}

const MEDIA_EXT = new Set([
  'mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'm4v', 'ts', 'gif',
  'mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'opus',
]);
const FILE_EXT = new Set([
  ...MEDIA_EXT,
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'svg',
  'md', 'txt', 'json', 'csv', 'xlsx', 'docx', 'pdf', 'pptx', 'html', 'zip', 'tar', 'gz', 'py', 'ts', 'js',
]);

const CLAIM_KEYWORDS = ['输出', '保存', '已生成', '生成', '写入', '导出', '路径', '产物', '落盘', '文件'];

export interface PathClaim {
  raw: string;
  resolved: string;
  isMedia: boolean;
  claimed: boolean;
  exists: boolean;
  size: number;
  reason: string;
}

/** 解析回答中提到的文件路径（区分"宣称产物"与"顺带提及"） */
export function extractPathClaims(answer: string): PathClaim[] {
  const found = new Map<string, PathClaim>();

  const consider = (raw: string, sentence: string) => {
    if (!raw) return;
    const cleaned = raw.replace(/[),.;:、。，）】\]]+$/, '');
    if (!cleaned || cleaned.length > 300) return;
    const ext = path.extname(cleaned).replace('.', '').toLowerCase();
    if (!ext || !FILE_EXT.has(ext)) return;
    if (found.has(cleaned)) return;

    const resolved = path.isAbsolute(cleaned) ? cleaned : path.resolve(PROJECT_ROOT, 'output', cleaned);
    const exists = fs.existsSync(resolved);
    let size = 0;
    try {
      if (exists) size = fs.statSync(resolved).size;
    } catch {
      /* ignore */
    }
    const claimed = CLAIM_KEYWORDS.some((k) => sentence.includes(k));
    found.set(cleaned, {
      raw: cleaned,
      resolved,
      isMedia: MEDIA_EXT.has(ext),
      claimed,
      exists,
      size,
      reason: claimed ? '宣称产出' : '文中提及',
    });
  };

  const lines = answer.split(/\r?\n/);
  const absRe = /(?:^|[\s（(【\["'`：:=])((?:\/[\w.@+\-]+){2,}\.[A-Za-z0-9]{1,6})/g;
  const relRe = /(?:^|[\s（(【\["'`：:=])([\w.@+\-]{1,80}\.[A-Za-z0-9]{1,6})/g;

  for (const line of lines) {
    let m: RegExpExecArray | null;
    absRe.lastIndex = 0;
    while ((m = absRe.exec(line)) !== null) consider(m[1], line);
    relRe.lastIndex = 0;
    while ((m = relRe.exec(line)) !== null) consider(m[1], line);
  }
  return [...found.values()];
}

/** 抽取"宣称输出"行（用于与真实 stdout 对照） */
export function extractOutputClaims(answer: string): string[] {
  const claims: string[] = [];
  const patterns = [
    /(?:输出|预期输出|运行结果|结果为|执行结果|output)\s*[:：]\s*(.+)/gi,
    /#\s*(?:输出|预期输出)\s*[:：]\s*(.+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(answer)) !== null) {
      const v = m[1].trim().replace(/^[`"']|[`"']$/g, '').trim();
      if (v && v !== '...' && v.length <= 200) claims.push(v);
    }
  }
  return [...new Set(claims)];
}

/** 抽取引用链接 */
export function extractUrls(answer: string): string[] {
  const re = /https?:\/\/[^\s<>"'`）)\]】。，,;；]+/g;
  const raw = answer.match(re) ?? [];
  const cleaned = raw.map((u) => u.replace(/[.,;:、。，）)\]】]+$/, ''));
  return [...new Set(cleaned)].slice(0, 8);
}

/** 抽取任务中的"期望文案"（引号片段 / 文案类指令） */
export function extractExpectedCopy(task: string): string[] {
  const out: string[] = [];
  const quoted = task.match(/[「『"“']([^」』"”']{2,60})[」』"”']/g) ?? [];
  for (const q of quoted) out.push(q.replace(/^[「『"“']|[」』"”']$/g, '').trim());
  const re = /(?:文案|字幕|标题|口播|台词|内容)\s*(?:是|为|：|:)\s*([^\n。；;]{2,80})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) out.push(m[1].trim());
  return [...new Set(out.filter(Boolean))];
}

/** 字符二元组 Jaccard 相似度（0-1），用于文案一致性粗判 */
export function bigramSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '').toLowerCase();
  const A = norm(a);
  const B = norm(b);
  if (!A || !B) return 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (set.size === 0) set.add(s);
    return set;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

// ─────────────────────────── 各维度检查器 ───────────────────────────

interface CheckCtx {
  agent: string;
  task: string;
  answer: string;
  caps: VerifyCapabilities;
  pool: ModelPool | null;
  emit: (stage: string, detail: string) => void;
}

interface CheckOutcome {
  mode: VerifyMode;
  evidence: string[];
  issues: VerifyIssue[];
  degraded: string[];
  applicable: boolean;
}

const STUB_RE = /\b(TODO|FIXME|NotImplementedError|not\s+implemented)\b/i;
const TRACEBACK_RE = /Traceback \(most recent call last\)|^\s*\w*Error:/m;

/** ① 代码真实性：沙箱重跑 + 宣称输出核对 */
async function checkCode(ctx: CheckCtx): Promise<CheckOutcome> {
  const out: CheckOutcome = { mode: 'code', evidence: [], issues: [], degraded: [], applicable: false };
  const blocks = extractCodeBlocks(ctx.answer, ctx.agent);
  if (blocks.length === 0) return out;
  out.applicable = true;

  const claims = extractOutputClaims(ctx.answer);
  const picks = blocks.slice(0, 2);

  for (let i = 0; i < picks.length; i++) {
    const code = picks[i].code;
    const label = `代码块#${i + 1}（${code.split(/\r?\n/).length} 行）`;

    if (STUB_RE.test(code)) {
      out.issues.push({ level: 'block', code: 'CODE_STUB', detail: `${label} 含 TODO/未实现占位，不是可交付代码` });
    }

    ctx.emit('code', `沙箱重跑 ${label}`);
    let res: SandboxResult;
    let mode = 'sandbox';
    try {
      res = await runSandboxed(code, 20, false);
    } catch (e) {
      res = { stdout: '', stderr: (e as Error).message, exit_code: -1, timed_out: false, error: 'spawn' };
    }

    // 沙箱环境缺依赖 ≠ 代码错：降级到本地环境复跑以区分
    const sandboxEnvLimitation = /ModuleNotFoundError|No module named|虚拟环境不存在/.test(res.stderr + (res.error ?? ''));
    if (sandboxEnvLimitation) {
      ctx.emit('code', `${label} 沙箱缺依赖，降级本地复跑`);
      out.degraded.push(`${label} 沙箱缺依赖，已降级到本地环境复跑（隔离性下降）`);
      const local = await runLocal(code, 30);
      if (local.exit_code === 0) {
        res = local;
        mode = 'local';
      }
    }

    const stdout = res.stdout.trim();
    const stderr = res.stderr.trim();

    if (res.timed_out) {
      out.issues.push({ level: 'block', code: 'CODE_TIMEOUT', detail: `${label} 执行超时（>20s），不具备可交付性` });
    } else if (res.exit_code !== 0) {
      out.issues.push({
        level: 'block',
        code: 'CODE_RUN_FAIL',
        detail: `${label} 真实执行失败 exit=${res.exit_code}：${truncate(stderr || res.error || '无 stderr', 300)}`,
      });
    } else {
      out.evidence.push(`${label} 真实执行通过（${mode}，exit=0）${stdout ? `，stdout: ${truncate(stdout.replace(/\n/g, ' ⏎ '), 200)}` : '，无输出'}`);
    }
    if (res.exit_code === 0 && TRACEBACK_RE.test(stderr)) {
      out.issues.push({ level: 'warn', code: 'CODE_STDERR_TRACEBACK', detail: `${label} 退出码为 0 但 stderr 含异常栈` });
    }

    // 宣称输出 vs 实际 stdout
    if (claims.length && res.exit_code === 0) {
      const hay = stdout + '\n' + stderr;
      for (const c of claims) {
        if (!hay.includes(c)) {
          out.issues.push({
            level: 'block',
            code: 'CODE_CLAIM_MISMATCH',
            detail: `宣称「输出：${truncate(c, 60)}」但真实 stdout 中不存在该内容（疑似编造运行结果）`,
          });
        } else {
          out.evidence.push(`宣称输出「${truncate(c, 40)}」在真实 stdout 中命中`);
        }
      }
    }
  }

  // 只是"贴代码"却没跑：若回答宣称已运行但无任何执行痕迹 → 提醒
  if (!/\bexit_code\b|\[stdout\]|沙箱执行|venv 执行|本地执行/.test(ctx.answer) && claims.length) {
    out.issues.push({ level: 'warn', code: 'CODE_NO_EXEC_TRACE', detail: '回答声称有运行结果，但正文无执行痕迹' });
  }
  return out;
}

/** ② 产物真实性：宣称文件是否真实落盘 */
async function checkArtifacts(ctx: CheckCtx): Promise<CheckOutcome> {
  const out: CheckOutcome = { mode: 'artifact', evidence: [], issues: [], degraded: [], applicable: false };
  const claims = extractPathClaims(ctx.answer);
  if (claims.length === 0) return out;
  out.applicable = true;

  for (const c of claims) {
    if (!c.exists) {
      if (c.claimed) {
        out.issues.push({ level: 'block', code: 'ARTIFACT_MISSING', detail: `宣称产出但磁盘不存在：${c.raw}` });
      } else {
        out.issues.push({ level: 'warn', code: 'ARTIFACT_ABSENT', detail: `文中提及的文件不存在：${c.raw}` });
      }
      continue;
    }
    if (c.size === 0) {
      out.issues.push({ level: 'block', code: 'ARTIFACT_EMPTY', detail: `产物为空文件（0 字节）：${c.raw}` });
      continue;
    }
    out.evidence.push(`产物落盘校验通过：${c.raw}（${c.size} 字节，${c.reason}）`);
  }
  return out;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
}
interface ProbeJson {
  format?: { duration?: string; size?: string; format_name?: string; bit_rate?: string };
  streams?: ProbeStream[];
}

/** ③ 媒体真实性：元信息 + 抽帧静态检测 + OCR/ASR 文案比对 */
async function checkMedia(ctx: CheckCtx): Promise<CheckOutcome> {
  const out: CheckOutcome = { mode: 'media', evidence: [], issues: [], degraded: [], applicable: false };
  const media = extractPathClaims(ctx.answer).filter((c) => c.isMedia && c.exists && c.size > 0);
  if (media.length === 0) return out;
  out.applicable = true;

  const expectedCopy = extractExpectedCopy(ctx.task);
  const caps = ctx.caps;

  if (!caps.ffprobe) {
    out.degraded.push('ffprobe 缺失：媒体只做了文件存在性/大小校验，未做时长与抽帧核验');
    for (const m of media) out.evidence.push(`媒体文件存在：${m.raw}（${m.size} 字节，未做深度核验）`);
    if (expectedCopy.length) {
      out.issues.push({
        level: 'block',
        code: 'MEDIA_COPY_UNVERIFIED',
        detail: `任务明确要求文案（${truncate(expectedCopy.join(' '), 60)}），但 ffmpeg/ffprobe 缺失，画面文字与语音均无法核验 → 不予放行，须在具备 ffmpeg 的环境复验`,
      });
    }
    return out;
  }

  const tmp = mkTempDir('av');
  try {
    for (const m of media.slice(0, 2)) {
      const probe = await sh(caps.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', m.resolved], 30000);
      if (!probe.ok) {
        out.issues.push({ level: 'block', code: 'MEDIA_UNREADABLE', detail: `ffprobe 无法解析：${m.raw}（${truncate(probe.stderr, 200)}）` });
        continue;
      }
      let info: ProbeJson;
      try {
        info = JSON.parse(probe.stdout) as ProbeJson;
      } catch {
        out.issues.push({ level: 'block', code: 'MEDIA_UNREADABLE', detail: `ffprobe 输出解析失败：${m.raw}` });
        continue;
      }
      const duration = Number(info.format?.duration ?? 0);
      const vstream = (info.streams ?? []).find((s) => s.codec_type === 'video');
      const astream = (info.streams ?? []).find((s) => s.codec_type === 'audio');
      const isVideo = m.raw.toLowerCase().match(/\.(mp4|mov|mkv|avi|webm|flv|m4v|ts)$/) !== null;

      out.evidence.push(
        `媒体实测：${m.raw} 时长 ${duration.toFixed(2)}s` +
          (vstream ? `，视频 ${vstream.codec_name ?? '?'} ${vstream.width ?? '?'}x${vstream.height ?? '?'} @${vstream.avg_frame_rate ?? '?'}` : '') +
          (astream ? `，音频 ${astream.codec_name ?? '?'}/${astream.sample_rate ?? '?'}Hz` : '，无音轨'),
      );

      if (duration <= 0) out.issues.push({ level: 'block', code: 'MEDIA_ZERO_DURATION', detail: `${m.raw} 时长为 0，不是有效媒体` });
      if (isVideo && !vstream) out.issues.push({ level: 'block', code: 'MEDIA_NO_VIDEO_STREAM', detail: `${m.raw} 声称是视频但无视频流` });

      if (!isVideo || !vstream || duration <= 0) continue;

      // ── 抽帧：静帧/黑帧检测 ──
      const frameCount = 6;
      const frames: string[] = [];
      for (let i = 0; i < frameCount; i++) {
        const t = (duration * (i + 0.5)) / frameCount;
        const fp = path.join(tmp, `${sha(m.raw)}_${i}.png`);
        const r = await sh(caps.ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', m.resolved, '-frames:v', '1', fp], 30000);
        if (r.ok && fs.existsSync(fp) && fs.statSync(fp).size > 0) frames.push(fp);
      }
      if (frames.length < 2) {
        out.degraded.push(`${m.raw} 抽帧失败（${frames.length}/${frameCount}），静帧检测未执行`);
      } else {
        const hashes = frames.map((f) => md5(fs.readFileSync(f)));
        const uniq = new Set(hashes).size;
        if (uniq === 1) {
          out.issues.push({ level: 'block', code: 'MEDIA_STATIC_FRAMES', detail: `${m.raw} ${frames.length} 帧抽样完全一致 → 静帧/单图冒充视频` });
        } else {
          out.evidence.push(`抽帧 ${frames.length} 帧，画面差异帧数 ${uniq}/${frames.length}（非静帧）`);
        }
        // 亮度/黑帧分析（PIL+numpy）
        const analysis = await analyzeFrames(frames);
        if (analysis) {
          const dark = analysis.frames.filter((f) => f.mean < 12).length;
          if (dark >= Math.ceil(frames.length * 0.8)) {
            out.issues.push({ level: 'block', code: 'MEDIA_BLACK_FRAMES', detail: `${m.raw} ${dark}/${frames.length} 帧接近全黑，视频内容无效` });
          }
          if (analysis.diffs.length && Math.max(...analysis.diffs) < 1.0 && uniq > 1) {
            out.issues.push({ level: 'warn', code: 'MEDIA_NEAR_STATIC', detail: `${m.raw} 相邻帧平均差异 <1.0，画面几乎无变化` });
          }
          out.evidence.push(`帧亮度均值 ${analysis.frames.map((f) => f.mean.toFixed(0)).join('/')}`);
        }
      }

      // ── 文案一致性：OCR（画面文字） ──
      if (expectedCopy.length) {
        const copy = expectedCopy.join(' ');
        const ocrBackend = caps.tesseract ? 'tesseract' : caps.ocrPy ? 'rapidocr' : null;
        const hasOcrPath = Boolean(ocrBackend) && frames.length > 0;
        const hasVoicePath = Boolean(astream && caps.asr.kind !== 'none' && caps.ffmpeg);
        if (hasOcrPath) {
          const ocrTexts = await ocrFrames(frames.slice(0, 4), caps);
          const ocrAll = ocrTexts.join('\n').trim();
          if (ocrAll) {
            const sim = bigramSimilarity(ocrAll, copy);
            out.evidence.push(`画面 OCR（${ocrBackend}）命中率 ${(sim * 100).toFixed(1)}%（期望文案：${truncate(copy, 60)}）`);
            if (sim < 0.15) {
              out.issues.push({
                level: 'block',
                code: 'MEDIA_COPY_MISMATCH',
                detail: `画面文字与任务文案严重不符（相似度 ${(sim * 100).toFixed(1)}%）：OCR=${truncate(ocrAll.replace(/\s+/g, ' '), 120)}`,
              });
            } else if (sim < 0.35) {
              out.issues.push({ level: 'warn', code: 'MEDIA_COPY_WEAK', detail: `画面文字与任务文案匹配偏弱（${(sim * 100).toFixed(1)}%）` });
            }
          } else if (!hasVoicePath) {
            out.issues.push({
              level: 'block',
              code: 'MEDIA_COPY_MISSING',
              detail: `抽帧 ${Math.min(4, frames.length)} 张（${ocrBackend}）均未识别到画面文字，未体现任务要求的文案：${truncate(copy, 60)}`,
            });
          } else {
            out.degraded.push('画面 OCR 未识别到文字，改由语音侧核验');
          }
        } else if (!hasVoicePath) {
          out.issues.push({
            level: 'block',
            code: 'MEDIA_COPY_UNVERIFIED',
            detail: `任务明确要求文案（${truncate(copy, 60)}），但${ocrBackend ? '抽帧失败' : '无 OCR 后端'}且无可用语音转写 → 无法核验画面/语音是否含该文案，不予放行`,
          });
        } else {
          out.degraded.push('无 OCR 后端：未做"画面文字 vs 文案"比对，仅语音侧核验');
        }

        // ── 文案一致性：ASR（语音内容） ──
        if (hasVoicePath) {
          const wav = path.join(tmp, `${sha(m.raw)}.wav`);
          const ex = await sh(caps.ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error', '-i', m.resolved, '-vn', '-ac', '1', '-ar', '16000', wav], 90000);
          if (ex.ok && fs.existsSync(wav)) {
            const text = await transcribe(wav, caps);
            if (text) {
              const sim = bigramSimilarity(text, copy);
              out.evidence.push(`语音转写命中率 ${(sim * 100).toFixed(1)}%（转写：${truncate(text.replace(/\s+/g, ' '), 80)}）`);
              if (sim < 0.15) {
                out.issues.push({ level: 'block', code: 'MEDIA_ASR_MISMATCH', detail: `语音内容与任务文案不符（相似度 ${(sim * 100).toFixed(1)}%）` });
              }
            } else {
              out.degraded.push('ASR 转写失败（后端不可用），语音内容未核验');
            }
          }
        } else if (astream && caps.asr.kind === 'none') {
          out.degraded.push('无 ASR 后端：未做"语音内容 vs 文案"比对');
        }
      } else {
        out.degraded.push('任务未给出明确文案，跳过文案一致性比对（仅做媒体完整性/静帧检测）');
      }
    }
  } finally {
    rmTempDir(tmp);
  }
  return out;
}

interface FrameAnalysis {
  frames: { path: string; mean: number; std: number; error?: string }[];
  diffs: number[];
}

/** 用 PIL+numpy 做帧亮度/差异分析（复用项目 Python 环境） */
async function analyzeFrames(frames: string[]): Promise<FrameAnalysis | null> {
  const py = `
import json
from PIL import Image
import numpy as np
paths = json.loads(${JSON.stringify(JSON.stringify(frames))})
res, imgs = [], []
for p in paths:
    try:
        im = Image.open(p).convert("RGB").resize((64, 64))
        a = np.asarray(im).astype(float)
        imgs.append(a)
        res.append({"path": p, "mean": float(a.mean()), "std": float(a.std())})
    except Exception as e:
        res.append({"path": p, "mean": 0.0, "std": 0.0, "error": str(e)})
diffs = [float(np.abs(imgs[i] - imgs[i-1]).mean()) for i in range(1, len(imgs))]
print(json.dumps({"frames": res, "diffs": diffs}))
`;
  try {
    const r = await runLocal(py, 40);
    if (r.exit_code !== 0) return null;
    const line = r.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(line) as FrameAnalysis;
  } catch {
    return null;
  }
}

/** 画面文字识别：优先 tesseract，零输出时回退 Python rapidocr（免系统依赖） */
async function ocrFrames(frames: string[], caps: VerifyCapabilities): Promise<string[]> {
  if (caps.tesseract) {
    const out: string[] = [];
    for (const f of frames) {
      const r = await sh(caps.tesseract, [f, 'stdout', '-l', 'chi_sim+eng'], 40000);
      if (r.ok && r.stdout.trim()) out.push(r.stdout.trim());
    }
    if (out.length) return out;
  }
  if (caps.ocrPy || caps.tesseract) {
    const viaPy = await ocrFramesPy(frames);
    if (viaPy.length) return viaPy;
  }
  return [];
}

/** Python 侧 OCR（rapidocr-onnxruntime，ONNX 中文模型随 wheels 分发） */
async function ocrFramesPy(frames: string[]): Promise<string[]> {
  const py = `
import json
from rapidocr_onnxruntime import RapidOCR
engine = RapidOCR()
paths = json.loads(${JSON.stringify(JSON.stringify(frames))})
out = []
for p in paths:
    try:
        res, _ = engine(p)
        out.append("\\n".join(t[1] for t in (res or [])))
    except Exception:
        out.append("")
print(json.dumps(out, ensure_ascii=False))
`;
  try {
    // 走受信工具通道：onnxruntime 依赖 threading/importlib，run_local 的轻量护栏会误拦
    const r = await runTool(py, 180);
    if (r.exit_code !== 0) return [];
    const line = r.stdout.trim().split('\n').pop() ?? '';
    const arr = JSON.parse(line) as string[];
    return arr.filter((s) => s && s.trim()).map((s) => s.trim());
  } catch {
    return [];
  }
}

/** 语音转写（多后端适配） */
async function transcribe(wav: string, caps: VerifyCapabilities): Promise<string> {
  if (caps.asr.kind === 'whisper-cli' && caps.asr.cmd) {
    const tmpOut = path.dirname(wav);
    const r = await sh(caps.asr.cmd, [wav, '--model', 'tiny', '--output_format', 'txt', '--output_dir', tmpOut, '--fp16', 'False'], 300000);
    if (r.ok) {
      const txt = path.join(tmpOut, path.basename(wav, '.wav') + '.txt');
      if (fs.existsSync(txt)) return fs.readFileSync(txt, 'utf8').trim();
    }
    return '';
  }
  if (caps.asr.kind === 'faster-whisper') {
    const py = `
import json, sys
from faster_whisper import WhisperModel
m = WhisperModel("tiny", device="cpu", compute_type="int8")
segs, _ = m.transcribe(${JSON.stringify(wav)})
print(json.dumps({"text": "".join(s.text for s in segs)}, ensure_ascii=False))
`;
    const r = await runLocal(py, 300);
    if (r.exit_code === 0) {
      try {
        const line = r.stdout.trim().split('\n').pop() ?? '';
        return (JSON.parse(line) as { text?: string }).text ?? '';
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** ④ 来源真实性：链接可达 + 正文回抓核对 */
async function checkSources(ctx: CheckCtx): Promise<CheckOutcome> {
  const out: CheckOutcome = { mode: 'source', evidence: [], issues: [], degraded: [], applicable: false };
  const urls = extractUrls(ctx.answer);
  if (urls.length === 0) return out;
  out.applicable = true;

  const f = httpFetch();
  if (!f || ctx.caps.network === false) {
    out.degraded.push(`无网络能力：${urls.length} 条引用链接未做可达性核验`);
    return out;
  }

  let reachable = 0;
  const bodies: string[] = [];
  for (const u of urls.slice(0, 6)) {
    ctx.emit('source', `探测 ${u}`);
    const r = await fetchText(f, u, 12000);
    if (r && r.status < 400) {
      reachable++;
      bodies.push(r.text);
      out.evidence.push(`来源可达 ${r.status}：${u}`);
    } else {
      out.issues.push({
        level: 'warn',
        code: 'SOURCE_UNREACHABLE',
        detail: `引用链接不可达（${r ? r.status : '网络错误'}）：${u}`,
      });
    }
  }

  if (urls.length && reachable === 0) {
    out.issues.push({ level: 'block', code: 'SOURCE_ALL_DEAD', detail: `${urls.length} 条引用链接全部不可达，来源不可信` });
  }

  // 关键数字回抓核对：回答中带数字的宣称句，正文里能否找到
  const haystack = bodies.join('\n');
  if (haystack) {
    const numClaims = (ctx.answer.match(/[^\n。；]{0,40}\d[\d,.]*\s*(?:%|亿|万|元|美元|倍|人|台|辆|个)?[^\n。；]{0,20}/g) ?? [])
      .map((s) => s.trim())
      .filter((s) => /\d/.test(s) && s.length > 4)
      .slice(0, 6);
    let miss = 0;
    for (const c of numClaims) {
      const keys = (c.match(/\d[\d,.]*/g) ?? []).filter((n) => n.replace(/[^\d]/g, '').length >= 2);
      if (!keys.length) continue;
      const hit = keys.some((k) => haystack.includes(k) || haystack.includes(k.replace(/,/g, '')));
      if (!hit) miss++;
    }
    if (miss >= 2) {
      out.issues.push({ level: 'warn', code: 'SOURCE_NUMBER_UNVERIFIED', detail: `${miss} 处带数字的结论未能在引用正文中找到对应数据，存在编造风险` });
    }
  }
  return out;
}

async function fetchText(
  f: FetchLike,
  url: string,
  timeoutMs: number,
): Promise<{ status: number; text: string } | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await f(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XuanShuVerifier/1.0)', Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: ctl.signal,
    });
    clearTimeout(t);
    let text = '';
    try {
      text = truncate(await r.text(), 200000);
    } catch {
      text = '';
    }
    return { status: r.status, text };
  } catch {
    return null;
  }
}

/** ⑤ 跨模型语义复核 */
async function checkLlm(ctx: CheckCtx): Promise<CheckOutcome> {
  const out: CheckOutcome = { mode: 'llm', evidence: [], issues: [], degraded: [], applicable: false };
  if (!ctx.pool || !ctx.caps.llm) return out;
  out.applicable = true;

  const key = pickVerifierModel(ctx.pool, ctx.agent);
  if (!key) {
    out.degraded.push('无可用模型做跨模型语义复核');
    return out;
  }

  const prompt = [
    '你是独立验收员（Verifier），负责复核另一个 Agent 的交付结果是否真的完成了任务。',
    '要求：只依据下面给出的「任务」与「回答」判断，不要脑补成功；发现夸大、编造、答非所问、遗漏关键要求都要指出。',
    '',
    `【任务】\n${truncate(ctx.task, 2000)}`,
    '',
    `【被验收回答】\n${truncate(ctx.answer, 4000)}`,
    '',
    '请严格输出 JSON（不要任何其他文字）：',
    '{"verdict":"pass|fail","score":0-100,"reason":"一句话结论","flaws":["具体缺陷1","具体缺陷2"],"missing":["任务要求中未完成的部分"]}',
  ].join('\n');

  ctx.emit('llm', `跨模型复核（${key}）`);
  let content = '';
  try {
    const p = ctx.pool.callLlm(keyModelAgent(), [{ role: 'user', content: prompt }], undefined, key, undefined);
    const resp = await Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('llm review timeout')), 60000)),
    ]);
    content = String(resp?.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    out.degraded.push(`跨模型复核失败（${truncate((e as Error).message, 120)}）`);
    return out;
  }

  const parsed = parseJsonLoose(content);
  if (!parsed) {
    out.degraded.push('跨模型复核返回非 JSON，未采信');
    return out;
  }
  const verdict = String(parsed.verdict ?? '').toLowerCase();
  const flaws = Array.isArray(parsed.flaws) ? parsed.flaws.map(String) : [];
  const missing = Array.isArray(parsed.missing) ? parsed.missing.map(String) : [];
  out.evidence.push(`跨模型复核（${key}）判定：${verdict || '?'}（${truncate(String(parsed.reason ?? ''), 160)}）`);
  if (verdict === 'fail') {
    out.issues.push({
      level: 'block',
      code: 'LLM_VERDICT_FAIL',
      detail: `独立语义复核未通过：${truncate(String(parsed.reason ?? ''), 200)}${flaws.length ? ' | 缺陷：' + flaws.slice(0, 3).join('；') : ''}${missing.length ? ' | 缺失：' + missing.slice(0, 3).join('；') : ''}`,
    });
  }
  return out;
}

/** 为验收挑选一个"与被验收 Agent 不同"的模型 */
function pickVerifierModel(pool: ModelPool, childAgent: string): string | null {
  const childKey = (() => {
    try {
      return pool.getKey(childAgent);
    } catch {
      return '';
    }
  })();
  const usable: string[] = [];
  for (const [k, v] of pool.allModels) {
    if (v.custom) continue;
    if (pool.modelHasKey(k) || pool.apiKey) usable.push(k);
  }
  if (!usable.length) return null;
  const different = usable.find((k) => k !== childKey);
  return different ?? usable[0];
}

/** 复核调用使用的伪 Agent 名（避免污染真实 Agent 的绑定） */
function keyModelAgent(): string {
  return '审核Agent';
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/) ?? [])[0];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─────────────────────────── 编排 ───────────────────────────

/** 判断某 Agent 需要跑哪些验收维度 */
export function planModes(agent: string, task: string, answer: string): VerifyMode[] {
  const modes = new Set<VerifyMode>();
  const hasCode = extractCodeBlocks(answer, agent).length > 0;
  if (hasCode) modes.add('code');
  modes.add('artifact');
  if (/视频Agent|音频Agent/.test(agent) || extractPathClaims(answer).some((c) => c.isMedia)) modes.add('media');
  if (/搜索Agent|浏览器Agent/.test(agent) || extractUrls(answer).length > 0) modes.add('source');
  modes.add('llm');
  void task;
  return [...modes];
}

/** 汇总各维度结果 → 最终裁决 */
function merge(raws: CheckOutcome[], durationMs: number): VerifyVerdict {
  const issues = raws.flatMap((r) => r.issues);
  const evidence = raws.flatMap((r) => r.evidence);
  const degraded = raws.flatMap((r) => r.degraded);
  const modes = raws.filter((r) => r.applicable).map((r) => r.mode);

  let score = 100;
  for (const i of issues) score -= i.level === 'block' ? 40 : 8;
  score = Math.max(0, Math.min(100, score));

  const blocks = issues.filter((i) => i.level === 'block');
  const ok = blocks.length === 0 && modes.length > 0;

  const retry_hint = blocks.length
    ? [
        '上一轮交付未通过独立验收，请针对以下问题返修后重新交付：',
        ...blocks.map((b, i) => `${i + 1}. [${b.code}] ${b.detail}`),
        '返修要求：必须用工具真实执行/真实落盘后再回复；不得再出现"宣称已完成但磁盘无产物""宣称输出与真实 stdout 不符"的情况。',
      ].join('\n')
    : '';

  const summary = ok
    ? `验收通过（${modes.join('/')}${degraded.length ? `，${degraded.length} 项降级` : ''}）score=${score}`
    : `验收未通过：${blocks.length} 项阻断问题（${blocks.map((b) => b.code).join(',')}）`;

  return { ok, score, modes, issues, evidence, degraded, retry_hint, duration_ms: durationMs, summary };
}

/**
 * 主入口：对子 Agent 的交付结果做独立验收。
 * 永不抛异常——任何内部故障都降级为 degraded 声明，避免拖垮主流程。
 */
export async function verifyChildResult(opts: VerifyOptions): Promise<VerifyVerdict> {
  const t0 = Date.now();
  const pool = opts.pool ?? null;
  const caps = await detectCapabilities(false, pool);
  const emit: CheckCtx['emit'] = (stage, detail) => {
    try {
      opts.onProgress?.({ type: 'verify', agent: opts.agent, stage, detail });
    } catch {
      /* ignore */
    }
  };

  const ctx: CheckCtx = { agent: opts.agent, task: opts.task, answer: opts.answer, caps, pool, emit };
  const want = planModes(opts.agent, opts.task, opts.answer);
  const raws: CheckOutcome[] = [];

  const run = async (fn: (c: CheckCtx) => Promise<CheckOutcome>, enabled: boolean) => {
    if (!enabled) return;
    try {
      raws.push(await fn(ctx));
    } catch (e) {
      raws.push({ mode: 'artifact', evidence: [], issues: [], degraded: [`验收子过程异常：${(e as Error).message}`], applicable: false });
    }
  };

  await run(checkCode, want.includes('code') || opts.agent === '代码Agent');
  await run(checkArtifacts, want.includes('artifact'));
  await run(checkMedia, want.includes('media') || opts.agent === '视频Agent' || opts.agent === '音频Agent');
  await run(checkSources, want.includes('source'));
  await run(checkLlm, opts.llmReview !== false);

  let verdict = merge(raws, Date.now() - t0);

  // 总超时保护
  const limit = opts.timeoutMs ?? 150000;
  if (verdict.duration_ms > limit) {
    verdict = {
      ...verdict,
      ok: false,
      degraded: [...verdict.degraded, `验收耗时 ${verdict.duration_ms}ms 超出预算 ${limit}ms，结果可能不完整`],
    };
  }
  emit('done', verdict.summary);
  return verdict;
}

/** 把裁决格式化为可注入子 Agent 的反饋文本 */
export function formatVerdictForPrompt(v: VerifyVerdict): string {
  return [
    '【独立验收结果】' + v.summary,
    v.evidence.length ? '实测证据：\n' + v.evidence.map((e) => '  - ' + e).join('\n') : '',
    v.degraded.length ? '未验项（能力不足，非通过）：\n' + v.degraded.map((d) => '  - ' + d).join('\n') : '',
    v.retry_hint,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 用户可见的验收摘要 */
export function formatVerdictBrief(v: VerifyVerdict): string {
  const lines = [
    `${v.ok ? '✅ 验收通过' : '❌ 验收未通过'} · 维度 ${v.modes.join('/') || '无'} · 置信分 ${v.score}`,
  ];
  for (const e of v.evidence.slice(0, 6)) lines.push(`  · ${e}`);
  for (const i of v.issues.slice(0, 6)) lines.push(`  ${i.level === 'block' ? '⛔' : '⚠️'} [${i.code}] ${i.detail}`);
  for (const d of v.degraded.slice(0, 4)) lines.push(`  ◻︎ 未验：${d}`);
  return lines.join('\n');
}

/** 供工具/健康检查使用的环境自检 */
export async function verifySelfCheck(pool?: ModelPool | null): Promise<string> {
  const caps = await detectCapabilities(true, pool);
  return [
    '[验收能力自检]',
    `ffmpeg   : ${caps.ffmpeg ?? '缺失（媒体抽帧/转写不可用）'}`,
    `ffprobe  : ${caps.ffprobe ?? '缺失（媒体元信息不可用）'}`,
    `tesseract: ${caps.tesseract ?? '缺失（画面 OCR 不可用）'}`,
    `ASR      : ${caps.asr.kind === 'none' ? '缺失（语音转写不可用）' : caps.asr.kind}`,
    `模型复核 : ${caps.llm ? '可用' : '无 Key，跳过'}`,
    `网络     : ${caps.network === null ? '未知' : caps.network ? '可用' : '不可用'}`,
    caps.notes.length ? '注意事项：\n' + caps.notes.map((n) => '  - ' + n).join('\n') : '注意事项：无',
  ].join('\n');
}
