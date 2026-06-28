#!/bin/bash
set -e
echo "========================================"
echo "  玄姝Agent 启动中..."
echo "========================================"
if ! command -v python3 &>/dev/null; then
    echo "[错误] 未找到 python3，请先安装 Python 3.10+"; exit 1
fi
echo "[1/2] 安装依赖..."
pip3 install flask flask-cors requests openai -q
if [ -z "$OPENAI_API_KEY" ]; then
    echo "[提示] 未设置 OPENAI_API_KEY，本地模拟模式运行"
fi
echo "[2/2] 启动服务..."
python3 frontend.py &
PID=$!
sleep 2
echo ""
echo "========================================"
echo "  打开浏览器: http://localhost:8900"
echo "  按 Ctrl+C 停止"
echo "========================================"
trap "kill $PID 2>/dev/null; echo ''; echo '已停止'; exit 0" INT TERM
wait
