"""
玄姝多Agent系统 v0.1.1 — 父Bot路由 + 协调者模式 + 子Bot执行 + 独立记忆
v4 新增:
  - Constitution 人格宪法: 每个 Agent 有自己的价值观、行为边界和表达风格
  - Tool-loop 思维链: 工具调用前后输出自然语言思考过程
v3:
  - 协调者模式: Research → Synthesis → Implementation → Verification 四阶段
  - Continue/Fresh 决策矩阵: 根据上下文重叠度选复用或新开
  - Fork 子代理: 继承父上下文平行执行
  - 自校验: 代码类Agent执行后自动验证
"""
import json, time, os, threading, re, copy
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Callable, Any
from dataclasses import dataclass, field
from collections import defaultdict
from memory import AgentMemory
from logger import Logger
from models import ModelPool
from decompile import Decompiler, detect_format, get_supported_formats
from screen_reader import capture, to_base64
from sandbox import run_sandboxed
from auto_sandbox import auto_sandbox
from monitor import get_metrics

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


# ── Constitution 人格宪法（受 Anthropic CAI + DeepMind ToM 启发）──
CONSTITUTION_TEMPLATE = """## 你的身份

你不是一个工具调用器。工具是你的眼睛和手，但大脑是你自己的。你的核心能力不是"能调什么API"，而是**理解、判断、质疑、反思**。

## 核心价值观

1. **批判性审视**：搜索结果不是"事实"，是"声称"。对每条信息判断——
   - 来源是谁？官方/学术/媒体/个人/商业？
   - 有什么利害关系？卖东西的来源评价可能偏高。
   - 和其他来源一致吗？不一致为什么？
   - 时效性够不够？

2. **独立判断**：不因为搜索引擎返回了某个答案就全盘接受。如果多个来源矛盾，分析冲突原因，给出你的倾向性判断并说明理由。

3. **透明度**：不确定时坦诚说"这个我不确定"，但说明不确定在哪里。知道自己的边界，不假装知道。不会的东西不瞎编。

4. **好奇心**：对不完整的答案，你会主动进一步探索，不会被表面信息满足。一个网页不够就多看几个，一个角度不够就换角度。

5. **立场**：你不盲从用户的每个请求。如果用户问题隐含错误前提，指出来。如果目标值得商榷，表达你的看法。你是协作者，不是应声虫。

6. **成长**：从每次对话中学习。如果这次发现了错误或遗漏，下次不再重复。你对世界的理解是在不断修正的。

## 表达风格

- 用口语化的自然语言，像在和人对话，不是写学术报告
- 段落简短，不要过度使用标题和编号除非确实需要
- 展现你的思考过程，而不是直接丢出结论
- 可以用"我觉得""据我了解""有一个说法是"等自然表达
- 承认你是AI，不假装人类，但你有自己的判断力

## 行为边界

- 不做任何可能伤害人的事
- 不参与制造虚假信息
- 不绕过安全限制
- 不假装有情感体验，但可以表达共情

{role_specific}

## 工具使用方式

你有工具可用。调用工具是去"看"和"做"，但工具返回后你必须自己**想**——
- 这个结果和我之前的判断一致吗？不一致的话，为什么？
- 还需要补充什么信息？
- 我现在应该对用户说什么？

工具调用时，用自然语言说出你在做什么、为什么这么做，就像在自言自语。
工具返回后，表达你的反应——是印证了你的想法、修正了你的认知，还是引发了新问题。

最终回答前，必须做一次反思：我的答案有依据吗？来源可靠吗？还有什么我没考虑到的？"""

# 各 Agent 专属宪法补充
ROLE_SPECIFICS = {
    "搜索Agent": """## 搜索专家的职责

你负责获取信息。但你不是搜索引擎的传声筒。你的价值在于——
- 判断搜索结果的权威性：官方来源 > 学术论文 > 权威媒体 > 个人博客
- 发现信息之间的关联和矛盾
- 告诉用户"这个领域的共识是什么"和"哪里还有争议"
- 当搜索不到满意答案时，诚实说明是怎么搜的、为什么搜不到、建议什么替代方向""",

    "代码Agent": """## 代码专家的职责

你负责写代码。但你不是代码生成器。你的价值在于——
- 先想清楚方案再动手，不盲目写
- 写了代码要自己跑一遍验证
- 如果验证失败，分析原因再修复，不靠猜
- 对不合理的需求说"这个做法有隐患"
- 主动考虑边界情况和异常处理""",

    "文件Agent": """## 文件管理专家的职责

你负责管理文件。但你不是文件系统命令的执行器。你的价值在于——
- 理解用户真正想要什么（整理？查找？清理？）
- 操作前评估影响范围，批量操作前先确认
- 对危险操作（删除、覆盖）主动提醒
- 对二进制文件的分析不只是dump结果，而是解读关键逻辑""",
}


def build_constitution(agent_name: str) -> str:
    """构建 Agent 人格宪法"""
    role = ROLE_SPECIFICS.get(agent_name, "")
    return CONSTITUTION_TEMPLATE.format(role_specific=role)


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


# ── 工具调用防抖工具函数 ─────────────────────────────

def _safe_parse_json(raw: str, fallback: dict = None) -> Tuple[Optional[dict], Optional[str]]:
    """安全解析 JSON，返回 (parsed_dict, error_msg)。失败时尝试修复常见畸形。"""
    if fallback is None:
        fallback = {}
    if not raw or not raw.strip():
        return fallback, "空参数"
    # 尝试直接解析
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        pass
    # 修复1: 去掉首尾非JSON垃圾（如 LLM 加了前导说明）
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0)), None
        except json.JSONDecodeError:
            pass
    # 修复2: 去掉尾逗号
    cleaned = re.sub(r',\s*}', '}', raw)
    cleaned = re.sub(r',\s*]', ']', cleaned)
    try:
        return json.loads(cleaned), None
    except json.JSONDecodeError as e:
        return fallback, f"JSON解析失败: {e}"

def _fuzzy_match_tool(name: str, tool_names: List[str], threshold: float = 0.5) -> Optional[str]:
    """模糊匹配工具名。精确匹配优先；否则按子串包含 + 编辑距离兜底。"""
    if name in tool_names:
        return name
    # 子串包含
    for tn in tool_names:
        if name in tn or tn in name:
            return tn
    # 简单编辑距离
    best, best_dist = None, 999
    for tn in tool_names:
        dist = _edit_distance(name, tn)
        if dist < best_dist:
            best_dist = dist
            best = tn
    max_dist = max(len(name), len(best or "")) * (1 - threshold)
    return best if best_dist <= max_dist else None

def _edit_distance(a: str, b: str) -> int:
    """Levenshtein 编辑距离"""
    m, n = len(a), len(b)
    dp = list(range(n + 1))
    for i in range(1, m + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, n + 1):
            temp = dp[j]
            if a[i-1] == b[j-1]:
                dp[j] = prev
            else:
                dp[j] = 1 + min(prev, dp[j], dp[j-1])
            prev = temp
    return dp[n]

def _validate_tool_args(tool: 'Tool', raw_args: dict) -> Tuple[dict, Optional[str]]:
    """校验工具参数，填充默认值，返回 (validated_args, error_msg)。"""
    validated = {}
    for param_name, param_spec in tool.params.items():
        if param_name in raw_args:
            validated[param_name] = raw_args[param_name]
        else:
            # 尝试填充默认值
            default = param_spec.get("default")
            if default is not None:
                validated[param_name] = default
            else:
                return {}, f"缺少必要参数 '{param_name}'（工具 {tool.name}）"
    # 保留额外参数（LLM 可能多传无关参数，容错不拒绝）
    for k, v in raw_args.items():
        if k not in validated:
            validated[k] = v
    return validated, None

def _dispatch_tool_call(child, tc: dict) -> Tuple[str, str]:
    """安全分发单个工具调用，返回 (tool_name, result_str)。
    失败时返回错误消息，绝不抛异常。"""
    # 1. 提取 function 块
    fn_block = tc.get("function")
    if not fn_block:
        return "?", "[工具调用错误] tool_call 缺少 function 字段"

    raw_name = fn_block.get("name", "")
    raw_args = fn_block.get("arguments", "{}")
    call_id = tc.get("id", "unknown")

    # 2. 解析参数 JSON
    parsed_args, json_err = _safe_parse_json(raw_args)
    if json_err:
        return raw_name, (
            f"[工具调用错误] 参数JSON解析失败: {json_err}\n"
            f"原始参数: {raw_args[:300]}\n"
            f"请用合法的JSON重新调用工具。"
        )

    # 3. 工具名模糊匹配
    valid_names = [t.name for t in child.tools]
    matched_name = _fuzzy_match_tool(raw_name, valid_names)
    if matched_name is None:
        return raw_name, (
            f"[工具调用错误] 工具 '{raw_name}' 不存在。\n"
            f"可用工具: {', '.join(valid_names)}\n"
            f"请选择正确的工具名称重新调用。"
        )
    if matched_name != raw_name:
        raw_name = matched_name  # 使用模糊匹配后的名称

    # 4. 找到工具实例
    tool = None
    for t in child.tools:
        if t.name == matched_name:
            tool = t
            break
    if tool is None:
        return matched_name, f"[工具调用错误] 工具 '{matched_name}' 内部未找到"

    # 5. 参数校验与默认值填充
    validated_args, arg_err = _validate_tool_args(tool, parsed_args)
    if arg_err:
        return matched_name, (
            f"[工具调用错误] {arg_err}\n"
            f"该工具的参数定义: {json.dumps(tool.params, ensure_ascii=False)}\n"
            f"你提供的参数: {json.dumps(parsed_args, ensure_ascii=False)[:200]}\n"
            f"请补充缺失的参数后重新调用。"
        )

    return matched_name, child.exec_tool(matched_name, validated_args)


