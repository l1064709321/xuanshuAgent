"""玄姝可观测性 v1.0 — 性能/成本/延迟监控
- 每个 Agent 的 token 消耗、LLM 调用次数、工具调用延迟
- 实时统计 + JSON 导出
"""
import time, json, os
from typing import Dict, Optional
from collections import defaultdict
from threading import Lock

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


def get_metrics() -> Metrics:
    return _global_metrics
