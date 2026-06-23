"""
扣子风格多Agent协作系统
Project Space → 平级Agent(提示词+插件+知识库) → LLM路由
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
    """扣子风格插件 — 封装API为工具"""
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


# ── Agent 定义（扣子风格）──────────────────────────────
@dataclass
class Agent:
    """扣子Bot — 提示词+插件+知识库，平级协作"""
    name: str
    description: str          # 一句话用途，路由用
    system_prompt: str        # 人设与回复逻辑
    tools: List[Tool] = field(default_factory=list)
    knowledge: List[str] = field(default_factory=list)  # 知识库文本

    def tool_schemas(self) -> list:
        return [t.schema() for t in self.tools]

    def exec_tool(self, name: str, args: dict) -> str:
        for t in self.tools:
            if t.name == name and t.executor:
                return t.executor(args)
        return f"[{name}] 工具未注册"


# ── 项目空间（扣子 Project Space）─────────────────────
class ProjectSpace:
    """扣子项目空间 — 共享上下文，平级Agent协作"""

    ROUTER_PROMPT = """你是任务路由器。根据用户消息选择最合适的Agent。只输出Agent名称。

可用Agent：
- 搜索Agent: 联网搜索、查实时信息、天气、百科、新闻、最新动态
- 代码Agent: 编程、写代码、调试、算法、脚本、技术问题
- 文件Agent: 读写文件、文件管理、文档处理、目录操作

用户消息：{query}

