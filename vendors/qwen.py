"""vendors/qwen.py — 阿里通义千问厂商调度

官方：qwen-max / qwen-long 支持 1M 上下文，OpenAI 兼容端点
（dashscope 或 openai 兼容 base_url），无显式前缀缓存标记。
"""
from .base import BaseVendor


class QwenVendor(BaseVendor):
    vendor = "qwen"
    context_window = 1_000_000
    max_output = 64_000
    cjk_chars_per_token = 1.0
    cache_mode = "openai"      # OpenAI 兼容端点，前缀稳定即走服务端缓存
