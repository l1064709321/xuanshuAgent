"""
扣子风格多Agent系统 — 父Bot路由 + 子Bot执行 + 独立记忆
"""
import json, time, os
from typing import List, Dict, Optional
from dataclasses import dataclass, field
from memory import AgentMemory
from logger import Logger
from models import ModelPool


@dataclass
class Tool:
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


def _wiki(args):
    try:
        import wikipedia
        out = []
        for t in wikipedia.search(args["query"], results=3):
            try:
                p = wikipedia.page(t, auto_suggest=False)
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


@dataclass
class ChildBot:
    name: str
    description: str
    system_prompt: str
    tools: List[Tool] = field(default_factory=list)
    knowledge: List[str] = field(default_factory=list)

    def __post_init__(self):
        self.memory = AgentMemory()

    def tool_schemas(self) -> list:
        return [t.schema() for t in self.tools]

    def exec_tool(self, name: str, args: dict) -> str:
        for t in self.tools:
            if t.name == name and t.executor:
                return t.executor(args)
        return f"[{name}] 工具未注册"


class ParentBot:
    ROUTER_PROMPT = """你是任务路由器。根据用户消息，选择最合适的子Agent处理。
只输出子Agent的名称，不要解释。

可用子Agent：
- 搜索Agent: 联网搜索、查实时信息、天气、百科、新闻
- 代码Agent: 编程、写代码、调试、算法、技术问题
- 文件Agent: 读写文件、文件管理、文档处理

用户消息：{query}

选中的Agent（只输出名称）："""

    def __init__(self, pool, verbose=True):
        self.pool = pool
        self.log = Logger(enabled=verbose)
        self.children: Dict[str, ChildBot] = {}
        self.shared_msgs: List[dict] = []
        self._init_children()

    def _init_children(self):
        self.children = {
            "搜索Agent": ChildBot(
                name="搜索Agent",
                description="联网搜索、查实时信息、天气、百科",
                system_prompt="你是信息检索专家。收到查询后调用插件获取数据，整理结果并注明来源。语气简洁专业。",
                tools=[
                    Tool("search_wikipedia", "搜维基百科", {"query":{"type":"string","description":"关键词"}}, _wiki),
                    Tool("get_weather", "查天气", {"city":{"type":"string","description":"城市名"}}, _weather),
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
                    Tool("list_files", "列出文件", {"path":{"type":"string","description":"路径"}}, _ls),
                    Tool("read_file", "读文件", {"path":{"type":"string","description":"路径"}}, _read),
                    Tool("write_file", "写文件", {"path":{"type":"string","description":"路径"},"content":{"type":"string","description":"内容"}}, _write),
                ],
            ),
        }

    def _route(self, query: str) -> str:
        prompt = self.ROUTER_PROMPT.format(query=query)
        msgs = [{"role":"user","content":prompt}]
        try:
            resp = self.pool.call_llm("__router__", msgs)
            choice = resp["choices"][0]["message"]["content"].strip()
            if choice in self.children:
                return choice
            for name in self.children:
                if name in choice or choice in name:
                    return name
        except Exception as e:
            self.log.error(f"LLM路由失败: {e}")
        return self._keyword_route(query)

    def _keyword_route(self, query: str) -> str:
        q = query.lower()
        kw = {
            "搜索Agent": ["搜索","查","什么是","天气","百科","维基","wiki","新闻","几度"],
            "代码Agent": ["代码","写","python","bug","报错","函数","算法","编程","脚本","开发"],
            "文件Agent": ["文件","保存","读取","目录","列表","创建","写入","文档"],
        }
        best, best_s = "搜索Agent", 0
        for name, kws in kw.items():
            s = sum(1 for k in kws if k in q)
            if s > best_s: best_s, best = s, name
        return best

    def chat(self, user_input: str) -> str:
        child_name = self._route(user_input)
        child = self.children[child_name]
        recalled = child.memory.recall(user_input)
        mem_text = ""
        if recalled:
            mem_text = "\n".join(f"[记忆] {m.content}" for m in recalled)
        messages = [{"role":"system","content":child.system_prompt}]
        if child.knowledge:
            messages.append({"role":"system","content":"[知识库]\n"+"\n\n".join(child.knowledge)})
        recent = self.shared_msgs[-12:]
        if recent:
            ctx = " | ".join(f"{'Q' if m['role']=='user' else 'A'}: {m['content'][:60]}" for m in recent)
            messages.append({"role":"system","content":f"[上下文摘要]\n{ctx}"})
        content = f"{mem_text}\n---\n{user_input}" if mem_text else user_input
        messages.append({"role":"user","content":content})
        child_reply = self._run_child(child, messages)
        self._child_memorize(child, user_input, child_reply)
        self.shared_msgs.append({"role":"user","content":user_input})
        self.shared_msgs.append({"role":"assistant","content":child_reply})
        if len(self.shared_msgs) > 40: self.shared_msgs = self.shared_msgs[-40:]
        return child_reply

    def _run_child(self, child, messages):
        tools = child.tool_schemas()
        for loop in range(5):
            resp = self.pool.call_llm(child.name, messages, tools)
            msg = resp["choices"][0]["message"]
            tcs = msg.get("tool_calls")
            if not tcs:
                return msg.get("content", "")
            messages.append(msg)
            for tc in tcs:
                fn = tc["function"]["name"]
                fa = json.loads(tc["function"]["arguments"])
                result = child.exec_tool(fn, fa)
                messages.append({"role":"tool","tool_call_id":tc["id"],"content":str(result)})
        return "[子Agent] 工具调用轮数超限"

    def _child_memorize(self, child, user_input, reply):
        triggers = ["重要","记住","别忘了","我的名字","我叫"]
        if any(t in user_input for t in triggers) or len(user_input) > 100:
            imp = 0.7 if any(t in user_input for t in triggers) else 0.4
            child.memory.add(f"用户: {user_input[:80]}...", imp)

    def reset(self):
        self.shared_msgs = []
        for child in self.children.values():
            child.memory = AgentMemory()

    def status(self) -> str:
        lines = [f"父Bot — {len(self.children)}个子Agent"]
        for name, child in self.children.items():
            model = self.pool.get_model(name)
            s = child.memory.get_stats()
            lines.append(f"  {name}: {model.name} | 插件:{len(child.tools)} | 知识库:{len(child.knowledge)}条 | 记忆:{s['短期记忆']}短/{s['中期记忆']}中")
        lines.append(f"  父Bot对话: {len(self.shared_msgs)//2}轮")
        return "\n".join(lines)
