#!/usr/bin/env python3
"""
玄姝多Agent系统 — 父Bot路由 + 子Bot独立记忆
用法: python main.py [--model qwen25-7b] [--key sk-xxx] [--quiet]
"""

import os, sys, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import ParentBot
from models import ModelPool, BUILTIN_MODELS


class Commander:
    """命令处理器"""

    def __init__(self, bot: ParentBot, pool: ModelPool):
        self.bot = bot
        self.pool = pool

    def handle(self, cmd: str) -> bool:
        if not cmd.startswith("/"):
            return False

        parts = cmd.split(maxsplit=1)
        action = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        handlers = {
            "/model": self._model, "/m": self._model,
            "/new": self._new, "/n": self._new,
            "/search": self._search, "/soc": self._search,
            "/status": self._status, "/s": self._status,
            "/mem": self._mem,
            "/bind": self._bind,
            "/help": self._help,
            "/agents": self._agents,
            "/kb": self._kb,
            "/screen": self._screen,
        }
        handler = handlers.get(action)
        if handler:
            return handler(arg)

        if action in ("/quit", "/exit"):
            print("\n再见。")
            sys.exit(0)
        print(f"  未知命令: {action} (/help)")
        return True

    def _model(self, arg: str) -> bool:
        if not arg:
            self._show_menu()
            return True
        arg = arg.strip().lower()
        if arg == "list":
            self._show_menu()
            return True
        if arg == "status":
            print(f"\n  {self.pool.status()}")
            return True
        if arg == "reset":
            self.pool.set_default(self.pool.default_key)
            for c in self.bot.children:
                self.pool.unbind(c)
            print(f"\n  已重置: {BUILTIN_MODELS[self.pool.default_key].name}")
            return True
        if arg.isdigit():
            idx = int(arg) - 1
            keys = list(BUILTIN_MODELS.keys())
            if 0 <= idx < len(keys):
                self.pool.set_default(keys[idx])
                print(f"\n  默认: {BUILTIN_MODELS[keys[idx]].name}")
                return True
            print(f"  编号范围 1-{len(keys)}")
            return True
        resolved = self.pool.resolve(arg)
        if resolved:
            self.pool.set_default(resolved)
            print(f"\n  默认: {BUILTIN_MODELS[resolved].name}")
            return True
        print(f"  未找到: {arg}")
        return True

    def _show_menu(self):
        print(f"\n{'─'*50}")
        print("  模型切换")
        print(f"{'─'*50}")
        print(self.pool.table())
        print(f"{'─'*50}")

    def _new(self, arg: str) -> bool:
        self.bot.reset()
        msg = "新对话"
        if arg:
            resolved = self.pool.resolve(arg.strip())
            if resolved:
                self.pool.set_default(resolved)
                msg += f" | 模型: {BUILTIN_MODELS[resolved].name}"
        print(f"\n  {msg}")
        return True

    def _status(self, arg=""):
        print(f"\n{self.bot.status()}")
        return True

    def _mem(self, arg=""):
        for name, child in self.bot.children.items():
            ctx = child.memory.to_context(max_items=5)
            if ctx:
                print(f"\n  [{name}]")
                print(ctx)
        return True

    def _bind(self, arg: str):
        if not arg:
            print(f"  用法: /bind <Agent名> <模型名>")
            print(f"  Agent: {', '.join(self.bot.children.keys())}")
            return True
        parts = arg.split(maxsplit=1)
        if len(parts) < 2:
            print("  用法: /bind <Agent名> <模型名>")
            return True
        agent_name, model_query = parts
        target = None
        for name in self.bot.children:
            if name == agent_name or agent_name in name:
                target = name
                break
        if not target:
            print(f"  未找到: {agent_name}")
            return True
        resolved = self.pool.resolve(model_query)
        if not resolved:
            print(f"  未找到模型: {model_query}")
            return True
        self.pool.bind(target, resolved)
        print(f"  {target} → {BUILTIN_MODELS[resolved].name}")
        return True

    def _agents(self, arg: str):
        print(f"\n{'─'*50}")
        for name, child in self.bot.children.items():
            model = self.pool.get_model(name)
            s = child.memory.get_stats()
            print(f"  {name}: {model.name}")
            print(f"    人设: {child.system_prompt[:60]}...")
            print(f"    插件: {', '.join(t.name for t in child.tools) or '无'}")
            print(f"    知识库: {len(child.knowledge)}条")
            print(f"    独立记忆: {s['短期记忆']}短/{s['中期记忆']}中/{s['长期记忆']}长")
        print(f"{'─'*50}")
        return True

    def _kb(self, arg: str):
        if not arg:
            for name, child in self.bot.children.items():
                if child.knowledge:
                    print(f"\n  [{name}] 知识库 ({len(child.knowledge)}条):")
                    for i, k in enumerate(child.knowledge):
                        print(f"    [{i}] {k[:80]}")
            return True
        parts = arg.split(maxsplit=2)
        if len(parts) < 3 or parts[0] != "add":
            print("  用法: /kb add <Agent名> <知识文本>")
            return True
        _, agent_name, text = parts
        if agent_name in self.bot.children:
            self.bot.children[agent_name].knowledge.append(text)
            print(f"  已添加知识到 {agent_name}")
        else:
            print(f"  未找到: {agent_name}")
        return True

    def _search(self, arg: str) -> bool:
        if not arg:
            print("  用法: /search <查询词>")
            print("  例:   /search python asyncio 最佳实践")
            return True
        from web_search import deepen, format_cli
        print("  正在搜索 (信誉过滤中)...")
        results = deepen(arg, top_k=3, max_search=10)
        print(format_cli(results))
        return True

    def _screen(self, arg: str):
        from screen_reader import read_screen
        result = read_screen()
        if result["ok"]:
            print(f"\n  截图成功: {result['path']}")
            print(f"  大小: {result['size']} bytes")
            print(f"  提示: /screen analyze 可调用 AI 分析")
        else:
            print(f"\n  失败: {result['error']}")
        return True

    def _help(self):
        print(f"""
{'─'*50}
  玄姝多Agent系统
{'─'*50}
  /model [编号|别名]  切换默认模型
  /new [模型]         新对话
  /search <查询词>    联网搜索(信誉过滤+官方优先)
  /screen             截取屏幕并分析
  /bind Agent 模型    子Agent独立绑定模型
  /status             系统状态（含记忆）
  /agents             查看所有子Agent配置
  /mem                查看各子Agent独立记忆
  /kb [add Agent 文本] 管理知识库
  /help               帮助
  /quit               退出
{'─'*50}""")
        return True


