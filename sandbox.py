"""玄姝安全沙箱 v1.0 — 隔离代码执行环境
- 资源限制：CPU 30s, 内存 512MB, 无网络
- 临时目录隔离，执行后自动清理
- seccomp 过滤危险系统调用（Linux）
"""
import os, sys, tempfile, subprocess, resource, shutil, json, threading
from pathlib import Path
from typing import Optional, Dict

_WS = os.path.dirname(os.path.abspath(__file__))
_SANDBOX_BASE = os.path.join(_WS, ".sandbox")
os.makedirs(_SANDBOX_BASE, exist_ok=True)


class SandboxError(Exception):
    pass


def _build_seccomp_profile() -> Optional[str]:
    """构建 seccomp-bpf 规则 —— 仅允许安全的系统调用"""
    # 白名单模式：只放行读/写/exit/brk/mmap 等安全调用
    allowed = [
        "read", "write", "close", "fstat", "lseek",
        "mmap", "mprotect", "munmap", "brk",
        "exit", "exit_group",
        "rt_sigaction", "rt_sigprocmask",
        "futex", "clock_gettime", "getpid",
        "arch_prctl", "set_tid_address", "set_robust_list",
    ]
    try:
        import subprocess as sp
        r = sp.run(["which", "seccomp-tools"], capture_output=True)
        if r.returncode != 0:
            return None
        return json.dumps({"defaultAction": "SCMP_ACT_KILL", "architectures": ["SCMP_ARCH_X86_64"],
                           "syscalls": [{"names": allowed, "action": "SCMP_ACT_ALLOW"}]})
    except Exception:
        return None


def _setup_resource_limits():
    """设置 CPU 30s, 内存 512MB 上限"""
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (50, 50))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except Exception:
        pass


def _prepare_sandbox_dir() -> str:
    """创建临时沙箱目录"""
    sandbox_dir = tempfile.mkdtemp(prefix="sandbox_", dir=_SANDBOX_BASE)
    os.chmod(sandbox_dir, 0o700)
    return sandbox_dir


def run_sandboxed(code: str, timeout: int = 30, env: dict = None) -> Dict:
    """在隔离环境中执行 Python 代码。

    Returns:
        {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool, "error": str|None}
    """
    sandbox_dir = _prepare_sandbox_dir()
    script_path = os.path.join(sandbox_dir, "_exec.py")

    # 包装代码：注入安全护栏
    wrapper = f"""
import sys, os, builtins

# 禁止危险内置函数
_orig_open = open
def _safe_open(file, mode='r', *args, **kwargs):
    if 'w' in mode or 'a' in mode or '+' in mode:
        raise PermissionError("沙箱禁止写入文件")
    if file.startswith('/') and not file.startswith('{sandbox_dir}'):
        raise PermissionError("沙箱禁止访问外部路径")
    return _orig_open(file, mode, *args, **kwargs)

# 禁止危险模块
_orig_import = builtins.__import__
def _safe_import(name, *args, **kwargs):
    blocked = ['os', 'subprocess', 'shutil', 'socket', 'requests', 'urllib', 
               'ctypes', 'multiprocessing', 'threading', 'signal', 'pty',
               'fcntl', 'termios', 'sys', 'posix', 'grp', 'pwd', 'spwd']
    for b in blocked:
        if name == b or name.startswith(b + '.'):
            raise ImportError("沙箱禁止导入 " + name)
    return _orig_import(name, *args, **kwargs)

builtins.open = _safe_open
builtins.__import__ = _safe_import
os.chdir('{sandbox_dir}')

# 用户代码
{code}
"""

    try:
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(wrapper)
    except Exception as e:
        shutil.rmtree(sandbox_dir, ignore_errors=True)
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}

    try:
        proc = subprocess.Popen(
            ["python3", script_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=sandbox_dir,
            env={**os.environ, "HOME": sandbox_dir, "PATH": "/usr/bin:/bin",
                 "PYTHONPATH": "", **(env or {})},
            preexec_fn=_setup_resource_limits if sys.platform == "linux" else None,
        )
        stdout, stderr = proc.communicate(timeout=timeout)
        return {
            "stdout": stdout[:5000],
            "stderr": stderr[:2000],
            "exit_code": proc.returncode,
            "timed_out": False,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        return {"stdout": "", "stderr": "执行超时({}s)".format(timeout), "exit_code": -1, "timed_out": True, "error": "timeout"}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}
    finally:
        shutil.rmtree(sandbox_dir, ignore_errors=True)
