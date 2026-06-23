"""
扣子风格多Agent系统 — 父Bot路由 + 子Bot执行 + 独立记忆
"""
import json, time, os
from typing import List, Dict, Optional
from dataclasses import dataclass, field
from memory import AgentMemory
from logger import Logger
from models import ModelPool


# ── 工具（插件）────────────────────────────────────────
@dataclass
class Tool:
    """插件 — 封装API为工具"""
    name: str
    description: str
    params: dict
    executor: callable = None

    def schema(self) -> dict:
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


# ── 工具实现 ──────────────────────────────────────────
_WIKI_AVAILABLE = False
try:
    import wikipedia as _wikipedia
    _WIKI_AVAILABLE = True
except ImportError:
    pass

def _wiki(args):
    if not _WIKI_AVAILABLE:
        return "维基百科插件未安装。请在终端执行: pip install wikipedia"
    try:
        out = []
        for t in _wikipedia.search(args["query"], results=3):
            try:
                p = _wikipedia.page(t, auto_suggest=False)
                out.append(f"**{t}**: {p.summary[:200]}")
            except: pass
        return "\n\n".join(out) or "未找到"
    except Exception as e: return f"搜索失败: {e}"

def _weather(args):
    import urllib.request, urllib.parse
    try:
        city = urllib.parse.quote(args["city"])
        req = urllib.request.Request(
            f"https://wttr.in/{city}?format=%C+%t+%h",
            headers={"User-Agent": "curl"}
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.read().decode()
    except Exception as e: return f"天气查询失败: {e}"

def _ls(args):
    try:
        files = os.listdir(args["path"])
        return f"共 {len(files)} 个: {', '.join(files[:20])}"
    except Exception as e: return f"错误: {e}"

def _read(args):
    try:
        with open(args["path"]) as f: return f.read()[:2000]
    except Exception as e: return f"读取失败: {e}"

def _write(args):
    try:
        with open(args["path"], "w") as f: f.write(args["content"])
        return f"已写入 {args['path']}"
    except Exception as e: return f"写入失败: {e}"


# ── 子Bot ────────────────────────────────────────────
@dataclass
class ChildBot:
    """子Agent — 独立人设+插件+知识库+记忆"""
    name: str
    description: str
    system_prompt: str
    tools: List[Tool] = field(default_factory=list)
    knowledge: List[str] = field(default_factory=list)

    def __post_init__(self):
        self.memory = AgentMemory()  # 每个子Bot独立记忆

    def tool_schemas(self) -> list:
        return [t.schema() for t in self.tools]

    def exec_tool(self, name: str, args: dict) -> str:
        for t in self.tools:
            if t.name == name and t.executor:
                return t.executor(args)
        return f"[{name}] 工具未注册"


# ── 父Bot ────────────────────────────────────────────
class ParentBot:
    """主Bot — 意图识别路由器 + 结果汇总"""

    ROUTER_PROMPT = """你是任务路由器。根据用户消息，选择最合适的子Agent处理。
只输出子Agent的名称，不要解释。

可用子Agent：
- 搜索Agent: 联网搜索、查实时信息、天气、百科、新闻
- 代码Agent: 编程、写代码、调试、算法、技术问题
- 文件Agent: 读写文件、文件管理、文档处理

用户消息：{query}

选中的Agent（只输出名称）："""

    SUMMARIZE_PROMPT = """你是总协调。用户的原始问题是：
{original_query}

子Agent【{agent_name}】的回复是：
{agent_reply}

请将子Agent的回复整理成简洁的最终答案呈现给用户。如果子Agent的回复已经足够好，直接保留核心内容。"""

    def __init__(self, pool: ModelPool, verbose: bool = True):
        self.pool = pool
        self.log = Logger(enabled=verbose)
        self.children: Dict[str, ChildBot] = {}
        self.shared_msgs: List[dict] = []  # 父Bot的对话历史
        self._init_children()

    def _init_children(self):
        self.children = {
            "搜索Agent": ChildBot(
                name="搜索Agent",
                description="联网搜索、查实时信息、天气、百科",
                system_prompt="你是信息检索专家。收到查询后调用插件获取数据，整理结果并注明来源。语气简洁专业。",
                tools=[
                    Tool("search_wikipedia", "搜维基百科", {"query": {"type": "string", "description": "关键词"}}, _wiki),
                    Tool("get_weather", "查天气", {"city": {"type": "string", "description": "城市名"}}, _weather),
                ],
            ),
            "代码Agent": ChildBot(
                name="代码Agent",
                description="编程、写代码、调试、算法",
                system_prompt="你是编程专家。直接写可运行代码放```块中，解释要简洁。优先Python。",
                tools=[],
            ),
            "文件Agent": ChildBot(
                name="文件Agent",
                description="读写文件、文件管理、文档处理",
                system_prompt="你是文件管理助手。执行操作并报告结果。写文件前确认内容正确。",
                tools=[
                    Tool("list_files", "列出文件", {"path": {"type": "string", "description": "路径"}}, _ls),
                    Tool("read_file", "读文件", {"path": {"type": "string", "description": "路径"}}, _read),
                    Tool("write_file", "写文件", {"path": {"type": "string", "description": "路径"}, "content": {"type": "string", "description": "内容"}}, _write),
                ],
            ),
        }

    # ── 路由 ──────────────────────────────────────────
    def _route(self, query: str) -> str:
        """LLM意图识别 → 选子Bot"""
        prompt = self.ROUTER_PROMPT.format(query=query)
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self.pool.call_llm("__router__", msgs)
            choice = resp["choices"][0]["message"]["content"].strip()
            self.log.sys(f'LLM路由 → "{choice}"')
            if choice in self.children:
                return choice
            # 模糊匹配
            for name in self.children:
                if name in choice or choice in name:
                    self.log.sys(f'模糊匹配 → "{name}"')
                    return name
        except Exception as e:
            self.log.error(f"LLM路由失败: {e}")

        return self._keyword_route(query)

    def _keyword_route(self, query: str) -> str:
        q = query.lower()
        kw = {
            "搜索Agent": ["搜索", "查", "什么是", "天气", "百科", "维基", "wiki", "新闻", "几度"],
            "代码Agent": ["代码", "写", "python", "bug", "报错", "函数", "算法", "编程", "脚本", "开发"],
            "文件Agent": ["文件", "保存", "读取", "目录", "列表", "创建", "写入", "文档"],
        }
        best = "搜索Agent"
        best_s = 0
        for name, kws in kw.items():
            s = sum(1 for k in kws if k in q)
            if s > best_s:
                best_s, best = s, name
        self.log.sys(f'关键词路由 → "{best}" (得分:{best_s})')
        return best

    # ── 对话 ──────────────────────────────────────────
    def chat(self, user_input: str) -> str:
        # 1. LLM路由
        child_name = self._route(user_input)
        child = self.children[child_name]
        self.log.agent(child_name, "选中")

        # 2. 子Bot独立记忆检索
        recalled = child.memory.recall(user_input)
        mem_text = ""
        if recalled:
            mem_lines = [f"[记忆] {m.content}" for m in recalled]
            mem_text = "\n".join(mem_lines)
            self.log.memory(f"{child_name}", f"命中{len(recalled)}条")

        # 3. 构建子Bot消息（系统提示 + 知识库 + 压缩上下文 + 记忆 + 用户输入）
        messages = [{"role": "system", "content": child.system_prompt}]

        if child.knowledge:
            kb_text = "\n\n".join(child.knowledge)
            messages.append({"role": "system", "content": f"[知识库]\n{kb_text}"})

        # 压缩父Bot历史传给子Bot（最近6轮摘要）
        recent = self.shared_msgs[-12:]
        if recent:
            ctx = " | ".join(
                f"{'Q' if m['role']=='user' else 'A'}: {m['content'][:60]}"
                for m in recent
            )
            messages.append({"role": "system", "content": f"[上下文摘要]\n{ctx}"})

        content = f"{mem_text}\n---\n{user_input}" if mem_text else user_input
        messages.append({"role": "user", "content": content})

        # 4. 子Bot执行（工具循环）
        child_reply = self._run_child(child, messages)

        # 5. 子Bot自主记忆
        self._child_memorize(child, user_input, child_reply)

        # 6. 存入父Bot共享历史
        self.shared_msgs.append({"role": "user", "content": user_input})
        self.shared_msgs.append({"role": "assistant", "content": child_reply})
        if len(self.shared_msgs) > 40:
            self.shared_msgs = self.shared_msgs[-40:]

        return child_reply

    def _run_child(self, child: ChildBot, messages: list) -> str:
        """子Bot工具调用循环"""
        tools = child.tool_schemas()
        for loop in range(5):
            t0 = time.time()
            resp = self.pool.call_llm(child.name, messages, tools)
            latency = time.time() - t0

            usage = resp.get("usage", {})
            model = resp.get("_model", "?")
            self.log.llm(model, usage.get("total_tokens", 0), latency)

            msg = resp["choices"][0]["message"]
            tcs = msg.get("tool_calls")

            if not tcs:
                reply = msg.get("content", "")
                if loop > 0:
                    self.log.sys(f"工具完成({loop}轮)")
                return reply

            messages.append(msg)
            for tc in tcs:
                fn = tc["function"]["name"]
                fa = json.loads(tc["function"]["arguments"])
                self.log.tool_start(fn, fa)
                result = child.exec_tool(fn, fa)
                self.log.tool_end(result)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": str(result),
                })

        return "[子Agent] 工具调用轮数超限"

    def _child_memorize(self, child: ChildBot, user_input: str, reply: str):
        """子Bot自主写入记忆"""
        triggers = ["重要", "记住", "别忘了", "我的名字", "我叫"]
        if any(t in user_input for t in triggers) or len(user_input) > 100:
            imp = 0.7 if any(t in user_input for t in triggers) else 0.4
            child.memory.add(f"用户: {user_input[:80]}...", imp)
            self.log.memory(f"{child.name}", f"写入 重要性:{imp:.1f}")

    def reset(self):
        self.shared_msgs = []
        for child in self.children.values():
            child.memory = AgentMemory()
        self.log.sys("对话已重置")

    def status(self) -> str:
        lines = [f"父Bot — {len(self.children)}个子Agent"]
        for name, child in self.children.items():
            model = self.pool.get_model(name)
            s = child.memory.get_stats()
            lines.append(
                f"  {name}: {model.name} | 插件:{len(child.tools)} | "
                f"知识库:{len(child.knowledge)}条 | 记忆:{s['短期记忆']}短/{s['中期记忆']}中"
            )
        lines.append(f"  父Bot对话: {len(self.shared_msgs)//2}轮")
        return "\n".join(lines)
