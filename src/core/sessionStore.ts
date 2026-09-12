/**
 * 会话持久化 — 服务端结构化消息链 JSONL 落盘
 *
 * 对应 Claude Code 架构中的「消息链是运行时第一公民 / transcript 磁盘化」：
 *  - 主对话不再依赖前端从 DOM 回传历史，改由服务端按 session_id 恢复结构化链；
 *  - 每条消息保留 role / content / tool_calls / tool_call_id，含工具轮次；
 *  - system 消息不落盘（每次请求重新注入，保证日期行/系统提示最新）。
 *
 * Phase 1 实现为同步读写（消息规模小，低并发场景足够）；
 * Phase 4 将在其上叠加自动压缩/记忆抽取。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SESSIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.data',
  'sessions',
);

try {
  mkdirSync(SESSIONS_DIR, { recursive: true });
} catch {
  // 目录创建失败不致命，后续 save 会再报
}

export type StoredMessage = {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  ts?: number;
};

function safeId(sessionId: string): string {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : '';
}

export function createSessionId(): string {
  return (
    'sess_' +
    Date.now().toString(36) +
    '_' +
    Math.random().toString(36).slice(2, 10)
  );
}

export function loadSession(sessionId: string): StoredMessage[] | null {
  const safe = safeId(sessionId);
  if (!safe) return null;
  const p = join(SESSIONS_DIR, safe + '.jsonl');
  if (!existsSync(p)) return null;
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    const out: StoredMessage[] = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line) as StoredMessage;
        if (m && typeof m.role === 'string') out.push(m);
      } catch {
        // 跳过损坏行
      }
    }
    return out;
  } catch {
    return null;
  }
}

export function saveSession(sessionId: string, messages: StoredMessage[]): void {
  const safe = safeId(sessionId);
  if (!safe) return;
  const p = join(SESSIONS_DIR, safe + '.jsonl');
  const body =
    messages
      .map((m) =>
        JSON.stringify({
          role: m.role,
          ...(m.content !== undefined && { content: m.content }),
          ...(m.tool_calls !== undefined && { tool_calls: m.tool_calls }),
          ...(m.tool_call_id !== undefined && { tool_call_id: m.tool_call_id }),
          ts: m.ts ?? Date.now(),
        }),
      )
      .join('\n') + '\n';
  writeFileSync(p, body, 'utf8');
}