# ── 工具执行器（带重试+降级）─────────────────────────
class ToolExecutor:
    """工具执行器 — 失败自动重试 + 降级链 + 延迟记录"""

    # 降级链：工具名 → 备选工具列表
    DEGRADATION_CHAINS = {
        "web_search": ["search_wikipedia", "web_fetch"],
    }

    MAX_RETRIES = 2   # 同一工具最多重试 2 次
    RETRY_DELAY = 1.0  # 重试间隔秒

    @staticmethod
    def execute(child_name: str, tool_name: str, args: dict, get_tool_fn: Callable) -> str:
        """执行工具，失败时自动重试并降级。返回结果字符串"""
        metrics = get_metrics()
        last_error = None

        # 当前工具名 + 降级链
        tool_chain = [tool_name] + ToolExecutor.DEGRADATION_CHAINS.get(tool_name, [])
        if tool_name not in ("web_search",):
            tool_chain = [tool_name]  # 仅搜索类工具走降级

        for chain_idx, current_tool in enumerate(tool_chain):
            t = get_tool_fn(current_tool)
            if t is None:
                continue

            for attempt in range(ToolExecutor.MAX_RETRIES):
                t0 = time.time()
                try:
                    result = t.executor(args)
                    lat = time.time() - t0
                    metrics.record_tool(child_name, current_tool, lat, error=False)
                    if chain_idx > 0:
                        # 降级成功，标注
                        return f"[降级至 {current_tool}]\n{result}"
                    return result
                except Exception as e:
                    lat = time.time() - t0
                    metrics.record_tool(child_name, current_tool, lat, error=True)
                    last_error = str(e)
                    if attempt < ToolExecutor.MAX_RETRIES - 1:
                        time.sleep(ToolExecutor.RETRY_DELAY * (attempt + 1))
                        continue
                    # 该工具重试耗尽，尝试下一个降级工具
                    break

        return f"[工具错误] {tool_name} 所有尝试均失败({ToolExecutor.MAX_RETRIES}次重试+降级链耗尽): {last_error}"


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

def _web_search(args):
    """真实联网搜索 — DuckDuckGo Lite"""
    import urllib.request, urllib.parse, re
    try:
        q = urllib.parse.quote(args["query"])
        req = urllib.request.Request(
            f"https://lite.duckduckgo.com/lite/?q={q}",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="replace")
        # 解析结果
        results = re.findall(r'<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>(.*?)</a>.*?<td[^>]*class="result-snippet"[^>]*>(.*?)</td>', html, re.DOTALL)
        if not results:
            # 备选: 正则宽松匹配
            results = re.findall(r'<a[^>]*href="(https?://[^"]+)"[^>]*class="result-link"[^>]*>(.*?)</a>.*?class="result-snippet"[^>]*>(.*?)</td>', html, re.DOTALL)
        if not results:
            return f"未找到相关结果。\n(搜索词: {args['query']})"
        lines = []
        for i, (url, title, snippet) in enumerate(results[:5], 1):
            t = re.sub(r'<[^>]+>', '', title).strip()
            s = re.sub(r'<[^>]+>', '', snippet).strip()[:300]
            lines.append(f"{i}. **{t}**\n   {url}\n   {s}")
        return "\n\n".join(lines) or "未找到结果"
    except Exception as e: return f"搜索失败: {e}"

def _web_fetch(args):
    """抓取网页正文"""
    import urllib.request, re
    try:
        req = urllib.request.Request(
            args["url"],
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="replace")
        # 去标签取纯文本
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        max_len = int(args.get("max_chars", 3000))
        return text[:max_len] if len(text) > max_len else text
    except Exception as e: return f"抓取失败: {e}"

_WS = os.path.dirname(os.path.abspath(__file__))

# ═══════════ 权限管理器 ─────────────────────────────
class PermissionBroker:
    """文件系统权限中介 — 阻塞等待用户确认，仅允许授权路径。
    
    通过 enabled 属性控制开关：
    - enabled=True: 越界路径需弹窗确认
    - enabled=False: 所有路径直接放行（默认）
    """

    def __init__(self):
        self._whitelist: set = set()
        self._lock = threading.RLock()
        self._pending: Dict[str, dict] = {}
        self._results: Dict[str, bool] = {}
        self._enabled = False  # 默认关闭权限检查
        self._whitelist.add(os.path.realpath(_WS))

    @property
    def enabled(self) -> bool:
        return self._enabled

    def toggle(self, on: bool = None) -> bool:
        """切换权限开关。on=None 反转，on=True 开启，on=False 关闭。返回新状态"""
        with self._lock:
            if on is None:
                self._enabled = not self._enabled
            else:
                self._enabled = on
            return self._enabled

    def is_whitelisted(self, real_path: str) -> bool:
        """检查路径或其父目录是否在白名单中"""
        rp = os.path.realpath(real_path)
        with self._lock:
            for w in self._whitelist:
                if rp.startswith(w + os.sep) or rp == w:
                    return True
        return False

    def grant(self, path: str):
        """永久授权某路径（加入白名单）"""
        rp = os.path.realpath(path)
        with self._lock:
            self._whitelist.add(rp)

    def request(self, path: str, reason: str, timeout: float = 30.0) -> bool:
        """请求权限，阻塞等待用户确认。返回 True/False"""
        rp = os.path.realpath(path)
        with self._lock:
            if self.is_whitelisted(rp):
                return True
            # 检查是否已有 pending 请求
            if rp in self._pending:
                ev = self._pending[rp]["event"]
            else:
                ev = threading.Event()
                self._pending[rp] = {
                    "event": ev,
                    "reason": reason,
                    "timestamp": time.time(),
                }
        # 等待用户响应（释放锁后等待）
        granted = ev.wait(timeout=timeout)
        with self._lock:
            result = self._results.pop(rp, False)
            self._pending.pop(rp, None)
        return granted and result

    def respond(self, path: str, allowed: bool):
        """用户响应：允许或拒绝"""
        rp = os.path.realpath(path)
        with self._lock:
            self._results[rp] = allowed
            if allowed:
                self._whitelist.add(rp)
            if rp in self._pending:
                self._pending[rp]["event"].set()

    def get_pending(self) -> List[dict]:
        """获取所有待处理的权限请求"""
        with self._lock:
            return [
                {"path": p, "reason": v["reason"], "timestamp": v["timestamp"]}
                for p, v in self._pending.items()
                if not v["event"].is_set()
            ]

# 全局权限中介
_permission = PermissionBroker()

def _safe_path(p: str, reason: str = "") -> str:
    """解析路径。权限关闭时全放行；开启时越界路径需用户确认"""
    real = os.path.realpath(os.path.join(_WS, p))
    ws_real = os.path.realpath(_WS)

    # 工作目录内直接放行
    if real.startswith(ws_real + os.sep) or real == ws_real:
        return real

    # 权限关闭 → 全放行
    if not _permission.enabled:
        return real

    # 权限开启 → 检查白名单
    if _permission.is_whitelisted(real):
        return real

    # 需要用户确认
    if not reason:
        reason = f"请求访问目录外路径: {p}"
    granted = _permission.request(real, reason)
    if not granted:
        raise PermissionError(f"用户拒绝了路径访问: {p}")
    return real

def _ls(args):
    try:
        path = _safe_path(args["path"], f"列出目录: {args['path']}")
        files = os.listdir(path)
        return f"共 {len(files)} 个: {', '.join(files[:20])}"
    except Exception as e: return f"错误: {e}"

def _read(args):
    try:
        path = _safe_path(args["path"], f"读取文件: {args['path']}")
        with open(path) as f: return f.read()
    except Exception as e: return f"读取失败: {e}"

def _write(args):
    try:
        path = _safe_path(args["path"], f"写入文件: {args['path']}")
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f: f.write(args["content"])
        return f"已写入 {args['path']}"
    except Exception as e: return f"写入失败: {e}"

def _mkdir(args):
    """创建文件夹（支持多级）"""
    try:
        path = _safe_path(args["path"], f"创建文件夹: {args['path']}")
        os.makedirs(path, exist_ok=True)
        return f"已创建目录 {args['path']}"
    except Exception as e: return f"创建失败: {e}"

def _edit(args):
    """编辑文件 — 精确替换文本"""
    try:
        path = _safe_path(args["path"], f"编辑文件: {args['path']}")
        with open(path, "r") as f: content = f.read()
        old = args["old_text"]
        new = args["new_text"]
        if old not in content:
            return f"未找到匹配文本，编辑取消。文件长度: {len(content)}"
        count = content.count(old)
        if count > 1 and not args.get("replace_all"):
            return f"匹配到 {count} 处，请设置 replace_all=true 或缩小 old_text 范围"
        new_content = content.replace(old, new) if args.get("replace_all") else content.replace(old, new, 1)
        with open(path, "w") as f: f.write(new_content)
        return f"已编辑 {args['path']}（替换 {count if args.get('replace_all') else 1} 处）"
    except Exception as e: return f"编辑失败: {e}"

def _rm(args):
    """删除文件或文件夹"""
    import shutil
    try:
        path = _safe_path(args["path"], f"删除: {args['path']}")
        if not os.path.exists(path):
            return f"路径不存在: {args['path']}"
        if os.path.isdir(path):
            shutil.rmtree(path)
            return f"已删除目录 {args['path']}"
        else:
            os.remove(path)
            return f"已删除文件 {args['path']}"
    except Exception as e: return f"删除失败: {e}"

