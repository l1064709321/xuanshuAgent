@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 玄姝 Agent 启动中...

:: 检测 Python
set PYTHON=
for %%v in (python python3 py) do (
    where %%v >nul 2>&1 && %%v -c "import sys;sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1 && set PYTHON=%%v && goto :found
)
echo 错误: 需要 Python 3.8+，请先安装 https://www.python.org/
pause
exit /b 1

:found
echo Python: %PYTHON%

:: 安装依赖（先试国内镜像，失败用官方源）
echo 安装依赖...
%PYTHON% -m pip install -r requirements.txt -q -i https://pypi.tuna.tsinghua.edu.cn/simple 2>nul || %PYTHON% -m pip install -r requirements.txt -q

:: 验证
%PYTHON% -c "import flask" >nul 2>&1 || (
    echo 错误: Flask 安装失败
    echo 请手动运行: %PYTHON% -m pip install -r requirements.txt
    pause
    exit /b 1
)

echo 已启动 → http://localhost:8901
%PYTHON% frontend.py
