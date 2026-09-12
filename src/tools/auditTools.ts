/**
 * src/tools/auditTools.ts — 审核Agent「小核」的独立验收工具集
 *
 * 与 verifier.ts 的分工：
 *  - verifier.ts 是引擎（确定性检查 + 跨模型复核），由 coordinator 在交付收尾自动调用；
 *  - 本文件把引擎能力暴露成工具，让「小核」在需要人工介入式复核时主动调用（可组合、可追问）。
 *
 * 所有 handler 只读或只做沙箱执行，不写业务文件、不修改系统状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ModelPool } from '../core/modelPool.js';
import {
  verifyChildResult,
  verifySelfCheck,
  formatVerdictForPrompt,
  extractPathClaims,
  extractUrls,
} from '../core/verifier.js';
import { PROJECT_ROOT } from '../core/sandbox.js';

type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = {
  schema: FnSchema;
  handler: (args: Record<string, unknown>, ctx?: { agent?: string; pool?: ModelPool }) => string | Promise<string>;
};

/** 归一化路径：相对路径依次尝试 项目根 / output 目录 */
function resolvePath(p: string): string {
  if (!p) return '';
  if (path.isAbsolute(p)) return p;
  const inOutput = path.join(PROJECT_ROOT, 'output', p);
  if (fs.existsSync(inOutput)) return inOutput;
  return path.resolve(PROJECT_ROOT, p);
}

export const auditTools: ToolDef[] = [
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_capabilities',
        description: '验收能力自检：报告本机 ffmpeg/ffprobe/tesseract/ASR/模型Key/网络 是否可用，以及哪些验收维度会被降级。复核他人交付前建议先调用一次。',
        parameters: { type: 'object', properties: {} },
      },
    },
    handler: async (_args, ctx) => verifySelfCheck(ctx?.pool ?? null),
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_delivery',
        description: '对一份交付结果做全维度独立验收（代码真实重跑 + 产物落盘 + 媒体真实性 + 引用可达 + 跨模型语义复核）。返回裁决、实测证据、未验项与返修指令。',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: '原始任务要求（用于判断是否答非所问、遗漏要求）' },
            answer: { type: 'string', description: '待验收的交付内容全文（被验收 Agent 的回答）' },
            agent: { type: 'string', description: '被验收 Agent 名称，如 代码Agent / 视频Agent / 搜索Agent' },
          },
          required: ['task', 'answer'],
        },
      },
    },
    handler: async (args, ctx) => {
      const task = String(args.task ?? '');
      const answer = String(args.answer ?? '');
      if (!task || !answer) return '[verify_delivery 失败] 需要 task 与 answer';
      const v = await verifyChildResult({
        agent: String(args.agent ?? '未知Agent'),
        task,
        answer,
        pool: ctx?.pool ?? null,
      });
      return formatVerdictForPrompt(v);
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_code_runnable',
        description: '把一段 Python 代码放进隔离沙箱真实执行，返回 exit_code/stdout/stderr。用于判断代码是否真的能跑通，而不是"看起来对"。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '待验证的 Python 代码' },
            expected_output: { type: 'string', description: '可选：期望 stdout 中出现的内容，用于核对宣称输出' },
          },
          required: ['code'],
        },
      },
    },
    handler: async (args, ctx) => {
      const code = String(args.code ?? '');
      if (!code.trim()) return '[verify_code_runnable 失败] 缺少 code';
      const expected = String(args.expected_output ?? '');
      const answer = ['```python', code, '```', expected ? `输出：${expected}` : ''].join('\n');
      const v = await verifyChildResult({
        agent: '代码Agent',
        task: '验证以下代码可真实执行' + (expected ? `，且输出包含「${expected}」` : ''),
        answer,
        pool: ctx?.pool ?? null,
        llmReview: false,
      });
      return formatVerdictForPrompt(v);
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_media_truth',
        description: '核验音视频产物真伪：真实元信息（时长/分辨率/音轨）、抽帧静帧与黑帧检测、画面 OCR 与语音 ASR 是否与期望文案一致。用于判断"视频是否真按文案产出、有无图文/情景不符"。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '音视频文件路径' },
            expected_copy: { type: 'string', description: '期望的文案/字幕/口播内容（用于一致性比对，可留空）' },
          },
          required: ['path'],
        },
      },
    },
    handler: async (args, ctx) => {
      const p = resolvePath(String(args.path ?? ''));
      if (!p || !fs.existsSync(p)) return `[verify_media_truth 失败] 文件不存在: ${args.path}`;
      const copy = String(args.expected_copy ?? '');
      const v = await verifyChildResult({
        agent: '视频Agent',
        task: copy ? `产出视频，文案：「${copy}」` : '产出视频',
        answer: `视频已生成，输出：${p}`,
        pool: ctx?.pool ?? null,
        llmReview: false,
      });
      return formatVerdictForPrompt(v);
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_sources',
        description: '核验引用的真实性：逐个真实 HTTP 探测链接可达性，并回抓正文核对回答中的关键数字。用于识别编造链接/编造数据。',
        parameters: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: '含引用链接与结论的回答全文' },
            task: { type: 'string', description: '可选：原始检索问题' },
          },
          required: ['answer'],
        },
      },
    },
    handler: async (args, ctx) => {
      const answer = String(args.answer ?? '');
      const urls = extractUrls(answer);
      if (!urls.length) return '[verify_sources] 未在内容中发现 http(s) 链接，无可核验来源';
      const v = await verifyChildResult({
        agent: '搜索Agent',
        task: String(args.task ?? '核验引用真实性'),
        answer,
        pool: ctx?.pool ?? null,
        llmReview: false,
      });
      return formatVerdictForPrompt(v);
    },
  },
  {
    schema: {
      type: 'function',
      function: {
        name: 'verify_artifacts',
        description: '核验交付产物是否真实落盘：逐个检查路径是否存在、是否为空文件，识别"宣称已生成但磁盘上没有"的幻觉产物。',
        parameters: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: '待核验的文件路径列表' },
          },
          required: ['paths'],
        },
      },
    },
    handler: async (args, ctx) => {
      const list = Array.isArray(args.paths) ? args.paths.map(String) : [];
      if (!list.length) return '[verify_artifacts 失败] 缺少 paths';
      const answer = list.map((p) => `已生成并保存到：${p}`).join('\n');
      const v = await verifyChildResult({
        agent: '文件Agent',
        task: '核验以下产物真实落盘且非空',
        answer,
        pool: ctx?.pool ?? null,
        llmReview: false,
      });
      // 补充一次性汇总，便于直接阅读
      const claims = extractPathClaims(answer);
      const table = claims
        .map((c) => `  ${c.exists ? (c.size > 0 ? '✅' : '⚠️空文件') : '⛔缺失'} ${c.raw} (${c.size} 字节)`)
        .join('\n');
      return `${formatVerdictForPrompt(v)}\n\n[逐项结果]\n${table}`;
    },
  },
];
