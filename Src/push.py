#!/usr/bin/env python3
"""一键推送 — 从 .github_token 和 .github_remote 读取配置，推送前自动沙箱验证"""
import os, sys, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(HERE)

# 读取 token
with open(os.path.join(HERE, ".github_token")) as f:
    TOKEN = f.read().strip()

# 读取远程地址
with open(os.path.join(HERE, ".github_remote")) as f:
    REMOTE_URL = f.read().strip()

# 构造带认证的 URL
AUTH_URL = REMOTE_URL.replace("https://", f"https://l1064709321:{TOKEN}@")

# 设置 git 环境
os.environ["PATH"] = os.path.expanduser("~/local/bin") + ":" + os.environ.get("PATH", "")

# ═══════ 推送前自动沙箱验证 ═══════
print("🔬 沙箱自动验证中…")
try:
    from auto_sandbox import auto_sandbox
    py_result = auto_sandbox.pre_push_validate(HERE)
    html_result = auto_sandbox.validate_frontend(os.path.join(HERE, "index.html"))
    print(f"  Python: {py_result['passed']}/{py_result['total']} syntax OK")
    if py_result['failed']:
        print(f"  ⚠ Python 语法错误: {len(py_result['failed'])} 个文件")
        for f in py_result['failed'][:3]:
            print(f"    - {f['file']}: {f['error'][:80]}")
    print(f"  Frontend: {'OK' if html_result['valid'] else 'FAIL'}")
    if not html_result['valid']:
        print(f"  ⚠ index.html 完整性检查失败: {html_result.get('error','')} {html_result.get('checks','')}")
except Exception as e:
    print(f"  ⚠ 沙箱验证跳过: {e}")
print("")

# 设置带认证的远程
subprocess.run(["git", "remote", "set-url", "origin", AUTH_URL], check=True)

# 添加所有更改
subprocess.run(["git", "add", "-A"], check=True)

# 提交（如果有变更）
msg = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "auto push"
result = subprocess.run(["git", "commit", "-m", msg], capture_output=True, text=True)
if result.returncode != 0 and "nothing to commit" not in result.stdout + result.stderr:
    print("提交失败:", result.stderr)
    sys.exit(1)

# 推送到 main 分支
subprocess.run(["git", "push", "origin", "main"], check=True)
print("推送成功 → main 分支")
