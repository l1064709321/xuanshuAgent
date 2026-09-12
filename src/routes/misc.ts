/**
 * src/routes/misc.ts — 补充缺失的前端配套路由
 *
 * 覆盖前端已开发 UI 但后端缺失的接口：
 *  - API Key / 模型切换 / 自定义模型
 *  - Token 统计、上下文记忆、文件上传
 *  - 记忆 / 技能 / 工作流 / 快照
 *
 * 持久化统一落在项目根 .data/ 目录（JSON），避免占用系统目录。
 */
import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { join, resolve, basename, dirname, relative, sep, extname } from 'node:path';
import { getPool } from '../core/engine.js';
import { getTokenStats } from '../core/tokenStats.js';
import { getLimits, setLimits, resetLimits, DEFAULT_LIMITS, LIMITS_RANGE } from '../core/limits.js';
import {
  MEM_ALLOWED_EXT,
  MEM_MAX_READ,
  MEM_MAX_WRITE,
  MEM_BACKUP_KEEP,
  isValidMemRel,
  safeResolve,
  atomicWrite,
  backupBeforeWrite,
  softDeleteToTrash,
} from '../core/memGuard.js';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA_DIR = join(ROOT, '.data');
const MEM_DIR = join(ROOT, '.memdir');
const MEM_BACKUP_DIR = join(MEM_DIR, '.backup');
const MEM_TRASH_DIR = join(MEM_DIR, '.trash');
const SKILL_DIR = join(ROOT, '.skills');
const WF_DIR = join(ROOT, 'workflows');
const UPLOAD_DIR = join(ROOT, 'workspace_files');

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(MEM_DIR, { recursive: true });
mkdirSync(MEM_BACKUP_DIR, { recursive: true });
mkdirSync(MEM_TRASH_DIR, { recursive: true });
mkdirSync(SKILL_DIR, { recursive: true });
mkdirSync(WF_DIR, { recursive: true });
mkdirSync(UPLOAD_DIR, { recursive: true });

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

/** 递归列出目录内文件（相对路径 + 大小），目录返回 size: 0 */
function listFilesRecursive(base: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      if (dir === base && (name === '.backup' || name === '.trash')) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          out.push({ rel: relative(base, full).split(sep).join('/') + '/', size: 0 });
          walk(full);
        } else {
          out.push({ rel: relative(base, full).split(sep).join('/'), size: st.size });
        }
      } catch { /* 忽略 */ }
    }
  };
  walk(base);
  return out;
}

