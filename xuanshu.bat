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

:: 安装依赖（多源轮询 + 超时控制，一个源卡住就换下一个）
echo 安装依赖（多源轮询，失败自动切换）...
for %%s in (
  "https://pypi.tuna.tsinghua.edu.cn/simple"
  "https://mirrors.aliyun.com/pypi/simple"
  "https://mirrors.cloud.tencent.com/pypi/simple"
  "https://repo.huaweicloud.com/repository/pypi/simple"
  "https://pypi.mirrors.ustc.edu.cn/simple"
  "https://pypi.org/simple"
) do (
  echo → 尝试源: %%s
  %PYTHON% -m pip install -r requirements.txt -i %%s --timeout=10 --retries=1 --disable-pip-version-check
  if not errorlevel 1 goto :deps_ok
  echo → 该源失败或超时，切换下一个源...
)
echo 所有源均失败，请检查网络后手动运行: %PYTHON% -m pip install -r requirements.txt
pause
exit /b 1

:deps_ok
echo 依赖安装完成

:: 验证
%PYTHON% -c "import flask" >nul 2>&1 || (
    echo 错误: Flask 安装失败
    echo 请手动运行: %PYTHON% -m pip install -r requirements.txt
    pause
    exit /b 1
)

echo 已启动 → http://localhost:8901 （按 Ctrl+C 退出）
%PYTHON% frontend.py
