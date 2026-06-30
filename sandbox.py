"""玄姝安全沙箱 v1.0 — 隔离代码执行环境
- 资源限制：CPU 30s, 内存 512MB, 无网络
- 临时目录隔离，执行后自动清理
- seccomp 过滤危险系统调用（Linux）
"""
import os, sys, tempfile, subprocess, resource, shutil, json
from pathlib import Path
from typing import Optional, Dict

_WS = os.path.dirname(os.path.abspath(__file__))
_SANDBOX_BASE = os.path.join(_WS, ".sandbox")
os.makedirs(_SANDBOX_BASE, exist_ok=True)

# 项目级虚拟环境 —— agent 执行 Python 代码时统一走此 venv
_VENV_PYTHON = os.path.join(_WS, ".venv", "bin", "python3")


class SandboxError(Exception):
    pass


def _apply_seccomp():
    """应用 seccomp-bpf 白名单 —— 仅允许安全的系统调用"""
    try:
        import ctypes
        import ctypes.util
    except ImportError:
        return

    # x86_64 系统调用号映射
    _NR = {
        "read": 0, "write": 1, "close": 3, "fstat": 5, "lseek": 8,
        "mmap": 9, "mprotect": 10, "munmap": 11, "brk": 12,
        "rt_sigaction": 13, "rt_sigprocmask": 14, "ioctl": 16,
        "pread64": 17, "newfstatat": 262, "exit": 60, "exit_group": 231,
        "futex": 202, "clock_gettime": 228, "getpid": 39,
        "arch_prctl": 158, "set_tid_address": 218, "set_robust_list": 273,
    }
    allowed = list(_NR.keys())

    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

        class SockFilter(ctypes.Structure):
            _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8),
                        ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]

        class SockFprog(ctypes.Structure):
            _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(SockFilter))]

        AUDIT_ARCH = 0xC000003E  # x86_64
        filters = []
        # 验证架构
        filters.append(SockFilter(0x20, 0, 0, 4))
        filters.append(SockFilter(0x15, 0, len(allowed) + 1, AUDIT_ARCH))

        # 白名单 syscall
        for name in allowed:
            nr = _NR.get(name)
            if nr is None:
                continue
            filters.append(SockFilter(0x20, 0, 0, 0))
            filters.append(SockFilter(0x15, 1, 0, nr))

        # 默认 KILL
        filters.append(SockFilter(0x06, 0, 0, 0x80000000))

        filter_array = (SockFilter * len(filters))(*filters)
        prog = SockFprog(len(filters), filter_array)

        PR_SET_SECCOMP = 22
        SECCOMP_MODE_FILTER = 2
        libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.byref(prog))
    except Exception:
        pass


def _setup_resource_limits():
    """设置 CPU 30s, 内存 512MB, 子进程上限 8"""
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (8, 8))
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

# 预加载标准库中被广泛依赖的安全模块，避免其内部 import os/sys 被连锁拦截
_SAFE_STDLIB = ['math', 'random', 'json', 'datetime', 'collections', 'itertools',
                'functools', 're', 'enum', 'typing', 'copy', 'hashlib', 'base64',
                'csv', 'pathlib', 'string', 'textwrap', 'io', 'codecs']
for _m in _SAFE_STDLIB:
    try: __import__(_m)
    except: pass

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
               'fcntl', 'termios', 'posix', 'grp', 'pwd', 'spwd']
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
            [_VENV_PYTHON, script_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=sandbox_dir,
            env={**{k:v for k,v in os.environ.items() if k != "PYTHONPATH"},
                 "HOME": sandbox_dir, "PATH": "/usr/bin:/bin",
                 **(env or {})},
            preexec_fn=(lambda: (_setup_resource_limits(), _apply_seccomp())) if sys.platform == "linux" else None,
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
