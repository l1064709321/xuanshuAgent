"""
扣子风格多Agent系统 v3 — 父Bot路由 + 协调者模式 + 子Bot执行 + 独立记忆
v3 新增:
  - 协调者模式: Research → Synthesis → Implementation → Verification 四阶段
  - Continue/Fresh 决策矩阵: 根据上下文重叠度选复用或新开
  - Fork 子代理: 继承父上下文平行执行
  - 自校验: 代码类Agent执行后自动验证
"""
import json, time, os
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, field
from memory import AgentMemory
from logger import Logger
from models import ModelPool

# ── 共享记忆文件夹（文件级持久化）──
_MEMDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".memdir")
os.makedirs(_MEMDIR, exist_ok=True)


class MemdirStore:
    """共享记忆文件夹 — 任意格式文件读写，解决跨 Agent 记忆不连贯"""

    def __init__(self, root: str = _MEMDIR):
        self.root = os.path.realpath(root)
        os.makedirs(self.root, exist_ok=True)

    def _safe_path(self, rel: str) -> str:
        full = os.path.realpath(os.path.join(self.root, rel))
        if not full.startswith(self.root):
            raise PermissionError(f"禁止访问: {rel}")
        return full

    def list(self) -> list:
        entries = []
        for root, dirs, files in os.walk(self.root):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, self.root)
                entries.append({"rel": rel, "size": os.path.getsize(full)})
        return entries

    def read(self, rel: str) -> str:
        path = self._safe_path(rel)
        if not os.path.isfile(path):
            return ""
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(50000)

    def write(self, rel: str, content: str):
        path = self._safe_path(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def delete(self, rel: str) -> bool:
        path = self._safe_path(rel)
        if os.path.isfile(path):
            os.remove(path)
            return True
        return False

    def search(self, keyword: str) -> list:
        results = []
        for entry in self.list():
            try:
                content = self.read(entry["rel"])
                if keyword.lower() in content.lower():
                    results.append({"rel": entry["rel"], "preview": content[:200]})
            except Exception:
                pass
        return results

    def snapshot(self):
        """将当前各 Agent 的 JSON 记忆合并写为 Markdown 便于人类/Agent 阅读"""
        import glob, json as _json
        mem_json_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".memory")
        lines = [f"# 玄姝记忆快照 {time.strftime('%Y-%m-%d %H:%M')}\n"]
        for fname in sorted(glob.glob(os.path.join(mem_json_dir, "*.json"))):
            name = os.path.splitext(os.path.basename(fname))[0]
            try:
                with open(fname, "r", encoding="utf-8") as f:
                    data = _json.load(f)
                st = data.get("short_term", [])
                mt = data.get("medium_term", [])
                lt = data.get("long_term", [])
                all_items = st + mt + lt
                if not all_items:
                    continue
                lines.append(f"## {name}\n")
                for item in all_items:
                    c = item.get("content", "")
                    imp = item.get("importance", 0.5)
                    lines.append(f"- [重要性:{imp:.1f}] {c}")
                lines.append("")
            except Exception:
                continue
        self.write("snapshots/memory-snapshot.md", "\n".join(lines))


# 全局记忆文件夹实例
memdir = MemdirStore(_MEMDIR)


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

_WS = os.path.dirname(os.path.abspath(__file__))

def _safe_path(p: str) -> str:
    real = os.path.realpath(os.path.join(_WS, p))
    if not real.startswith(os.path.realpath(_WS) + os.sep) and real != os.path.realpath(_WS):
        raise PermissionError(f"禁止访问工作目录外路径: {p}")
    return real

def _ls(args):
    try:
        path = _safe_path(args["path"])
        files = os.listdir(path)
        return f"共 {len(files)} 个: {', '.join(files[:20])}"
    except Exception as e: return f"错误: {e}"

def _read(args):
    try:
        path = _safe_path(args["path"])
        with open(path) as f: return f.read()[:2000]
    except Exception as e: return f"读取失败: {e}"

def _write(args):
    try:
        path = _safe_path(args["path"])
        with open(path, "w") as f: f.write(args["content"])
        return f"已写入 {args['path']}"
    except Exception as e: return f"写入失败: {e}"

