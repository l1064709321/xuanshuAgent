#!/usr/bin/env python3
"""
扣子风格多Agent协作系统 — Project Space + 平级Agent + LLM路由
用法: python main.py [--model qwen25-7b] [--key sk-xxx] [--quiet]
"""

import os, sys, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import ProjectSpace
from models import ModelPool, BUILTIN_MODELS


class Commander:
    """扣子风格命令处理器"""

    def __init__(self, space: ProjectSpace, pool: ModelPool):
        self.space = space
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
            "/status": self._status, "/s": self._status,
            "/mem": self._mem,
            "/bind": self._bind,
            "/help": self._help,
            "/agents": self._agents,
            "/kb": self._kb,
        }
        handler = handlers.get(action)
        if handler:
            return handler(arg)

        if action in ("/quit", "/exit"):
            print("\n再见。")
            sys.exit(0)
        print(f"  未知命令: {action} (输入 /help)")
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
            for a in self.space.agents:
                self.pool.unbind(a)
            print(f"\n  已重置为默认: {BUILTIN_MODELS[self.pool.default_key].name}")
            return True
        if arg.isdigit():
            idx = int(arg) - 1
            keys = list(BUILTIN_MODELS.keys())
            if 0 <= idx < len(keys):
                self.pool.set_default(keys[idx])
                print(f"\n  默认模型: {BUILTIN_MODELS[keys[idx]].name}")
                return True
            print(f"  编号范围 1-{len(keys)}")
            return True

        resolved = self.pool.resolve(arg)
        if resolved:
            self.pool.set_default(resolved)
            print(f"\n  默认模型: {BUILTIN_MODELS[resolved].name}")
            return True
        print(f"  未找到: {arg} (/model list 查看)")
        return True

    def _show_menu(self):
        print(f"\n{'─'*50}")
        print("  模型切换")
        print(f"{'─'*50}")
        print(self.pool.table())
        print(f"{'─'*50}")
        print(f"  0 重置默认 | 编号或别名切换")
        print(f"{'─'*50}")

    def _new(self, arg: str) -> bool:
        self.space.reset()
        msg = "新对话"
        if arg:
            resolved = self.pool.resolve(arg.strip())
            if resolved:
                self.pool.set_default(resolved)
                msg += f" | 模型: {BUILTIN_MODELS[resolved].name}"
        print(f"\n  {msg}")
        return True

    def _status(self):
        print(f"\n{self.space.status()}")
        return True

    def _mem(self):
        ctx = self.space.memory.to_context(max_items=10)
        print(f"\n{ctx}" if ctx else "\n  无记忆")
        return True

    def _bind(self, arg: str):
        if not arg:
            print(f"  用法: /bind <Agent名> <模型名>")
            print(f"  Agent: {', '.join(self.space.agents.keys())}")
            return True
        parts = arg.split(maxsplit=1)
        if len(parts) < 2:
            print("  用法: /bind <Agent名> <模型名>")
            return True
        agent_name, model_query = parts
        # 找Agent
        target = None
        for name in self.space.agents:
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
        """列出所有Agent及其配置"""
        print(f"\n{'─'*50}")
        for name, agent in self.space.agents.items():
            model = self.pool.get_model(name)
            print(f"  {name}: {model.name}")
            print(f"    人设: {agent.system_prompt[:60]}...")
            print(f"    插件: {', '.join(t.name for t in agent.tools) or '无'}")
            print(f"    知识库: {len(agent.knowledge)}条")
        print(f"{'─'*50}")
        return True

    def _kb(self, arg: str):
        """管理知识库 /kb add agent名 <文本>"""
        if not arg:
            # 显示所有知识库
            for name, agent in self.space.agents.items():
                if agent.knowledge:
                    print(f"\n  [{name}] 知识库 ({len(agent.knowledge)}条):")
                    for i, k in enumerate(agent.knowledge):
                        print(f"    [{i}] {k[:80]}")
            return True
        parts = arg.split(maxsplit=2)
        if len(parts) < 3 or parts[0] != "add":
            print("  用法: /kb add <Agent名> <知识文本>")
            return True
        action, agent_name, text = parts
        if agent_name in self.space.agents:
            self.space.agents[agent_name].knowledge.append(text)
            print(f"  已添加知识到 {agent_name}")
        else:
            print(f"  未找到: {agent_name}")
        return True

    def _help(self):
        print(f"""
{'─'*50}
  扣子风格多Agent系统 — 命令列表
{'─'*50}
  /model [编号|别名]  切换模型
  /new [模型]         新对话
  /bind Agent 模型    为Agent绑定独立模型
  /status             项目空间状态
  /agents             查看所有Agent配置
  /mem                查看记忆
  /kb [add Agent 文本] 管理知识库
  /help               帮助
  /quit               退出
{'─'*50}""")
        return True


def main():
    p = argparse.ArgumentParser(description="扣子风格多Agent系统")
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

    model_key = args.model or "local"
    if model_key not in BUILTIN_MODELS:
        resolved = ModelPool().resolve(model_key)
        model_key = resolved or "local"

    api_key = args.key or os.environ.get("OPENAI_API_KEY", "")
    if model_key != "local" and not api_key:
        print(f"{BUILTIN_MODELS[model_key].name} 需要 API Key")
        api_key = input("API Key: ").strip()
        if not api_key:
            print("无Key，切换为本地模拟模式")
            model_key = "local"

    pool = ModelPool(default_key=model_key, api_key=api_key)
    space = ProjectSpace(pool=pool, verbose=not args.quiet)
    cmd = Commander(space, pool)

    print(f"\n{'='*50}")
    print(f"  扣子风格多Agent协作系统")
    print(f"  默认模型: {BUILTIN_MODELS[model_key].name}")
    print(f"  /help 查看命令  |  /agents 查看Agent")
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
        reply = space.chat(inp)
        print(f"\n{reply}")


if __name__ == "__main__":
    main()
