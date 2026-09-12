/**
 * src/core/tokenStats.ts — Token 用量统计（内存态）
 * 供 /api/token-stats 监控面板读取；chat 路由在每次 LLM 调用后写入。
 */

export interface AgentTokenStat {
  calls: number;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
}

interface TimelinePoint {
  ts: number;
  prompt: number;
  cached: number;
  completion: number;
}

const byAgent = new Map<string, AgentTokenStat>();
const timeline: TimelinePoint[] = [];
const MAX_TIMELINE = 200;
// 上游 usage 是否上报过缓存字段：未上报时命中率恒为 0 属于"无数据"，而非"真命中 0%"
let cacheReported = false;

export function recordTokens(
  agent: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  cacheFieldReported = false,
): void {
  if (cacheFieldReported) cacheReported = true;
  const key = agent || "主Agent";
  const cur = byAgent.get(key) ?? { calls: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 };
  cur.calls += 1;
  cur.prompt_tokens += promptTokens;
  cur.cached_tokens += cachedTokens;
  cur.completion_tokens += completionTokens;
  byAgent.set(key, cur);

  timeline.push({ ts: Date.now() / 1000, prompt: promptTokens, cached: cachedTokens, completion: completionTokens });
  if (timeline.length > MAX_TIMELINE) timeline.splice(0, timeline.length - MAX_TIMELINE);
}

export function getTokenStats(): {
  ok: boolean;
  hit_rate: number;
  cache_reported: boolean;
  tokens_per_minute: number;
  total: { prompt_tokens: number; completion_tokens: number; calls: number; cached_tokens: number };
  by_agent: Record<string, AgentTokenStat>;
  budget: { remaining: number; used: number; limit: number };
  timeline: TimelinePoint[];
} {
  let prompt = 0, cached = 0, completion = 0, calls = 0;
  const byAgentOut: Record<string, AgentTokenStat> = {};
  for (const [k, v] of byAgent) {
    byAgentOut[k] = { ...v };
    prompt += v.prompt_tokens;
    cached += v.cached_tokens;
    completion += v.completion_tokens;
    calls += v.calls;
  }
  const hitRate = prompt > 0 ? Math.round((cached / prompt) * 100) : 0;

  // 近 60 秒 token 速率
  const now = Date.now() / 1000;
  const recent = timeline.filter((p) => now - p.ts <= 60);
  const recentSum = recent.reduce((s, p) => s + p.prompt + p.completion, 0);

  return {
    ok: true,
    hit_rate: hitRate,
    cache_reported: cacheReported,
    tokens_per_minute: Math.round(recentSum),
    total: { prompt_tokens: prompt, completion_tokens: completion, calls, cached_tokens: cached },
    by_agent: byAgentOut,
    budget: { remaining: 0, used: 0, limit: 0 },
    timeline: timeline.slice(-40),
  };
}
