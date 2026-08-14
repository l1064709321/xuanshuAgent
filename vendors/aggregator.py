"""vendors/aggregator.py — 聚合平台厂商调度（SiliconFlow / OpenRouter / Together 等）

聚合平台托管多家模型，上下文与 token 折算跟随底层模型：
- SiliconFlow：托管 DeepSeek / Qwen / Kimi / MiniMax 等，中文模型为主
- OpenRouter：200+ 模型，含 OpenAI / Anthropic / Google 等
默认按中文原生 tokenizer（≈1 字符 1 token）与 128K 窗口兜底，
description 里的窗口标注会覆盖此默认值。
"""
from .base import BaseVendor


class AggregatorVendor(BaseVendor):
    vendor = "aggregator"
    context_window = 128_000
    max_output = 16_000
    cjk_chars_per_token = 1.0
    cache_mode = "none"