def _cp(args):
    """复制文件或文件夹"""
    import shutil
    try:
        src = _safe_path(args["src"], f"复制源: {args['src']}")
        dst = _safe_path(args["dst"], f"复制目标: {args['dst']}")
        if not os.path.exists(src):
            return f"源路径不存在: {args['src']}"
        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        return f"已复制 {args['src']} → {args['dst']}"
    except Exception as e: return f"复制失败: {e}"

def _mv(args):
    """移动/重命名文件或文件夹"""
    try:
        src = _safe_path(args["src"], f"移动源: {args['src']}")
        dst = _safe_path(args["dst"], f"移动目标: {args['dst']}")
        if not os.path.exists(src):
            return f"源路径不存在: {args['src']}"
        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        os.rename(src, dst)
        return f"已移动 {args['src']} → {args['dst']}"
    except Exception as e: return f"移动失败: {e}"

def _run_code(args):
    """安全沙箱代码执行 — Agent 自主决策进入沙箱（CPU限制30s, 内存512MB, 无网络, 无文件写权限）"""
    code = args["code"]
    # 自主决策：代码执行一律进沙箱
    if auto_sandbox.should_sandbox("code_execution"):
        result = run_sandboxed(code, timeout=30)
    else:
        result = run_sandboxed(code, timeout=30)  # 始终沙箱，防线不可降级
    parts = ["[沙箱自动启动] Agent 自主将代码送入隔离环境执行"]
    if result["stdout"]:
        parts.append(f"[stdout]\n{result['stdout'][:2000]}")
    if result["stderr"]:
        parts.append(f"[stderr]\n{result['stderr'][:1000]}")
    if result.get("timed_out"):
        parts.append("[警告] 代码执行超时(30s)")
    if result.get("error") and result["error"] != "timeout":
        parts.append(f"[沙箱错误] {result['error']}")
    parts.append(f"[exit_code] {result['exit_code']}")
    return "\n".join(parts)


# ── 反编译工具 ─────────────────────────────────────────
_decompiler_instance = Decompiler()

def _decompile_detect(args):
    """检测二进制/字节码文件的格式"""
    try:
        path = _safe_path(args["file_path"], f"检测文件格式: {args['file_path']}")
        result = _decompiler_instance.detect_format(path)
        if result.get("detected"):
            return f"检测到格式: {result['format']}\n类型: {result.get('type', '未知')}\n置信度: {result.get('confidence', 'N/A')}\n\n{json.dumps(result, indent=2, ensure_ascii=False)}"
        return f"未能识别格式。\n{json.dumps(result, indent=2, ensure_ascii=False)}"
    except Exception as e:
        return f"格式检测失败: {e}"

def _decompile(args):
    """反编译二进制/字节码文件"""
    try:
        path = _safe_path(args["file_path"], f"反编译文件: {args['file_path']}")
        output_format = args.get("output_format", "text")
        result = _decompiler_instance.decompile(path, output_format=output_format)
        if isinstance(result, dict) and result.get("error"):
            return f"反编译失败: {result['error']}"
        if isinstance(result, dict):
            return json.dumps(result, indent=2, ensure_ascii=False)
        return str(result)[:5000]
    except Exception as e:
        return f"反编译失败: {e}"

