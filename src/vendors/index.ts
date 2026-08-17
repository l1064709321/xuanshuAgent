/**
 * src/vendors/index.ts — 厂商调度器注册表
 *
 * 每个厂商一个文件、一套独立调度，按 provider / model_key 归一化后路由。
 * 新增厂商：建一个 vendors/xxx.ts，定义 XxxVendor(BaseVendor)，
 * 在此处 VENDOR_REGISTRY 注册即可被调度器识别。
 */
import { BaseVendor, type ChatMessage, type ContextPolicy } from './base.js';
import { AnthropicVendor } from './anthropic.js';
import { OpenAIVendor } from './openai.js';
import { GoogleVendor } from './google.js';
import { DeepSeekVendor } from './deepseek.js';
import { QwenVendor } from './qwen.js';
import { GlmVendor } from './glm.js';
import { KimiVendor } from './kimi.js';
import { MiniMaxVendor } from './minimax.js';
import { NvidiaVendor } from './nvidia.js';
import { AggregatorVendor } from './aggregator.js';

// 归一化厂商名 → Vendor 类
export const VENDOR_REGISTRY: Record<string, typeof BaseVendor> = {
  anthropic: AnthropicVendor,
  openai: OpenAIVendor,
  google: GoogleVendor,
  deepseek: DeepSeekVendor,
  qwen: QwenVendor,
  glm: GlmVendor,
  kimi: KimiVendor,
  minimax: MiniMaxVendor,
  nvidia: NvidiaVendor,
  aggregator: AggregatorVendor,
};

/** 厂商归一化：provider（ModelPreset.provider）优先，model_key 兜底。 */
export function normalizeVendor(provider: string, modelKey: string): string {
  const p = (provider || '').toLowerCase();
  const k = (modelKey || '').toLowerCase();
  if (p.includes('anthropic') || k.includes('claude')) return 'anthropic';
  if (p.includes('openai') || k.includes('gpt')) return 'openai';
  if (p.includes('google') || k.includes('gemini')) return 'google';
  if (p.includes('deepseek') || k.includes('deepseek')) return 'deepseek';
  if ((provider || '').includes('通义') || p.includes('dashscope') || k.includes('qwen')) return 'qwen';
  if ((provider || '').includes('智谱') || p.includes('bigmodel') || k.includes('glm')) return 'glm';
  if (p.includes('moonshot') || (provider || '').includes('月之暗面') || k.includes('kimi')) return 'kimi';
  if (p.includes('minimax') || k.includes('minimax')) return 'minimax';
  if (p.includes('nvidia') || k.includes('nemotron')) return 'nvidia';
  if ((provider || '').includes('聚合') || p.includes('siliconflow') || p.includes('openrouter') || p.includes('together')) return 'aggregator';
  return 'default';
}

/** 按厂商归一化路由到对应 Vendor 类，解析出上下文调度策略。 */
export function resolvePolicy(modelKey = '', provider = '', description = ''): ContextPolicy {
  const vendor = normalizeVendor(provider, modelKey);
  const cls = VENDOR_REGISTRY[vendor] ?? BaseVendor;
  return new cls().resolve(description);
}

/** 按厂商调度注入缓存标记（调用对应 vendor 的 cache() 方法）。 */
export function injectCacheHints(messages: ChatMessage[], provider = '', modelKey = ''): ChatMessage[] {
  const vendor = normalizeVendor(provider, modelKey);
  const cls = VENDOR_REGISTRY[vendor] ?? BaseVendor;
  return new cls().cache(messages);
}

export { BaseVendor, extractWindow, estimateTokens } from './base.js';
export type { ContextPolicy, ChatMessage } from './base.js';
