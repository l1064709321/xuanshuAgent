"""vendors/nvidia.py — NVIDIA 厂商调度

官方：Nemotron 系列（nemotron-super 120B 等），1M 上下文，
OpenAI 兼容端点（https://integrate.api.nvidia.com/v1）。
"""
from .base import BaseVendor


class NvidiaVendor(BaseVendor):
    vendor = "nvidia"
    context_window = 1_000_000
    max_output = 64_000
    cjk_chars_per_token = 1.5
    cache_mode = "none"
