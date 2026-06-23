"""
模型池 — 30+ 主流大模型，支持自定义添加
"""
from typing import Dict, Optional
from dataclasses import dataclass, field

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
    "gpt-4o": ModelEntry("gpt-4o", "GPT-4o", "gpt-4o",
        "https://api.openai.com/v1", "OpenAI", "多模态旗舰", ("4o",)),
    "gpt-4o-mini": ModelEntry("gpt-4o-mini", "GPT-4o-mini", "gpt-4o-mini",
        "https://api.openai.com/v1", "OpenAI", "轻量多模态", ("4omini", "mini")),
    "gpt-4.1": ModelEntry("gpt-4.1", "GPT-4.1", "gpt-4.1",
        "https://api.openai.com/v1", "OpenAI", "2025迭代版", ("4.1", "41")),
    "o3": ModelEntry("o3", "o3", "o3",
        "https://api.openai.com/v1", "OpenAI", "推理增强", tuple()),
    "o4-mini": ModelEntry("o4-mini", "o4-mini", "o4-mini",
        "https://api.openai.com/v1", "OpenAI", "轻量推理", ("o4",)),
    # ── Anthropic ──
    "claude-4-sonnet": ModelEntry("claude-4-sonnet", "Claude 4 Sonnet", "claude-sonnet-4-20250514",
        "https://api.anthropic.com/v1", "Anthropic", "通用创作/代码", ("sonnet", "claude4s")),
    "claude-4-opus": ModelEntry("claude-4-opus", "Claude 4 Opus", "claude-opus-4-20250514",
        "https://api.anthropic.com/v1", "Anthropic", "旗舰高性能", ("opus", "claude4o")),
    "claude-3.5-haiku": ModelEntry("claude-3.5-haiku", "Claude 3.5 Haiku", "claude-3-5-haiku-20241022",
        "https://api.anthropic.com/v1", "Anthropic", "轻量快速", ("haiku", "claude35")),
    # ── Google ──
    "gemini-2.5-pro": ModelEntry("gemini-2.5-pro", "Gemini 2.5 Pro", "gemini-2.5-pro-exp-03-25",
        "https://generativelanguage.googleapis.com/v1beta", "Google", "多模态", ("gemini25", "g25p")),
    "gemini-2.5-flash": ModelEntry("gemini-2.5-flash", "Gemini 2.5 Flash", "gemini-2.5-flash",
        "https://generativelanguage.googleapis.com/v1beta", "Google", "轻量快速", ("g25f", "flash")),
    # ── DeepSeek ──
    "deepseek-v3": ModelEntry("deepseek-v3", "DeepSeek-V3", "deepseek-chat",
        "https://api.deepseek.com/v1", "DeepSeek", "旗舰通用", ("ds", "v3", "deepseek")),
    "deepseek-r1": ModelEntry("deepseek-r1", "DeepSeek-R1", "deepseek-reasoner",
        "https://api.deepseek.com/v1", "DeepSeek", "推理思维链", ("r1", "reasoner")),
    # ── 阿里通义 ──
    "qwen3-235b": ModelEntry("qwen3-235b", "Qwen3-235B", "qwen3-235b-a22b",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "旗舰多模态", ("qwen3", "235b")),
    "qwen2.5-72b": ModelEntry("qwen2.5-72b", "Qwen2.5-72B", "qwen2.5-72b-instruct",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "开源千亿参数", ("qwen72", "72b")),
    "qwen2.5-32b": ModelEntry("qwen2.5-32b", "Qwen2.5-32B", "qwen2.5-32b-instruct",
        "https://dashscope.aliyuncs.com/compatible-mode/v1", "阿里通义", "高性价比", ("qwen32", "32b")),
    # ── 智谱 ──
    "glm-4-plus": ModelEntry("glm-4-plus", "GLM-4-Plus", "glm-4-plus",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "旗舰高性能", ("glm4p", "glmplus")),
    "glm-4-air": ModelEntry("glm-4-air", "GLM-4-Air", "glm-4-air",
        "https://open.bigmodel.cn/api/paas/v4/", "智谱", "轻量低成本", ("glm4a", "glmair")),
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
        "https://api.minimax.chat/v1", "Minimax", "多模态语音", ("minimax", "abab")),
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
    # ── 聚合平台 ──
    "siliconflow": ModelEntry("siliconflow", "SiliconFlow(聚合)", "deepseek-ai/DeepSeek-V3",
        "https://api.siliconflow.cn/v1", "聚合平台", "支持多模型，用/model切换model_id", ("sf", "硅基")),
    "openrouter": ModelEntry("openrouter", "OpenRouter(聚合)", "openai/gpt-4o",
        "https://openrouter.ai/api/v1", "聚合平台", "海外聚合 200+模型", ("or",)),
    "together": ModelEntry("together", "Together AI(聚合)", "meta-llama/Llama-4-Maverick",
        "https://api.together.xyz/v1", "聚合平台", "开源模型托管", ("tai",)),
    # ── 本地模拟 ──
    "local": ModelEntry("local", "本地模拟", "local", "", "本地",
        "不调API 测试用", ("mock", "test")),
}


class ModelPool:
    """模型池 — 管理API连接复用 + Agent-模型绑定 + 自定义模型"""

    def __init__(self, default_key: str = "local", api_key: str = ""):
        self.default_key = default_key
        self.api_key = api_key
        self._clients: Dict[str, OpenAI] = {}
        self._bindings: Dict[str, str] = {}
        self._custom: Dict[str, ModelEntry] = {}  # 用户自定义模型

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
    def _get_client(self, base_url: str) -> Optional[OpenAI]:
        if not base_url:
            return None
        if base_url not in self._clients:
            self._clients[base_url] = _get_openai()(api_key=self.api_key, base_url=base_url)
        return self._clients[base_url]

    def call_llm(self, agent: str, messages: list, tools: list = None) -> dict:
        model = self.get_model(agent)
        client = self._get_client(model.base_url)

        if client is None:
            last = messages[-1]["content"][:60] if messages else ""
            return {
                "choices": [{"message": {"content": f"[{model.name}] {last}... (连API)", "tool_calls": None}}],
                "usage": {"total_tokens": 0},
                "_model": model.name,
            }

        params = {"model": model.model_id, "messages": messages[-20:]}
        if tools:
            params["tools"] = tools
        try:
            resp = client.chat.completions.create(**params)
            d = resp.model_dump()
            d["_model"] = model.name
            return d
        except Exception as e:
            return {
                "choices": [{"message": {"role": "assistant", "content": f"[{model.name}] API错误: {e}"}}],
                "usage": {"total_tokens": 0},
                "_model": model.name,
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
                "description": v.description, "custom": v.custom
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
