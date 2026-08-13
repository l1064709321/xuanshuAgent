"""
protocol.py — 玄姝协议抽象层
提取核心类型定义、路由常量、沙箱策略，解耦 core.py 与前端/工具链。

职责边界：
- 类型定义：消息格式、工具调用格式、Agent 路由表
- 策略常量：复杂度分层、沙箱模式、降级链
- 禁止：不包含任何执行逻辑、LLM 调用、I/O 操作
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any, Literal

# ── 消息协议 ──────────────────────────────────────────

@dataclass
class Message:
    """标准化消息格式，兼容 OpenAI Chat Completions API"""
    role: str          # system | user | assistant | tool
    content: str = ""
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[dict]] = None
    cache_control: Optional[dict] = None  # Anthropic 缓存标记

    def to_dict(self) -> dict:
        d = {"role": self.role, "content": self.content}
        if self.name:
            d["name"] = self.name
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        if self.tool_calls:
            d["tool_calls"] = self.tool_calls
        if self.cache_control:
            d["cache_control"] = self.cache_control
        return d

# ── 工具协议 ──────────────────────────────────────────

@dataclass
class ToolSpec:
    """工具规格定义（前端/Agent 通用），不含 executor"""
    name: str
    description: str
    params: dict              # JSON Schema properties
    sandbox_mode: str = "none"  # none | auto | sandbox

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": self.params,
                    "required": list(self.params.keys()),
                },
            },
        }

TOOL_CALL_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "工具名"},
        "arguments": {"type": "object", "description": "工具参数"},
    },
    "required": ["name", "arguments"],
}

# ── Agent 路由协议 ────────────────────────────────────

# 复杂度分层常量
COMPLEXITY_CHEAP_KW = ["翻译", "总结", "是什么", "怎么样", "天气", "几点", "日期", "缩写", "格式"]
COMPLEXITY_NORMAL_KW = ["写", "代码", "生成", "分析", "脚本", "实现", "修复", "构建", "创建", "部署"]
COMPLEXITY_STRONG_KW = ["重构", "优化整个", "全面", "完整项目", "架构", "安全审计", "全部替换"]

# Agent 路由表：Agent 名 → (描述, 工具列表提示)
AGENT_ROUTING_TABLE: Dict[str, tuple] = {
    "小搜": ("联网搜索、查实时信息、天气、百科、新闻", ["anysearch", "web_fetch"]),
    "小览": ("端到端Web交互（打开网页、点击、填表、滚动、截屏）", ["browser_navigate", "browser_click", "browser_screenshot"]),
    "小码": ("编程、写代码、调试、算法、技术问题", ["run_code", "python_exec", "shell_exec"]),
    "小文": ("读写文件、文件管理、文档处理", ["read_file", "write_file", "list_dir"]),
    "小屏": ("系统控制、进程管理、资源监控、软件包管理", ["sys_info", "exec_command"]),
    "小手机": ("手机控制、ADB 操作", ["adb_screenshot", "adb_tap", "adb_swipe"]),
}

# ── 沙箱协议 ──────────────────────────────────────────

SANDOX_MODE = Literal["none", "auto", "sandbox"]

# 代码执行类工具名集合（auto 模式下自动触发沙箱）
CODE_TOOL_NAMES: set = {"run_code", "python_exec", "shell_exec", "bash", "exec_python", "eval"}

# 代码类参数名：参数中任一字段命中则触发沙箱
CODE_ARG_KEYS: set = {"code", "command", "script", "cmd", "source"}

def classify_sandbox_policy(tool_name: str, tool_sandbox_mode: str, args: dict) -> bool:
    """判定是否应对该工具调用启用沙箱。
    返回 True 表示应沙箱化执行。"""
    if tool_sandbox_mode == "sandbox":
        return True
    if tool_sandbox_mode == "auto":
        if tool_name in CODE_TOOL_NAMES:
            return True
        if any(k in args for k in CODE_ARG_KEYS):
            return True
    return False

# ── 工具降级链 ────────────────────────────────────────

DEGRADATION_CHAINS: Dict[str, list] = {
    "web_search": ["anysearch", "search_wikipedia", "web_fetch"],
    "anysearch": ["web_search", "search_wikipedia"],
}

# ── 上下文窗口常量 ─────────────────────────────────────

# 滚动压缩阈值：shared_msgs 超此数量触发压缩
COMPRESS_MSG_THRESHOLD = 80

# 压缩保留数
COMPRESS_KEEP_COUNT = 80

# 增量蒸馏最少增量条数
MIN_DISTILL_DELTA = 2

# Agent 循环上限（替代旧硬编码 5）
MAX_AGENT_LOOPS = 12

# ── 缓存协议 ──────────────────────────────────────────

# 支持前缀缓存的模型提供商模式
CACHE_ANTHROPIC_PATTERNS = ("claude", "anthropic")
CACHE_DS_OPENAI_PATTERNS = ("deepseek", "gpt", "openai", "qwen")

# ── Token 预算 ─────────────────────────────────────────

# 默认日 token 预算
DEFAULT_DAILY_TOKEN_BUDGET = 1_000_000

# ── 记忆文件 ───────────────────────────────────────────

MEMORY_FILE = "MEMORY.md"       # Agent 自身经验
USER_FILE = "USER.md"           # 用户画像
MEMORY_MAX_CHARS = 8000         # MEMORY.md 容量上限
USER_MAX_CHARS = 3000           # USER.md 容量上限
