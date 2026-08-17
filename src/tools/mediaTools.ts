/**
 * src/tools/mediaTools.ts — 音频/视频Agent 工具（ffmpeg 封装）
 *
 * ffmpeg 不可用时返回清晰提示，不崩溃。输出文件写入 output 目录。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const exec = promisify(execFile);

// ── ffmpeg 二进制探测（不在 PATH 时回退 ~/.local/bin）──
let FFMPEG_BIN = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';
let ffmpegReady: boolean | null = null;
async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegReady !== null) return ffmpegReady;
  const candidates = ['ffmpeg', path.join(os.homedir(), '.local', 'bin', 'ffmpeg')];
  for (const c of candidates) {
    try {
      await exec(c, ['-version'], { timeout: 5000 });
      FFMPEG_BIN = c;
      FFPROBE_BIN = c.replace(/ffmpeg$/, 'ffprobe');
      ffmpegReady = true;
      return true;
    } catch { /* try next */ }
  }
  ffmpegReady = false;
  return false;
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
  const { stdout, stderr } = await exec(FFMPEG_BIN, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { timeout: timeoutMs });
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
        const { stdout } = await exec(FFPROBE_BIN,  ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], { timeout: 30000 });
        const info = JSON.parse(stdout);
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
  {
    schema: { type: 'function', function: { name: 'audio_extract', description: '从视频文件中提取音频轨道', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入视频文件' }, format: { type: 'string', description: '输出格式 mp3/wav/aac，默认 mp3' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const format = String(args.format ?? 'mp3').replace(/^\./, '');
      if (!input || !fs.existsSync(input)) return `[audio_extract 失败] 文件不存在: ${args.input}`;
      try {
        const out = outPath(input, format, 'audio');
        await ff(['-i', input, '-vn', '-c:a', format === 'wav' ? 'pcm_s16le' : format === 'aac' ? 'aac' : 'libmp3lame', out]);
        return `[提取完成] ${out}`;
      } catch (e) {
        const msg = (e as Error).message;
        return msg.includes('does not contain any stream') ? '[audio_extract 失败] 源视频没有音频轨道' : `[audio_extract 失败] ${msg}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_speed', description: '调整音频播放速度（变速不变调）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, rate: { type: 'number', description: '倍率 0.5-2.0，默认 1.5' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const rate = Number(args.rate ?? 1.5);
      if (!input || !fs.existsSync(input)) return `[audio_speed 失败] 文件不存在: ${args.input}`;
      if (rate <= 0 || rate > 2) return '[audio_speed 失败] rate 需在 (0, 2] 区间';
      try {
        const out = outPath(input, path.extname(input).slice(1) || 'mp3', 'speed');
        await ff(['-i', input, '-filter:a', `atempo=${rate}`, '-c:a', 'libmp3lame', out]);
        return `[变速完成] ${out} (${rate}x)`;
      } catch (e) {
        return `[audio_speed 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_normalize', description: '音频响度归一化（EBU R128）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, loudness: { type: 'number', description: '目标响度 LUFS，默认 -16' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const loudness = Number(args.loudness ?? -16);
      if (!input || !fs.existsSync(input)) return `[audio_normalize 失败] 文件不存在: ${args.input}`;
      try {
        const out = outPath(input, path.extname(input).slice(1) || 'mp3', 'norm');
        await ff(['-i', input, '-filter:a', `loudnorm=I=${loudness}:TP=-1.5:LRA=11`, '-c:a', 'libmp3lame', out]);
        return `[归一化完成] ${out} (目标 ${loudness} LUFS)`;
      } catch (e) {
        return `[audio_normalize 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'audio_fade', description: '音频淡入淡出（秒）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, fade_in: { type: 'number', description: '淡入秒数，默认 2' }, fade_out: { type: 'number', description: '淡出秒数，默认 2' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const fadeIn = Number(args.fade_in ?? 2);
      const fadeOut = Number(args.fade_out ?? 2);
      if (!input || !fs.existsSync(input)) return `[audio_fade 失败] 文件不存在: ${args.input}`;
      try {
        const { stdout } = await exec(FFPROBE_BIN,  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { timeout: 15000 });
        const dur = Number(stdout.trim() || 0);
        const out = outPath(input, path.extname(input).slice(1) || 'mp3', 'fade');
        const filter = [`afade=t=in:st=0:d=${fadeIn}`];
        if (dur > fadeIn + fadeOut) filter.push(`afade=t=out:st=${Math.max(dur - fadeOut, 0)}:d=${fadeOut}`);
        await ff(['-i', input, '-filter:a', filter.join(','), '-c:a', 'libmp3lame', out]);
        return `[淡入淡出完成] ${out} (入 ${fadeIn}s / 出 ${fadeOut}s)`;
      } catch (e) {
        return `[audio_fade 失败] ${(e as Error).message}`;
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
        const { stdout } = await exec(FFPROBE_BIN,  ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], { timeout: 30000 });
        const info = JSON.parse(stdout);
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
  {
    schema: { type: 'function', function: { name: 'video_merge', description: '拼接多个视频（同参数，顺序连接）', parameters: { type: 'object', properties: { inputs: { type: 'array', items: { type: 'string' }, description: '输入视频列表' } }, required: ['inputs'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const inputs = (args.inputs as unknown[]) ?? [];
      if (!inputs.length) return '[video_merge 失败] 缺少 inputs';
      const files = inputs.map((i) => resolveIn(String(i)));
      for (const f of files) {
        if (!f || !fs.existsSync(f)) return `[video_merge 失败] 文件不存在: ${f}`;
      }
      try {
        const listFile = path.join(OUTPUT_DIR, `.vmerge_${Date.now()}.txt`);
        fs.writeFileSync(listFile, files.map((f) => `file '${f?.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
        const out = path.join(OUTPUT_DIR, `vmerged_${Date.now() % 10000}.mp4`);
        await ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], 300000);
        fs.unlinkSync(listFile);
        return `[拼接完成] ${out}`;
      } catch (e) {
        return `[video_merge 失败] ${(e as Error).message}（若编码参数不一致，请先统一转码再拼接）`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_compress', description: '压缩视频（降低码率/分辨率，减小体积）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, crf: { type: 'number', description: '画质 18-35，越大越省空间，默认 28' }, max_width: { type: 'number', description: '最大宽度（可选，等比缩放）' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const crf = Number(args.crf ?? 28);
      const maxWidth = args.max_width ? Number(args.max_width) : 0;
      if (!input || !fs.existsSync(input)) return `[video_compress 失败] 文件不存在: ${args.input}`;
      try {
        const out = outPath(input, 'mp4', 'comp');
        const scaleFilter = maxWidth > 0 ? `scale='min(${maxWidth},iw)':-2` : '';
        const vf = scaleFilter ? ['-vf', scaleFilter] : [];
        await ff(['-i', input, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), ...vf, '-c:a', 'aac', '-b:a', '128k', out], 600000);
        const orig = fs.statSync(input).size;
        const comp = fs.statSync(out).size;
        return `[压缩完成] ${out} (${(comp / 1024 / 1024).toFixed(1)}MB，节省 ${(100 - (comp / orig) * 100).toFixed(0)}%)`;
      } catch (e) {
        return `[video_compress 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_resize', description: '视频分辨率缩放（保持宽高比）', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, width: { type: 'number', description: '目标宽度（高度自动等比）' } }, required: ['input', 'width'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const width = Number(args.width ?? 0);
      if (!input || !fs.existsSync(input)) return `[video_resize 失败] 文件不存在: ${args.input}`;
      if (width <= 0) return '[video_resize 失败] width 必须大于 0';
      try {
        const out = outPath(input, 'mp4', 'resize');
        await ff(['-i', input, '-vf', `scale=${width}:-2`, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', out], 600000);
        return `[缩放完成] ${out} (宽 ${width}px)`;
      } catch (e) {
        return `[video_resize 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_fps', description: '调整视频帧率', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, fps: { type: 'number', description: '目标帧率，默认 30' } }, required: ['input'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const fps = Number(args.fps ?? 30);
      if (!input || !fs.existsSync(input)) return `[video_fps 失败] 文件不存在: ${args.input}`;
      if (fps <= 0) return '[video_fps 失败] fps 必须大于 0';
      try {
        const out = outPath(input, 'mp4', 'fps');
        await ff(['-i', input, '-vf', `fps=${fps}`, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', out], 600000);
        return `[帧率调整完成] ${out} (${fps} fps)`;
      } catch (e) {
        return `[video_fps 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'video_watermark', description: '给视频添加文字水印', parameters: { type: 'object', properties: { input: { type: 'string', description: '输入文件' }, text: { type: 'string', description: '水印文字' }, position: { type: 'string', description: '位置 top-left/top-right/bottom-left/bottom-right，默认 bottom-right' } }, required: ['input', 'text'] } } },
    handler: async (args: Record<string, unknown>) => {
      if (!(await hasFfmpeg())) return NOT_READY;
      const input = resolveIn(String(args.input ?? ''));
      const text = String(args.text ?? '');
      const position = String(args.position ?? 'bottom-right');
      if (!input || !fs.existsSync(input)) return `[video_watermark 失败] 文件不存在: ${args.input}`;
      if (!text) return '[video_watermark 失败] 缺少 text';
      try {
        const out = outPath(input, 'mp4', 'wm');
        // 当前 ffmpeg 构建无 drawtext 滤镜（未编译 freetype），
        // 改用 PIL 生成文字 PNG + overlay 实现水印。
        const png = outPath(input, 'png', 'wm_txt');
        const fontFile = ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f)) ?? '';
        const pyCode = [
          'from PIL import Image, ImageDraw, ImageFont',
          `text = ${JSON.stringify(text)}`,
          `font = ImageFont.truetype(${JSON.stringify(fontFile)}, 36) if ${JSON.stringify(fontFile)} else ImageFont.load_default()`,
          'tmp = Image.new("RGBA", (10, 10)); d = ImageDraw.Draw(tmp)',
          'bbox = d.textbbox((0, 0), text, font=font)',
          'w, h = bbox[2] - bbox[0] + 24, bbox[3] - bbox[1] + 24',
          'img = Image.new("RGBA", (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(img)',
          `d.text((13 - bbox[0] + 2, 13 - bbox[1] + 2), text, font=font, fill=(0, 0, 0, 128))`,
          `d.text((13 - bbox[0], 13 - bbox[1]), text, font=font, fill=(255, 255, 255, 153))`,
          `img.save(${JSON.stringify(png)})`,
          'print("OK")',
        ].join('\n');
        await exec('python3', ['-c', pyCode], { timeout: 30000 });
        const posExp: Record<string, string> = {
          'top-left': '10:10',
          'top-right': 'W-w-10:10',
          'bottom-left': '10:H-h-10',
          'bottom-right': 'W-w-10:H-h-10',
        };
        await ff(['-i', input, '-i', png, '-filter_complex', `overlay=${posExp[position] ?? 'W-w-10:H-h-10'}`, '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'copy', out], 600000);
        return `[水印完成] ${out} (${position})`;
      } catch (e) {
        return `[video_watermark 失败] ${(e as Error).message}（中文水印需系统装有中文字体）`;
      }
    },
  },
];
