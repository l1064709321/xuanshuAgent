/**
 * src/tools/imageTools.ts — 图像Agent 工具（8 工具）
 *
 * 迁移决策：Node 侧图像库（sharp）安装失败（npm 缓存损坏），
 * 复用项目保留的 Python 沙箱能力，通过 runLocal 调用原版 image_tools.py
 * （PIL 已安装）。功能与原版完全对齐。
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
 * 原版 image_tools._safe_path("") 会把空 output 解析为项目根目录（短路 bug），
 * 这里统一为缺省 output 的工具生成 output 目录下的默认路径。
 */
function ensureOutput(args: Record<string, unknown>, tag: string, ext?: string): Record<string, unknown> {
  if (args.output) return args;
  const input = String(args.path ?? '');
  const base = path.basename(input, path.extname(input));
  const e = ext ?? (path.extname(input) || '.png');
  return { ...args, output: path.join(OUTPUT_DIR, `${base}_${tag}${Date.now() % 10000}${e}`) };
}

/**
 * 调用原版 Python 图像工具函数。
 * 参数以 JSON 内嵌进代码字符串（JSON.stringify 已做转义，防注入）。
 */
async function callPy(fn: string, args: Record<string, unknown>, timeout = 60): Promise<string> {
  const code = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})`,
    `import image_tools`,
    `print(image_tools.${fn}(${JSON.stringify(args)}))`,
  ].join('\n');
  const res = await runTool(code, timeout);
  if (res.exit_code !== 0) {
    return `[${fn} 失败] ${res.stderr.trim() || res.error || '未知错误'}`;
  }
  return res.stdout.trim() || `(${fn} 完成，无输出)`;
}

export const imageTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'image_info', description: '获取图像元信息（尺寸/模式/格式/文件大小/EXIF）', parameters: { type: 'object', properties: { path: { type: 'string', description: '图像文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_info', { path: String(args.path ?? '') }, 30),
  },
  {
    schema: { type: 'function', function: { name: 'image_compress', description: '压缩图像（质量或目标大小），输出 JPG', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, quality: { type: 'number', description: 'JPEG 质量 1-95，默认 70' }, max_size_kb: { type: 'number', description: '目标大小上限 KB（可选，自动迭代压缩）' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_compress', ensureOutput(args, 'comp'), 120),
  },
  {
    schema: { type: 'function', function: { name: 'image_crop', description: '裁剪图像（box: left, top, right, bottom 像素）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, box: { type: 'array', items: { type: 'number' }, description: '[left, top, right, bottom]' } }, required: ['path', 'box'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_crop', ensureOutput(args, 'crop'), 60),
  },
  {
    schema: { type: 'function', function: { name: 'image_resize', description: '缩放图像（width/height 二选一或同时给出，等比时只给一项）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, width: { type: 'number', description: '目标宽度' }, height: { type: 'number', description: '目标高度' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_resize', ensureOutput(args, 'resize'), 60),
  },
  {
    schema: { type: 'function', function: { name: 'image_convert', description: '图像格式转换（jpg/png/webp/bmp）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, format: { type: 'string', description: '目标格式 jpg/png/webp/bmp' } }, required: ['path', 'format'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_convert', ensureOutput(args, 'convert', '.' + String(args.format ?? 'jpg').replace(/^\./, '')), 60),
  },
  {
    schema: { type: 'function', function: { name: 'image_rotate', description: '旋转图像（角度，正值逆时针）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, angle: { type: 'number', description: '旋转角度' } }, required: ['path', 'angle'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_rotate', ensureOutput(args, 'rot'), 60),
  },
  {
    schema: { type: 'function', function: { name: 'image_thumbnail', description: '生成缩略图（最长边限制，输出到 output 目录）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, max_size: { type: 'number', description: '最长边像素，默认 300' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_thumbnail', ensureOutput(args, 'thumb'), 60),
  },
  {
    schema: { type: 'function', function: { name: 'image_watermark', description: '添加文字水印（支持旋转/透明度）', parameters: { type: 'object', properties: { path: { type: 'string', description: '输入图像路径' }, text: { type: 'string', description: '水印文字' }, position: { type: 'string', description: '位置 center/top-left/top-right/bottom-left/bottom-right，默认 bottom-right' }, opacity: { type: 'number', description: '透明度 0-255，默认 128' }, angle: { type: 'number', description: '水印旋转角度，默认 0' } }, required: ['path', 'text'] } } },
    handler: async (args: Record<string, unknown>) => callPy('image_watermark', ensureOutput(args, 'wm'), 120),
  },
];
