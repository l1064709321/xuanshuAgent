/**
 * src/tools/mediaTools.ts — 音频/视频Agent 工具（ffmpeg 封装）
 *
 * ffmpeg 不可用时返回清晰提示，不崩溃。输出文件写入 output 目录。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const exec = promisify(execFile);

let ffmpegReady: boolean | null = null;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegReady !== null) return ffmpegReady;
  try {
    await exec('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegReady = true;
  } catch {
    ffmpegReady = false;
  }
  return ffmpegReady;
}

const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function resolveIn(p: string): string | null {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

function outPath(input: string, ext: string, tag: string): string {
  const base = path.basename(input, path.extname(input));
  return path.join(OUTPUT_DIR, `${base}_${tag}${Date.now() % 10000}.${ext}`);
}

async function ff(args: string[], timeoutMs = 120000): Promise<string> {
  const { stdout, stderr } = await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: timeoutMs });
  return (stdout + (stderr ? `\n[ffmpeg stderr]\n${stderr.slice(0, 1000)}` : '')).trim() || '(完成，无输出)';
}

const NOT_READY = '[ffmpeg 未安装] 当前环境缺少 ffmpeg，无法执行媒体处理。请先安装（如 dnf install -y ffmpeg）后重试。';

export const audioTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'audio_info', description: '查看音频文件元信息（时长/编码/采样率/码率）', parameters: { type: 'object', properties: { path: { type: 'string', description: '音频文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.path ?? ''));
      if (!input || !fs.existsSync(input)) return `[audio_info 失败] 文件不存在: ${args.path}`;
      try {
        const { stderr } = await exec('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], { timeout: 30000 });
        const info = JSON.parse(stderr);
        const fmt = info.format || {};
        const stream = (info.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio');
        return [
          `[文件] ${args.path}`,
          `[时长] ${(Number(fmt.duration) || 0).toFixed(2)}s`,
          `[编码] ${stream?.codec_name || '未知'}`,
          `[采样率] ${stream?.sample_rate || '未知'} Hz`,
          `[码率] ${fmt.bit_rate ? (Number(fmt.bit_rate) / 1000).toFixed(0) + ' kbps' : '未知'}`,
          `[声道] ${stream?.channels ?? '未知'}`,
        ].join('\n');
      } catch (e) {
        return `[audio_info 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_convert', description: '音频格式转换（如 mp3/wav/ogg/flac）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, format: { type: 'string', description: '目标格式' } }, required: ['input', 'format'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const format = String(args.format ?? '').replace(/^\./, '');
      if (!input || !fs.existsSync(input)) return `[audio_convert 失败] 文件不存在: ${args.input}`;
      if (!format) return '[audio_convert 失败] 缺少 format';
      try {
        const out = outPath(input, format, 'convert');
        await ff(['-i', input, '-vn', out]);
        return `[转换完成] ${out}`;
      } catch (e) {
        return `[audio_convert 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_cut', description: '裁剪音频片段（秒）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, start: { type: 'number', description: '起始秒' }, end: { type: 'number', description: '结束秒' } }, required: ['input', 'start', 'end'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const start = Number(args.start ?? 0);
      const end = Number(args.end ?? 0);
      if (!input || !fs.existsSync(input)) return `[audio_cut 失败] 文件不存在: ${args.input}`;
      if (end <= start) return '[audio_cut 失败] end 必须大于 start';
      try {
        const out = outPath(input, path.extname(input).slice(1) || 'mp3', 'cut');
        await ff(['-i', input, '-ss', String(start), '-to', String(end), '-c', 'copy', out]);
        return `[裁剪完成] ${out} (${start}s → ${end}s)`;
      } catch (e) {
        return `[audio_cut 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_merge', description: '合并多个音频文件（按顺序拼接）', parameters: { type: 'object', properties: { inputs: { type: 'array', items: { type: 'string' }, description: '输入文件列表' } }, required: ['inputs'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const inputs = (args.inputs as unknown[]) ?? [];
      if (!inputs.length) return '[audio_merge 失败] 缺少 inputs';
      const files = inputs.map((i) => resolveIn(String(i)));
      for (const f of files) {
        if (!f || !fs.existsSync(f)) return `[audio_merge 失败] 文件不存在: ${f}`;
      }
      try {
        const listFile = path.join(OUTPUT_DIR, `.merge_${Date.now()}.txt`);
        fs.writeFileSync(listFile, files.map((f) => `file '${f?.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
        const out = path.join(OUTPUT_DIR, `merged_${Date.now() % 10000}.mp3`);
        await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
        fs.unlinkSync(listFile);
        return `[合并完成] ${out}`;
      } catch (e) {
        return `[audio_merge 失败] ${(e as Error).message}`;
      }
    },
  },
];

export const videoTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'video_info', description: '查看视频元信息（时长/分辨率/编码/码率/帧率）', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.path ?? ''));
      if (!input || !fs.existsSync(input)) return `[video_info 失败] 文件不存在: ${args.path}`;
      try {
        const { stderr } = await exec('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], { timeout: 30000 });
        const info = JSON.parse(stderr);
        const fmt = info.format || {};
        const vstream = (info.streams || []).find((s: { codec_type: string }) => s.codec_type === 'video');
        const astream = (info.streams || []).find((s: { codec_type: string }) => s.codec_type === 'audio');
        const fps = vstream?.avg_frame_rate?.split('/');
        const fpsVal = fps && Number(fps[0]) && Number(fps[1]) ? (Number(fps[0]) / Number(fps[1])).toFixed(1) : '未知';
        return [
          `[文件] ${args.path}`,
          `[时长] ${(Number(fmt.duration) || 0).toFixed(2)}s`,
          `[分辨率] ${vstream?.width || '?'}x${vstream?.height || '?'}`,
          `[视频编码] ${vstream?.codec_name || '未知'}`,
          `[帧率] ${fpsVal} fps`,
          `[音频] ${astream?.codec_name || '无'}`,
          `[码率] ${fmt.bit_rate ? (Number(fmt.bit_rate) / 1000).toFixed(0) + ' kbps' : '未知'}`,
        ].join('\n');
      } catch (e) {
        return `[video_info 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_convert', description: '视频格式转换（如 mp4/webm/mov/avi）', parameters: { type: 'object', properties: { input: { type: 'string' }, format: { type: 'string' } }, required: ['input', 'format'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const format = String(args.format ?? '').replace(/^\./, '');
      if (!input || !fs.existsSync(input)) return `[video_convert 失败] 文件不存在: ${args.input}`;
      if (!format) return '[video_convert 失败] 缺少 format';
      try {
        const out = outPath(input, format, 'convert');
        await ff(['-i', input, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', out]);
        return `[转换完成] ${out}`;
      } catch (e) {
        return `[video_convert 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_cut', description: '裁剪视频片段（秒）', parameters: { type: 'object', properties: { input: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['input', 'start', 'end'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const start = Number(args.start ?? 0);
      const end = Number(args.end ?? 0);
      if (!input || !fs.existsSync(input)) return `[video_cut 失败] 文件不存在: ${args.input}`;
      if (end <= start) return '[video_cut 失败] end 必须大于 start';
      try {
        const out = outPath(input, 'mp4', 'cut');
        await ff(['-i', input, '-ss', String(start), '-to', String(end), '-c', 'copy', out]);
        return `[裁剪完成] ${out} (${start}s → ${end}s)`;
      } catch (e) {
        return `[video_cut 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_screenshot', description: '从视频指定时间点截取一帧图片（PNG）', parameters: { type: 'object', properties: { input: { type: 'string' }, time: { type: 'number', description: '时间点（秒）' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const time = Number(args.time ?? 0);
      if (!input || !fs.existsSync(input)) return `[video_screenshot 失败] 文件不存在: ${args.input}`;
      try {
        const out = outPath(input, 'png', 'shot');
        await ff(['-i', input, '-ss', String(time), '-frames:v', '1', out]);
        return `[截图完成] ${out} (@${time}s)`;
      } catch (e) {
        return `[video_screenshot 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_gif', description: '从视频生成 GIF（指定起始秒和时长）', parameters: { type: 'object', properties: { input: { type: 'string' }, start: { type: 'number', description: '起始秒' }, duration: { type: 'number', description: '时长秒' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const start = Number(args.start ?? 0);
      const duration = Number(args.duration ?? 3);
      if (!input || !fs.existsSync(input)) return `[video_gif 失败] 文件不存在: ${args.input}`;
      try {
        const out = outPath(input, 'gif', 'gif');
        await ff(['-i', input, '-ss', String(start), '-t', String(duration), '-vf', 'fps=12,scale=480:-1', out]);
        return `[GIF 完成] ${out} (${start}s 起 ${duration}s)` + (fs.statSync(out).size > 8 * 1024 * 1024 ? '\n[注意] 文件较大，可用更短时长或更低 fps 减小体积' : '');
      } catch (e) {
        return `[video_gif 失败] ${(e as Error).message}`;
      }
    },
  },
];