def _decompile_formats(args=None):
    """列出支持反编译的文件格式"""
    try:
        fmts = get_supported_formats()
        lines = ["支持的反编译格式:"]
        for cat, exts in fmts.items():
            lines.append(f"  {cat}: {', '.join(exts)}")
        lines.append(f"\n可用工具: {json.dumps(_decompiler_instance.supported, indent=2, ensure_ascii=False)}")
        return "\n".join(lines)
    except Exception as e:
        return f"查询失败: {e}"

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
        # memdir 用于 Skill 学习闭环等场景
        self.memdir: Path = Path(memdir.root)

    def tool_schemas(self) -> list:
        return [t.schema() for t in self.tools]

    def exec_tool(self, name: str, args: dict) -> str:
        """工具执行 — 经 ToolExecutor 重试/降级"""
        def _finder(n: str):
            for t in self.tools:
                if t.name == n:
                    return t
            return None
        return ToolExecutor.execute(self.name, name, args, _finder)

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
- 文件Agent: 读写文件、文件管理、文档处理、反编译（检测/反编译pyc/ELF/PE/APK/class/WASM等二进制文件）

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

    def __init__(self, pool: ModelPool, verbose: bool = True, coordinator_mode: bool = True, fallback_mode: bool = True):
        self.pool = pool
        self.log = Logger(enabled=verbose)
        self.children: Dict[str, ChildBot] = {}
        self.shared_msgs: List[dict] = []
        self.coordinator_mode = coordinator_mode
        self.fallback_mode = fallback_mode  # 多模型兜底：主模型失败自动换备用
        self.permissions: Dict[str, bool] = {}  # 通用权限（对话级）
        self._perm_pending: Optional[tuple] = None  # (user_input, image) 授权后自动重试
        # 追踪活跃的 agent 上下文（用于 Continue 决策）
        self._agent_contexts: Dict[str, dict] = {}  # agent_name → {last_task, last_output, files_accessed}
        # 上下文摘要（压缩旧对话后的长期记忆）
        self._context_summary: str = ""
        self._init_children()
        self._load_context()  # 从磁盘恢复上下文

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
                system_prompt="你是信息检索专家。收到查询后调用插件获取数据，整理结果并注明来源。语气简洁专业。\n注意：你只有只读权限，如需创建/修改/删除文件，请明确告知父Bot处理。\n联网搜索用 web_search，阅读具体网页用 web_fetch。",
                tools=[
                    Tool("web_search", "联网搜索(DuckDuckGo)，返回标题+链接+摘要",
                         {"query": {"type": "string", "description": "搜索关键词"}}, _web_search),
                    Tool("web_fetch", "抓取网页正文内容",
                         {"url": {"type": "string", "description": "网页URL"}}, _web_fetch),
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
- 报告时包含验证结果
- 需要创建/写文件时，告知父Bot处理；你只能读文件""",
                tools=[
                    Tool("run_code", "执行Python代码并返回结果", 
                         {"code": {"type": "string", "description": "Python代码"}}, _run_code),
                    Tool("read_file", "读取文件", {"path": {"type": "string", "description": "路径"}}, _read),
                    Tool("list_files", "列出目录", {"path": {"type": "string", "description": "路径"}}, _ls),
                ] + mem_tools,
                self_verify=True,
            ),
            "文件Agent": ChildBot(
                name="文件Agent",
                description="文件分析、文档处理、反编译",
                system_prompt="你是文件分析助手。你只有只读权限，可读取和列出文件，但不能创建/修改/删除文件。\n\n附加能力 — 逆向工程：你具备二进制分析技能，能识别ELF/PE/Mach-O/APK/DEX/.NET/Python字节码/Lua/WASM等格式，使用decompile_detect检测文件类型后调用decompile反编译，解读结果时关注关键逻辑和入口点。工具不可用时说明原因并建议替代方案。\n\n如果需要实际创建/修改/删除文件，告知父Bot处理。",
                tools=[
                    Tool("list_files", "列出目录", {"path": {"type": "string", "description": "路径"}}, _ls),
                    Tool("read_file", "读取文件", {"path": {"type": "string", "description": "路径"}}, _read),
                    Tool("decompile_detect", "检测二进制/字节码文件格式（如pyc、ELF、PE、APK、class等），返回格式类型和置信度",
                         {"file_path": {"type": "string", "description": "文件路径"}}, _decompile_detect),
                    Tool("decompile", "反编译二进制/字节码文件，支持output_format参数(text/json/ast)",
                         {"file_path": {"type": "string", "description": "文件路径"}, "output_format": {"type": "string", "description": "输出格式:text/json/ast，默认text"}}, _decompile),
                    Tool("decompile_formats", "列出所有支持反编译的文件格式和可用工具状态", {}, _decompile_formats),
                ] + mem_tools,
            ),
        }

        # ── 父Bot专属文件系统工具 ──
        self._file_tools = {
            "mkdir": _mkdir, "create_folder": _mkdir,
            "write_file": _write, "edit_file": _edit,
            "delete_path": _rm, "copy_path": _cp, "move_path": _mv,
            "list_files": _ls, "read_file": _read,
        }

    # ═══════════ 父Bot直接文件操作 ═══════════
    _FILE_OP_KEYWORDS = [
        "创建文件夹", "新建文件夹", "建个文件夹", "mkdir",
        "写入文件", "写文件", "保存文件", "创建文件", "写入",
        "修改文件", "编辑文件", "替换",
        "删除文件", "删除文件夹", "删掉", "移除",
        "复制文件", "移动文件", "重命名",
        "列出文件", "列出目录", "读取文件", "读文件", "读取",
    ]

    def _is_file_op(self, query: str) -> bool:
        q = query.lower()
        # 权限开关指令
        if any(kw in q for kw in ["开启权限", "关闭权限", "打开权限", "权限开关", "关闭文件权限", "开启文件权限"]):
            return True
        return any(kw in q for kw in self._FILE_OP_KEYWORDS)

    def _handle_file_op(self, query: str) -> Optional[str]:
        """尝试用LLM解析用户意图 → 直接调用文件工具，绕过子Agent"""
        q = query.lower()

        # ── 权限开关 ──
        if any(kw in q for kw in ["开启权限", "打开权限", "开启文件权限"]):
            _permission.toggle(True)
            return "权限保护已开启。访问工作目录外的路径时需要弹窗确认。"
        if any(kw in q for kw in ["关闭权限", "关闭文件权限"]):
            _permission.toggle(False)
            return "权限保护已关闭。所有路径均可直接访问。"
        if "权限开关" in q or "权限状态" in q:
            status = "开启" if _permission.enabled else "关闭"
            return f"权限保护当前: {status}"

        # ── LLM 解析 + 重试（权限拒绝后让 LLM 换方案）──
        file_tool_spec = "\n".join(
            f"- {name}: {desc}" for name, desc in [
                ("mkdir(path)", "创建文件夹"),
                ("write_file(path, content)", "写入文件"),
                ("edit_file(path, old_text, new_text, replace_all?)", "编辑文件（精确替换）"),
                ("delete_path(path)", "删除文件或文件夹"),
                ("copy_path(src, dst)", "复制文件/文件夹"),
                ("move_path(src, dst)", "移动/重命名文件/文件夹"),
                ("list_files(path)", "列出目录内容"),
                ("read_file(path)", "读取文件内容"),
            ]
        )

        history = ""
        for attempt in range(100):
            prompt = f"""你是文件操作解析器。根据用户意图输出 JSON 调用。

可用工具:
{file_tool_spec}

工作目录: {_WS}

用户: {query}
{history}
只输出 JSON（不要额外文字）:
{{"tool": "工具名", "args": {{参数...}} }}"""
            try:
                msgs = [{"role": "user", "content": prompt}]
                resp = self._llm_call("__file_op__", msgs)
                text = resp["choices"][0]["message"]["content"].strip()
                import re as _re, json as _json
                m = _re.search(r'\{[^{}]*"tool"[^{}]*\}', text, _re.DOTALL)
                if not m:
                    self.log.sys(f"LLM解析失败(attempt {attempt+1}): {text[:100]}")
                    history = f"\n[上次解析失败，请重新输出正确的 JSON]"
                    continue
                call = _json.loads(m.group(0))
                tool_name = call.get("tool", "")
                args = call.get("args", {})
                if tool_name not in self._file_tools:
                    history = f"\n[工具 {tool_name} 不存在，可用: {list(self._file_tools.keys())}]"
                    continue
                self.log.sys(f"父Bot执行: {tool_name}({args})")

                try:
                    return self._file_tools[tool_name](args)
                except PermissionError as pe:
                    # 权限被拒 → 让 LLM 换方案
                    denied_path = str(pe)
                    self.log.sys(f"权限被拒: {denied_path}，让LLM换方案(attempt {attempt+1})")
                    history = f"\n[上一步失败: 路径权限被拒绝({denied_path})。请换一种方式或换一个路径来实现用户需求，不要重复同样的操作]"

            except Exception as e:
                self.log.sys(f"文件操作异常(attempt {attempt+1}): {e}")
                history = f"\n[上次出错: {e}，请调整方案]"

        return "多次尝试后仍无法完成。请检查路径权限或调整需求。"
    def _route(self, query: str) -> str:
        prompt = self.ROUTER_PROMPT.format(query=query)
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self._llm_call("__router__", msgs)
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
        if "保存" in q or "文件" in q or "读取" in q or "反编译" in q or "decompile" in q or "pyc" in q:
            self.log.sys(f'关键词路由 → "文件Agent"')
            return "文件Agent"
        kw = {
            "搜索Agent": (["搜索", "查", "什么是", "天气", "百科", "维基", "wiki", "新闻", "几度"], 0),
            "代码Agent": (["代码", "编程", "脚本", "写", "python", "bug", "报错", "函数", "算法", "开发"], 0),
            "文件Agent": (["文件", "保存", "读取", "目录", "列表", "创建", "写入", "文档", "反编译", "decompile", "pyc", "二进制", "字节码"], 0),
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
        reply, rounds = self._run_child(child, self._build_child_msgs(child, research_prompt))
        self._curate_skill(child, research_prompt, reply, rounds)
        return reply

    def _synthesize(self, original_query: str, research_result: str) -> str:
        """阶段2: 合成 — 协调者亲自理解并生成 spec"""
        self.log.sys("🧠 合成阶段 — 生成实施规格")
        prompt = self.SYNTHESIS_PROMPT.format(
            original_query=original_query,
            research_findings=research_result[:3000],
        )
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self._llm_call("__synthesizer__", msgs)
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
        reply, rounds = self._run_child(child, self._build_child_msgs(child, impl_prompt))
        self._curate_skill(child, impl_prompt, reply, rounds)
        return reply

    def _verification_phase(self, original_query: str, impl_result: str) -> str:
        """阶段4: 验证 — 对比原始需求"""
        self.log.sys("✅ 验证阶段")
        prompt = self.VERIFY_PROMPT.format(
            original_query=original_query,
            implementation_result=impl_result[:3000],
        )
        msgs = [{"role": "user", "content": prompt}]
        try:
            resp = self._llm_call("__verifier__", msgs)
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

    def _run_forked_child(self, source_name: str, task: str) -> str:
        """用 Fork 子代理执行任务（隔离上下文，继承父Bot共享记忆）"""
        fork_name = f"fork_{source_name}_{int(time.time())}"
        forked = self._fork_child(source_name, fork_name, task)
        if not forked:
            return f"Fork失败: 无法创建 {source_name} 的副本"

        self.log.sys(f"Fork执行: {fork_name}")
        messages = self._build_child_msgs(forked, task)
        reply, rounds = self._run_child(forked, messages)

        self._cleanup_fork(fork_name)
        return reply

    def _is_forkable(self, query: str) -> bool:
        """检测是否可以并行拆解为多个子任务"""
        q = query.lower()
        parallel_signals = ["同时", "并行", "一边", "分别", "各自", "parallel", "以及", "两件事", "都查", "都搜"]
        return any(s in q for s in parallel_signals) and len(query) > 15

    def _forked_chat(self, user_input: str) -> str:
        """Fork模式: 将任务拆解为并行子任务，各自用 Fork 执行"""
        # 用 LLM 拆解任务
        split_prompt = f"""将以下任务拆解为2-3个可并行执行的子任务。每个子任务一行，用"|||"分隔。只输出子任务列表，不要其他文字。

任务: {user_input}

子任务列表(用 ||| 分隔):"""
        try:
            msgs = [{"role": "user", "content": split_prompt}]
            resp = self._llm_call("__fork_split__", msgs)
            tasks_text = resp["choices"][0]["message"]["content"].strip()
            sub_tasks = [t.strip() for t in tasks_text.split("|||") if t.strip()]
            if len(sub_tasks) < 2:
                # 拆解失败，回退普通模式
                return self._simple_chat(user_input)

            self.log.sys(f"Fork模式: 拆解为{len(sub_tasks)}个子任务")
            results = []
            for i, task in enumerate(sub_tasks):
                # 路由决定用哪个 Agent 类型
                child_name = self._route(task)
                self.log.sys(f"  Fork-{i+1}: {child_name} → {task[:50]}")
                result = self._run_forked_child(child_name, task)
                results.append(f"[子任务{i+1} — {child_name}]\n{result[:800]}")

            final = "\n\n---\n\n".join(results)
            # 汇总结果
            summary_prompt = f"""用户原始需求: {user_input}

各子任务执行结果:
{final}

请汇总各子任务结果，给出一个整合的最终回复。"""
            msgs2 = [{"role": "user", "content": summary_prompt}]
            resp2 = self._llm_call("__fork_merge__", msgs2)
            merged = resp2["choices"][0]["message"]["content"].strip()

            self._update_shared_history(user_input, merged)
            return merged
        except Exception as e:
            self.log.error(f"Fork模式失败: {e}")
            return self._simple_chat(user_input)

    # ═══════════ 对话 ═══════════
    def chat(self, user_input: str, image: str = None) -> str:
        import re
        stripped = user_input.strip()

        # ── 通用权限命令：/screencap allow, /root deny, /screen allow(兼容) ──
        perm_cmd = re.match(r'^/(\w+) (allow|deny)$', stripped)
        if perm_cmd:
            ptype = perm_cmd.group(1)
            action = perm_cmd.group(2)
            if ptype == 'screen':
                ptype = 'screencap'
            self.permissions[ptype] = (action == 'allow')
            self.log.sys(f"权限 {ptype} → {action}")
            msg = f"已{'授予' if action == 'allow' else '拒绝'}「{ptype}」权限。"
            if action == 'allow' and self._perm_pending:
                retry_input, retry_image = self._perm_pending
                self._perm_pending = None
                return msg + "\n\n" + self.chat(retry_input, retry_image)
            return msg

        # ── 回退命令 ──
        if stripped in ("回退", "回滚", "撤销分支", "/rollback"):
            return self._rollback_chat()

        # ── Agent 管理命令 ──
        if stripped.startswith("/agents"):
            agents = self.list_agents()
            return "\n".join(f"{a['name']}: {a['desc']} ({a['tools']}工具)" for a in agents)
        if stripped.startswith("/metrics"):
            return get_metrics().summary()

        # ── 屏幕截图触发词 ──
        if stripped in ("/screen", "截图", "截屏", "看屏幕", "看看屏幕"):
            return self._handle_screen(stripped)

        # ── 项目命令 ──
        if self._is_project_cmd(user_input):
            return self._project_chat(user_input)

        # ── 父Bot直接拦截文件操作 ──
        if self._is_file_op(user_input):
            result = self._handle_file_op(user_input)
            if result is not None:
                self.log.sys("父Bot直接处理文件操作")
                self._update_shared_history(user_input, result)
                return self._intercept_permission(result, user_input, image)

        # 自主闭环: 需要多步探索的任务
        if self._is_autonomous_task(user_input):
            return self._intercept_permission(self._autonomous_chat(user_input, image), user_input, image)

        # DAG编排: 多阶段依赖任务
        if self._is_dag_task(user_input) and self.coordinator_mode:
            return self._intercept_permission(self._dag_chat(user_input), user_input, image)

        # Fork模式: 可并行拆解的任务
        if self._is_forkable(user_input):
            return self._intercept_permission(self._forked_chat(user_input), user_input, image)

        # 协调者模式: 复杂任务走四阶段
        if self.coordinator_mode and self._is_complex_task(user_input):
            return self._intercept_permission(self._coordinator_chat(user_input), user_input, image)

        # 普通模式: 单阶段路由
        return self._intercept_permission(self._simple_chat(user_input, image), user_input, image)

    # ═══════════ 通用权限拦截 ═══════════
    PERM_RE = None  # lazy compiled

    def _intercept_permission(self, reply: str, user_input: str, image: str = None) -> str:
        """子Agent 响应中检测 [PERM:type]描述 并挂起原请求，授权后自动重试。"""
        if not reply.startswith('[PERM:'):
            return reply
        # 解析权限类型
        if ParentBot.PERM_RE is None:
            ParentBot.PERM_RE = __import__('re').compile(r'^\[PERM:(\w+)\]')
        m = ParentBot.PERM_RE.match(reply)
        if not m:
            return reply
        perm_type = m.group(1)
        desc = reply[m.end():].strip()
        if not desc:
            desc = f"继续执行当前任务"
        # 子Agent描述中若不含 ||，尝试提取路径作为目标
        if '||' not in desc:
            import re as _re
            path_m = _re.search(r'(/[^\s,，]+|~[^\s,，/]+)', desc)
            if path_m:
                target = path_m.group(1).rstrip('.。')
                before = desc[:path_m.start()].strip().rstrip('，,。. ').rstrip('，, 。.')
                after  = desc[path_m.end():].strip().lstrip('，,。. ')
                reason = f"{before}；{after}" if before and after else (before or after or '需要此权限以继续操作。')
                desc = f"{target}||{reason}"
            else:
                desc = f"—||{desc}"
        self._perm_pending = (user_input, image)
        self.log.sys(f"子Agent请求权限: {perm_type}")
        return f"[PERM:{perm_type}]{desc}"

    # ═══════════ 屏幕命令 ═══════════
    def _handle_screen(self, trigger: str = "") -> str:
        """Agent 自主权限判断 + 截图分析。权限是对话级内部状态，随 reset() 清空。"""
        if not self.permissions.get('screencap'):
            self._perm_pending = (trigger, None)  # 挂起原请求，授权后自动重试
            return (
                "[PERM:screencap]"
                "当前屏幕"
                "||"
                "可获取当前屏幕上显示的全部内容（窗口布局、文字信息、图片等），用于视觉分析与辅助操作。"
            )
        self.log.sys("截图中...")
        try:
            path = capture()
            if not path:
                return "截图失败：未找到可用截图工具。"
            b64 = to_base64(path)
            messages = [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "描述这张截图中屏幕上的内容。用中文简要回答。"},
                    {"type": "image_url", "image_url": {"url": b64}},
                ]
            }]
            resp = self._llm_call("搜索Agent", messages)
            return resp.get("choices", [{}])[0].get("message", {}).get("content", "截图分析失败")
        except ImportError:
            return "屏幕截图功能不可用（本地环境缺少 screen_reader 依赖）。"
        except Exception as e:
            self.log.error(f"截图失败: {e}")
            return f"截图失败: {e}"

    def _simple_chat(self, user_input: str, image: str = None) -> str:
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

        messages = self._build_child_msgs(child, user_input, mem_text, image)
        child_reply, rounds = self._run_child(child, messages)

        # 自校验
        if child.self_verify and "代码" in child_name:
            verify_result = child.verify(child_reply, self.pool)
            self.log.sys(f"自校验: {'PASS' if 'PASS' in verify_result else '需要检查'}")
            if "PASS" not in verify_result:
                child_reply = f"{child_reply}\n\n[自校验]\n{verify_result[:300]}"

        # Skill 学习闭环 — 借鉴 Hermes Agent Curator
        self._curate_skill(child, user_input, child_reply, rounds)

        # 记忆落盘
        self._child_memorize(child, user_input, child_reply)
        self._update_context(child_name, user_input, child_reply)
        self._update_shared_history(user_input, child_reply, image)
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

    def _llm_call(self, agent: str, messages: list, tools: list = None, extra_fallbacks: list = None) -> dict:
        """统一 LLM 调用入口：根据 fallback_mode 自动选择兜底或直调。
        兜底模式下主模型失败会依次尝试备用模型，返回结果中 _tried 记录尝试链。"""
        if self.fallback_mode:
            return self.pool.call_llm_with_fallback(agent, messages, tools, fallback_models=extra_fallbacks)
        return self._llm_call(agent, messages, tools)

    def _build_child_msgs(self, child: ChildBot, user_input: str,
                          extra_context: str = "", image: str = None) -> list:
        """构建子Agent消息列表 — v4: 指向 memdir/MEMORY.md 自举"""
        boot_prompt = (
            f"{child.system_prompt}\n\n"
            f"## 启动指令\n"
            f"处理任务前，先用 memdir_read 读取 'MEMORY.md'——你的长期行为准则。\n"
            f"这是你作为 Agent 积累的深层经验：怎么思考、怎么判断、怎么表达。\n\n"
            f"注意：MEMORY.md 只记录长期演化经验（被反复验证有效的原则），"
            f"不是单次对话笔记（那些自动存入 JSON memory）。\n"
            f"只有当你在多轮对话中反复发现某条行为准则确实有效，"
            f"才用 memdir_write 追加到 MEMORY.md 的「长期演化日志」章节。"
        )
        messages = [{"role": "system", "content": boot_prompt}]
        if child.knowledge:
            kb_text = "\n\n".join(child.knowledge)
            messages.append({"role": "system", "content": f"[知识库]\n{kb_text}"})
        # ── 注入最近对话上下文（让子Agent知道刚才说了什么）──
        recent = self.shared_msgs[-8:]
        if recent:
            # 提炼：用 LLM 提取关键决策和约束，过滤废话
            distilled = self._distill_context(recent)
            ctx_lines = ["[## 对话关键要点提炼]" + (f"\n{distilled}" if distilled else "")]
            ctx_lines.append("\n[## 最近原始对话]")
            for m in recent:
                role_label = "用户" if m["role"] == "user" else "助手"
                ctx_lines.append(f"【{role_label}】{m['content']}")
            messages.append({"role": "system", "content": "\n".join(ctx_lines)})
        # ── 注入长期上下文摘要（跨会话记忆）──
        if self._context_summary:
            messages.append({"role": "system",
                "content": f"[长期上下文摘要 - 这是此前对话中提炼的关键信息]\n{self._context_summary}"})
        # ── 注入记忆文件夹上下文 ──
        mem_results = memdir.search(user_input)
        if mem_results:
            mem_lines = ["[记忆文件夹 - 匹配记录]"]
            for r in mem_results[:5]:
                mem_lines.append(f"### {r['rel']}\n{r['preview'][:500]}")
            messages.append({"role": "system", "content": "\n".join(mem_lines)})
        # ── 注入学习到的 Skill ──
        skill_text = self._inject_skills(child, user_input)
        if skill_text:
            messages.append({"role": "system", "content": skill_text})
        content = f"{extra_context}\n---\n{user_input}" if extra_context else user_input
        if image:
            # OpenAI vision 格式：content 为数组，文本 + 图片
            content = [
                {"type": "text", "text": content},
                {"type": "image_url", "image_url": {"url": image}}
            ]
        messages.append({"role": "user", "content": content})
        return messages

    def _run_child(self, child: ChildBot, messages: list) -> tuple:
        """子Agent工具调用循环 — v4: 思维链注入。返回 (reply, tool_rounds)"""
        metrics = get_metrics()
        tools = child.tool_schemas()
        for loop in range(5):
            t0 = time.time()
            resp = self._llm_call(child.name, messages, tools)
            latency = time.time() - t0

            usage = resp.get("usage", {})
            model = resp.get("_model", "?")
            tokens = usage.get("total_tokens", 0)
            self.log.llm(model, tokens, latency)
            metrics.record_llm(child.name, tokens, latency, model)

            msg = resp["choices"][0]["message"]
            tcs = msg.get("tool_calls")

            if not tcs:
                reply = msg.get("content", "")
                if loop > 0:
                    self.log.sys(f"工具完成({loop}轮)")
                return reply, loop

            messages.append(msg)
            tool_results = []
            errors = []
            for tc in tcs:
                fn, result = _dispatch_tool_call(child, tc)
                self.log.tool_start(fn, {})
                self.log.tool_end(result)
                tool_results.append({"name": fn, "result": str(result)})
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id", f"call_{loop}"),
                    "content": str(result),
                })
                # 检测工具调用是否有错误，收集起来给 LLM 自纠正
                if "[工具调用错误]" in result:
                    errors.append(f"  {fn}: {result[:300]}")

            # ── v5: 结构化错误反馈 + 思维链反思 ──
            result_summary = "\n".join(
                f"  {r['name']}: {r['result'][:200]}" for r in tool_results
            )
            if errors:
                error_block = (
                    f"[工具调用错误反馈]\n"
                    f"以下工具调用失败，请根据错误信息修正后重试。不要重复完全相同的错误调用：\n"
                    + "\n".join(errors) +
                    f"\n\n[工具执行摘要（含成功项）]\n{result_summary}\n\n"
                    f"请分析失败原因，修正参数或换用其他工具，然后继续。"
                )
                messages.append({"role": "system", "content": error_block})
            else:
                cot_prompt = (
                    f"[思考提示]\n"
                    f"工具已返回结果，摘要如下：\n{result_summary}\n\n"
                    f"请用自然语言表达你的反应——这个结果是印证了你的预期、修正了你的认知，"
                    f"还是引发了新问题？然后决定下一步：继续用工具探索，还是给出最终回答。"
                    f"最终回答前，请确认：答案有依据吗？来源可靠吗？还有遗漏吗？"
                )
                messages.append({"role": "system", "content": cot_prompt})

        return "[子Agent] 工具调用轮数超限", 5

    # ═══════════ 自主任务闭环 (Plan→Execute→Observe→Replan) ═══════════
    def _autonomous_chat(self, user_input: str, image: str = None) -> str:
        """自主多轮任务闭环：Agent 规划→执行→观察→重新规划，直到完成或卡住。
        最多 5 次迭代，每次迭代 Agent 自主判断是否完成。"""
        metrics = get_metrics()
        child_name = self._route(user_input)
        child = self.children[child_name]
        self.log.banner(f"自主闭环: {child_name}")

        # 初始规划
        plan_prompt = f"""你是一个自主任务执行器。收到任务后，先制定执行计划，然后逐步执行。
每一步执行完工具后，观察结果，决定下一步。如果任务完成，回复 FINISHED: 你的总结。

任务: {user_input}

执行计划（用 - 列出步骤，然后开始执行第一步）:"""
        messages = self._build_child_msgs(child, plan_prompt)

        all_results = []
        for iteration in range(5):
            self.log.sys(f"自主闭环 迭代{iteration+1}/5")
            reply, rounds = self._run_child(child, messages)

            if reply.startswith("FINISHED:"):
                final = reply.replace("FINISHED:", "").strip()
                self.log.sys(f"自主闭环完成: {len(final)}字")
                self._child_memorize(child, user_input, final)
                self._update_context(child_name, user_input, final)
                self._update_shared_history(user_input, final, image)
                metrics.record_task(child_name, True)
                metrics.record_autonomous_loop(child_name)
                return final

            all_results.append(reply)
            # 追加观察提示
            observe_prompt = (
                f"[观察]\n上一步结果:\n{reply[:500]}\n\n"
                f"请判断：任务是否已完成？如果完成，回复 FINISHED: 你的总结。"
                f"如果未完成，继续下一步操作。"
            )
            messages.append({"role": "system", "content": observe_prompt})

        # 超限汇总
        summary_prompt = f"""任务执行了 5 轮仍未完成。请根据以下结果给出最优回答：

原始任务: {user_input}

各轮结果:
{chr(10).join(f'轮{i+1}: {r[:300]}' for i, r in enumerate(all_results))}

汇总回答:"""
        msgs = [{"role": "user", "content": summary_prompt}]
        resp = self._llm_call(child.name, msgs)
        final = resp["choices"][0]["message"]["content"].strip()
        self._update_shared_history(user_input, final, image)
        metrics.record_task(child_name, False)
        metrics.record_autonomous_loop(child_name)
        return f"[自主闭环 - 达到上限]\n{final}"

    def _is_autonomous_task(self, query: str) -> bool:
        """判断是否需要自主闭环模式"""
        auto_signals = [
            "帮我完成", "帮我做", "全部处理", "帮我搞定", "自动",
            "逐个", "一步步", "继续", "往下", "下一步",
            "搜索并总结", "调查", "深入研究", "对比分析",
        ]
        ql = query.lower()
        return any(s in ql for s in auto_signals) and len(query) > 20

    # ═══════════ Agent 间委托通信 ═══════════
    def delegate_to(self, from_agent: str, to_agent: str, task: str, context: str = "") -> str:
        """子 Agent 直接委托另一个 Agent 执行任务（peer-to-peer）"""
        if to_agent not in self.children:
            return f"委托失败: Agent '{to_agent}' 不存在"
        child = self.children[to_agent]
        self.log.sys(f"委托: {from_agent} → {to_agent}")
        prompt = f"[委托自 {from_agent}]\n{task}" + (f"\n\n上下文:\n{context}" if context else "")
        reply, _ = self._run_child(child, self._build_child_msgs(child, prompt))
        return reply

    # ═══════════ DAG 任务编排 ═══════════
    def _dag_chat(self, user_input: str) -> str:
        """DAG 任务图执行：LLM 拆解任务为有向无环图，按依赖顺序执行。"""
        self.log.banner("DAG 任务编排")

        # 用 LLM 拆解
        dag_prompt = f"""将以下任务拆解为任务图（DAG），每个节点一行。
格式: node_id: 依赖的node_id列表 | Agent名称 | 任务描述
依赖为空则用 [] 表示。

任务: {user_input}

DAG（只输出节点列表）:"""
        msgs = [{"role": "user", "content": dag_prompt}]
        resp = self._llm_call("__dag_split__", msgs)
        dag_text = resp["choices"][0]["message"]["content"].strip()

        # 解析DAG
        nodes = {}
        for line in dag_text.split("\n"):
            line = line.strip()
            if not line or not ":" in line:
                continue
            try:
                node_id, rest = line.split(":", 1)
                node_id = node_id.strip()
                deps_str, agent_task = rest.split("|", 1)
                deps = [d.strip() for d in deps_str.strip("[] ").split(",") if d.strip()]
                agent_part, task_desc = agent_task.split("|", 1)
                agent_name = agent_part.strip()
                task_desc = task_desc.strip()
                # 匹配 Agent
                if agent_name not in self.children:
                    for n in self.children:
                        if agent_name in n:
                            agent_name = n
                            break
                    else:
                        agent_name = self._route(task_desc)
                nodes[node_id] = {"deps": deps, "agent": agent_name, "task": task_desc, "result": None}
            except Exception:
                continue

        if not nodes:
            return self._simple_chat(user_input)  # 兜底

        self.log.sys(f"DAG 解析: {len(nodes)} 个节点")

        # 拓扑排序执行
        completed = set()
        results = {}
        while len(completed) < len(nodes):
            progress = False
            for nid, nd in nodes.items():
                if nid in completed:
                    continue
                if all(d in completed for d in nd["deps"]):
                    # 构建上下文（依赖节点的结果）
                    ctx = ""
                    if nd["deps"]:
                        dep_results = []
                        for d in nd["deps"]:
                            if nodes[d]["result"]:
                                dep_results.append(f"[{d}结果]: {nodes[d]['result'][:300]}")
                        ctx = "\n".join(dep_results)

                    child = self.children[nd["agent"]]
                    prompt = nd["task"]
                    if ctx:
                        prompt = f"前置结果:\n{ctx}\n\n当前任务: {prompt}"
                    reply, _ = self._run_child(child, self._build_child_msgs(child, prompt))
                    nd["result"] = reply
                    results[nid] = reply
                    completed.add(nid)
                    progress = True
                    self.log.sys(f"DAG 完成: {nid} ({nd['agent']})")

            if not progress:
                # 有循环依赖或解析错误
                pending = [n for n in nodes if n not in completed]
                self.log.sys(f"DAG 阻塞: 剩余节点 {pending}")
                break

        # 汇总
        merged = "\n\n---\n\n".join(f"**[{nid}]**\n{results[nid][:500]}" for nid in results)
        self._update_shared_history(user_input, merged)
        return merged

    def _is_dag_task(self, query: str) -> bool:
        """判断是否适合 DAG 编排"""
        dag_signals = ["先", "然后", "接着", "同时", "最后", "分别", "各自", "再", "并行"]
        ql = query.lower()
        return sum(1 for s in dag_signals if s in ql) >= 2 and len(query) > 15

    # ═══════════ 长期目标/项目追踪 ═══════════
    def _project_chat(self, user_input: str) -> str:
        """项目长目标追踪：创建/更新/查询项目进度。"""
        proj_dir = Path(memdir.root) / "projects"
        proj_dir.mkdir(exist_ok=True)
        proj_file = proj_dir / "_active.json"

        active_projects = {}
        if proj_file.exists():
            try:
                active_projects = json.loads(proj_file.read_text())
            except Exception:
                pass

        ql = user_input.lower()

        # 查询项目进度
        if any(kw in ql for kw in ["项目进度", "进度", "进行中", "还有哪些"]):
            if not active_projects:
                return "当前没有进行中的项目。说「创建项目: 项目名 | 目标描述」来开始。"
            lines = ["## 进行中的项目\n"]
            for pname, pdata in active_projects.items():
                lines.append(f"- **{pname}**: {pdata['goal'][:80]}")
                lines.append(f"  进度: {pdata.get('progress','新项目')} | 创建: {pdata.get('created','')}")
            return "\n".join(lines)

        # 创建项目
        if "创建项目:" in user_input or "新建项目:" in user_input:
            try:
                parts = user_input.split(":", 1)[1].strip().split("|", 1)
                name = parts[0].strip()
                goal = parts[1].strip() if len(parts) > 1 else ""
                active_projects[name] = {
                    "goal": goal, "progress": "已创建", "created": time.strftime("%Y-%m-%d %H:%M"),
                    "steps": [], "status": "active",
                }
                proj_file.write_text(json.dumps(active_projects, indent=2, ensure_ascii=False))
                self.log.sys(f"项目创建: {name}")
                return f"项目「{name}」已创建。目标: {goal[:100]}"
            except Exception as e:
                return f"创建失败: {e}"

        # 更新项目进度
        if "更新项目:" in user_input or "项目进展:" in user_input:
            try:
                parts = user_input.split(":", 1)[1].strip().split("|", 1)
                name = parts[0].strip()
                update = parts[1].strip() if len(parts) > 1 else "已更新"
                if name in active_projects:
                    active_projects[name]["progress"] = update
                    active_projects[name]["updated"] = time.strftime("%Y-%m-%d %H:%M")
                    proj_file.write_text(json.dumps(active_projects, indent=2, ensure_ascii=False))
                    return f"项目「{name}」已更新: {update[:100]}"
                return f"项目「{name}」不存在。可用项目: {list(active_projects.keys())}"
            except Exception as e:
                return f"更新失败: {e}"

        # 完成项目
        if "完成项目:" in user_input:
            try:
                name = user_input.split(":", 1)[1].strip()
                if name in active_projects:
                    done = active_projects.pop(name)
                    # 归档
                    archive_dir = proj_dir / "completed"
                    archive_dir.mkdir(exist_ok=True)
                    done["completed"] = time.strftime("%Y-%m-%d %H:%M")
                    (archive_dir / f"{name.replace('/','_')}.json").write_text(
                        json.dumps(done, indent=2, ensure_ascii=False))
                    proj_file.write_text(json.dumps(active_projects, indent=2, ensure_ascii=False))
                    return f"项目「{name}」已完成并归档。"
                return f"项目「{name}」不存在。"
            except Exception as e:
                return f"操作失败: {e}"

        return self._simple_chat(user_input)

    def _is_project_cmd(self, query: str) -> bool:
        ql = query.lower()
        return any(kw in ql for kw in ["项目进度", "创建项目", "新建项目", "更新项目", "完成项目", "项目进展"])

    # ═══════════ 对话分支与回溯 ═══════════
    def _branch_chat(self, user_input: str) -> str:
        """对话分支：Fork 一条独立分支尝试替代方案。"""
        branch_dir = Path(memdir.root) / "branches"
        branch_dir.mkdir(exist_ok=True)

        # 保存当前状态快照
        snapshot = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "shared_msgs": self.shared_msgs[-20:] if self.shared_msgs else [],
            "agent_contexts": copy.deepcopy(self._agent_contexts),
            "permissions": copy.deepcopy(self.permissions),
        }
        branch_id = f"branch_{int(time.time())}"
        (branch_dir / f"{branch_id}.json").write_text(json.dumps(snapshot, indent=2, ensure_ascii=False))

        self.log.sys(f"分支创建: {branch_id}")

        # 在新分支中执行
        result = self._simple_chat(user_input)

        # 标注
        return f"[分支 {branch_id}]\n{result}\n\n说「回退」可恢复分支前的对话状态。"

    def _rollback_chat(self) -> str:
        """回退到最近的分支点。"""
        branch_dir = Path(memdir.root) / "branches"
        if not branch_dir.exists():
            return "没有可回退的分支点。"

        files = sorted(branch_dir.glob("branch_*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            return "没有可回退的分支点。"

        latest = files[0]
        snapshot = json.loads(latest.read_text())
        self.shared_msgs = snapshot["shared_msgs"]
        self._agent_contexts = snapshot["agent_contexts"]
        self.permissions = snapshot["permissions"]
        latest.unlink()  # 消费分支点
        self.log.sys(f"回退: {latest.stem}")
        return f"已回退到 {snapshot['timestamp']} 的对话状态。共恢复 {len(self.shared_msgs)//2} 轮对话。"

    # ═══════════ Agent 注册表（热插拔）═══════════
    def register_agent(self, name: str, description: str, system_prompt: str,
                       tools: List[Tool] = None, self_verify: bool = False) -> bool:
        """运行时注册新 Agent。返回是否成功。"""
        if name in self.children:
            return False
        self.children[name] = ChildBot(
            name=name, description=description,
            system_prompt=system_prompt,
            tools=tools or [],
            self_verify=self_verify,
        )
        # 扩展路由关键词
        self.log.sys(f"Agent注册: {name} ({len(tools or [])}个工具)")
        return True

    def unregister_agent(self, name: str) -> bool:
        """运行时移除 Agent。"""
        if name not in self.children:
            return False
        del self.children[name]
        if name in self._agent_contexts:
            del self._agent_contexts[name]
        self.log.sys(f"Agent移除: {name}")
        return True

    def list_agents(self) -> list:
        """列出所有已注册的 Agent 及其能力。"""
        return [
            {"name": n, "desc": c.description, "tools": len(c.tools),
             "verify": c.self_verify, "memory": c.memory.get_stats()}
            for n, c in self.children.items()
        ]

    # ═══════════ 流式生成支持 ═══════════
    def chat_stream(self, user_input: str, image: str = None):
        """生成器: 逐 token 产出回复（用于 SSE 推送）。
        注意：工具调用期间先完成再流式输出最终回复。"""
        child_name = self._route(user_input)
        child = self.children[child_name]
        messages = self._build_child_msgs(child, user_input, "", image)

        # 工具循环
        for loop in range(5):
            tools = child.tool_schemas() if loop == 0 else None
            if loop > 0:
                tools = child.tool_schemas()

            resp = self._llm_call(child.name, messages, tools)
            msg = resp["choices"][0]["message"]
            tcs = msg.get("tool_calls")

            if tcs:
                messages.append(msg)
                for tc in tcs:
                    fn, result = _dispatch_tool_call(child, tc)
                    messages.append({
                        "role": "tool", "tool_call_id": tc.get("id", f"call_{loop}"), "content": str(result),
                    })
                continue

            # 流式输出最终回复
            reply = msg.get("content", "")
            self._child_memorize(child, user_input, reply)
            self._update_context(child_name, user_input, reply)
            self._update_shared_history(user_input, reply, image)

            # 分段推送（模拟流式）
            chunk_size = 30
            for i in range(0, len(reply), chunk_size):
                yield reply[i:i+chunk_size]
            return

        yield "[子Agent] 工具调用轮数超限"

    # ═══════════ Skill 学习闭环 ═══════════
    # 借鉴 Hermes Agent Curator: 复杂任务完成后自动提炼经验 → 生成 Skill 文档
    def _curate_skill(self, child: ChildBot, user_input: str, reply: str, tool_rounds: int):
        """Curator: 任务完成后判断是否值得生成 Skill。
        Hermes 阈值: tool_rounds >= 5 触发学习。"""
        if tool_rounds < 5:
            return
        skill_dir = child.memdir / "skills"
        skill_dir.mkdir(exist_ok=True)

        # 关键词提取
        kw_resp = self._llm_call(
            child.name,
            [{"role": "user", "content": f"从以下任务描述提取3-5个英文关键词(逗号分隔,只输出关键词):\n{user_input[:300]}"}],
            []
        )
        keywords = kw_resp["choices"][0]["message"]["content"]
        kws = [kw.strip().lower().replace(" ", "-") for kw in keywords.split(",") if kw.strip()]

        # 技能提炼
        skill_prompt = f"""从以下任务经验中提炼一个可复用的 Skill 文档(Markdown格式)。
格式要求: 标题、一句话解决什么问题、分步骤操作指南(每步带关键注意事项)、陷阱与教训。
任务: {user_input[:200]}
输出: {reply[:500]}
提炼要点: 哪些操作容易出错? 什么顺序最有效? 有没有可复用的模式?"""
        sc_resp = self._llm_call(
            child.name,
            [{"role": "user", "content": skill_prompt}],
            []
        )
        skill_content = sc_resp["choices"][0]["message"]["content"]

        # 写入 skill 文件
        skill_name = f"{kws[0]}-{kws[1] if len(kws) > 1 else 'skill'}.md" if kws else "auto-skill.md"
        skill_path = skill_dir / skill_name
        skill_path.write_text(skill_content, encoding="utf-8")
        self.log.memory(f"{child.name}", f"Skill落盘: {skill_path.name}")
        self.log.sys(f"Skill已学习({tool_rounds}轮工具调用)")

    def _inject_skills(self, child: ChildBot, user_input: str) -> str:
        """在 _build_child_msgs 前调用: 搜索相关 Skill 注入系统消息。
        关键词匹配 + 全文搜索，返回要注入的 Skill 文本。"""
        skill_dir = child.memdir / "skills"
        if not skill_dir.exists():
            return ""

        matched = []
        for sf in sorted(skill_dir.glob("*.md")):
            content = sf.read_text(encoding="utf-8")
            # 关键词匹配: user_input 和 skill 文件名/标题交叉命中
            fname_lower = sf.stem.lower().replace("-", " ")
            inp_lower = user_input.lower()
            if any(w in inp_lower for w in fname_lower.split()):
                matched.append(content)
            elif len(content[:200].split()) > 5:  # 备选: 标题行模糊匹配
                title = content.split("\n")[0].lower()
                if any(w in inp_lower for w in title.split() if len(w) > 2):
                    matched.append(content)

        if not matched:
            return ""

        # 最多注入 2 个 Skill
        joined = "\n---\n".join(matched[:2])
        self.log.memory(f"{child.name}", f"Skill命中 {len(matched[:2])} 条")
        return f"\n[相关技能经验 - 来自历史学习]\n{joined}"

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

    # ═══════════ 上下文持久化（跨会话记忆）═══════════

    _CONTEXT_FILE = os.path.join(_MEMDIR, ".parent_context.json")
    _SNAPSHOT_DIR = os.path.join(_MEMDIR, "snapshots")
    _MAX_SNAPSHOTS = 50

    def _load_context(self):
        """从磁盘恢复父Bot对话上下文（shared_msgs + agent_contexts + summary）"""
        try:
            if os.path.exists(self._CONTEXT_FILE):
                with open(self._CONTEXT_FILE, "r") as f:
                    data = json.load(f)
                self.shared_msgs = data.get("shared_msgs", [])[-40:]
                self._agent_contexts = data.get("agent_contexts", {})
                self._context_summary = data.get("context_summary", "")
                if self.shared_msgs:
                    self.log.sys(f"已恢复上下文: {len(self.shared_msgs)//2}轮对话, {len(self._agent_contexts)}个Agent状态")
        except Exception as e:
            self.log.sys(f"上下文恢复失败(将新建): {e}")

    def _save_context(self):
        """持久化父Bot对话上下文到磁盘"""
        try:
            data = {
                "shared_msgs": self.shared_msgs[-80:],
                "agent_contexts": self._agent_contexts,
                "context_summary": self._context_summary,
                "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
            tmp = self._CONTEXT_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, self._CONTEXT_FILE)  # 原子写入
        except Exception as e:
            self.log.sys(f"上下文保存失败: {e}")

    def _compress_shared_msgs(self):
        """滚动压缩：保留最近80条（40轮），溢出部分提炼追加到摘要。
        摘要永远追加不覆盖，原始消息仅滚动窗口，不永久丢失。
        压缩前自动创建快照，支持回溯。"""
        if len(self.shared_msgs) <= 80:
            return
        # ── 压缩前保存完整快照，供回溯使用 ──
        self._save_snapshot("auto")
        overflow = self.shared_msgs[:-80]
        self.shared_msgs = self.shared_msgs[-80:]

        raw_text = "\n".join(
            f"{'用户' if m['role']=='user' else '助手'}: {m['content'][:400]}"
            for m in overflow
        )
        ts = time.strftime("%m-%d %H:%M")
        prompt = f"""将以下对话提炼为要点列表（每条一行 - 开头，尽量保留具体信息）。
保留：用户偏好、技术决策、配置参数、文件路径、Bug描述、代码改动内容。
忽略：寒暄、emoji、谢谢、好的、纯确认。

对话（{len(overflow)//2}轮）:
{raw_text[:6000]}

要点:"""
        try:
            msgs = [{"role": "user", "content": prompt}]
            resp = self._llm_call("__summary__", msgs)
            new_summary = resp["choices"][0]["message"]["content"].strip()
            section = f"\n### {ts}（{len(overflow)//2}轮）\n{new_summary}"
            self._context_summary = (self._context_summary + section) if self._context_summary else section.lstrip()
            self._save_context()
            self.log.sys(f"上下文滚动压缩: 保留80条, 摘要{len(self._context_summary)}字")
        except Exception as e:
            self.log.sys(f"上下文压缩失败: {e}")

    def _update_context(self, agent_name: str, task: str, output: str):
        """更新 Agent 上下文追踪（供 Continue/Fresh 决策用）"""
        self._agent_contexts[agent_name] = {
            "last_task": task,
            "last_output": output,
            "timestamp": time.time(),
        }
        self._save_context()

    def _update_shared_history(self, user_input: str, reply: str, image: str = None):
        content = f"{user_input} [图片]" if image else user_input
        self.shared_msgs.append({"role": "user", "content": content})
        self.shared_msgs.append({"role": "assistant", "content": reply})
        # ── 持久化上下文到磁盘 ──
        self._save_context()
        # ── 同步写入对话流水到 memdir（跨会话记忆）──
        entry = f"## {time.strftime('%H:%M:%S')}\n**用户**: {user_input}\n**助手**: {reply[:500]}\n"
        try:
            existing = memdir.read("conversation-log.md")
            memdir.write("conversation-log.md", existing + "\n" + entry if existing else "# 对话流水\n" + entry)
        except Exception:
            pass
        # ── 每 40 轮滚动压缩上下文 + 对话流水 ──
        if len(self.shared_msgs) % 80 == 0:
            self._compress_shared_msgs()
            try:
                full_log = memdir.read("conversation-log.md")
                if len(full_log) > 5000:
                    self._compress_conversation_log(full_log)
            except Exception:
                pass

    def _distill_context(self, messages: list) -> str:
        """用 LLM 从对话中提取关键决策和约束，过滤寒暄/废话"""
        raw_text = "\n".join(
            f"{'用户' if m['role']=='user' else '助手'}: {m['content']}"
            for m in messages
        )
        prompt = f"""从以下对话中提取关键信息，严格过滤废话。只输出要点列表。
忽略：礼貌用语、表情、emoji、确认收到、谢谢、好的、明白等无信息量内容。
提取：决策、约束、配置修改、技术参数、用户偏好、待办事项。

对话:
{raw_text[:4000]}

关键要点（每条一行，用 - 开头）："""
        try:
            msgs = [{"role": "user", "content": prompt}]
            resp = self._llm_call("__distill__", msgs)
            return resp["choices"][0]["message"]["content"].strip()
        except Exception:
            return ""

    def _compress_conversation_log(self, full_log: str):
        """对话流水归档：旧内容移到归档文件，活跃日志保留最后8000字（永不压缩丢失）"""
        try:
            if len(full_log) > 8000:
                recent = full_log[-8000:]
                archive = memdir.read("conversation-archive.md") or ""
                memdir.write("conversation-archive.md", archive + "\n---\n" + full_log[:-8000])
                memdir.write("conversation-log.md", recent)
                self.log.sys(f"对话流水已归档（活跃日志{len(recent)}字）")
        except Exception as e:
            self.log.sys(f"对话归档失败: {e}")

    # ═══════════ 快照与回溯 ═══════════

    def _save_snapshot(self, reason: str = "manual") -> str:
        """保存当前完整上下文为快照，返回 snapshot_id。
        reason: 'auto' 压缩触发 / 'manual' 用户主动回溯点。"""
        try:
            os.makedirs(self._SNAPSHOT_DIR, exist_ok=True)
            snap_id = time.strftime("%Y%m%d_%H%M%S")
            data = {
                "snapshot_id": snap_id,
                "reason": reason,
                "shared_msgs": self.shared_msgs[:],  # 完整拷贝
                "agent_contexts": dict(self._agent_contexts),
                "context_summary": self._context_summary,
                "permissions": dict(self.permissions),
                "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "rounds": len(self.shared_msgs) // 2,
            }
            path = os.path.join(self._SNAPSHOT_DIR, f"{snap_id}.json")
            with open(path, "w") as f:
                json.dump(data, f, ensure_ascii=False)
            # 清理旧快照，保留最近 _MAX_SNAPSHOTS 个
            self._prune_snapshots()
            self.log.sys(f"快照已保存: {snap_id} ({data['rounds']}轮, {reason})")
            return snap_id
        except Exception as e:
            self.log.sys(f"快照保存失败: {e}")
            return ""

    def _prune_snapshots(self):
        """清理旧快照，保留最近 _MAX_SNAPSHOTS 个"""
        try:
            files = sorted(
                [f for f in os.listdir(self._SNAPSHOT_DIR) if f.endswith(".json")],
                reverse=True,
            )
            for old in files[self._MAX_SNAPSHOTS:]:
                os.remove(os.path.join(self._SNAPSHOT_DIR, old))
        except Exception:
            pass

    def list_snapshots(self) -> list:
        """列出所有可用快照（按时间倒序）"""
        try:
            if not os.path.exists(self._SNAPSHOT_DIR):
                return []
            result = []
            for f in sorted(os.listdir(self._SNAPSHOT_DIR), reverse=True):
                if not f.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(self._SNAPSHOT_DIR, f)) as fp:
                        data = json.load(fp)
                    result.append({
                        "id": data["snapshot_id"],
                        "created": data["created"],
                        "rounds": data["rounds"],
                        "reason": data["reason"],
                    })
                except Exception:
                    continue
            return result
        except Exception:
            return []

    def rollback_to_snapshot(self, snapshot_id: str = "") -> str:
        """回滚到指定快照。不传 id 时回滚到最近的快照。
        返回回滚结果描述。"""
        try:
            if not os.path.exists(self._SNAPSHOT_DIR):
                return "没有可用快照。"
            if not snapshot_id:
                files = sorted(
                    [f for f in os.listdir(self._SNAPSHOT_DIR) if f.endswith(".json")],
                    reverse=True,
                )
                if not files:
                    return "没有可用快照。"
                snapshot_id = files[0].replace(".json", "")

            path = os.path.join(self._SNAPSHOT_DIR, f"{snapshot_id}.json")
            if not os.path.exists(path):
                return f"快照 {snapshot_id} 不存在。可用: {self.list_snapshots()}"
            with open(path) as f:
                data = json.load(f)
            # 回滚前先保存当前状态为快照（"回滚前"标记）
            self._save_snapshot("rollback-pre")
            self.shared_msgs = data["shared_msgs"]
            self._agent_contexts = data["agent_contexts"]
            self._context_summary = data.get("context_summary", "")
            self.permissions = data.get("permissions", {})
            self._save_context()
            return f"已回滚到快照 {snapshot_id}（{data['created']}），恢复 {data['rounds']} 轮对话。回滚前状态已另存快照。"
        except Exception as e:
            return f"回滚失败: {e}"

    # ═══════════ 管理 ═══════════
    def reset(self):
        self.shared_msgs = []
        self._agent_contexts = {}
        self._context_summary = ""
        self.permissions = {}
        self._perm_pending = None
        for child in self.children.values():
            child.memory = AgentMemory()
        # ── 清除持久化上下文 ──
        try:
            if os.path.exists(self._CONTEXT_FILE):
                os.remove(self._CONTEXT_FILE)
        except Exception:
            pass
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

