/**
 * 服务端窗口截断 — 控制发送给模型的上下文长度（Phase 1 第 4 步）
 *
 * 原则：
 *  - 磁盘会话链保持全量（审计/回溯用），只对「发送给模型的消息」做窗口截断；
 *  - 以「块」为单位裁剪：一个块 = user 单条 | assistant 单条 | assistant(含 tool_calls)+其配对 tool 消息们；
 *    tool 配对永不拆散，避免 tool_call_id 悬空导致 API 报错或模型上下文错乱；
 *  - 超窗早期纯文本轮次折叠为一条 system「折叠提示」，防止模型凭空编造被丢弃的早期细节；
 *  - LLM 语义摘要（真正的记忆抽取/压缩）留到 Phase 4 SessionMemory 自动阈值抽取时实现。
 */
import type { StoredMessage } from './sessionStore.js';

/** 最多保留的完整块数（约等于最近 20~30 轮用户问答，含工具轮次） */
const MAX_BLOCKS = 24;
/** 单块超长文本兜底截断（防止单条 user 消息本身过长撑爆窗口，如粘贴大文档） */
const MAX_SINGLE_MSG_CHARS = 6000;

export function truncateForApi(messages: StoredMessage[]): StoredMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // system 消息保留在头部（运行时注入的 MAIN_SYSTEM_PROMPT / 日期行）
  const head: StoredMessage[] = [];
  const rest: StoredMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') head.push(m);
    else rest.push(m);
  }
  if (rest.length === 0) return head;

  // 兜底：单条消息超长截断（保留首尾，中段省略）
  const clip = (m: StoredMessage): StoredMessage => {
    if (typeof m.content !== 'string' || m.content.length <= MAX_SINGLE_MSG_CHARS) return m;
    const half = Math.floor(MAX_SINGLE_MSG_CHARS / 2);
    return { ...m, content: m.content.slice(0, half) + '\n...[中段省略]...\n' + m.content.slice(-half) };
  };

  // 1) 切块：从前往后扫，user / assistant 开启新块，tool 追加到当前块
  const blocks: StoredMessage[][] = [];
  for (const m of rest) {
    if (m.role === 'user' || m.role === 'assistant') {
      blocks.push([clip(m)]);
    } else if (blocks.length > 0) {
      // tool / tool_call 结果消息归入前一个 assistant 块
      blocks[blocks.length - 1].push(clip(m));
    } else {
      // 异常前缀 tool（理论上不会出现），直接丢弃
      continue;
    }
  }

  // 2) 未超窗：原样拼回
  if (blocks.length <= MAX_BLOCKS) {
    return [...head, ...blocks.flat()];
  }

  // 3) 超窗：保留最近 MAX_BLOCKS 块，早期块折叠为 system 提示
  const dropped = blocks.slice(0, blocks.length - MAX_BLOCKS).flat();
  const kept = blocks.slice(blocks.length - MAX_BLOCKS).flat();

  const droppedUsers = dropped
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .slice(0, 6)
    .map((m) => {
      const s = (m.content as string).replace(/\s+/g, ' ').trim();
      return s.length > 24 ? s.slice(0, 24) + '…' : s;
    });

  let foldLine: string;
  if (droppedUsers.length > 0) {
    foldLine =
      '【早期对话折叠】为控制上下文长度，更早的对话已被系统折叠。早期话题片段：' +
      droppedUsers.join(' / ') +
      '。若用户引用这些早期细节，请如实告知"更早的内容已被折叠"，并请用户补充或重新说明，严禁凭空编造被折叠的内容。';
  } else {
    foldLine = '【早期对话折叠】更早的对话工具轮次已被系统折叠以控制上下文长度。请基于现有内容回答。';
  }
  head.push({ role: 'system', content: foldLine });

  return [...head, ...kept];
}
