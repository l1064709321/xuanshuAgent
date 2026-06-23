"""
模型池 - 每Agent独立绑定，运行时动态切换
"""
from typing import Dict, Optional
from dataclasses import dataclass
from openai import OpenAI


@dataclass
class ModelEntry:
    key: str            # qwen25-7b
    name: str           # Qwen2.5-7B
    model_id: str       # Qwen/Qwen2.5-7B-Instruct
    base_url: str
    provider: str
    description: str = ""
    aliases: tuple = ()  # 别名用于模糊匹配


BUILTIN_MODELS: Dict[str, ModelEntry] = {
    "qwen25-7b": ModelEntry(
        "qwen25-7b", "Qwen2.5-7B", "Qwen/Qwen2.5-7B-Instruct",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "免费 速度快", ("qwen7", "qwen", "7b"),
    ),
    "qwen25-32b": ModelEntry(
        "qwen25-32b", "Qwen2.5-32B", "Qwen/Qwen2.5-32B-Instruct",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "免费 能力强", ("qwen32", "32b"),
    ),
    "deepseek-v3": ModelEntry(
        "deepseek-v3", "DeepSeek-V3", "deepseek-ai/DeepSeek-V3",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "旗舰通用 付费", ("deepseek", "v3", "ds"),
    ),
    "deepseek-r1": ModelEntry(
        "deepseek-r1", "DeepSeek-R1", "deepseek-ai/DeepSeek-R1",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "推理思维链 付费", ("r1", "reasoning"),
    ),
    "glm4-9b": ModelEntry(
        "glm4-9b", "GLM-4-9B", "THUDM/glm-4-9b-chat",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "智谱 免费", ("glm", "glm4", "9b", "zhipu"),
    ),
    "llama3-8b": ModelEntry(
        "llama3-8b", "Llama3.1-8B", "meta-llama/Meta-Llama-3.1-8B-Instruct",
        "https://api.siliconflow.cn/v1", "SiliconFlow",
        "Meta 免费", ("llama", "meta", "8b"),
    ),
    "local": ModelEntry(
        "local", "本地模拟", "local", "", "本地",
        "不调API 测试用", ("mock", "test"),
    ),
}


class ModelPool:
    """模型池 - 管理API连接复用 + Agent-模型绑定"""

    def __init__(self, default_key: str = "local", api_key: str = ""):
        self.default_key = default_key
        self.api_key = api_key
        self._clients: Dict[str, OpenAI] = {}
        self._bindings: Dict[str, str] = {}  # agent_name → model_key

    # ---- Agent绑定 ----
    def bind(self, agent: str, key: str):
        if key not in BUILTIN_MODELS:
            raise ValueError(f"未知模型: {key}")
        self._bindings[agent] = key

    def unbind(self, agent: str):
        self._bindings.pop(agent, None)

    def get_key(self, agent: str) -> str:
        return self._bindings.get(agent, self.default_key)

    def get_model(self, agent: str) -> ModelEntry:
        return BUILTIN_MODELS[self.get_key(agent)]

    def set_default(self, key: str):
        if key not in BUILTIN_MODELS:
            raise ValueError(f"未知模型: {key}")
        self.default_key = key

    # ---- 模糊匹配 ----
    def resolve(self, query: str) -> Optional[str]:
        """别名/关键词 → model_key"""
        q = query.lower().strip()
        # 精确匹配 key
        if q in BUILTIN_MODELS:
            return q
        # 精确匹配 model_id
        for k, v in BUILTIN_MODELS.items():
            if q == v.model_id.lower():
                return k
        # 别名匹配
        for k, v in BUILTIN_MODELS.items():
            if q in v.aliases:
                return k
            if q in k.lower():
                return k
            if q in v.name.lower():
                return k
        return None

    # ---- API调用 ----
    def _get_client(self, base_url: str) -> Optional[OpenAI]:
        if not base_url:
            return None
        if base_url not in self._clients:
            self._clients[base_url] = OpenAI(api_key=self.api_key, base_url=base_url)
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

    # ---- 状态查询 ----
    def status(self) -> str:
        """当前模型绑定状态"""
        lines = [f"默认: {BUILTIN_MODELS[self.default_key].name}"]
        for agent, k in self._bindings.items():
            lines.append(f"  {agent} → {BUILTIN_MODELS[k].name}")
        return "\n".join(lines) if len(lines) > 1 else lines[0]

    def table(self) -> str:
        """模型列表表格"""
        lines = []
        for i, (k, v) in enumerate(BUILTIN_MODELS.items(), 1):
            marker = "★" if k == self.default_key else " "
            tag = "免费" if "免费" in v.description else "付费"
            lines.append(f"  [{i}] {marker} {v.name:<16s} {v.provider:<12s} {tag}  {v.description}")
        return "\n".join(lines)
