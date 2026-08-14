"""vendors/glm.py — 智谱 GLM 厂商调度

官方：GLM-4.5/GLM-4.6 系列 128K~203K 上下文，OpenAI 兼容端点
（https://open.bigmodel.cn/api/paas/v4）。
"""
from .base import BaseVendor


class GlmVendor(BaseVendor):
    vendor = "glm"
    context_window = 200_000
    max_output = 16_000
    cjk_chars_per_token = 1.0
    cache_mode = "none"
