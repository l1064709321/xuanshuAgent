"""vendors/minimax.py — MiniMax 厂商调度

官方：MiniMax M1/M2/M3 系列，80K~200K 上下文，
OpenAI 兼容端点（https://api.minimaxi.com/v1）。
"""
from .base import BaseVendor


class MiniMaxVendor(BaseVendor):
    vendor = "minimax"
    context_window = 200_000
    max_output = 16_000
    cjk_chars_per_token = 1.0
    cache_mode = "none"
