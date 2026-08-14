"""vendors/base.py — 厂商调度器基类与公共工具

各厂商的上下文窗口、token 折算、缓存策略差异极大，各自独立成文件维护，
统一继承 BaseVendor。基类负责：
- ContextPolicy 统一数据结构
- 窗口标注解析（description 里的 '1M'/'203K'/'20万' 等）
- token 估算（中文按厂商折算系数，英文 4 字符 1 token）
- 派生参数（最近窗口 / 压缩阈值 / 压缩保留预算，按窗口比例）
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ContextPolicy:
    vendor: str                  # 归一化厂商名
    context_window: int          # 上下文窗口 token 上限
    max_output: int              # 单次最大输出 token
    cjk_chars_per_token: float   # 中文折算系数（N 个中文字符 ≈ 1 token）
    cache_mode: str              # anthropic | deepseek | openai | none
    recent_tokens: int           # 最近对话窗口预算（token）
    compact_threshold: int       # 压缩触发阈值（token）
    keep_budget: int             # 压缩后保留预算（token）


# 派生参数比例：以窗口为基准（业界基准：Codex ~95% 触发，Claude 保留近 8~10 轮）
_RECENT_RATIO = 0.02     # 最近窗口 ≈ 窗口 2%
_COMPACT_RATIO = 0.25    # 压缩触发 ≈ 窗口 25%（留足输出空间）
_KEEP_RATIO = 0.12       # 压缩保留 ≈ 窗口 12%

_WINDOW_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(万|[KkMm])\b")


def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def extract_window(description: str, default: int) -> int:
    """从 description 解析窗口标注（如 '1M上下文' / '203K上下文' / '20万上下文'）。"""
    if not description:
        return default
    best = 0
    for m in _WINDOW_RE.finditer(description):
        num = float(m.group(1))
        unit = m.group(2)
        if unit == "万":
            tokens = int(num * 10_000)
        elif unit in ("K", "k"):
            tokens = int(num * 1_000)
        elif unit in ("M", "m"):
            tokens = int(num * 1_000_000)
        else:
            continue
        best = max(best, tokens)
    return best or default


def estimate_tokens(text: str, cjk_chars_per_token: float = 1.0) -> int:
    """token 估算：中文按厂商折算系数，英文按 4 字符 1 token。"""
    if not text:
        return 0
    cjk = sum(1 for c in text if "\u4e00" <= c <= "\u9fff")
    other = len(text) - cjk
    return int(cjk / cjk_chars_per_token) + other // 4 + 1


class BaseVendor:
    """厂商调度器基类。

    子类覆盖以下类属性即可完成一个厂商的调度配置：
    - vendor / context_window / max_output / cjk_chars_per_token / cache_mode
    可选覆盖 cache(messages) 实现厂商专属缓存标记（借用官方 API 规范）。
    """
    vendor: str = "default"
    context_window: int = 32_000
    max_output: int = 8_000
    cjk_chars_per_token: float = 1.0
    cache_mode: str = "none"

    def resolve(self, description: str = "") -> ContextPolicy:
        """按 description 里的窗口标注解析出最终调度策略。"""
        w = extract_window(description, self.context_window)
        return ContextPolicy(
            vendor=self.vendor,
            context_window=w,
            max_output=self.max_output,
            cjk_chars_per_token=self.cjk_chars_per_token,
            cache_mode=self.cache_mode,
            recent_tokens=_clamp(int(w * _RECENT_RATIO), 1200, 6000),
            compact_threshold=int(w * _COMPACT_RATIO),
            keep_budget=int(w * _KEEP_RATIO),
        )

    def cache(self, messages: list) -> list:
        """厂商专属缓存标记。默认深拷贝原样返回（无前缀缓存的厂商）。"""
        import copy
        return copy.deepcopy(messages)