export const miscRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fileSize: 16 * 1024 * 1024, files: 20 } });

  // ── API Key 状态 / 切换模型 / 设置 Key ──
  app.get('/model-key/status', async () => {
    const pool = getPool();
    const keys: Record<string, string> = {};
    const store = readJson<Record<string, string>>(join(DATA_DIR, 'keys.json'), {});
    for (const k of pool.allModels.keys()) {
      const v = pool.getModelKey(k);
      if (v) keys[k] = v;
    }
    for (const [k, v] of Object.entries(store)) {
      if (v) keys[k] = v;
    }
    return { ok: true, keys };
  });

  app.post('/switch-model', async (req, reply) => {
    const body = (req.body ?? {}) as { model?: string };
    const pool = getPool();
    const model = body.model || pool.default_key;
    if (!pool.allModels.has(model)) {
      return reply.code(400).send({ ok: false, error: `未知模型: ${model}` });
    }
    pool.setDefault(model);
    return { ok: true, current_model: model, has_key: Boolean(pool.getModelKey(model)) };
  });

  app.post('/set-key', async (req, reply) => {
    const body = (req.body ?? {}) as { key?: string; model?: string };
    const pool = getPool();
    const model = body.model && pool.allModels.has(body.model) ? body.model : pool.default_key;
    const key = (body.key || '').trim();
    const store = readJson<Record<string, string>>(join(DATA_DIR, 'keys.json'), {});
    if (!key) {
      // 空 Key = 重置当前模型 Key
      pool.removeModelKey(model);
      delete store[model];
      writeJson(join(DATA_DIR, 'keys.json'), store);
      return { ok: true, current_model: model, has_key: false, model, local: false };
    }
    pool.setModelKey(model, key);
    store[model] = key;
    writeJson(join(DATA_DIR, 'keys.json'), store);
    return { ok: true, current_model: model, has_key: true, model, local: false };
  });

  app.post('/model-key', async (req, reply) => {
    const body = (req.body ?? {}) as { model?: string; key?: string };
    const pool = getPool();
    const model = body.model || '';
    if (!model || !pool.allModels.has(model)) {
      return reply.code(400).send({ ok: false, error: '未知模型' });
    }
    const key = (body.key || '').trim();
    const store = readJson<Record<string, string>>(join(DATA_DIR, 'keys.json'), {});
    if (key) {
      pool.setModelKey(model, key);
      store[model] = key;
    } else {
      pool.removeModelKey(model);
      delete store[model];
    }
    writeJson(join(DATA_DIR, 'keys.json'), store);
    return { ok: true, current_model: pool.default_key, has_key: Boolean(pool.getModelKey(model)) };
  });

  // ── 自定义模型 ──
  app.post('/models', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; model_id?: string; base_url?: string; provider?: string };
    const pool = getPool();
    const name = (body.name || '').trim();
    const modelId = (body.model_id || name).trim();
    const baseUrl = (body.base_url || '').trim();
    if (!name || !baseUrl) return reply.code(400).send({ ok: false, error: '名称与 API Base URL 必填' });
    try {
      const entry = pool.addCustom(name, modelId, baseUrl, body.provider || '自定义');
      return { ok: true, model: entry };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.delete('/models/:key', async (req, reply) => {
    const pool = getPool();
    const { key } = req.params as { key: string };
    try {
      pool.removeCustom(key);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // ── Token 统计 ──
  app.get('/token-stats', async () => getTokenStats());

  // ── 多轮执行限制（子 Agent 轮数上限 / 无进展熔断阈值，前端可调） ──
  app.get('/exec/limits', async () => {
    return { ok: true, limits: getLimits(), defaults: DEFAULT_LIMITS, range: LIMITS_RANGE };
  });

  app.post('/exec/limits', async (req) => {
    const body = (req.body ?? {}) as { maxRounds?: unknown; stallRounds?: unknown; reset?: unknown };
    const limits = body.reset === true
      ? resetLimits()
      : setLimits({
        ...(body.maxRounds === undefined ? {} : { maxRounds: Number(body.maxRounds) }),
        ...(body.stallRounds === undefined ? {} : { stallRounds: Number(body.stallRounds) }),
      });
    return { ok: true, limits };
  });

  // ── 上下文记忆（最近对话持久化） ──
  // 字段契约统一为 { role, content, agent?, t? }；兼容历史前端提交的裸数组与 { r, c, a, t } 形态。
  type CtxMsg = { role: string; content: string; agent?: string; t?: string };
  const normalizeMsg = (m: unknown): CtxMsg | null => {
    if (!m || typeof m !== 'object') return null;
    const o = m as Record<string, unknown>;
    const role = String(o.role ?? o.r ?? '').trim();
    const content = String(o.content ?? o.c ?? '');
    if (!role || !content) return null;
    const agent = o.agent ?? o.a;
    const t = o.t;
    return {
      role,
      content,
      agent: agent === undefined || agent === null ? undefined : String(agent),
      t: t === undefined || t === null ? undefined : String(t),
    };
  };

  app.get('/context', async () => {
    const data = readJson<{ shared_msgs?: unknown[]; model?: string; context_summary?: string }>(
      join(DATA_DIR, 'context.json'), {},
    );
    const shared = (Array.isArray(data.shared_msgs) ? data.shared_msgs : [])
      .map(normalizeMsg)
      .filter((m): m is CtxMsg => m !== null);
    return { ok: true, shared_msgs: shared, model: data.model, context_summary: data.context_summary };
  });

  app.post('/context/save', async (req) => {
    const body = (req.body ?? {}) as unknown;
    const rawIncoming = Array.isArray(body)
      ? body
      : ((body as { shared_msgs?: unknown }).shared_msgs ?? []);
    const incoming = (Array.isArray(rawIncoming) ? rawIncoming : [])
      .map(normalizeMsg)
      .filter((m): m is CtxMsg => m !== null);
    // 客户端提交的是完整会话快照，采用覆盖写入而非叠加，避免刷新后气泡重复累积
    const prev = readJson<{ shared_msgs?: unknown[] }>(join(DATA_DIR, 'context.json'), {});
    const prevNorm = (Array.isArray(prev.shared_msgs) ? prev.shared_msgs : [])
      .map(normalizeMsg)
      .filter((m): m is CtxMsg => m !== null);
    const keep = incoming.length > 0 ? incoming : prevNorm;
    writeJson(join(DATA_DIR, 'context.json'), { shared_msgs: keep.slice(-120), at: Date.now() });
    return { ok: true, count: keep.length };
  });

  // ── 文件上传 ──
  app.post('/workspace/upload-batch', async (req, reply) => {
    const uploaded: { path: string }[] = [];
    const errors: string[] = [];
    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type !== 'file') continue;
        const name = basename(part.filename || '');
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
          errors.push('非法文件名: ' + part.filename);
          continue;
        }
        const target = join(UPLOAD_DIR, name);
        try {
          const buf = await part.toBuffer();
          writeFileSync(target, buf);
          uploaded.push({ path: 'workspace_files/' + name });
        } catch (e) {
          errors.push(name + ': ' + (e as Error).message);
        }
      }
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
    return { ok: errors.length === 0, uploaded, error: errors.join('; ') || undefined };
  });

  // ── 记忆文件（.memdir） ──
  app.post('/memory/list', async () => {
    return { ok: true, entries: listFilesRecursive(MEM_DIR) };
  });

  app.post('/memory/read', async (req, reply) => {
    const body = (req.body ?? {}) as { rel?: string };
    const rel = (body.rel || '').replace(/^\/+/, '');
    if (!isValidMemRel(rel)) return reply.code(400).send({ ok: false, error: '非法路径' });
    const target = safeResolve(MEM_DIR, rel);
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    try {
      const st = statSync(target);
      if (!st.isFile()) return reply.code(400).send({ ok: false, error: '不是文件' });
      if (st.size > MEM_MAX_READ) return reply.code(400).send({ ok: false, error: '文件过大(' + st.size + 'B)' });
      const content = readFileSync(target, 'utf-8');
      return { ok: true, content };
    } catch (e) {
      return reply.code(404).send({ ok: false, error: '读取失败: ' + (e as Error).message });
    }
  });

  // 写入/覆盖记忆文件：原子写入 + 写前备份 + 大小/扩展名限制
  app.post('/memory/write', async (req, reply) => {
    const body = (req.body ?? {}) as { rel?: string; content?: string };
    const rel = (body.rel || '').replace(/^\/+/, '');
    if (!isValidMemRel(rel)) return reply.code(400).send({ ok: false, error: '非法路径' });
    const target = safeResolve(MEM_DIR, rel);
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    const content = typeof body.content === 'string' ? body.content : '';
    if (Buffer.byteLength(content, 'utf-8') > MEM_MAX_WRITE) {
      return reply.code(400).send({ ok: false, error: '内容过大(上限 1MB)' });
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      backupBeforeWrite(target, MEM_DIR, MEM_BACKUP_DIR);
      atomicWrite(target, content);
      return { ok: true, rel };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: '写入失败: ' + (e as Error).message });
    }
  });

  // 软删除：移入 .trash 回收区（可恢复），不做物理删除
  app.post('/memory/delete', async (req, reply) => {
    const body = (req.body ?? {}) as { rel?: string };
    const rel = (body.rel || '').replace(/^\/+/, '');
    if (!isValidMemRel(rel)) return reply.code(400).send({ ok: false, error: '非法路径' });
    const target = safeResolve(MEM_DIR, rel);
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    try {
      if (!existsSync(target)) return reply.code(404).send({ ok: false, error: '文件不存在' });
      softDeleteToTrash(target, MEM_DIR, MEM_TRASH_DIR);
      return { ok: true, rel, trashed: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // 列出回收区（用于误删恢复）
  app.post('/memory/trash/list', async () => {
    const out: { rel: string; size: number; ts: number }[] = [];
    const walk = (dir: string) => {
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries.sort()) {
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else {
            const m = name.match(/^(.*)\.(\d+)\.trash$/);
            if (m) out.push({ rel: relative(MEM_TRASH_DIR, full).split(sep).join('/'), size: st.size, ts: Number(m[2]) });
          }
        } catch { /* 忽略 */ }
      }
    };
    walk(MEM_TRASH_DIR);
    return { ok: true, entries: out.sort((a, b) => b.ts - a.ts) };
  });

  // 从回收区恢复最近一份同名文件
  app.post('/memory/trash/restore', async (req, reply) => {
    const body = (req.body ?? {}) as { rel?: string };
    const rel = (body.rel || '').replace(/^\/+/, '');
    if (!rel || rel.includes('..')) return reply.code(400).send({ ok: false, error: '非法路径' });
    const trashFile = safeResolve(MEM_TRASH_DIR, rel);
    if (!trashFile || !existsSync(trashFile)) return reply.code(404).send({ ok: false, error: '回收区无此文件' });
    const m = basename(rel).match(/^(.*)\.(\d+)\.trash$/);
    if (!m) return reply.code(400).send({ ok: false, error: '非回收文件' });
    const origRel = join(dirname(rel), m[1]).split(sep).join('/');
    const target = safeResolve(MEM_DIR, origRel);
    if (!target || !isValidMemRel(origRel)) return reply.code(400).send({ ok: false, error: '目标非法' });
    try {
      mkdirSync(dirname(target), { recursive: true });
      backupBeforeWrite(target, MEM_DIR, MEM_BACKUP_DIR);
      copyFileSync(trashFile, target);
      rmSync(trashFile, { force: true });
      return { ok: true, rel: relative(MEM_DIR, target).split(sep).join('/') };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // ── 技能（.skills/<agent>/<id>.md） ──
  function skillAgentDir(agent: string): string {
    const safe = agent.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '').slice(0, 32);
    const dir = join(SKILL_DIR, safe || 'default');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  app.post('/skills/list', async () => {
    const out: { id: string; name: string; agent: string }[] = [];
    let entries: string[] = [];
    try { entries = readdirSync(SKILL_DIR); } catch { /* 忽略 */ }
    for (const agent of entries) {
      const adir = join(SKILL_DIR, agent);
      if (!statSync(adir).isDirectory()) continue;
      let files: string[] = [];
      try { files = readdirSync(adir); } catch { /* 忽略 */ }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const id = f.replace(/\.md$/, '');
        const name = readFileSync(join(adir, f), 'utf-8').split('\n')[0]?.replace(/^#\s*/, '').trim() || id;
        out.push({ id, name, agent });
      }
    }
    return { ok: true, skills: out };
  });

  app.post('/skills/create', async (req, reply) => {
    const body = (req.body ?? {}) as { agent?: string; name?: string; content?: string };
    const agent = (body.agent || '默认').trim();
    const name = (body.name || '').trim();
    const content = (body.content || '').trim();
    if (!name || !content) return reply.code(400).send({ ok: false, error: '名称与内容必填' });
    const id = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '') || String(Date.now());
    const target = join(skillAgentDir(agent), id + '.md');
    writeFileSync(target, content.startsWith('#') ? content : '# ' + name + '\n\n' + content, 'utf-8');
    return { ok: true, id };
  });

  app.post('/skills/update', async (req, reply) => {
    const body = (req.body ?? {}) as { agent?: string; id?: string; name?: string; content?: string };
    const agent = (body.agent || '').trim();
    const id = (body.id || '').toString().replace(/\.md$/, '');
    const name = (body.name || '').trim();
    const content = (body.content || '').trim();
    if (!name || !content) return reply.code(400).send({ ok: false, error: '名称与内容必填' });
    const target = safeResolve(join(SKILL_DIR, agent), id + '.md');
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    if (!existsSync(target)) return reply.code(404).send({ ok: false, error: '技能不存在' });
    const newId = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-').replace(/^-+|-+$/g, '') || String(Date.now());
    const contentFile = content.startsWith('#') ? content : '# ' + name + '\n\n' + content;
    if (newId === id) {
      writeFileSync(target, contentFile, 'utf-8');
      return { ok: true, id };
    }
    // 名称变更 → 写入新文件并删除旧文件，避免重复条目
    const newTarget = safeResolve(join(SKILL_DIR, agent), newId + '.md');
    if (!newTarget) return reply.code(400).send({ ok: false, error: '非法名称' });
    writeFileSync(newTarget, contentFile, 'utf-8');
    rmSync(target, { force: true });
    return { ok: true, id: newId };
  });

  app.post('/skills/read', async (req, reply) => {
    const body = (req.body ?? {}) as { agent?: string; id?: string };
    const agent = (body.agent || '').trim();
    const id = (body.id || '').toString().replace(/\.md$/, '');
    const target = safeResolve(join(SKILL_DIR, agent), id + '.md');
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    try {
      const content = readFileSync(target, 'utf-8');
      const name = content.split('\n')[0]?.replace(/^#\s*/, '').trim() || id;
      return { ok: true, name, content };
    } catch (e) {
      return reply.code(404).send({ ok: false, error: '读取失败' });
    }
  });

  app.post('/skills/delete', async (req, reply) => {
    const body = (req.body ?? {}) as { agent?: string; id?: string };
    const agent = (body.agent || '').trim();
    const id = (body.id || '').toString().replace(/\.md$/, '');
    const target = safeResolve(join(SKILL_DIR, agent), id + '.md');
    if (!target) return reply.code(400).send({ ok: false, error: '非法路径' });
    try {
      rmSync(target, { force: true });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // ── 工作流（workflows/<id>.json） ──
  app.post('/workflow/list', async () => {
    const workflows: unknown[] = [];
    let files: string[] = [];
    try { files = readdirSync(WF_DIR); } catch { /* 忽略 */ }
    for (const f of files.filter(x => x.endsWith('.json'))) {
      try {
        const wf = JSON.parse(readFileSync(join(WF_DIR, f), 'utf-8'));
        workflows.push({ ...wf, id: f.replace(/\.json$/, '') });
      } catch { /* 忽略坏文件 */ }
    }
    return { ok: true, workflows };
  });

  app.post('/workflow/create', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; trigger?: unknown; steps?: unknown[]; enabled?: boolean };
    const name = (body.name || '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: '规则名称必填' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    writeJson(join(WF_DIR, id + '.json'), { name, trigger: body.trigger || {}, steps: body.steps || [], enabled: body.enabled !== false, at: Date.now() });
    return { ok: true, id };
  });

  app.post('/workflow/update', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string; name?: string; trigger?: unknown; steps?: unknown[]; enabled?: boolean };
    const id = (body.id || '').toString();
    const target = safeResolve(WF_DIR, id + '.json');
    if (!target) return reply.code(400).send({ ok: false, error: '非法 id' });
    if (!existsSync(target)) return reply.code(404).send({ ok: false, error: '规则不存在' });
    const prev = readJson<Record<string, unknown>>(target, {});
    writeJson(target, { ...prev, ...body, id: undefined });
    return { ok: true };
  });

  app.post('/workflow/delete', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: string };
    const id = (body.id || '').toString();
    const target = safeResolve(WF_DIR, id + '.json');
    if (!target) return reply.code(400).send({ ok: false, error: '非法 id' });
    try {
      rmSync(target, { force: true });
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  // ── 快照（导出/导入：打包 .memdir + 对话上下文到 .data/snapshot.json） ──
  app.post('/snapshots/export', async () => {
    const snapshot = {
      at: Date.now(),
      context: readJson(join(DATA_DIR, 'context.json'), {}),
      memdir: listFilesRecursive(MEM_DIR).map(e => {
        let content = '';
        try {
          const t = safeResolve(MEM_DIR, e.rel);
          if (t) content = readFileSync(t, 'utf-8');
        } catch { /* 忽略 */ }
        return { rel: e.rel, content };
      }),
    };
    writeJson(join(DATA_DIR, 'snapshot.json'), snapshot);
    return { ok: true };
  });

  app.post('/snapshots/import', async () => {
    const snap = readJson<{ memdir?: { rel: string; content: string }[] }>(join(DATA_DIR, 'snapshot.json'), {});
    let imported = 0;
    const errors: string[] = [];
    for (const m of snap.memdir || []) {
      if (!isValidMemRel(m.rel)) { errors.push(m.rel + ': 非法路径'); continue; }
      const target = safeResolve(MEM_DIR, m.rel);
      if (!target) { errors.push(m.rel + ': 非法路径'); continue; }
      if (Buffer.byteLength(m.content || '', 'utf-8') > MEM_MAX_WRITE) { errors.push(m.rel + ': 内容过大'); continue; }
      try {
        mkdirSync(dirname(target), { recursive: true });
        atomicWrite(target, m.content || '');
        imported++;
      } catch (e) {
        errors.push(m.rel + ': ' + (e as Error).message);
      }
    }
    return { ok: errors.length === 0, imported, error: errors.join('; ') || undefined };
  });
};
