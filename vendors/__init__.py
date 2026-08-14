"""vendors/__init__.py — 厂商调度器注册表

每个厂商一个文件、一套独立调度，按 provider / model_key 归一化后路由。
新增厂商：建一个 vendors/xxx.py，定义 XxxVendor(BaseVendor)，
在此处 VENDOR_REGISTRY 注册即可被调度器识别。
"""
from __future__ import annotations

from .base import BaseVendor, ContextPolicy, extract_window, estimate_tokens
from .anthropic import AnthropicVendor
from .openai import OpenAIVendor
from .google import GoogleVendor
from .deepseek import DeepSeekVendor
from .qwen import QwenVendor
from .glm import GlmVendor
from .kimi import KimiVendor
from .minimax import MiniMaxVendor
from .nvidia import NvidiaVendor
from .aggregator import AggregatorVendor


# 归一化厂商名 → Vendor 类
VENDOR_REGISTRY: dict = {
    "anthropic": AnthropicVendor,
    "openai": OpenAIVendor,
    "google": GoogleVendor,
    "deepseek": DeepSeekVendor,
    "qwen": QwenVendor,
    "glm": GlmVendor,
    "kimi": KimiVendor,
    "minimax": MiniMaxVendor,
    "nvidia": NvidiaVendor,
    "aggregator": AggregatorVendor,
}


def normalize_vendor(provider: str, model_key: str) -> str:
    """厂商归一化：provider（models.ModelEntry.provider）优先，model_key 兜底。"""
    p = (provider or "").lower()
    k = (model_key or "").lower()
    if "anthropic" in p or "claude" in k:
        return "anthropic"
    if "openai" in p or "gpt" in k:
        return "openai"
    if "google" in p or "gemini" in k:
        return "google"
    if "deepseek" in p or "deepseek" in k:
        return "deepseek"
    if "通义" in (provider or "") or "dashscope" in p or "qwen" in k:
        return "qwen"
    if "智谱" in (provider or "") or "bigmodel" in p or "glm" in k:
        return "glm"
    if "moonshot" in p or "月之暗面" in (provider or "") or "kimi" in k:
        return "kimi"
    if "minimax" in p or "minimax" in k:
        return "minimax"
    if "nvidia" in p or "nemotron" in k:
        return "nvidia"
    if "聚合" in (provider or "") or "siliconflow" in p or "openrouter" in p or "together" in p:
        return "aggregator"
    return "default"


def resolve_policy(model_key: str = "", provider: str = "", description: str = "") -> ContextPolicy:
    """按厂商归一化路由到对应 Vendor 类，解析出上下文调度策略。"""
    vendor = normalize_vendor(provider, model_key)
    cls = VENDOR_REGISTRY.get(vendor, BaseVendor)
    return cls().resolve(description)


def inject_cache_hints(messages: list, provider: str = "", model_key: str = "") -> list:
    """按厂商调度注入缓存标记（调用对应 vendor 的 cache() 方法）。"""
    vendor = normalize_vendor(provider, model_key)
    cls = VENDOR_REGISTRY.get(vendor, BaseVendor)
    return cls().cache(messages)


__all__ = [
    "BaseVendor", "ContextPolicy", "VENDOR_REGISTRY",
    "normalize_vendor", "resolve_policy", "estimate_tokens", "inject_cache_hints",
]
