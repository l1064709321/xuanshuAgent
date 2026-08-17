/**
 * src/tools/memTools.ts — Agent 自主记忆工具（.memdir）
 *
 * 对齐 Python core.py 的记忆机制：每个 Agent 在 .memdir 下有专属记忆文件，
 * 支持 list/read/write/search/snapshot。记忆写入走追加模式，不覆盖历史。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: { agent: string }) => string | Promise<string> };


const MEMDIR = path.join(PROJECT_ROOT, '.memdir');

/** Agent 记忆文件名映射：Agent 名 → 记忆文件（对齐 Python agent_memdir 命名） */
export function memFileName(agent: string): string {
  const names: Record<string, string> = {
    '电脑Agent': '电脑.md',
    '手机Agent': '手机.md',
    '搜索Agent': '搜索.md',
    '浏览器Agent': '浏览器.md',
    '代码Agent': '代码.md',
    '文件Agent': '文件.md',
    '音频Agent': '音频.md',
    '视频Agent': '视频.md',
  };
  return names[agent] ?? `${agent}.md`;
}

function safeResolve(rel: string, agent: string): string | null {
  if (rel && (rel.includes('..') || rel.startsWith('/') || rel.includes(':'))) return null;
  const file = rel.includes('.') && !rel.endsWith('.md') ? rel : memFileName(agent);
  return path.join(MEMDIR, file);
}

export const memTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'memdir_list', description: '列出记忆文件夹中所有文件（含大小与修改时间）', parameters: { type: 'object', properties: {} } } },
    handler: (args: Record<string, unknown>) => {
      try {
        if (!fs.existsSync(MEMDIR)) return '[记忆文件夹为空]';
        const files = fs.readdirSync(MEMDIR).filter((f) => !f.startsWith('.'));
        if (!files.length) return '[记忆文件夹为空]';
        return files.map((f) => {
          const st = fs.statSync(path.join(MEMDIR, f));
          return `- ${f} (${st.size}B, ${st.mtime.toISOString().slice(0, 16)})`;
        }).join('\n');
      } catch (e) {
        return `[memdir_list 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'memdir_read', description: '读取记忆文件夹中的文件（默认读取自己的记忆文件）', parameters: { type: 'object', properties: { rel: { type: 'string', description: '文件相对路径，如 代码.md（可选，默认自己）' } } } } },
    handler: (args: Record<string, unknown>, ctx) => {
      try {
        const rel = String(args.rel ?? '');
        const fp = safeResolve(rel, ctx?.agent ?? "未知Agent");
        if (!fp) return '[memdir_read 失败] 非法路径';
        if (!fs.existsSync(fp)) return '[记忆文件不存在]';
        const content = fs.readFileSync(fp, 'utf8');
        return content.slice(0, 6000) + (content.length > 6000 ? '\n...(截断)' : '');
      } catch (e) {
        return `[memdir_read 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'memdir_write', description: '写入内容到记忆文件夹（追加模式，自动附加时间戳，不覆盖历史）', parameters: { type: 'object', properties: { rel: { type: 'string', description: '文件相对路径，如 代码.md（可选，默认自己）' }, content: { type: 'string', description: '要追加的内容' } }, required: ['content'] } } },
    handler: (args: Record<string, unknown>, ctx) => {
      try {
        const rel = String(args.rel ?? '');
        const content = String(args.content ?? '');
        const fp = safeResolve(rel, ctx?.agent ?? "未知Agent");
        if (!fp) return '[memdir_write 失败] 非法路径';
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        const ts = new Date().toISOString().slice(0, 16);
        const block = `\n## ${ts}\n${content.trim()}\n`;
        fs.appendFileSync(fp, block, 'utf8');
        return `[已写入记忆] ${path.relative(MEMDIR, fp)} (+${content.length}字符)`;
      } catch (e) {
        return `[memdir_write 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'memdir_search', description: '在记忆文件夹中搜索关键词，返回命中文件与上下文', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词' } }, required: ['keyword'] } } },
    handler: (args: Record<string, unknown>) => {
      try {
        const kw = String(args.keyword ?? '').toLowerCase();
        if (!kw) return '[memdir_search 失败] 缺少关键词';
        if (!fs.existsSync(MEMDIR)) return '[记忆文件夹为空]';
        const files = fs.readdirSync(MEMDIR).filter((f) => !f.startsWith('.'));
        const hits: string[] = [];
        for (const f of files) {
          const content = fs.readFileSync(path.join(MEMDIR, f), 'utf8');
          if (!content.toLowerCase().includes(kw)) continue;
          const lines = content.split('\n');
          const ctxLines: string[] = [];
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(kw)) {
              ctxLines.push(lines.slice(Math.max(0, i - 1), i + 2).join('\n'));
            }
          });
          hits.push(`【${f}】\n${ctxLines.slice(0, 5).join('\n---\n')}`);
        }
        return hits.length ? hits.join('\n\n') : `[无命中] 记忆文件夹中未找到 "${args.keyword}"`;
      } catch (e) {
        return `[memdir_search 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'memdir_snapshot', description: '生成记忆快照：汇总全部记忆文件到一份报告', parameters: { type: 'object', properties: {} } } },
    handler: () => {
      try {
        if (!fs.existsSync(MEMDIR)) return '[记忆文件夹为空]';
        const files = fs.readdirSync(MEMDIR).filter((f) => !f.startsWith('.'));
        if (!files.length) return '[记忆文件夹为空]';
        const parts = files.map((f) => {
          const content = fs.readFileSync(path.join(MEMDIR, f), 'utf8');
          return `## ${f}\n${content.slice(0, 1500)}`;
        });
        return `【记忆快照】共 ${files.length} 个文件\n\n${parts.join('\n\n')}`;
      } catch (e) {
        return `[memdir_snapshot 失败] ${(e as Error).message}`;
      }
    },
  },
];
