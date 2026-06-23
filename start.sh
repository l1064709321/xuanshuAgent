#!/bin/bash
# ==========================================
#  悬殊点Agent — 一键启动脚本
# ==========================================

set -e

echo "========================================"
echo "  悬殊点Agent 启动中..."
echo "========================================"

# 检查 Python
if ! command -v python3 &>/dev/null; then
    echo "[错误] 未找到 python3，请先安装 Python 3.10+"
    exit 1
fi

# 安装依赖
echo ""
echo "[1/3] 安装依赖..."
pip3 install flask flask-cors requests wikipedia -q

# 检查 API Key
if [ -z "$OPENAI_API_KEY" ]; then
    echo ""
    echo "[提示] 未设置 OPENAI_API_KEY 环境变量"
    echo "  方式1: export OPENAI_API_KEY='sk-xxx'"
    echo "  方式2: 启动后在 Web 页面设置 Key"
    echo "  当前将以本地模拟模式运行"
fi

# 启动后端
echo ""
echo "[2/3] 启动后端 API (端口 8900)..."
python3 frontend.py &
BACKEND_PID=$!
sleep 2

# 启动前端
echo ""
echo "[3/3] 启动前端服务 (端口 8901)..."
echo ""
echo "========================================"
echo "  后端 API: http://localhost:8900"
echo "  前端页面: http://localhost:8901"
echo "  按 Ctrl+C 停止所有服务"
echo "========================================"
echo ""

# 用 Python 启动简单 HTTP 服务器托管前端
python3 -m http.server 8901 --directory . &
FRONTEND_PID=$!

# 捕获退出信号
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo ''; echo '已停止'; exit 0" INT TERM

wait
