/**
 * src/tools/adbTools.ts — 手机Agent 工具（ADB 封装）
 *
 * 通过 adb 命令操控 Android 设备/模拟器。adb 未安装或未连接设备时返回清晰提示。
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

let adbReady: boolean | null = null;
async function adbState(): Promise<{ ok: boolean; msg: string }> {
  if (adbReady === false) return { ok: false, msg: '[adb 未安装] 当前环境缺少 adb，无法操控手机。请先安装 android-tools。' };
  try {
    if (adbReady === null) {
      await exec('adb', ['version'], { timeout: 5000 });
      adbReady = true;
    }
    const { stdout } = await exec('adb', ['devices'], { timeout: 5000 });
    const lines = stdout.trim().split('\n').slice(1);
    const devices = lines.filter((l) => l.includes('\tdevice'));
    if (!devices.length) return { ok: false, msg: '[adb 未连接] 未检测到在线设备（adb devices 为空）。请连接设备/模拟器并授权 USB 调试。' };
    return { ok: true, msg: devices.map((l) => l.split('\t')[0]).join(',') };
  } catch (e) {
    adbReady = false;
    return { ok: false, msg: '[adb 不可用] ' + ((e as Error).message || 'adb 调用失败') };
  }
}

async function adb(args: string[], timeoutMs = 30000): Promise<string> {
  const { stdout, stderr } = await exec('adb', ['-e', ...args], { timeout: timeoutMs });
  return (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(无输出)';
}

const SHOT_DIR = path.join(PROJECT_ROOT, 'output', 'screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

export const adbTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'adb_screenshot', description: '截取设备屏幕并保存 PNG（返回文件路径）', parameters: { type: 'object', properties: {} } } },
    handler: async () => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      try {
        const out = path.join(SHOT_DIR, `screen_${Date.now()}.png`);
        await adb(['exec-out', 'screencap', '-p'], 30000).then(async (raw) => {
          // exec-out 走二进制，改用直接输出
          await exec('adb', ['-e', 'exec-out', 'screencap', '-p'], { timeout: 30000 }).then(async (r) => {
            await fs.promises.writeFile(out, r.stdout);
          });
        }).catch(() => undefined);
        if (!fs.existsSync(out) || fs.statSync(out).size < 1000) {
          // 兜底：先写入设备再 pull
          await adb(['shell', 'screencap', '-p', '/sdcard/_shot.png']);
          await exec('adb', ['-e', 'pull', '/sdcard/_shot.png', out], { timeout: 30000 });
          await adb(['shell', 'rm', '/sdcard/_shot.png']);
        }
        return `[截图完成] ${out}`;
      } catch (e) {
        return `[adb_screenshot 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'adb_tap', description: '点击屏幕坐标（px）', parameters: { type: 'object', properties: { x: { type: 'integer', description: 'x 坐标' }, y: { type: 'integer', description: 'y 坐标' } }, required: ['x', 'y'] } } },
    handler: async (args: Record<string, unknown>) => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      const x = Number(args.x ?? 0), y = Number(args.y ?? 0);
      if (!x && !y) return '[adb_tap 失败] 缺少坐标';
      try {
        await adb(['shell', 'input', 'tap', String(x), String(y)]);
        return `[已点击] (${x}, ${y})`;
      } catch (e) {
        return `[adb_tap 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'adb_swipe', description: '滑动屏幕（起点到终点，ms 为时长）', parameters: { type: 'object', properties: { x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' }, ms: { type: 'integer', description: '滑动时长毫秒，默认300' } }, required: ['x1', 'y1', 'x2', 'y2'] } } },
    handler: async (args: Record<string, unknown>) => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      const { x1, y1, x2, y2 } = args as Record<string, number>;
      const ms = Number(args.ms ?? 300) || 300;
      try {
        await adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);
        return `[已滑动] (${x1},${y1}) → (${x2},${y2}) ${ms}ms`;
      } catch (e) {
        return `[adb_swipe 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'adb_input', description: '向设备输入文本', parameters: { type: 'object', properties: { text: { type: 'string', description: '文本' } }, required: ['text'] } } },
    handler: async (args: Record<string, unknown>) => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      const text = String(args.text ?? '');
      if (!text) return '[adb_input 失败] 缺少 text';
      try {
        await adb(['shell', 'input', 'text', text.replace(/ /g, '%s')]);
        return `[已输入] ${text.slice(0, 100)}`;
      } catch (e) {
        return `[adb_input 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'adb_install', description: '安装 APK 到设备（覆盖安装需加 -r）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'APK 文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      const apk = String(args.path ?? '');
      const abs = path.isAbsolute(apk) ? apk : path.resolve(PROJECT_ROOT, apk);
      if (!fs.existsSync(abs)) return `[adb_install 失败] APK 不存在: ${apk}`;
      try {
        await exec('adb', ['-e', 'install', '-r', abs], { timeout: 180000 });
        return `[安装完成] ${apk}`;
      } catch (e) {
        return `[adb_install 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'adb_launch', description: '启动 APP（包名）', parameters: { type: 'object', properties: { package: { type: 'string', description: '应用包名' } }, required: ['package'] } } },
    handler: async (args: Record<string, unknown>) => {
      const st = await adbState();
      if (!st.ok) return st.msg;
      const pkg = String(args.package ?? '');
      if (!pkg) return '[adb_launch 失败] 缺少 package';
      try {
        const { stdout } = await exec('adb', ['-e', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', pkg], { timeout: 10000 });
        const activity = stdout.trim().split('\n').filter((l) => l.includes('/')).pop();
        if (!activity) return `[adb_launch 失败] 未找到 ${pkg} 的主 Activity`;
        await adb(['shell', 'am', 'start', '-n', activity]);
        return `[已启动] ${pkg} (${activity})`;
      } catch (e) {
        return `[adb_launch 失败] ${(e as Error).message}`;
      }
    },
  },
];
