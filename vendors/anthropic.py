"""vendors/anthropic.py — Anthropic Claude 厂商调度

官方缓存机制：prompt caching 采用 cache_control 显式标记，
每个请求最多 4 个缓存断点，TTL 5 分钟，命中后输入 token 计费 -90%。
system 提示词是最稳定的缓存断点，故对其整体标记 ephemeral。
"""
from .base import BaseVendor


class AnthropicVendor(BaseVendor):
    vendor = "anthropic"
    context_window = 1_000_000   # Opus/Sonnet 1M，Haiku 200K
    max_output = 64_000
    cjk_chars_per_token = 1.4    # Claude 中文约 1.4 字符 1 token
    cache_mode = "anthropic"

    def cache(self, messages):
        import copy
        _msgs = copy.deepcopy(messages)
        for i, m in enumerate(_msgs):
            if m.get("role") == "system":
                content = m.get("content", "")
                if isinstance(content, str):
                    _msgs[i]["content"] = [
                        {"type": "text", "text": content,
                         "cache_control": {"type": "ephemeral"}}
                    ]
        return _msgs
