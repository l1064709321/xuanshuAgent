@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: 检测 Python 3.8+
set PYTHON=
for %%v in (python python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 py) do (
    where %%v >nul 2>&1
    if !errorlevel! equ 0 (
        %%v -c "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)" >nul 2>&1
        if !errorlevel! equ 0 (
            set PYTHON=%%v
            goto :python_found
        )
    )
)
echo [玄姝] 错误: 未找到 Python 3.8+，请先安装 https://www.python.org/
pause
exit /b 1

:python_found
echo ╔══════════════════════════════════════╗
echo ║       玄姝 Agent 启动中...          ║
echo ╚══════════════════════════════════════╝

:: 虚拟环境
if not exist ".venv" (
    echo [玄姝] 创建虚拟环境...
    !PYTHON! -m venv .venv
)
call .venv\Scripts\activate.bat

:: 安装依赖
echo [玄姝] 检查依赖...
pip install -r requirements.txt -q

:: 启动
echo [玄姝] 启动服务 (端口 8901)...
python frontend.py

endlocal