def _run_code(args):
    """自校验代码执行 — 运行代码并返回结果+退出码"""
    import subprocess, tempfile
    try:
        code = args["code"]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
            f.write(code)
            tmp_path = f.name
        result = subprocess.run(
            ["python3", tmp_path], capture_output=True, text=True, timeout=30
        )
        os.unlink(tmp_path)
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        parts = []
        if stdout:
            parts.append(f"[stdout]\n{stdout[:1000]}")
        if stderr:
            parts.append(f"[stderr]\n{stderr[:500]}")
        parts.append(f"[exit_code] {result.returncode}")
        return "\n".join(parts)
    except subprocess.TimeoutExpired:
        return "[错误] 代码执行超时(30s)"
    except Exception as e:
        return f"[错误] 执行失败: {e}"


# ── 子Bot ────────────────────────────────────────────
_MEM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".memory")

@dataclass
class ChildBot:
    """子Agent — 独立人设+插件+知识库+记忆"""
    name: str
    description: str
    system_prompt: str
    tools: List[Tool] = field(default_factory=list)
    knowledge: List[str] = field(default_factory=list)
    self_verify: bool = False  # 是否启用自校验

    def __post_init__(self):
        safe_name = self.name.replace(" ", "_").replace("/", "_")
        persist = os.path.join(_MEM_DIR, f"{safe_name}.json")
        self.memory = AgentMemory(persist_path=persist)
        if self.memory.load():
            pass

    def tool_schemas(self) -> list:
        return [t.schema() for t in self.tools]

    def exec_tool(self, name: str, args: dict) -> str:
        for t in self.tools:
            if t.name == name and t.executor:
                return t.executor(args)
        return f"[{name}] 工具未注册"

    def verify(self, last_reply: str, pool: "ModelPool") -> str:
        """自校验 — 对代码输出进行验证"""
        verify_prompt = f"""你是代码审查员。请验证以下代码的正确性：

{last_reply[:2000]}

检查要点:
1. 语法是否正确
2. 逻辑是否有明显漏洞
3. 是否有未处理的边界情况
4. 关键变量是否正确初始化

如果发现问题，简要说明。如果没有明显问题，回复"PASS"。"""
        try:
            msgs = [{"role": "user", "content": verify_prompt}]
            resp = pool.call_llm(self.name + "_verify", msgs)
            return resp["choices"][0]["message"]["content"].strip()
        except Exception as e:
            return f"验证跳过: {e}"


