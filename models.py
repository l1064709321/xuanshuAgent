"""
模型池 — 30+ 主流大模型，支持自定义添加
"""
from typing import Dict, Optional
from dataclasses import dataclass, field
import time

# 延迟导入，避免 openai 未安装时启动失败
OpenAI = None
def _get_openai():
    global OpenAI
    if OpenAI is None:
        from openai import OpenAI as _OpenAI
        OpenAI = _OpenAI
    return OpenAI


@dataclass
class ModelEntry:
    key: str            # gpt-4o
    name: str           # GPT-4o
    model_id: str       # gpt-4o
    base_url: str       # https://api.openai.com/v1
    provider: str       # OpenAI
    description: str = ""
    aliases: tuple = ()
    custom: bool = False  # 用户自定义


# 所有主流模型的 API Base URL
BUILTIN_MODELS: Dict[str, ModelEntry] = {
    # ── OpenAI ──
    "gpt-5.5": ModelEntry("gpt-5.5", "GPT-5.5", "gpt-5.5",
        "https://api.openai.com/v1", "OpenAI", "旗舰 1.1M上下文", ("gpt55", "5.5", "spud")),
    "gpt-5.5-pro": ModelEntry("gpt-5.5-pro", "GPT-5.5 Pro", "gpt-5.5-pro",
        "https://api.openai.com/v1", "OpenAI", "极致推理 $30/$180", ("gpt55pro", "5.5pro")),
    "gpt-4o": ModelEntry("gpt-4o", "GPT-4o", "gpt-4o",
        "https://api.openai.com/v1", "OpenAI", "多模态旗舰", ("4o",)),
    "gpt-4o-mini": ModelEntry("gpt-4o-mini", "GPT-4o-mini", "gpt-4o-mini",
        "https://api.openai.com/v1", "OpenAI", "轻量多模态", ("4omini", "mini")),
    # ── Anthropic ──
    "claude-opus-4.8": ModelEntry("claude-opus-4.8", "Claude Opus 4.8", "claude-opus-4-8",
        "https://api.anthropic.com/v1", "Anthropic", "旗舰高性能 1M上下文", ("opus", "opus48", "claude48")),
    "claude-sonnet-4.6": ModelEntry("claude-sonnet-4.6", "Claude Sonnet 4.6", "claude-sonnet-4-6",
        "https://api.anthropic.com/v1", "Anthropic", "速度智能平衡 1M上下文", ("sonnet", "sonnet46", "claude46")),
    "claude-haiku-4.5": ModelEntry("claude-haiku-4.5", "Claude Haiku 4.5", "claude-haiku-4-5-20251001",
        "https://api.anthropic.com/v1", "Anthropic", "最快 20万上下文", ("haiku", "haiku45")),
    "claude-fable-5": ModelEntry("claude-fable-5", "Claude Fable 5", "claude-fable-5",
        "https://api.anthropic.com/v1", "Anthropic", "Mythos级 100万上下文", ("fable", "fable5", "mythos")),
    # ── Google ──
    "gemini-3.1-pro": ModelEntry("gemini-3.1-pro", "Gemini 3.1 Pro", "gemini-3.1-pro-preview",
        "https://generativelanguage.googleapis.com/v1beta", "Google", "旗舰多模态", ("gemini31", "g31p", "gemini3")),
    "gemini-3-flash": ModelEntry("gemini-3-flash", "Gemini 3 Flash", "gemini-3-flash-preview",
        "https://generativelanguage.googleapis.com/v1beta", "Google", "默认首选 速度快", ("g3f", "flash3", "gflash")),
    # ── DeepSeek ──
    "deepseek-v4-pro": ModelEntry("deepseek-v4-pro", "DeepSeek-V4-Pro", "deepseek-v4-pro",
        "https://api.deepseek.com/v1", "DeepSeek", "旗舰 1.6T/49B 1M上下文", ("v4pro", "v4", "dsv4", "v4-pro")),
    "deepseek-v4-flash": ModelEntry("deepseek-v4-flash", "DeepSeek-V4-Flash", "deepseek-v4-flash",
        "https://api.deepseek.com/v1", "DeepSeek", "高性价比 284B/13B 1M上下文", ("v4flash", "v4f", "flash")),
    "deepseek-v3": ModelEntry("deepseek-v3", "DeepSeek-V3(旧)", "deepseek-chat",
        "https://api.deepseek.com/v1", "DeepSeek", "旧版 2026/07/24弃用", ("v3", "ds", "deepseek")),
    "deepseek-r1": ModelEntry("deepseek-r1", "DeepSeek-R1(旧)", "deepseek-reasoner",
        "https://api.deepseek.com/v1", "DeepSeek", "旧版推理 2026/07/24弃用", ("r1", "reasoner")),
    # ── 阿里通义 ──
    "qwen3.7-max": ModelEntry("qwen3.7-max", "Qwen3.7-Max", "qwen3.7-max-2026-06-08",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "最新旗舰 1M上下文 64K输出", ("qwen37", "qwen3.7", "qwmax", "qwen-max")),
    "qwen3.7-plus": ModelEntry("qwen3.7-plus", "Qwen3.7-Plus", "qwen3.7-plus-2026-05-26",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "Plus版 1M上下文", ("qwen37p", "qwplus")),
    "qwen2.5-72b": ModelEntry("qwen2.5-72b", "Qwen2.5-72B", "qwen2.5-72b-instruct",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "开源千亿参数", ("qwen72", "72b")),
    "qwen2.5-32b": ModelEntry("qwen2.5-32b", "Qwen2.5-32B", "qwen2.5-32b-instruct",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "高性价比", ("qwen32", "32b")),
    # ── 智谱 ──
    "glm-5.2": ModelEntry("glm-5.2", "GLM-5.2", "glm-5.2",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "最新旗舰 MoE 744B/40B 1M上下文 MIT开源", ("glm52", "glm5.2", "glm", "glm5", "zhipu")),
    "glm-4-air": ModelEntry("glm-4-air", "GLM-4-Air", "glm-4-air",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "轻量低成本", ("glm4a", "glmair")),
    "glm-4.7-flash": ModelEntry("glm-4.7-flash", "GLM-4.7-Flash", "glm-4.7-flash",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "永久免费 203K上下文", ("glm47f", "glmfree", "zhipufree")),
    "glm-4.7": ModelEntry("glm-4.7", "GLM-4.7", "glm-4.7",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "旗舰付费 200B 203K上下文", ("glm47",)),
    # ── 月之暗面 ──
    "moonshot-v1": ModelEntry("moonshot-v1", "Moonshot-v1", "moonshot-v1-8k",
        "https://api.moonshot.cn/v1", "月之暗面", "200万字上下文", ("moonshot", "kimi1")),
    "kimi-k2": ModelEntry("kimi-k2", "Kimi-K2", "kimi-k2-0905-preview",
        "https://api.moonshot.cn/v1", "月之暗面", "增强推理", ("k2", "kimik2")),
    # ── 字节豆包 ──
    "doubao-pro": ModelEntry("doubao-pro", "Doubao-Pro", "ep-20241201175000-xxxxx",
        "https://ark.cn-beijing.volces.com/api/v3/", "字节豆包", "旗舰通用", ("doubao", "dbpro")),
    "doubao-lite": ModelEntry("doubao-lite", "Doubao-Lite", "ep-20241201175000-xxxxx",
        "https://ark.cn-beijing.volces.com/api/v3/", "字节豆包", "轻量低成本", ("dblite",)),
    # ── 百川 ──
    "baichuan4": ModelEntry("baichuan4", "Baichuan4", "Baichuan4",
        "https://api.baichuan-ai.com/v1", "百川", "通用多模态", ("bc4", "百川")),
    # ── Minimax ──
    "abab6.5": ModelEntry("abab6.5", "abab6.5", "abab6.5s-chat",
        "https://api.minimax.chat/v1", "Minimax", "多模态语音(旧)", ("minimax", "abab")),
    "minimax-m3": ModelEntry("minimax-m3", "MiniMax-M3", "MiniMax-M3",
        "https://api.minimaxi.com/v1", "Minimax", "最新原生多模态 1M上下文", ("m3", "mm3")),
    "minimax-m2.7": ModelEntry("minimax-m2.7", "MiniMax-M2.7", "MiniMax-M2.7",
        "https://api.minimaxi.com/v1", "Minimax", "自主迭代旗舰 自我进化", ("m2.7", "mm27", "minimax27")),
    "minimax-m2.7-fast": ModelEntry("minimax-m2.7-fast", "MiniMax-M2.7-Fast", "MiniMax-M2.7-highspeed",
        "https://api.minimaxi.com/v1", "Minimax", "高速版 效果不变", ("m27f", "mm27fast")),
    # ── 零一万物 ──
    "yi-large": ModelEntry("yi-large", "Yi-Large", "yi-large",
        "https://api.lingyiwanwu.com/v1", "零一万物", "千亿参数", ("yi", "零一")),
    # ── 讯飞星火 ──
    "spark-4.0": ModelEntry("spark-4.0", "Spark 4.0", "generalv4.0",
        "https://spark-api-open.xf-yun.com/v1", "讯飞星火", "多模态", ("spark", "星火")),
    # ── 腾讯混元 ──
    "hunyuan-pro": ModelEntry("hunyuan-pro", "Hunyuan-Pro", "hunyuan-pro",
        "https://api.hunyuan.cloud.tencent.com/v1", "腾讯混元", "旗舰多模态", ("hunyuan", "混元")),
    # ── Mistral ──
    "mistral-large": ModelEntry("mistral-large", "Mistral Large", "mistral-large-latest",
        "https://api.mistral.ai/v1", "Mistral", "多语言/函数调用", ("mlarge",)),
    "mistral-small": ModelEntry("mistral-small", "Mistral Small", "mistral-small-latest",
        "https://api.mistral.ai/v1", "Mistral", "轻量快速", ("msmall",)),
    # ── Meta ──
    "llama-4": ModelEntry("llama-4", "Llama 4", "llama-4-maverick",
        "https://api.llama.com/v1", "Meta", "官方托管", ("llama4", "l4")),
    "llama-3.3": ModelEntry("llama-3.3", "Llama 3.3", "llama-3.3-70b",
        "https://api.llama.com/v1", "Meta", "70B 开源", ("llama3", "l33")),
    # ── xAI ──
    "grok-3": ModelEntry("grok-3", "Grok-3", "grok-3-beta",
        "https://api.x.ai/v1", "xAI", "实时联网/幽默", ("grok", "g3")),
    # ── Cohere ──
    "command-r-plus": ModelEntry("command-r-plus", "Command R+", "command-r-plus",
        "https://api.cohere.ai/v1", "Cohere", "企业级RAG", ("cr+", "cohere")),
    # ── NVIDIA ──
    "nemotron-super": ModelEntry("nemotron-super", "Nemotron-Super", "nvidia/nemotron-3-super-120b-a12b",
        "https://integrate.api.nvidia.com/v1", "NVIDIA", "120B 免费 1M上下文", ("nemotron", "nvidia", "nemo")),
    "nv-minimax-m2.7": ModelEntry("nv-minimax-m2.7", "NV MiniMax-M2.7", "minimaxai/minimax-m2.7",
        "https://integrate.api.nvidia.com/v1", "NVIDIA", "MiniMax自主迭代 免费", ("nvmm27", "nv-minimax27")),
    "nv-minimax-m3": ModelEntry("nv-minimax-m3", "NV MiniMax-M3", "minimaxai/minimax-m3",
        "https://integrate.api.nvidia.com/v1", "NVIDIA", "原生多模态 1M上下文 免费", ("nvmm3",)),
    # ── Groq ──
    "groq-llama4": ModelEntry("groq-llama4", "Groq Llama-4", "llama-4-maverick",
        "https://api.groq.com/openai/v1", "聚合平台", "超快推理 免费额度", ("groq", "gllama")),
    # ── Reka ──
    "reka-flash": ModelEntry("reka-flash", "Reka Flash", "reka-flash",
        "https://api.reka.ai/v1", "Reka", "多模态快速", ("reka",)),
    # ── AI21 ──
    "jamba-1.6": ModelEntry("jamba-1.6", "Jamba 1.6", "jamba-1.6-large",
        "https://api.ai21.com/v1", "AI21", "256K Mamba混合架构", ("jamba", "j16")),
    # ── 聚合平台 ──
    "siliconflow": ModelEntry("siliconflow", "SiliconFlow(聚合)", "deepseek-ai/DeepSeek-V4-Flash",
        "https://api.siliconflow.cn/v1", "聚合平台", "国产模型聚合 免费额度", ("sf", "硅基")),
    "sf-qwen3.7": ModelEntry("sf-qwen3.7", "SF Qwen3.7-Max", "Qwen/Qwen3.7-Max",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 Qwen3.7旗舰", ("sfqw", "sfqwen")),
    "sf-glm-5.2": ModelEntry("sf-glm-5.2", "SF GLM-5.2", "THUDM/glm-5.2",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 GLM-5.2 MIT开源", ("sfglm",)),
    "sf-glm-4.7-flash": ModelEntry("sf-glm-4.7-flash", "SF GLM-4.7-Flash", "THUDM/glm-4.7-flash",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 GLM免费 无限制", ("sfglmfree",)),
    "sf-deepseek-v4-pro": ModelEntry("sf-deepseek-v4-pro", "SF DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Pro",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 DeepSeek V4旗舰", ("sfv4p",)),
    "sf-deepseek-r1": ModelEntry("sf-deepseek-r1", "SF DeepSeek-R1", "deepseek-ai/DeepSeek-R1",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 深度推理", ("sfr1",)),
    "sf-qwq-32b": ModelEntry("sf-qwq-32b", "SF QwQ-32B", "Qwen/QwQ-32B",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 推理专用 免费", ("sfqwq",)),
    "sf-qwen3.7-plus": ModelEntry("sf-qwen3.7-plus", "SF Qwen3.7-Plus", "Qwen/Qwen3.7-Plus",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 Qwen3.7高性价比", ("sfqwp",)),
    "sf-qwen-coder": ModelEntry("sf-qwen-coder", "SF Qwen-Coder", "Qwen/Qwen3-Coder",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 代码专用", ("sfqc",)),
    "sf-llama4": ModelEntry("sf-llama4", "SF Llama-4", "meta-llama/Llama-4-Maverick",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 Llama-4 免费", ("sfl4",)),
    "sf-mistral-large": ModelEntry("sf-mistral-large", "SF Mistral-Large", "mistralai/Mistral-Large",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 Mistral旗舰", ("sfml",)),
    "sf-internlm3": ModelEntry("sf-internlm3", "SF InternLM3", "internlm/internlm3-8b-instruct",
        "https://api.siliconflow.cn/v1", "聚合平台", "硅基 书生·浦语 免费", ("sflm3",)),
    # ── SiliconFlow 免费模型 ──
    "sf-deepseek-r1-distill-qwen7b": ModelEntry("sf-deepseek-r1-distill-qwen7b", "SF R1-Distill-Qwen7B", "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 R1蒸馏7B", ("sfr1d7",)),
    "sf-deepseek-r1-qwen3-8b": ModelEntry("sf-deepseek-r1-qwen3-8b", "SF R1-Qwen3-8B", "deepseek-ai/DeepSeek-R1-0528-Qwen3-8B",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 R1最新蒸馏", ("sfr1q3",)),
    "sf-deepseek-ocr": ModelEntry("sf-deepseek-ocr", "SF DeepSeek-OCR", "deepseek-ai/DeepSeek-OCR",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 OCR专用", ("sfocr",)),
    "sf-qwen3-8b": ModelEntry("sf-qwen3-8b", "SF Qwen3-8B", "Qwen/Qwen3-8B",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 Qwen3基础", ("sfq38",)),
    "sf-qwen3-235b": ModelEntry("sf-qwen3-235b", "SF Qwen3-235B-MoE", "Qwen/Qwen3-235B-A22B-Instruct",
        "https://api.siliconflow.cn/v1", "聚合平台", "Qwen3 旗舰MoE付费", ("sfq3235",)),
    "sf-qwen3-30b": ModelEntry("sf-qwen3-30b", "SF Qwen3-30B-MoE", "Qwen/Qwen3-30B-A3B",
        "https://api.siliconflow.cn/v1", "聚合平台", "Qwen3 小MoE", ("sfq330",)),
    "sf-qwen3-coder-480b": ModelEntry("sf-qwen3-coder-480b", "SF Qwen3-Coder-480B", "Qwen/Qwen3-Coder-480B-A35B",
        "https://api.siliconflow.cn/v1", "聚合平台", "代码王者 480B MoE", ("sfqc480",)),
    "sf-qwen2.5-7b": ModelEntry("sf-qwen2.5-7b", "SF Qwen2.5-7B", "Qwen/Qwen2.5-7B-Instruct",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 Qwen2.5", ("sfq257",)),
    "sf-qwen2.5-coder-7b": ModelEntry("sf-qwen2.5-coder-7b", "SF Qwen2.5-Coder-7B", "Qwen/Qwen2.5-Coder-7B-Instruct",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 代码专用", ("sfq25c",)),
    "sf-qwen2.5-vl-72b": ModelEntry("sf-qwen2.5-vl-72b", "SF Qwen2.5-VL-72B", "Qwen/Qwen2.5-VL-72B-Instruct",
        "https://api.siliconflow.cn/v1", "聚合平台", "视觉旗舰 付费", ("sfvl72",)),
    "sf-qwen3-vl-235b": ModelEntry("sf-qwen3-vl-235b", "SF Qwen3-VL-235B", "Qwen/Qwen3-VL-235B-A22B",
        "https://api.siliconflow.cn/v1", "聚合平台", "视觉MoE旗舰", ("sfvl235",)),
    "sf-qwen3-omni": ModelEntry("sf-qwen3-omni", "SF Qwen3-Omni", "Qwen/Qwen3-Omni",
        "https://api.siliconflow.cn/v1", "聚合平台", "全模态(图+视+音)", ("sfomni",)),
    "sf-glm-4.1v-9b": ModelEntry("sf-glm-4.1v-9b", "SF GLM-4.1V-9B", "THUDM/GLM-4.1V-9B-Thinking",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 视觉推理", ("sfglmv",)),
    "sf-glm-z1-9b": ModelEntry("sf-glm-z1-9b", "SF GLM-Z1-9B", "THUDM/GLM-Z1-9B-0414",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 GLM推理", ("sfglmz",)),
    "sf-glm-4-9b": ModelEntry("sf-glm-4-9b", "SF GLM-4-9B", "THUDM/GLM-4-9B-0414",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 GLM-4基础", ("sfglm4",)),
    "sf-glm-4-9b-chat": ModelEntry("sf-glm-4-9b-chat", "SF GLM-4-9B-Chat", "THUDM/glm-4-9b-chat",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 GLM-4对话", ("sfglmc",)),
    "sf-kimi-k2-thinking": ModelEntry("sf-kimi-k2-thinking", "SF Kimi-K2-Thinking", "moonshotai/Kimi-K2-Thinking",
        "https://api.siliconflow.cn/v1", "聚合平台", "K2思考版 付费", ("sfk2t",)),
    "sf-kimi-k2.5": ModelEntry("sf-kimi-k2.5", "SF Kimi-K2.5 Pro", "moonshotai/Kimi-K2.5",
        "https://api.siliconflow.cn/v1", "聚合平台", "K2.5最新 付费", ("sfk25",)),
    "sf-minimax-m1": ModelEntry("sf-minimax-m1", "SF MiniMax-M1", "MiniMaxAI/MiniMax-M1-80k",
        "https://api.siliconflow.cn/v1", "聚合平台", "MiniMax M1 付费", ("sfmm1",)),
    "sf-r1-distill-qwen14b": ModelEntry("sf-r1-distill-qwen14b", "SF R1-Distill-Qwen14B", "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B",
        "https://api.siliconflow.cn/v1", "聚合平台", "R1蒸馏14B 付费", ("sfr14",)),
    "sf-r1-distill-qwen32b": ModelEntry("sf-r1-distill-qwen32b", "SF R1-Distill-Qwen32B", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
        "https://api.siliconflow.cn/v1", "聚合平台", "R1蒸馏32B 付费", ("sfr32",)),
    "sf-r1-distill-llama70b": ModelEntry("sf-r1-distill-llama70b", "SF R1-Distill-Llama70B", "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
        "https://api.siliconflow.cn/v1", "聚合平台", "R1蒸馏70B 付费", ("sfr70",)),
    "sf-hunyuan-mt-7b": ModelEntry("sf-hunyuan-mt-7b", "SF Hunyuan-MT-7B", "tencent/Hunyuan-MT-7B",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 混元翻译", ("sfhymt",)),
    "sf-paddleocr": ModelEntry("sf-paddleocr", "SF PaddleOCR-VL", "PaddlePaddle/PaddleOCR-VL",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 百度OCR", ("sfpocr",)),
    "sf-bge-m3": ModelEntry("sf-bge-m3", "SF BGE-M3(嵌入)", "BAAI/bge-m3",
        "https://api.siliconflow.cn/v1", "聚合平台", "免费 多语言嵌入", ("sfbge",)),
    "sf-qwen3-emb-8b": ModelEntry("sf-qwen3-emb-8b", "SF Qwen3-Emb-8B", "Qwen/Qwen3-Embedding-8B",
        "https://api.siliconflow.cn/v1", "聚合平台", "嵌入大版", ("sfemb8",)),
    "sf-qwen-image": ModelEntry("sf-qwen-image", "SF Qwen-Image", "Qwen/Qwen-Image",
        "https://api.siliconflow.cn/v1", "聚合平台", "通义文生图", ("sfqimg",)),
    "sf-deepseek-v3.1": ModelEntry("sf-deepseek-v3.1", "SF DeepSeek-V3.1", "deepseek-ai/DeepSeek-V3.1",
        "https://api.siliconflow.cn/v1", "聚合平台", "V3.1混合思考", ("sfv31",)),
    "openrouter": ModelEntry("openrouter", "OpenRouter(聚合)", "openai/gpt-5.5",
        "https://openrouter.ai/api/v1", "聚合平台", "海外聚合 200+模型 免费模型多", ("or",)),
    "or-deepseek-v4": ModelEntry("or-deepseek-v4", "OR DeepSeek-V4", "deepseek/deepseek-v4-flash:free",
        "https://openrouter.ai/api/v1", "聚合平台", "OR DeepSeek-V4免费", ("orv4", "ords")),
    "or-deepseek-v4-pro": ModelEntry("or-deepseek-v4-pro", "OR DeepSeek-V4-Pro", "deepseek/deepseek-v4-pro",
        "https://openrouter.ai/api/v1", "聚合平台", "OR DeepSeek V4旗舰", ("orv4p",)),
    "or-gemini-flash": ModelEntry("or-gemini-flash", "OR Gemini Flash", "google/gemini-3-flash-preview:free",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Gemini Flash免费", ("orgf", "orgem")),
    "or-gemini-pro": ModelEntry("or-gemini-pro", "OR Gemini Pro", "google/gemini-3.1-pro-preview",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Gemini Pro旗舰", ("orgp",)),
    "or-llama4": ModelEntry("or-llama4", "OR Llama-4", "meta-llama/llama-4-maverick:free",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Llama-4 免费", ("orl4",)),
    "or-mistral-large": ModelEntry("or-mistral-large", "OR Mistral-Large", "mistralai/mistral-large:free",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Mistral Large免费", ("orml",)),
    "or-qwen3.7": ModelEntry("or-qwen3.7", "OR Qwen3.7-Max", "qwen/qwen3.7-max",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Qwen3.7旗舰", ("orqw",)),
    "or-claude-sonnet": ModelEntry("or-claude-sonnet", "OR Claude Sonnet", "anthropic/claude-sonnet-4.6",
        "https://openrouter.ai/api/v1", "聚合平台", "OR Claude Sonnet", ("orcs",)),
    "or-nemotron-super": ModelEntry("or-nemotron-super", "OR Nemotron-Super-120B", "nvidia/nemotron-3-super-120b-a12b:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 120B MoE", ("ornem",)),
    "or-gpt-oss-120b": ModelEntry("or-gpt-oss-120b", "OR GPT-OSS-120B", "openai/gpt-oss-120b:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 OpenAI开源", ("orgptoss",)),
    "or-gpt-oss-20b": ModelEntry("or-gpt-oss-20b", "OR GPT-OSS-20B", "openai/gpt-oss-20b:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 小版开源", ("orgptoss20",)),
    "or-qwen3-coder": ModelEntry("or-qwen3-coder", "OR Qwen3-Coder", "qwen/qwen3-coder:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 代码王者", ("orqc",)),
    "or-qwen3-next-80b": ModelEntry("or-qwen3-next-80b", "OR Qwen3-Next-80B", "qwen/qwen3-next-80b-a3b-instruct:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Qwen3-Next", ("orqnext",)),
    "or-hermes-405b": ModelEntry("or-hermes-405b", "OR Hermes-3-405B", "nousresearch/hermes-3-llama-3.1-405b:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Nous 405B", ("orh405",)),
    "or-llama-3.3-70b": ModelEntry("or-llama-3.3-70b", "OR Llama-3.3-70B", "meta-llama/llama-3.3-70b-instruct:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Llama3.3", ("orl33",)),
    "or-llama-3.2-3b": ModelEntry("or-llama-3.2-3b", "OR Llama-3.2-3B", "meta-llama/llama-3.2-3b-instruct:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 轻量Llama", ("orl32",)),
    "or-gemma-4-26b": ModelEntry("or-gemma-4-26b", "OR Gemma-4-26B", "google/gemma-4-26b-a4b-it:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Gemma4", ("orgm4",)),
    "or-gemma-4-31b": ModelEntry("or-gemma-4-31b", "OR Gemma-4-31B", "google/gemma-4-31b-it:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Gemma4大版", ("orgm4b",)),
    "or-gemma-3-27b": ModelEntry("or-gemma-3-27b", "OR Gemma-3-27B", "google/gemma-3-27b-it:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Gemma3", ("orgm3",)),
    "or-gemma-3-12b": ModelEntry("or-gemma-3-12b", "OR Gemma-3-12B", "google/gemma-3-12b-it:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Gemma3小", ("orgm3s",)),
    "or-minimax-m2.5": ModelEntry("or-minimax-m2.5", "OR MiniMax-M2.5", "minimax/minimax-m2.5:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 MiniMax", ("ormm25",)),
    "or-step-3.5-flash": ModelEntry("or-step-3.5-flash", "OR Step-3.5-Flash", "stepfun/step-3.5-flash:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 阶跃星辰", ("orstep",)),
    "or-trinity-large": ModelEntry("or-trinity-large", "OR Trinity-Large", "arcee-ai/trinity-large-preview:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Arcee旗舰", ("ortrinity",)),
    "or-lfm-2.5-thinking": ModelEntry("or-lfm-2.5-thinking", "OR LFM-2.5-Thinking", "liquid/lfm-2.5-1.2b-thinking:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 液态思考", ("orlfm",)),
    "or-lfm-2.5": ModelEntry("or-lfm-2.5", "OR LFM-2.5", "liquid/lfm-2.5-1.2b-instruct:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 液态小模型", ("orlfmi",)),
    "or-nemotron-nano-30b": ModelEntry("or-nemotron-nano-30b", "OR Nemotron-Nano-30B", "nvidia/nemotron-3-nano-30b-a3b:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 NVIDIA小版", ("ornn30",)),
    "or-nemotron-nano-9b": ModelEntry("or-nemotron-nano-9b", "OR Nemotron-Nano-9B", "nvidia/nemotron-nano-9b-v2:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 NVIDIA迷你", ("ornn9",)),
    "or-nemotron-nano-12b-vl": ModelEntry("or-nemotron-nano-12b-vl", "OR Nemotron-Nano-12B-VL", "nvidia/nemotron-nano-12b-v2-vl:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 视觉版", ("ornn12",)),
    "or-glm-4.5-air": ModelEntry("or-glm-4.5-air", "OR GLM-4.5-Air", "z-ai/glm-4.5-air:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 智谱轻量", ("orglm45",)),
    "or-dolphin-mistral-24b": ModelEntry("or-dolphin-mistral-24b", "OR Dolphin-Mistral-24B", "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 未审查版", ("ordolphin",)),
    "or-lyria-3-pro": ModelEntry("or-lyria-3-pro", "OR Lyria-3-Pro", "google/lyria-3-pro-preview",
        "https://openrouter.ai/api/v1", "聚合平台", "Google音乐模型", ("orlyria",)),
    "or-owl-alpha": ModelEntry("or-owl-alpha", "OR Owl-Alpha", "openrouter/owl-alpha",
        "https://openrouter.ai/api/v1", "聚合平台", "OR自有模型", ("orowl",)),
    "or-gemini-2.5-pro": ModelEntry("or-gemini-2.5-pro", "OR Gemini-2.5-Pro", "google/gemini-2.5-pro",
        "https://openrouter.ai/api/v1", "聚合平台", "Gemini 2.5旗舰", ("org25p",)),
    "or-gemini-2.5-flash": ModelEntry("or-gemini-2.5-flash", "OR Gemini-2.5-Flash", "google/gemini-2.5-flash:free",
        "https://openrouter.ai/api/v1", "聚合平台", "免费 Gemini2.5快", ("org25f",)),
    "together": ModelEntry("together", "Together AI(聚合)", "meta-llama/Llama-4-Maverick",
        "https://api.together.xyz/v1", "聚合平台", "开源模型托管", ("tai",)),
    # ── 本地模型 ──
    "local": ModelEntry("local", "本地模拟", "local", "", "本地",
        "不调API 测试用", ("mock", "test")),
    "ollama": ModelEntry("ollama", "Ollama 本地", "qwen3:latest",
        "http://localhost:11434/v1", "本地", "Ollama本地推理", ("ollama",)),
    "lmstudio": ModelEntry("lmstudio", "LM Studio 本地", "local-model",
        "http://localhost:1234/v1", "本地", "LM Studio本地推理", ("lms", "studio")),
    "vllm": ModelEntry("vllm", "vLLM 本地", "default",
        "http://localhost:8000/v1", "本地", "vLLM本地推理", ("vllm",)),
    "localai": ModelEntry("localai", "LocalAI 本地", "gpt-4",
        "http://localhost:8080/v1", "本地", "LocalAI本地推理", ("lai",)),
    "textgen": ModelEntry("textgen", "TextGen 本地", "default",
        "http://localhost:5000/v1", "本地", "TextGen本地推理", ("tg", "ooba")),
}


class ModelPool:
    """模型池 — 管理API连接复用 + Agent-模型绑定 + 自定义模型"""

    def __init__(self, default_key: str = "nemotron-super", api_key: str = ""):
        self.default_key = default_key
        self._api_key = api_key
        self._clients: Dict[str, OpenAI] = {}
        self._bindings: Dict[str, str] = {}
        self._custom: Dict[str, ModelEntry] = {}  # 用户自定义模型
        self._per_model_keys: Dict[str, str] = {}  # model key → api_key
        # 多模型兜底链：按优先级依次尝试，直至成功
        self._fallback_chain: list = []
        # 失败模型冷却：记录失败时间，冷却期内跳过
        self._cooldown: Dict[str, float] = {}
        self._cooldown_seconds: float = 60.0  # 1分钟冷却

    @property
    def api_key(self) -> str:
        return self._api_key

    @api_key.setter
    def api_key(self, value: str):
        if self._api_key != value:
            self._clients.clear()  # key 变了，清空旧缓存
        self._api_key = value

    # ---- 每模型独立 API Key ----
    def set_model_key(self, model_key: str, api_key: str):
        """为指定模型设置独立 API Key"""
        self._per_model_keys[model_key] = api_key
        # 清除该 base_url 的缓存客户端，强制重建
        entry = self.all_models.get(model_key)
        if entry:
            self._clients.pop(entry.base_url, None)

    def remove_model_key(self, model_key: str):
        """移除指定模型的独立 API Key"""
        self._per_model_keys.pop(model_key, None)
        entry = self.all_models.get(model_key)
        if entry:
            self._clients.pop(entry.base_url, None)

    def model_has_key(self, model_key: str) -> bool:
        """模型是否已配置独立 Key"""
        return model_key in self._per_model_keys and bool(self._per_model_keys[model_key])

    def get_model_key(self, model_key: str) -> str:
        """获取模型的 API Key：优先独立 Key，否则全局 Key"""
        return self._per_model_keys.get(model_key, self._api_key)

    @property
    def per_model_keys(self) -> Dict[str, bool]:
        """返回各模型的独立 Key 配置状态（只返回是否已配，不暴露 Key 内容）"""
        return {k: bool(v) for k, v in self._per_model_keys.items()}

    @property
    def all_models(self) -> Dict[str, ModelEntry]:
        """合并内置+自定义"""
        merged = {**BUILTIN_MODELS, **self._custom}
        return merged

    def add_custom(self, name: str, model_id: str, base_url: str, provider: str = "自定义") -> ModelEntry:
        """添加自定义模型"""
        key = f"_custom_{name.lower().replace(' ', '-')}"
        entry = ModelEntry(key, name, model_id, base_url, provider,
                           "用户自定义", custom=True)
        self._custom[key] = entry
        return entry

    def remove_custom(self, key: str):
        self._custom.pop(key, None)

    # ---- Agent绑定 ----
    def bind(self, agent: str, key: str):
        if key not in self.all_models:
            raise ValueError(f"未知模型: {key}")
        self._bindings[agent] = key

    def unbind(self, agent: str):
        self._bindings.pop(agent, None)

    def get_key(self, agent: str) -> str:
        return self._bindings.get(agent, self.default_key)

    def get_model(self, agent: str) -> ModelEntry:
        return self.all_models[self.get_key(agent)]

    def set_default(self, key: str):
        if key not in self.all_models:
            raise ValueError(f"未知模型: {key}")
        self.default_key = key

    # ---- 模糊匹配 ----
    def resolve(self, query: str) -> Optional[str]:
        q = query.lower().strip()
        models = self.all_models
        if q in models:
            return q
        for k, v in models.items():
            if q == v.model_id.lower():
                return k
        for k, v in models.items():
            if q in v.aliases:
                return k
            if q in k.lower() or q in v.name.lower():
                return k
        return None

    # ---- API调用 ----
    def _get_client(self, base_url: str, model_key: str = "") -> Optional[OpenAI]:
        if not base_url:
            return None
        # 有 model_key 时用独立 Key，否则用全局 Key
        api_key = self.get_model_key(model_key) if model_key else self.api_key
        cache_key = f"{base_url}::{model_key}" if model_key else base_url
        if cache_key not in self._clients:
            try:
                self._clients[cache_key] = _get_openai()(api_key=api_key, base_url=base_url)
            except Exception:
                return None
        return self._clients[cache_key]

    def call_llm(self, agent: str, messages: list, tools: list = None, model_override: str = None) -> dict:
        """单次调用，内部委托到 call_llm_with_fallback（不启用兜底）"""
        return self.call_llm_with_fallback(agent, messages, tools, fallback_models=[], max_fallbacks=0, model_override=model_override)

    # ═══ 多模型兜底 ═══

    def set_fallback_chain(self, keys: list):
        """设置兜底链：模型key列表，按优先级依次尝试。传入空列表清空兜底。"""
        for k in keys:
            if k not in self.all_models:
                raise ValueError(f"未知模型: {k}")
        self._fallback_chain = list(keys)

    def clear_cooldown(self, model_key: str = ""):
        """清除模型冷却状态"""
        if model_key:
            self._cooldown.pop(model_key, None)
        else:
            self._cooldown.clear()

    def call_llm_with_fallback(
        self, agent: str, messages: list, tools: list = None,
        fallback_models: list = None, max_fallbacks: int = 5,
        model_override: str = None,
    ) -> dict:
        """多模型兜底调用：依次尝试主模型和备用模型，直至成功。
        
        - 先调用主模型（agent 绑定或默认）
        - 主模型失败后，按 fallback_models → _fallback_chain 顺序尝试
        - 处于冷却期的模型自动跳过
        - 返回第一个成功结果；全部失败则返回最后一次错误
        
        返回结果中额外字段：
          _model: 最终使用的模型名称
          _tried: 尝试过的模型列表 [(key, ok/err), ...]
          _fallback_used: 是否使用了备用模型
        """
        tried = []
        primary_key = model_override if model_override and model_override in self.all_models else self.get_key(agent)

        # 构建尝试列表：去重，跳过冷却期模型
        candidates = [primary_key]
        if fallback_models:
            candidates += fallback_models
        candidates += self._fallback_chain
        seen = set()
        ordered = []
        now = time.time()
        for k in candidates:
            if k in seen:
                continue
            seen.add(k)
            # 跳过冷却期内的模型（主模型不跳）
            if k != primary_key and k in self._cooldown:
                if now - self._cooldown[k] < self._cooldown_seconds:
                    tried.append((k, "冷却中"))
                    continue
                else:
                    del self._cooldown[k]  # 冷却到期
            ordered.append(k)
            if len(ordered) >= max_fallbacks + 1:
                break

        last_error = None
        for i, key in enumerate(ordered):
            model = self.all_models[key]
            client = self._get_client(model.base_url, key)
            if client is None:
                tried.append((key, "无API连接"))
                continue

            params = {"model": model.model_id, "messages": messages[-20:], "max_tokens": 4096}
            if tools:
                params["tools"] = tools
            # NVIDIA MiniMax 必须走 streaming，否则超时或空返回
            if key.startswith("nv-minimax"):
                params["stream"] = True
            try:
                if params.get("stream"):
                    stream = client.chat.completions.create(**params)
                    full_content = ""
                    tool_calls_data = {}
                    final_model = ""
                    for chunk in stream:
                        if not chunk.choices:
                            continue
                        delta = chunk.choices[0].delta
                        if delta.content:
                            full_content += delta.content
                        if delta.tool_calls:
                            for tc in delta.tool_calls:
                                idx = tc.index
                                if idx not in tool_calls_data:
                                    tool_calls_data[idx] = {"id": tc.id or f"call_{idx}", "function": {"name": "", "arguments": ""}}
                                if tc.id:
                                    tool_calls_data[idx]["id"] = tc.id
                                if tc.function and tc.function.name:
                                    tool_calls_data[idx]["function"]["name"] += tc.function.name
                                if tc.function and tc.function.arguments:
                                    tool_calls_data[idx]["function"]["arguments"] += tc.function.arguments
                        if chunk.model:
                            final_model = chunk.model
                    tc_list = [tool_calls_data[k] for k in sorted(tool_calls_data.keys())] if tool_calls_data else None
                    d = {
                        "id": "", "choices": [{"message": {"role": "assistant", "content": full_content}}],
                        "created": 0, "model": final_model, "object": "chat.completion",
                        "usage": {}, "system_fingerprint": None, "moderation": None, "service_tier": None,
                    }
                    if tc_list:
                        d["choices"][0]["message"]["tool_calls"] = tc_list
                else:
                    resp = client.chat.completions.create(**params)
                    d = resp.model_dump()
                d["_model"] = model.name
                d["_tried"] = tried
                d["_fallback_used"] = (i > 0)
                return d
            except Exception as e:
                err_msg = str(e)[:80]
                tried.append((key, err_msg))
                self._cooldown[key] = now  # 进入冷却
                last_error = err_msg
                continue

        # 全部失败
        return {
            "choices": [{"message": {"role": "assistant",
                "content": f"[多模型全部失败] 已尝试: {' → '.join(k for k,_ in tried)}。最后错误: {last_error}"}}],
            "usage": {"total_tokens": 0},
            "_model": "fallback-exhausted",
            "_tried": tried,
            "_fallback_used": True,
        }

    def status(self) -> str:
        lines = [f"默认: {self.all_models[self.default_key].name}"]
        for agent, k in self._bindings.items():
            lines.append(f"  {agent} → {self.all_models[k].name}")
        return "\n".join(lines) if len(lines) > 1 else lines[0]

    def table(self) -> str:
        lines = []
        for i, (k, v) in enumerate(self.all_models.items(), 1):
            marker = "★" if k == self.default_key else " "
            tag = "自定义" if v.custom else ("需Key" if v.base_url else "本地")
            lines.append(f"  [{i}] {marker} {v.name:<18s} {v.provider:<12s} {tag}  {v.description}")
        return "\n".join(lines)

    def to_list(self) -> list:
        """返回模型列表，供前端渲染"""
        result = []
        for k, v in self.all_models.items():
            result.append({
                "key": k, "name": v.name, "model_id": v.model_id,
                "base_url": v.base_url, "provider": v.provider,
                "description": v.description, "custom": v.custom,
                "has_key": self.model_has_key(k),
            })
        return result

    def providers(self) -> list:
        """厂商列表"""
        seen = set()
        result = []
        for v in self.all_models.values():
            if v.provider not in seen:
                seen.add(v.provider)
                result.append(v.provider)
        return result