def main():
    p = argparse.ArgumentParser(description="玄姝多Agent系统")
    p.add_argument("--model", type=str, help="初始模型")
    p.add_argument("--key", type=str, help="API Key")
    p.add_argument("--list", action="store_true", help="列出模型")
    p.add_argument("--quiet", action="store_true", help="关闭日志")
    args = p.parse_args()

    if args.list:
        pool = ModelPool()
        print("\n可用模型:\n")
        print(pool.table())
        return

    model_key = args.model or "nemotron-super"
    if model_key not in BUILTIN_MODELS:
        resolved = ModelPool().resolve(model_key)
        model_key = resolved or "nemotron-super"

    api_key = args.key or os.environ.get("OPENAI_API_KEY", "")
    if model_key != "local" and not api_key:
        print(f"{BUILTIN_MODELS[model_key].name} 需要 API Key")
        api_key = input("API Key: ").strip()
        if not api_key:
            print("无Key，切换为本地模拟模式")
            model_key = "local"

    pool = ModelPool(default_key=model_key, api_key=api_key)
    bot = ParentBot(pool=pool, verbose=not args.quiet)
    cmd = Commander(bot, pool)

    print(f"\n{'='*50}")
    print(f"  玄姝多Agent系统")
    print(f"  父Bot → 路由 → 子Bot执行 → 汇总")
    print(f"  默认模型: {BUILTIN_MODELS[model_key].name}")
    print(f"  /help 查看命令")
    print(f"{'='*50}")

    while True:
        try:
            inp = input("\n▸ ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见。")
            break
        if not inp:
            continue
        if cmd.handle(inp):
            continue
        reply = bot.chat(inp)
        print(f"\n{reply}")


if __name__ == "__main__":
    main()