选中的Agent（只输出名称）："""

    def __init__(self, pool: ModelPool, verbose: bool = True):
        self.pool = pool
        self.log = Logger(enabled=verbose)
        self.memory = AgentMemory()
        self.agents: Dict[str, Agent] = {}
        self.shared_msgs: List[dict] = []  # 共享对话历史
        self._init_agents()

    def _init_agents(self):
        self.agents = {
            "搜索Agent": Agent(
                name="搜索Agent",
                description="联网搜索、查实时信息、天气、百科",
                system_prompt="你是信息检索专家。收到查询后：1) 调用插件获取最新数据 2) 整理结果 3) 注明来源。语气简洁专业。",
                tools=[
                    Tool("search_wikipedia", "搜维基百科", {"query": {"type": "string", "description": "关键词"}}, _wiki),
                    Tool("get_weather", "查天气", {"city": {"type": "string", "description": "城市名"}}, _weather),
                ],
            ),
            "代码Agent": Agent(
                name="代码Agent",
                description="编程、写代码、调试、算法",
                system_prompt="你是编程专家。1) 直接写可运行代码 2) 解释要简洁 3) 优先使用Python。代码放```块中。",
                tools=[],
            ),
            "文件Agent": Agent(
                name="文件Agent",
                description="读写文件、文件管理、文档处理",
                system_prompt="你是文件管理助手。执行文件操作并报告结果。写文件前确认内容正确。",
                tools=[
                    Tool("list_files", "列出文件", {"path": {"type": "string", "description": "路径"}}, _ls),
                    Tool("read_file", "读文件", {"path": {"type": "string", "description": "路径"}}, _read),
                    Tool("write_file", "写文件", {"path": {"type": "string", "description": "路径"}, "content": {"type": "string", "description": "内容"}}, _write),
                ],
            ),
        }

    # ── LLM 路由 ──────────────────────────────────────
    def _route(self, query: str) -> str:
        """LLM路由 — 扣子风格意图识别，失败降级为关键词匹配"""
        agent_list = "\n".join(
            f"- {a.name}: {a.description}" for a in self.agents.values()
        )

        # 尝试LLM路由
        prompt = self.ROUTER_PROMPT.format(query=query)
        msgs = [{"role": "user", "content": prompt}]
        try:
            # 用默认模型做路由判断
            resp = self.pool.call_llm("__router__", msgs)
            choice = resp["choices"][0]["message"]["content"].strip()
            self.log.sys(f'LLM路由 → "{choice}"')
            if choice in self.agents:
                return choice
        except Exception as e:
            self.log.error(f"LLM路由失败: {e}")

        # 降级：关键词匹配
        return self._keyword_route(query)

    def _keyword_route(self, query: str) -> str:
        q = query.lower()
        keyword_map = {
            "搜索Agent": ["搜索", "查", "什么是", "天气", "百科", "维基", "wiki", "新闻", "几度", "温度"],
            "代码Agent": ["代码", "写", "python", "bug", "报错", "函数", "算法", "实现", "编程", "脚本", "程序", "开发"],
            "文件Agent": ["文件", "保存", "读取", "目录", "列表", "创建", "写入", "文档"],
        }
        best_agent, best_score = "搜索Agent", 0
        for name, kws in keyword_map.items():
            score = sum(1 for kw in kws if kw in q)
            if score > best_score:
                best_score, best_agent = score, name
        self.log.sys(f'关键词路由 → "{best_agent}" (得分:{best_score})')
        return best_agent

    # ── 对话 ──────────────────────────────────────────
    def chat(self, user_input: str) -> str:
        # 记忆检索
        recalled = self.memory.recall(user_input)
        mem_text = ""
        if recalled:
            mem_lines = [f"[记忆] {m.content}" for m in recalled]
            mem_text = "\n".join(mem_lines)
            self.log.memory("命中", f"{len(recalled)}条")

        # LLM路由
        agent_name = self._route(user_input)
        agent = self.agents[agent_name]

        # 构建消息：系统提示 + 记忆 + 用户输入
        messages = [{"role": "system", "content": agent.system_prompt}]

        # 注入知识库
        if agent.knowledge:
            kb_text = "\n\n".join(agent.knowledge)
            messages.append({"role": "system", "content": f"[知识库]\n{kb_text}"})

        # 共享对话历史（最近10轮）
        messages.extend(self.shared_msgs[-20:])

        # 当前用户输入
        content = f"{mem_text}\n---\n{user_input}" if mem_text else user_input
        messages.append({"role": "user", "content": content})

        tools = agent.tool_schemas()

        # 工具调用循环（最多5轮）
        for loop in range(5):
            t0 = time.time()
            resp = self.pool.call_llm(agent_name, messages, tools)
            latency = time.time() - t0

            usage = resp.get("usage", {})
            model_name = resp.get("_model", "?")
            self.log.llm(model_name, usage.get("total_tokens", 0), latency)
            self.log.agent(agent_name, f"第{loop+1}轮")

            msg = resp["choices"][0]["message"]
            tcs = msg.get("tool_calls")

            if not tcs:
                reply = msg.get("content", "")
                # 存入共享历史
                self.shared_msgs.append({"role": "user", "content": user_input})
                self.shared_msgs.append({"role": "assistant", "content": reply})
                # 保持历史长度
                if len(self.shared_msgs) > 40:
                    self.shared_msgs = self.shared_msgs[-40:]

                self._auto_memorize(user_input, reply)
                if loop > 0:
                    self.log.sys(f"工具完成({loop}轮)")
                return reply

            # 工具调用
            messages.append(msg)
            for tc in tcs:
                fn = tc["function"]["name"]
                fa = json.loads(tc["function"]["arguments"])
                self.log.tool_start(fn, fa)
                result = agent.exec_tool(fn, fa)
                self.log.tool_end(result)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": str(result),
                })

        return "[Agent] 工具调用轮数超限"

    def _auto_memorize(self, user_input: str, reply: str):
        triggers = ["重要", "记住", "别忘了", "我的名字", "我叫"]
        if any(t in user_input for t in triggers) or len(user_input) > 100:
            imp = 0.7 if any(t in user_input for t in triggers) else 0.4
            self.memory.add(f"用户: {user_input[:80]}...", imp)
            self.log.memory("写入", f"重要性:{imp:.1f}")

    def reset(self):
        self.shared_msgs = []
        self.memory = AgentMemory()
        self.log.sys("对话已重置")

    def status(self) -> str:
        """项目空间状态"""
        lines = [f"项目空间 — {len(self.agents)}个Agent"]
        for name, agent in self.agents.items():
            model = self.pool.get_model(name)
            tool_count = len(agent.tools)
            kb_size = len(agent.knowledge)
            lines.append(f"  {name}: {model.name} | 插件:{tool_count} | 知识库:{kb_size}条")
        lines.append(f"  共享对话: {len(self.shared_msgs)//2}轮")
        stats = self.memory.get_stats()
        lines.append(f"  记忆: {stats['短期记忆']}短/{stats['中期记忆']}中/{stats['长期记忆']}长")
        return "\n".join(lines)
