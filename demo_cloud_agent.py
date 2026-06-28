#!/usr/bin/env python3
"""
Sub Agent 调用 Hermes Agent / OpenClaw 演示
用法:  python3 demo_cloud_agent.py hermes   # 爱马仕
      python3 demo_cloud_agent.py claw     # OpenClaw
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core import ParentBot, ChildBot
from models import ModelPool, BUILTIN_MODELS

target = sys.argv[1] if len(sys.argv) > 1 else "hermes"
if target in ("claw", "openclaw"):
    model_key = "openclaw"
    agent_name = "OpenClaw Agent"
    desc = "OpenClaw 多平台 Agent 框架驱动"
else:
    model_key = "hermes-agent"
    agent_name = "HermesAgent"
    desc = "Hermes 自我进化 Agent 框架驱动"

MODEL_NAME = BUILTIN_MODELS[model_key].name
BASE_URL = BUILTIN_MODELS[model_key].base_url

pool = ModelPool(default_key=model_key)
pool.bind(agent_name, model_key)

child = ChildBot(
    name=agent_name,
    description=desc,
    system_prompt=f"你是 {MODEL_NAME} 驱动的助手，专业且准确。",
    tools=[],
)

bot = ParentBot(pool=pool, verbose=True)
bot.children[agent_name] = child

print("\n" + "=" * 50)
print(f"  Sub Agent → {MODEL_NAME} 调用链路")
print(f"  Base URL: {BASE_URL}")
print("=" * 50)

msgs = bot._build_child_msgs(child, "用一句话介绍一下你自己")
reply = bot._run_child(child, msgs)
print(f"\n{agent_name} 回复:\n{reply}")
