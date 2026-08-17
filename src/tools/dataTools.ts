/**
 * src/tools/dataTools.ts — 数据 Agent 工具（5 工具）
 *
 * CSV/JSON/SQLite 解析逻辑复用原版 data_tools.py（Python 标准库 + csv/sqlite3），
 * 通过 runLocal 调用，避免在 TS 侧重复实现易出错的解析边界。
 */
import { runTool } from '../core/sandbox.js';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };

async function callPy(fn: string, args: Record<string, unknown>, timeout = 60): Promise<string> {
  const code = [
    `import sys, json`,
    `sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})`,
    `import data_tools`,
    `print(data_tools.${fn}(${JSON.stringify(args)}))`,
  ].join('\n');
  const res = await runTool(code, timeout);
  if (res.exit_code !== 0) {
    return `[${fn} 失败] ${res.stderr.trim() || res.error || '未知错误'}`;
  }
  return res.stdout.trim() || `(${fn} 完成，无输出)`;
}

export const dataTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'csv_read', description: '读取 CSV 文件（自动识别分隔符，输出表头与数据行）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'CSV 文件路径' }, limit: { type: 'number', description: '最多读取行数，默认 20' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('csv_read', args, 60),
  },
  {
    schema: { type: 'function', function: { name: 'csv_stats', description: 'CSV 统计（行列数、各列类型与缺失值）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'CSV 文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('csv_stats', args, 60),
  },
  {
    schema: { type: 'function', function: { name: 'json_read', description: '读取 JSON 文件（格式化输出，支持深层路径查询）', parameters: { type: 'object', properties: { path: { type: 'string', description: 'JSON 文件路径' }, key: { type: 'string', description: '点路径，如 a.b[0].c（缺省输出全部）' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('json_read', args, 60),
  },
  {
    schema: { type: 'function', function: { name: 'sqlite_query', description: '对 SQLite 数据库执行只读 SQL 查询', parameters: { type: 'object', properties: { path: { type: 'string', description: '数据库文件路径' }, sql: { type: 'string', description: '只读 SQL（SELECT/PRAGMA）' }, limit: { type: 'number', description: '最多返回行数，默认 50' } }, required: ['path', 'sql'] } } },
    handler: async (args: Record<string, unknown>) => callPy('sqlite_query', args, 60),
  },
  {
    schema: { type: 'function', function: { name: 'sqlite_tables', description: '列出 SQLite 数据库所有表及行数', parameters: { type: 'object', properties: { path: { type: 'string', description: '数据库文件路径' } }, required: ['path'] } } },
    handler: async (args: Record<string, unknown>) => callPy('sqlite_tables', args, 60),
  },
];
