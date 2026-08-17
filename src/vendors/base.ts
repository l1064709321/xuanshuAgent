/**
 * src/vendors/base.ts — 厂商调度器基类与公共工具
 *
 * 各厂商的上下文窗口、token 折算、缓存策略差异极大，各自独立成文件维护，
 * 统一继承 BaseVendor。基类负责：
 * - ContextPolicy 统一数据结构
 * - 窗口标注解析（description 里的 '1M'/'203K'/'20万' 等）
 * - token 估算（中文按厂商折算系数，英文 4 字符 1 token）
 * - 派生参数（最近窗口 / 压缩阈值 / 压缩保留预算，按窗口比例）
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface ContextPolicy {
  vendor: string;              // 归一化厂商名
  context_window: number;      // 上下文窗口 token 上限
  max_output: number;          // 单次最大输出 token
  cjk_chars_per_token: number; // 中文折算系数（N 个中文字符 ≈ 1 token）
  cache_mode: string;          // anthropic | deepseek | openai | none
  recent_tokens: number;       // 最近对话窗口预算（token）
  compact_threshold: number;   // 压缩触发阈值（token）
  keep_budget: number;         // 压缩后保留预算（token）
}

// 派生参数比例：以窗口为基准（业界基准：Codex ~95% 触发，Claude 保留近 8~10 轮）
const RECENT_RATIO = 0.02;     // 最近窗口 ≈ 窗口 2%
const COMPACT_RATIO = 0.25;    // 压缩触发 ≈ 窗口 25%（留足输出空间）
const KEEP_RATIO = 0.12;       // 压缩保留 ≈ 窗口 12%

const WINDOW_RE = /(\d+(?:\.\d+)?)\s*(万|[KkMm])\b/;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function extractWindow(description: string, def: number): number {
  /** 从 description 解析窗口标注（如 '1M上下文' / '203K上下文' / '20万上下文'）。 */
  if (!description) return def;
  let best = 0;
  for (const m of description.matchAll(WINDOW_RE)) {
    const num = parseFloat(m[1]);
    const unit = m[2];
    let tokens = 0;
    if (unit === '万') tokens = Math.trunc(num * 10_000);
    else if (unit === 'K' || unit === 'k') tokens = Math.trunc(num * 1_000);
    else if (unit === 'M' || unit === 'm') tokens = Math.trunc(num * 1_000_000);
    else continue;
    best = Math.max(best, tokens);
  }
  return best || def;
}

export function estimateTokens(text: string, cjkCharsPerToken = 1.0): number {
  /** token 估算：中文按厂商折算系数，英文按 4 字符 1 token。 */
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff') cjk++;
  }
  const other = text.length - cjk;
  return Math.trunc(cjk / cjkCharsPerToken) + Math.trunc(other / 4) + 1;
}

export class BaseVendor {
  /** 厂商调度器基类。子类覆盖以下类属性即可完成一个厂商的调度配置。 */
  vendor = 'default';
  context_window = 32_000;
  max_output = 8_000;
  cjk_chars_per_token = 1.0;
  cache_mode = 'none';

  /** 按 description 里的窗口标注解析出最终调度策略。 */
  resolve(description = ''): ContextPolicy {
    const w = extractWindow(description, this.context_window);
    return {
      vendor: this.vendor,
      context_window: w,
      max_output: this.max_output,
      cjk_chars_per_token: this.cjk_chars_per_token,
      cache_mode: this.cache_mode,
      recent_tokens: clamp(Math.trunc(w * RECENT_RATIO), 1200, 6000),
      compact_threshold: Math.trunc(w * COMPACT_RATIO),
      keep_budget: Math.trunc(w * KEEP_RATIO),
    };
  }

  /** 厂商专属缓存标记。默认深拷贝原样返回（无前缀缓存的厂商）。 */
  cache(messages: ChatMessage[]): ChatMessage[] {
    return structuredClone(messages);
  }
}
