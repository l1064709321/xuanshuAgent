"""vendors/kimi.py — 月之暗面 Kimi 厂商调度

官方：Kimi K2/K2.5/K2.6/K3 系列，128K 上下文（部分 256K），
OpenAI 兼容端点（https://api.moonshot.cn/v1）。
与 DeepSeek 是两套调度：Kimi 无显式缓存标记，走服务端自动缓存，
中文 tokenizer 折算与 DeepSeek 接近（≈1 字符 1 token）。
"""
from .base import BaseVendor


class KimiVendor(BaseVendor):
    vendor = "kimi"
    context_window = 128_000
    max_output = 16_000
    cjk_chars_per_token = 1.0
    cache_mode = "none"
