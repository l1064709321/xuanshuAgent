"""
Agent 日志系统 — 带颜色的终端日志
"""
import time
from enum import Enum


class Level(Enum):
    ROUTE = ("ROUTE", "\033[96m")     # 青色
    TOOL = ("TOOL", "\033[93m")       # 黄色
    MEM = ("MEM", "\033[95m")         # 紫色
    LLM = ("LLM", "\033[92m")         # 绿色
    SYS = ("SYS", "\033[97m")         # 白色
    ERR = ("ERR", "\033[91m")         # 红色
    AGENT = ("AGENT", "\033[94m")     # 蓝色

    def __init__(self, tag, color):
        self.tag = tag
        self.color = color


RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"


class Logger:
    """Agent 日志"""

    def __init__(self, enabled: bool = True, show_time: bool = True):
        self.enabled = enabled
        self.show_time = show_time
        self.indent = 0

    def _fmt(self, level: Level, msg: str) -> str:
        if not self.enabled:
            return ""
        ts = f"{DIM}{time.strftime('%H:%M:%S')}{RESET} " if self.show_time else ""
        tag = f"{level.color}[{level.tag}]{RESET}"
        pad = "  " * self.indent
        return f"{ts}{tag} {pad}{msg}"

    def log(self, level: Level, msg: str):
        line = self._fmt(level, msg)
        if line:
            print(line)

    # 快捷方法
    def route(self, query: str, agent_name: str, score: int = 0):
        """路由日志"""
        self.log(Level.ROUTE, f'"{query[:50]}..." → {BOLD}{agent_name}{RESET} (匹配度:{score})')

    def tool_start(self, name: str, args: dict):
        """工具调用开始"""
        args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else "无参"
        self.log(Level.TOOL, f"调用 {BOLD}{name}{RESET}({args_str[:80]})")
        self.indent += 1

    def tool_end(self, result: str):
        """工具调用结束"""
        self.indent -= 1
        preview = result.replace("\n", " ")[:100]
        self.log(Level.TOOL, f"返回: {DIM}{preview}{RESET}")

    def memory(self, action: str, detail: str = ""):
        """记忆操作日志"""
        self.log(Level.MEM, f"{action} {DIM}{detail}{RESET}")

    def llm(self, model: str, tokens: int = 0, latency: float = 0):
        """LLM 调用日志"""
        parts = [f"模型:{BOLD}{model}{RESET}"]
        if tokens:
            parts.append(f"tokens:{tokens}")
        if latency:
            parts.append(f"{latency:.1f}s")
        self.log(Level.LLM, " | ".join(parts))

    def agent(self, agent_name: str, msg: str):
        """子Agent日志"""
        self.log(Level.AGENT, f"[{agent_name}] {msg}")

    def sys(self, msg: str):
        """系统日志"""
        self.log(Level.SYS, msg)

    def error(self, msg: str):
        """错误日志"""
        self.log(Level.ERR, msg)

    def divider(self):
        if self.enabled:
            print(f"{DIM}{'─'*50}{RESET}")

    def banner(self, title: str):
        if self.enabled:
            print(f"\n{BOLD}{'='*50}{RESET}")
            print(f"{BOLD}  {title}{RESET}")
            print(f"{BOLD}{'='*50}{RESET}")
