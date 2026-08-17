/**
 * src/tools/ttsTools.ts — 语音合成 Agent 工具（2 工具）
 *
 * 迁移决策：Node 侧 msedge-tts 安装失败（npm 缓存损坏），
 * 复用原版 tts_tools.py（edge-tts + ffmpeg 后处理管线）。
 */
import { runTool } from '../core/sandbox.js';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };

async function callPy(fn: string, args: Record<string, unknown>, timeout = 360): Promise<string> {
  const code = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})`,
    `import tts_tools`,
    `print(tts_tools.${fn}(${JSON.stringify(args)}))`,
  ].join('\n');
  const res = await runTool(code, timeout);
  if (res.exit_code !== 0) {
    return `[${fn} 失败] ${res.stderr.trim() || res.error || '未知错误'}`;
  }
  return res.stdout.trim() || `(${fn} 完成，无输出)`;
}

export const ttsTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'tts_speak', description: '文本转语音（玄姝女声，真人感后处理，输出 mp3）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要合成的文本' }, output: { type: 'string', description: '输出路径（缺省写入临时目录）' }, speed: { type: 'number', description: '语速倍率，默认 1.0' } }, required: ['text'] } } },
    handler: async (args: Record<string, unknown>) => callPy('tts_speak', args, 360),
  },
  {
    schema: { type: 'function', function: { name: 'tts_list_voices', description: '列出可用语音角色（edge-tts 音色列表）', parameters: { type: 'object', properties: {} } } },
    handler: async () => callPy('tts_list_voices', {}, 60),
  },
];
