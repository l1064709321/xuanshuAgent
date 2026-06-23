#!/bin/bash
set -e
echo "========================================"
echo "  悬殊点Agent 启动中..."
echo "========================================"
if ! command -v python3 &>/dev/null; then
    echo "[错误] 未找到 python3，请先安装 Python 3.10+"; exit 1
fi
echo "[1/3] 安装依赖..."
pip3 install flask flask-cors requests -q
if [ -z "$OPENAI_API_KEY" ]; then
    echo "[提示] 未设置 OPENAI_API_KEY，本地模拟模式运行"
fi
echo "[2/3] 启动后端 API (端口 8900)..."
python3 frontend.py &
BACKEND_PID=$!
sleep 2
echo "[3/3] 启动前端服务 (端口 8901)..."
python3 -m http.server 8901 --directory . &
FRONTEND_PID=$!
echo ""
echo "========================================"
echo "  后端 API: http://localhost:8900"
echo "  前端页面: http://localhost:8901"
echo "  按 Ctrl+C 停止"
echo "========================================"
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo '已停止'; exit 0" INT TERM
wait