# ── 父Bot（协调者模式）────────────────────────────────
class ParentBot:
    """主Bot — 意图路由器 + 协调者模式 + 结果汇总"""

    ROUTER_PROMPT = """你是任务路由器。根据用户消息，选择最合适的子Agent处理。
只输出子Agent的名称，不要解释。

可用子Agent：
- 搜索Agent: 联网搜索、查实时信息、天气、百科、新闻
- 代码Agent: 编程、写代码、调试、算法、技术问题
- 文件Agent: 读写文件、文件管理、文档处理

用户消息：{query}

选中的Agent（只输出名称）："""

    SYNTHESIS_PROMPT = """你是任务协调者。用户原始需求:
{original_query}

研究阶段发现:
{research_findings}

请将研究发现合成为可执行的实施规格（spec），必须包含：
1. 具体文件路径（如果有）
2. 需要修改的位置（行号/函数名）
3. 具体改动内容
4. "完成"的定义（什么算做完）

Spec:"""

    VERIFY_PROMPT = """你是验证协调者。用户原始需求:
{original_query}

实施结果:
{implementation_result}

请对比原始需求，验证实施结果是否满足要求。列出通过项和未通过项。
如果全部通过，第一行写"ALL_PASS"。

验证报告:"""

    def __init__(self, pool: ModelPool, verbose: bool = True, coordinator_mode: bool = True):
        self.pool = pool
        self.log = Logger(enabled=verbose)
        self.children: Dict[str, ChildBot] = {}
        self.shared_msgs: List[dict] = []
        self.coordinator_mode = coordinator_mode
        # 追踪活跃的 agent 上下文（用于 Continue 决策）
        self._agent_contexts: Dict[str, dict] = {}  # agent_name → {last_task, last_output, files_accessed}
        self._init_children()

    def _init_children(self):
        # ── 共享记忆文件夹工具 ──
        _mem_list = lambda a: "\n".join(f"  {e['rel']} ({e['size']}B)" for e in memdir.list()) or "记忆文件夹为空"
        _mem_read = lambda a: memdir.read(a.get("rel", "")) or "(空)"
        _mem_write = (lambda a: memdir.write(a.get("rel", ""), a.get("content", "")) or f"已写入 {a.get('rel','')}")
        _mem_search = lambda a: "\n".join(f"  {r['rel']}: {r['preview'][:80]}" for r in memdir.search(a.get("keyword", ""))) or "未找到"
        _mem_snapshot = lambda a: (memdir.snapshot() or "快照已生成")
        mem_tools = [
            Tool("memdir_list", "列出记忆文件夹中所有文件", {}, _mem_list),
            Tool("memdir_read", "读取记忆文件夹中的文件", {"rel": {"type": "string", "description": "文件相对路径"}}, _mem_read),
            Tool("memdir_write", "写入文件到记忆文件夹", {"rel": {"type": "string", "description": "文件相对路径"}, "content": {"type": "string", "description": "内容"}}, _mem_write),
            Tool("memdir_search", "搜索记忆文件夹", {"keyword": {"type": "string", "description": "关键词"}}, _mem_search),
            Tool("memdir_snapshot", "生成记忆快照（汇总文件到报告）", {}, _mem_snapshot),
        ]

        self.children = {
            "搜索Agent": ChildBot(
                name="搜索Agent",
                description="联网搜索、查实时信息、天气、百科",
                system_prompt="你是信息检索专家。收到查询后调用插件获取数据，整理结果并注明来源。语气简洁专业。",
                tools=[
                    Tool("search_wikipedia", "搜维基百科", {"query": {"type": "string", "description": "关键词"}}, _wiki),
                    Tool("get_weather", "查天气", {"city": {"type": "string", "description": "城市名"}}, _weather),
                ] + mem_tools,
            ),
            "代码Agent": ChildBot(
                name="代码Agent",
                description="编程、写代码、调试、算法",
                system_prompt="""你是编程专家。直接写可运行代码放```块中，解释要简洁。优先Python。
重要规则:
- 写完代码后必须用 run_code 工具执行验证
- 如果执行失败或有问题，自行修复后重新验证
- 只有验证通过才报告完成
- 报告时包含验证结果""",
                tools=[
                    Tool("run_code", "执行Python代码并返回结果", 
                         {"code": {"type": "string", "description": "Python代码"}}, _run_code),
                ] + mem_tools,
                self_verify=True,
            ),
            "文件Agent": ChildBot(
                name="文件Agent",
                description="读写文件、文件管理、文档处理",
                system_prompt="你是文件管理助手。执行操作并报告结果。写文件前确认内容正确。",
                tools=[
                    Tool("list_files", "列出文件", {"path": {"type": "string", "description": "路径"}}, _ls),
                    Tool("read_file", "读文件", {"path": {"type": "string", "description": "路径"}}, _read),
                    Tool("write_file", "写文件", {"path": {"type": "string", "description": "路径"}, "content": {"type": "string", "description": "内容"}}, _write),
                ] + mem_tools,
            ),
        }

    # ═══════════ 路由 ═══════════
    def _route(self, query: str) -> str:
        prompt = self.ROUTER_PROMPT.format(query=query)
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self.pool.call_llm("__router__", msgs)
            choice = resp["choices"][0]["message"]["content"].strip()
            self.log.sys(f'LLM路由 → "{choice}"')
            if choice in self.children:
                return choice
            for name in self.children:
                if name in choice or choice in name:
                    self.log.sys(f'模糊匹配 → "{name}"')
                    return name
        except Exception as e:
            self.log.error(f"LLM路由失败: {e}")
        return self._keyword_route(query)

    def _keyword_route(self, query: str) -> str:
        q = query.lower()
        if "搜索" in q or "查" in q:
            self.log.sys(f'关键词路由 → "搜索Agent"')
            return "搜索Agent"
        if "写" in q or "代码" in q:
            self.log.sys(f'关键词路由 → "代码Agent"')
            return "代码Agent"
        if "保存" in q or "文件" in q or "读取" in q:
            self.log.sys(f'关键词路由 → "文件Agent"')
            return "文件Agent"
        kw = {
            "搜索Agent": (["搜索", "查", "什么是", "天气", "百科", "维基", "wiki", "新闻", "几度"], 0),
            "代码Agent": (["代码", "编程", "脚本", "写", "python", "bug", "报错", "函数", "算法", "开发"], 0),
            "文件Agent": (["文件", "保存", "读取", "目录", "列表", "创建", "写入", "文档"], 0),
        }
        best = "搜索Agent"
        best_s = 0
        for name, (kws, _) in kw.items():
            s = 0
            for i, k in enumerate(kws):
                if k in q:
                    s += 5 if i < 3 else 1
            if s > best_s:
                best_s, best = s, name
        self.log.sys(f'关键词路由 → "{best}" (得分:{best_s})')
        return best

    # ═══════════ Continue/Fresh 决策矩阵 ═══════════
    def _decide_continue_or_fresh(self, agent_name: str, new_task: str) -> Tuple[bool, str]:
        """
        决策：复用现有上下文(Continue) 还是 新建(Fresh)
        参考 cc-haha 决策矩阵:
        - Continue: 研究覆盖的文件恰需编辑 / 修正失败 / 扩展近期工作
        - Fresh: 研究广但实施窄 / 验证代码 / 原方案完全错误 / 完全无关
        返回 (should_continue, reason)
        """
        ctx = self._agent_contexts.get(agent_name)
        if not ctx:
            return False, "无历史上下文，新建"

        last_task = ctx.get("last_task", "")
        last_output = ctx.get("last_output", "")

        # 计算上下文重叠度
        task_overlap = self._text_overlap(last_task, new_task)
        task_lower = new_task.lower()

        # 修正/继续类信号 → Continue
        continue_signals = ["修正", "改", "继续", "不对", "别", "再", "还", "修", "fix", "错了", "换个", "试试"]
        if any(s in task_lower for s in continue_signals):
            return True, "检测到修正/继续信号"

        # 错误修复 → Continue（已持有错误上下文）
        error_signals = ["报错", "错误", "失败", "bug", "error", "没通过", "不行"]
        if any(s in task_lower for s in error_signals):
            return True, "检测到错误修复信号"

        # 验证类任务 → Fresh（需新视角）
        verify_signals = ["验证", "检查", "复审", "review", "测试", "test"]
        if any(s in verify_signals for s in task_lower):
            return False, "验证任务需要新视角"

        # 上下文重叠度高 (>30%) → Continue
        if task_overlap > 0.3:
            return True, f"上下文重叠度 {task_overlap:.0%}"

        # 完全无关 → Fresh
        if task_overlap < 0.1:
            return False, f"上下文重叠度低 {task_overlap:.0%}"

        # 默认：研究类继续，实施类 fresh
        if "研究" in task_lower or "搜索" in task_lower or "查" in task_lower:
            return True, "研究类任务可继续"
        return False, "实施类任务建议新开"

    def _text_overlap(self, a: str, b: str) -> float:
        """文本重叠度 — 关键词+bigram混合"""
        a_lower = a.lower()
        b_lower = b.lower()
        # 核心关键词（提取2-4字有意义的片段）
        def key_terms(s):
            terms = set()
            for n in (1, 2):
                for i in range(len(s) - n + 1):
                    chunk = s[i:i+n]
                    # 过滤纯标点/数字
                    if any(c.isalpha() or '\u4e00' <= c <= '\u9fff' for c in chunk):
                        terms.add(chunk)
            return terms
        ta = key_terms(a_lower)
        tb = key_terms(b_lower)
        if not ta or not tb:
            return 0.0
        inter = ta & tb
        return len(inter) / min(len(ta), len(tb)) if ta and tb else 0.0

    # ═══════════ 协调者模式: 四阶段工作流 ═══════════
    def _is_complex_task(self, query: str) -> bool:
        """判断是否为需要多阶段的复杂任务"""
        complex_signals = [
            "研究", "分析", "调研", "对比", "方案", "设计",
            "实现", "开发", "重构", "修复", "优化",
            "生成", "创建", "构建", "部署",
            "查找并", "然后", "之后", "接着",
            "research", "implement", "fix", "build", "create",
        ]
        ql = query.lower()
        return any(s in ql for s in complex_signals) and len(query) > 30

    def _research_phase(self, query: str, child_name: str) -> str:
        """阶段1: 研究 — 只读探索"""
        child = self.children[child_name]
        research_prompt = f"""[研究任务] 只探索不修改。
{query}

要求: 报告文件路径、关键结构、行号位置。不修改任何文件。"""
        self.log.sys(f"📋 研究阶段 → {child_name}")
        return self._run_child(child, self._build_child_msgs(child, research_prompt))

    def _synthesize(self, original_query: str, research_result: str) -> str:
        """阶段2: 合成 — 协调者亲自理解并生成 spec"""
        self.log.sys("🧠 合成阶段 — 生成实施规格")
        prompt = self.SYNTHESIS_PROMPT.format(
            original_query=original_query,
            research_findings=research_result[:3000],
        )
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self.pool.call_llm("__synthesizer__", msgs)
            spec = resp["choices"][0]["message"]["content"].strip()
            self.log.sys(f"Spec生成: {len(spec)}字")
            return spec
        except Exception as e:
            self.log.error(f"合成失败: {e}")
            return research_result  # 兜底

    def _implementation_phase(self, spec: str, child_name: str) -> str:
        """阶段3: 实施 — 按 spec 执行修改"""
        child = self.children[child_name]
        impl_prompt = f"""[实施任务] 按以下规格执行修改，完成后验证。
{spec}"""
        self.log.sys(f"🔨 实施阶段 → {child_name}")
        return self._run_child(child, self._build_child_msgs(child, impl_prompt))

    def _verification_phase(self, original_query: str, impl_result: str) -> str:
        """阶段4: 验证 — 对比原始需求"""
        self.log.sys("✅ 验证阶段")
        prompt = self.VERIFY_PROMPT.format(
            original_query=original_query,
            implementation_result=impl_result[:3000],
        )
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self.pool.call_llm("__verifier__", msgs)
            return resp["choices"][0]["message"]["content"].strip()
        except Exception as e:
            self.log.error(f"验证失败: {e}")
            return "验证跳过"

    # ═══════════ Fork 子代理 ═══════════
    def _fork_child(self, source_name: str, new_name: str, task: str) -> Optional["ChildBot"]:
        """Fork: 创建继承父Bot共享上下文的子代理"""
        source = self.children.get(source_name)
        if not source:
            return None

        # 复制源 Agent 的核心属性
        forked = ChildBot(
            name=new_name,
            description=f"Fork of {source_name}: {task[:50]}",
            system_prompt=source.system_prompt,
            tools=source.tools,
            knowledge=source.knowledge,
            self_verify=source.self_verify,
        )
        # 注入父Bot共享上下文
        recent = self.shared_msgs[-8:]
        if recent:
            ctx_lines = ["[父Bot上下文继承]"]
            for m in recent:
                role = "Q" if m["role"] == "user" else "A"
                ctx_lines.append(f"{role}: {m['content'][:100]}")
            forked.knowledge = forked.knowledge + ["\n".join(ctx_lines)]

        # 注册到子Agent池（临时）
        self.children[new_name] = forked
        self.log.sys(f"Fork: {source_name} → {new_name}")
        return forked

    def _cleanup_fork(self, name: str):
        """清理临时 fork"""
        if name in self.children and not name.endswith("Agent"):
            del self.children[name]

    # ═══════════ 对话 ═══════════
    def chat(self, user_input: str) -> str:
        # 协调者模式: 复杂任务走四阶段
        if self.coordinator_mode and self._is_complex_task(user_input):
            return self._coordinator_chat(user_input)

        # 普通模式: 单阶段路由
        return self._simple_chat(user_input)

    def _simple_chat(self, user_input: str) -> str:
        """单阶段路由模式"""
        child_name = self._route(user_input)
        child = self.children[child_name]
        self.log.agent(child_name, "选中")

        # Continue/Fresh 决策
        should_continue, reason = self._decide_continue_or_fresh(child_name, user_input)
        self.log.sys(f"Continue/Fresh: {'复用' if should_continue else '新建'} — {reason}")

        # 记忆检索
        recalled = child.memory.recall(user_input)
        mem_text = ""
        if recalled:
            mem_lines = [f"[记忆] {m.content}" for m in recalled]
            mem_text = "\n".join(mem_lines)
            if should_continue:
                # Continue: 额外带上前一次的输出
                prev_ctx = self._agent_contexts.get(child_name, {})
                if prev_ctx.get("last_output"):
                    mem_text = f"[上一次输出]\n{prev_ctx['last_output'][:300]}\n---\n{mem_text}"
            self.log.memory(f"{child_name}", f"命中{len(recalled)}条")

        messages = self._build_child_msgs(child, user_input, mem_text)
        child_reply = self._run_child(child, messages)

        # 自校验
        if child.self_verify and "代码" in child_name:
            verify_result = child.verify(child_reply, self.pool)
            self.log.sys(f"自校验: {'PASS' if 'PASS' in verify_result else '需要检查'}")
            if "PASS" not in verify_result:
                child_reply = f"{child_reply}\n\n[自校验]\n{verify_result[:300]}"

        # 记忆落盘
        self._child_memorize(child, user_input, child_reply)
        self._update_context(child_name, user_input, child_reply)
        self._update_shared_history(user_input, child_reply)
        return child_reply

    def _coordinator_chat(self, user_input: str) -> str:
        """协调者模式: Research → Synthesis → Implementation → Verification"""
        self.log.banner("协调者模式")

        # 阶段1: 研究（搜索/文件Agent做研究）
        child_name = self._route(user_input)
        research_name = "搜索Agent" if child_name == "代码Agent" else child_name
        research = self._research_phase(f"研究: {user_input}", research_name)

        # 阶段2: 合成
        spec = self._synthesize(user_input, research)

        # 阶段3: 实施
        impl = self._implementation_phase(spec, child_name)

        # 阶段4: 验证
        verification = self._verification_phase(user_input, impl)

        # 组合结果
        result = f"""[研究阶段 — {research_name}]
{research[:500]}

[实施阶段 — {child_name}]
{impl[:1500]}

[验证]
{verification[:300]}"""

        # 记忆 + 上下文更新
        child = self.children[child_name]
        self._child_memorize(child, user_input, result)
        self._update_context(child_name, user_input, impl)
        self._update_shared_history(user_input, result)
        return result

    # ═══════════ 子Agent执行循环 ═══════════
    def _build_child_msgs(self, child: ChildBot, user_input: str,
                          extra_context: str = "") -> list:
        """构建子Agent消息列表"""
        messages = [{"role": "system", "content": child.system_prompt}]
        if child.knowledge:
            kb_text = "\n\n".join(child.knowledge)
            messages.append({"role": "system", "content": f"[知识库]\n{kb_text}"})
        recent = self.shared_msgs[-12:]
        if recent:
            ctx = " | ".join(
                f"{'Q' if m['role']=='user' else 'A'}: {m['content'][:60]}"
                for m in recent
            )
            messages.append({"role": "system", "content": f"[上下文摘要]\n{ctx}"})
        # ── 注入记忆文件夹上下文 ──
        mem_results = memdir.search(user_input)
        if mem_results:
            mem_lines = ["[记忆文件夹 - 匹配记录]"]
            for r in mem_results[:5]:
                mem_lines.append(f"### {r['rel']}\n{r['preview'][:500]}")
            messages.append({"role": "system", "content": "\n".join(mem_lines)})
        content = f"{extra_context}\n---\n{user_input}" if extra_context else user_input
        messages.append({"role": "user", "content": content})
        return messages

    def _run_child(self, child: ChildBot, messages: list) -> str:
        """子Agent工具调用循环"""
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

    # ═══════════ 记忆 & 上下文管理 ═══════════
    def _child_memorize(self, child: ChildBot, user_input: str, reply: str):
        traces = ["重要", "记住", "别忘了", "我的名字", "我叫", "偏好", "习惯",
                  "不要", "禁止", "总是", "必须", "以后", "设定", "配置"]
        explicit = any(t in user_input for t in traces)
        substantial = len(user_input) > 60 or len(reply) > 200
        if explicit or substantial:
            imp = 0.8 if explicit else 0.5
            snippet = user_input[:100] + ("..." if len(user_input) > 100 else "")
            child.memory.add(f"用户: {snippet}", imp)
            if len(reply) > 80:
                reply_snippet = reply[:120] + ("..." if len(reply) > 120 else "")
                child.memory.add(f"回复: {reply_snippet}", imp * 0.8)
            child.memory.save()
            self.log.memory(f"{child.name}", f"记忆已落盘 重要性:{imp:.1f}")

    def _update_context(self, agent_name: str, task: str, output: str):
        """更新 Agent 上下文追踪（供 Continue/Fresh 决策用）"""
        self._agent_contexts[agent_name] = {
            "last_task": task,
            "last_output": output,
            "timestamp": time.time(),
        }

    def _update_shared_history(self, user_input: str, reply: str):
        self.shared_msgs.append({"role": "user", "content": user_input})
        self.shared_msgs.append({"role": "assistant", "content": reply})
        if len(self.shared_msgs) > 40:
            self.shared_msgs = self.shared_msgs[-40:]

    # ═══════════ 管理 ═══════════
    def reset(self):
        self.shared_msgs = []
        self._agent_contexts = {}
        for child in self.children.values():
            child.memory = AgentMemory()
        self.log.sys("对话已重置")

    def status(self) -> str:
        lines = [f"父Bot v3 — {len(self.children)}个子Agent | 协调者模式: {'开' if self.coordinator_mode else '关'}"]
        for name, child in self.children.items():
            model = self.pool.get_model(name)
            s = child.memory.get_stats()
            ctx = self._agent_contexts.get(name, {})
            active = "活跃" if ctx else "空闲"
            lines.append(
                f"  {name}: {model.name} | 插件:{len(child.tools)} | "
                f"记忆:{s['短期记忆']}短/{s['中期记忆']}中 | {active}"
            )
        lines.append(f"  父Bot对话: {len(self.shared_msgs)//2}轮")
        return "\n".join(lines)

    def export_all_snapshots(self, base_dir: str = "") -> bool:
        """导出所有Agent记忆快照"""
        if not base_dir:
            base_dir = os.path.join(_WS, ".memory", "agent-memory-snapshots")
        success = True
        for name, child in self.children.items():
            safe_name = name.replace(" ", "_").replace("/", "_")
            snapshot_dir = os.path.join(base_dir, safe_name)
            if not child.memory.export_snapshot(snapshot_dir):
                self.log.error(f"快照导出失败: {name}")
                success = False
            else:
                self.log.sys(f"快照已导出: {name}")
        return success

    def import_all_snapshots(self, base_dir: str = "") -> int:
        """导入所有Agent记忆快照，返回导入条数"""
        if not base_dir:
            base_dir = os.path.join(_WS, ".memory", "agent-memory-snapshots")
        total = 0
        for name, child in self.children.items():
            safe_name = name.replace(" ", "_").replace("/", "_")
            snapshot_dir = os.path.join(base_dir, safe_name)
            check = child.memory.check_snapshot(snapshot_dir)
            if check["action"] in ("initialize", "update"):
                old_count = child.memory.get_stats()["short"]
                child.memory.import_snapshot(snapshot_dir)
                new_count = child.memory.get_stats()["short"]
                added = new_count - old_count
                total += added
                self.log.sys(f"快照导入: {name} +{added}条 ({check['action']})")
        return total

