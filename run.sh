#!/bin/bash
# 玄姝多Agent 一键启动
cd "$(dirname "$0")"

# 确保虚拟环境存在
if [ ! -d ".venv" ]; then
    echo ">>> 创建虚拟环境..."
    python3 -m venv .venv
fi

# 激活虚拟环境
source .venv/bin/activate

# 安装依赖（幂等，已安装则跳过）
pip install -r requirements.txt -q 2>/dev/null

# 启动
exec python3 frontend.py
