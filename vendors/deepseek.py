"""vendors/deepseek.py — DeepSeek 厂商调度

官方缓存机制（context caching / 上下文硬盘缓存）：
- 无需显式标记，系统自动缓存历史 token，前缀完全一致即命中
- 缓存命中时输入价格约为未命中的 1/10（deepseek-chat / deepseek-reasoner）
- 因此冻结层 system 必须逐字节稳定，动态内容一律放末尾，最大化命中率
官方端点：https://api.deepseek.com/v1（OpenAI 兼容）
上下文：deepseek-chat / deepseek-reasoner 64K~128K（随版本提升）
"""
from .base import BaseVendor


class DeepSeekVendor(BaseVendor):
    vendor = "deepseek"
    context_window = 128_000
    max_output = 64_000
    cjk_chars_per_token = 1.0   # DeepSeek 中文约 1 字符 1 token
    cache_mode = "deepseek"
