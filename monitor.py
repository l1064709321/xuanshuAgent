"""玄姝可观测性 v1.0 — 性能/成本/延迟监控
- 每个 Agent 的 token 消耗、LLM 调用次数、工具调用延迟
- 实时统计 + JSON 导出
"""
import time, json, os
from typing import Dict, Optional
from collections import defaultdict
from threading import Lock, RLock

_WS = os.path.dirname(os.path.abspath(__file__))


class Metrics:
    """Agent 级性能指标收集器"""

    def __init__(self):
        self._lock = Lock()
        self.reset()

    def reset(self):
        with self._lock:
            self._counters = defaultdict(lambda: {
                "llm_calls": 0, "llm_tokens": 0, "llm_latency_ms": 0.0,
                "tool_calls": 0, "tool_errors": 0, "tool_latency_ms": 0.0,
                "task_success": 0, "task_fail": 0,
                "sessions": 0, "autonomous_loops": 0,
            })
            self._start_time = time.time()

    def record_llm(self, agent: str, tokens: int, latency_s: float, model: str = ""):
        with self._lock:
            c = self._counters[agent]
            c["llm_calls"] += 1
            c["llm_tokens"] += tokens
            c["llm_latency_ms"] += latency_s * 1000
            if model:
                c.setdefault("models", defaultdict(int))[model] += 1

    def record_tool(self, agent: str, tool_name: str, latency_s: float, error: bool = False):
        with self._lock:
            c = self._counters[agent]
            c["tool_calls"] += 1
            c["tool_latency_ms"] += latency_s * 1000
            if error:
                c["tool_errors"] += 1

    def record_task(self, agent: str, success: bool):
        with self._lock:
            c = self._counters[agent]
            if success:
                c["task_success"] += 1
            else:
                c["task_fail"] += 1

    def record_session(self, agent: str):
        with self._lock:
            self._counters[agent]["sessions"] += 1

    def record_autonomous_loop(self, agent: str):
        with self._lock:
            self._counters[agent]["autonomous_loops"] += 1

    def summary(self) -> str:
        with self._lock:
            uptime = time.time() - self._start_time
            lines = [f"## 玄姝可观测性 | 运行 {uptime:.0f}s"]
            lines.append("")
            lines.append("| Agent | LLM调用 | Token | LLM延迟 | 工具调用 | 工具错误 | 任务/成功 | 自主循环 |")
            lines.append("|-------|---------|-------|---------|----------|----------|-----------|----------|")
            total_tokens = 0
            total_llm = 0
            for name, c in sorted(self._counters.items()):
                llm_lat = f"{c['llm_latency_ms']:.0f}ms" if c["llm_calls"] else "-"
                tool_lat = f"{c['tool_latency_ms']:.0f}ms" if c["tool_calls"] else "-"
                lines.append(
                    f"| {name} | {c['llm_calls']} | {c['llm_tokens']} | {llm_lat} | "
                    f"{c['tool_calls']} | {c['tool_errors']} | "
                    f"{c['task_success']}/{c['task_success']+c['task_fail']} | {c['autonomous_loops']} |"
                )
                total_tokens += c["llm_tokens"]
                total_llm += c["llm_calls"]
            lines.append("")
            lines.append(f"LLM总调用: {total_llm} | 总Token: {total_tokens}")
            return "\n".join(lines)

    def to_dict(self) -> dict:
        with self._lock:
            return {k: dict(v) for k, v in self._counters.items()}

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)


_global_metrics = Metrics()


# ═══════════════════════════════════════════
# Token 命中率实时追踪
# ═══════════════════════════════════════════

class TokenHitTracker:
    """Token 缓存命中率追踪器 — 记录每次 LLM 调用的 token 分布"""

    def __init__(self, history_size: int = 200):
        self._lock = RLock()
        self.history_size = history_size
        self.reset()

    def reset(self):
        with self._lock:
            self._by_agent: Dict[str, dict] = defaultdict(lambda: {
                "prompt_tokens": 0,
                "cached_tokens": 0,
                "completion_tokens": 0,
                "calls": 0,
            })
            self._total = {"prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "calls": 0}
            self._timeline: list = []  # [(ts, prompt, cached, completion, agent), ...]
            self._start_time = time.time()

    def record(self, agent: str, prompt_tokens: int, cached_tokens: int = 0, completion_tokens: int = 0):
        with self._lock:
            a = self._by_agent[agent]
            a["prompt_tokens"] += prompt_tokens
            a["cached_tokens"] += cached_tokens
            a["completion_tokens"] += completion_tokens
            a["calls"] += 1
            self._total["prompt_tokens"] += prompt_tokens
            self._total["cached_tokens"] += cached_tokens
            self._total["completion_tokens"] += completion_tokens
            self._total["calls"] += 1
            self._timeline.append((time.time(), prompt_tokens, cached_tokens, completion_tokens, agent))
            if len(self._timeline) > self.history_size:
                self._timeline = self._timeline[-self.history_size:]

    @property
    def hit_rate(self) -> float:
        """缓存命中率 = cached_tokens / prompt_tokens"""
        with self._lock:
            if self._total["prompt_tokens"] == 0:
                return 0.0
            return self._total["cached_tokens"] / self._total["prompt_tokens"]

    @property
    def tokens_per_minute(self) -> float:
        """每分钟 Token 消耗速率 (基于最近 5 分钟)"""
        with self._lock:
            window = 300  # 5 分钟
            cutoff = time.time() - window
            recent = [e for e in self._timeline if e[0] >= cutoff]
            if not recent:
                return 0.0
            total = sum(e[1] + e[3] for e in recent)  # prompt + completion
            elapsed = time.time() - max(cutoff, recent[0][0])
            if elapsed <= 0:
                return 0.0
            return total / (elapsed / 60)

    def stats(self) -> dict:
        """返回完整 Token 统计"""
        with self._lock:
            uptime = time.time() - self._start_time
            by_minute = []
            for entry in self._timeline[-50:]:
                by_minute.append({
                    "ts": entry[0],
                    "prompt": entry[1],
                    "cached": entry[2],
                    "completion": entry[3],
                    "agent": entry[4],
                })
            return {
                "uptime_s": int(uptime),
                "total": dict(self._total),
                "hit_rate": round(self.hit_rate * 100, 2),
                "tokens_per_minute": round(self.tokens_per_minute, 1),
                "by_agent": {k: dict(v) for k, v in self._by_agent.items()},
                "timeline": by_minute,
            }

    def feed_from_metrics(self, agent: str, prompt_tokens: int, cached_tokens: int = 0):
        """从现有的 Metrics.record_llm 中接入 — 兼容层。
        注意：此方法不记录 completion_tokens，仅用于历史兼容；不污染命中率统计。"""
        self.record(agent, prompt_tokens=prompt_tokens, cached_tokens=cached_tokens, completion_tokens=0)


_token_hit_tracker = None


def get_token_hit_tracker() -> TokenHitTracker:
    global _token_hit_tracker
    if _token_hit_tracker is None:
        _token_hit_tracker = TokenHitTracker()
    return _token_hit_tracker


def get_metrics() -> Metrics:
    return _global_metrics
