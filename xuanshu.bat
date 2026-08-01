@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

cd /d "%~dp0"

:: ======================================
::  玄姝 Agent — Windows 一键启动
:: ======================================

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
echo [玄姝] 错误: 未找到 Python 3.8+
echo [玄姝] 请安装: https://www.python.org/downloads/
echo [玄姝] 安装时务必勾选 "Add Python to PATH"
pause
exit /b 1

:python_found
echo ======================================
echo        玄姝 Agent 启动中...
echo ======================================
echo [玄姝] Python: !PYTHON!

:: 虚拟环境
if not exist ".venv\Scripts\python.exe" (
    echo [玄姝] 创建虚拟环境...
    !PYTHON! -m venv .venv
    if not exist ".venv\Scripts\python.exe" (
        echo [玄姝] 错误: 虚拟环境创建失败
        echo [玄姝] 请尝试以管理员身份运行此脚本
        pause
        exit /b 1
    )
)

:: 升级 pip
.venv\Scripts\python.exe -m pip install --upgrade pip -q 2>nul

:: 安装依赖 — 先试官方源，失败了换清华镜像
echo [玄姝] 安装依赖（官方源）...
.venv\Scripts\python.exe -m pip install -r requirements.txt -q
if !errorlevel! neq 0 (
    echo [玄姝] 官方源失败，切换清华镜像...
    .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    if !errorlevel! neq 0 (
        echo.
        echo [玄姝] 依赖安装失败！
        echo [玄姝] 常见原因:
        echo [玄姝]   1. 没有管理员权限 → 右键以管理员身份运行
        echo [玄姝]   2. 网络问题 → 检查网络连接
        echo [玄姝]   3. 磁盘满了 → 清理磁盘空间
        pause
        exit /b 1
    )
)

:: 验证 Flask 是否安装成功
.venv\Scripts\python.exe -c "import flask" >nul 2>&1
if !errorlevel! neq 0 (
    echo [玄姝] 错误: Flask 安装不完整，请以管理员身份重新运行
    pause
    exit /b 1
)

:: 启动
echo [玄姝] 启动服务 (端口 8901)...
echo [玄姝] 访问: http://localhost:8901
echo [玄姝] 按 Ctrl+C 停止
echo.
.venv\Scripts\python.exe frontend.py

endlocal
