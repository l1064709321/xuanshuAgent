"""vendors/openai.py — OpenAI 厂商调度

官方缓存机制：128K 及以上模型启用自动前缀缓存，无需显式标记，
命中后输入 token 计费 -50%，TTL 约 1 小时。保持 system 前缀稳定即命中。
"""
from .base import BaseVendor


class OpenAIVendor(BaseVendor):
    vendor = "openai"
    context_window = 400_000    # GPT-5.5 1.1M，GPT-4o 128K，取中间基准
    max_output = 64_000
    cjk_chars_per_token = 1.8   # tiktoken 中文约 1.8 字符 1 token
    cache_mode = "openai"
