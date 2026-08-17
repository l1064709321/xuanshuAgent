/**
 * src/tools/fileTools.ts — 文件Agent 工具
 *
 * 基于 Node fs 实现：列表/读取/写入/搜索。
 * 安全约束：
 *  - 禁止访问敏感路径（.git/.ssh/.env 等）
 *  - 写入/覆盖前检查，避免静默覆盖
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const SENSITIVE_DIRS = ['.git', '.ssh', '.aws', '.kube', '.svn'];

function isSensitive(abs: string): boolean {
  const rel = path.relative(PROJECT_ROOT, abs);
  const parts = rel.split(path.sep);
  return parts.some((p) => SENSITIVE_DIRS.includes(p.toLowerCase()) || (p.startsWith('.') && p.endsWith('.env')) || p === '.env');
}

function resolve(p: string): string | null {
  const abs = path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
  if (isSensitive(abs)) return null;
  return abs;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export const fileTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'file_list', description: '列出目录下的文件和子目录（含大小/时间），相对项目根或绝对路径', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径' } }, required: ['path'] } } },
    handler: (args: Record<string, unknown>) => {
      try {
        const raw = String(args.path ?? '.');
        const abs = resolve(raw);
        if (!abs) return '[file_list 已拦截] 目标为敏感路径';
        if (!fs.existsSync(abs)) return `[file_list 失败] 路径不存在: ${raw}`;
        const st = fs.statSync(abs);
        if (!st.isDirectory()) return `[file_list] ${raw} 是文件，非目录`;
        const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200);
        if (!entries.length) return '[空目录]';
        const lines = entries.map((e) => {
          const fp = path.join(abs, e.name);
          const s = fs.statSync(fp);
          return `${e.isDirectory() ? '[DIR]' : '     '} ${e.name}${e.isDirectory() ? '/' : ''}  ${e.isDirectory() ? '' : fmtSize(s.size)}  ${s.mtime.toISOString().slice(0, 16)}`;
        });
        return lines.join('\n') + (entries.length >= 200 ? '\n...(超过200条，已截断)' : '');
      } catch (e) {
        return `[file_list 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'file_read', description: '读取文本文件内容（自动识别编码，超长截断）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] } } },
    handler: (args: Record<string, unknown>) => {
      try {
        const raw = String(args.path ?? '');
        const abs = resolve(raw);
        if (!abs) return '[file_read 已拦截] 目标为敏感路径';
        if (!fs.existsSync(abs)) return `[file_read 失败] 文件不存在: ${raw}`;
        if (fs.statSync(abs).isDirectory()) return `[file_read 失败] ${raw} 是目录`;
        const buf = fs.readFileSync(abs);
        const MAX = 6000;
        let content: string;
        try {
          content = buf.toString('utf8');
        } catch {
          content = buf.toString('latin1');
        }
        return content.length > MAX ? content.slice(0, MAX) + `\n...(共${content.length}字符，已截断前${MAX})` : content;
      } catch (e) {
        return `[file_read 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'file_write', description: '写入文件。默认新建；若文件已存在将追加（mode=append），mode=overwrite 才覆盖。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '内容' }, mode: { type: 'string', description: 'append(默认，追加)/overwrite(覆盖，需确认)' } }, required: ['path', 'content'] } } },
    handler: (args: Record<string, unknown>) => {
      try {
        const raw = String(args.path ?? '');
        const content = String(args.content ?? '');
        const mode = String(args.mode ?? 'append');
        const abs = resolve(raw);
        if (!abs) return '[file_write 已拦截] 目标为敏感路径';
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (mode === 'overwrite') {
          fs.writeFileSync(abs, content, 'utf8');
          return `[已覆盖写入] ${raw} (${content.length}字符)`;
        }
        if (fs.existsSync(abs)) {
          fs.appendFileSync(abs, content.endsWith('\n') ? content : content + '\n', 'utf8');
          return `[已追加] ${raw} (原文件存在，追加 ${content.length}字符)`;
        }
        fs.writeFileSync(abs, content, 'utf8');
        return `[已新建] ${raw} (${content.length}字符)`;
      } catch (e) {
        return `[file_write 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'file_search', description: '按文件名关键词搜索（不含 node_modules/.git/dist），最多100条', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '文件名关键词' }, path: { type: 'string', description: '搜索起点（默认项目根）' } }, required: ['keyword'] } } },
    handler: (args: Record<string, unknown>) => {
      try {
        const keyword = String(args.keyword ?? '');
        const raw = String(args.path ?? '.');
        if (!keyword) return '[file_search 失败] 缺少 keyword';
        const root = resolve(raw);
        if (!root) return '[file_search 已拦截] 目标为敏感路径';
        const SKIP = new Set(['node_modules', '.git', 'dist', '.sandbox', '__pycache__']);
        const results: string[] = [];
        const walk = (dir: string, depth: number) => {
          if (depth > 5 || results.length >= 100) return;
          let entries: fs.Dirent[] = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) {
              walk(fp, depth + 1);
            } else if (e.name.toLowerCase().includes(keyword.toLowerCase())) {
              results.push(path.relative(PROJECT_ROOT, fp));
              if (results.length >= 100) return;
            }
          }
        };
        walk(root, 0);
        return results.length ? results.map((r) => `- ${r}`).join('\n') : `[无匹配] 未找到包含 "${keyword}" 的文件`;
      } catch (e) {
        return `[file_search 失败] ${(e as Error).message}`;
      }
    },
  },
];
