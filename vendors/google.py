"""vendors/google.py — Google Gemini 厂商调度

官方：Gemini 3 系列 1M~2M 上下文，OpenAI 兼容端点，无显式前缀缓存标记。
"""
from .base import BaseVendor


class GoogleVendor(BaseVendor):
    vendor = "google"
    context_window = 1_000_000
    max_output = 64_000
    cjk_chars_per_token = 1.5
    cache_mode = "none"
