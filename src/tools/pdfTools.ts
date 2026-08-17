/**
 * src/tools/pdfTools.ts — PDF Agent 工具（5 工具）
 *
 * 迁移决策：Node 侧 pdf-lib/pdf-parse 安装失败（npm 缓存损坏），
 * 复用原版 pdf_tools.py（pypdf 已安装），通过 runLocal 调用。
 */
import { runTool } from '../core/sandbox.js';
import { PROJECT_ROOT } from '../core/sandbox.js';
import path from 'node:path';
import fs from 'node:fs';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * 原版 pdf_tools 依赖显式 output/output_dir，缺省 "." 会落到项目根。
 * 这里统一补默认值到 output 目录。
 */
function ensureOutput(args: Record<string, unknown>): Record<string, unknown> {
  const a: Record<string, unknown> = { ...args };
  if (!a.output) a.output = path.join(OUTPUT_DIR, `merged_${Date.now() % 10000}.pdf`);
  return a;
}

async function callPy(fn: string, args: Record<string, unknown>, timeout = 120): Promise<string> {
  const code = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})`,
    `import pdf_tools`,
    `print(pdf_tools.${fn}(${JSON.stringify(args)}))`,
  ].join('\n');
  const res = await runTool(code, timeout);
  if (res.exit_code !== 0) {
    return `[${fn} 失败] ${res.stderr.trim() || res.error || '未知错误'}`;
  }
  return res.stdout.trim() || `(${fn} 完成，无输出)`;
}

export const pdfTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'pdf_read', description: '读取 PDF 文本内容（分页输出）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'PDF 文件路径' }, page: { type: 'number', description: '指定页码（从 1 开始，缺省读取全部）' }, max_pages: { type: 'number', description: '最多读取页数，默认 10' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('pdf_read', args, 120),
  },
  {
    schema: { type: 'function', function: { name: 'pdf_merge', description: '合并多个 PDF 为一个文件', parameters: { type: 'object', properties: { inputs: { type: 'array', items: { type: 'string' }, description: '输入 PDF 文件列表' }, output: { type: 'string', description: '输出路径（缺省写入 output 目录）' } }, required: ['inputs'] } } },
    handler: async (args: Record<string, unknown>) => callPy('pdf_merge', ensureOutput(args), 180),
  },
  {
    schema: { type: 'function', function: { name: 'pdf_split', description: '拆分 PDF（按页码范围或每 N 页一组）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入 PDF 路径' }, pages: { type: 'string', description: '页码范围，如 "1-3,5"（缺省按每页拆分）' }, output_dir: { type: 'string', description: '输出目录（缺省 output/pdf_split）' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('pdf_split', { ...args, output_dir: args.output_dir || path.join(OUTPUT_DIR, 'pdf_split') }, 180),
  },
  {
    schema: { type: 'function', function: { name: 'pdf_meta', description: '查看 PDF 元信息（页数/标题/作者/大小）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'PDF 文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('pdf_meta', args, 60),
  },
  {
    schema: { type: 'function', function: { name: 'pdf_extract_images', description: '提取 PDF 内嵌图片到输出目录', parameters: { type: 'object', properties: { path: { type: 'string', description: 'PDF 文件路径' }, output_dir: { type: 'string', description: '输出目录（缺省 output/pdf_images）' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('pdf_extract_images', { ...args, output_dir: args.output_dir || path.join(OUTPUT_DIR, 'pdf_images') }, 180),
  },
];
