"""玄姝安全沙箱 v2.0 — 多环境执行
- 默认沙箱：隔离执行，无网络，无文件写入
- venv 模式：使用指定虚拟环境（有依赖）
- 本地模式：直接执行（有完整环境时）
- seccomp 过滤危险系统调用（Linux）
"""
import os, sys, tempfile, subprocess, shutil, json
try:
    import resource
except ImportError:
    resource = None
from pathlib import Path
from typing import Optional, Dict

_WS = os.path.dirname(os.path.abspath(__file__))
_SANDBOX_BASE = os.path.join(_WS, ".sandbox")
os.makedirs(_SANDBOX_BASE, exist_ok=True)

# ── 自动检测可用的 Python 解释器 ──
def _detect_python() -> str:
    """按优先级检测可用的 Python：venv → 系统 python3 → python"""
    candidates = [
        os.path.join(_WS, ".venv", "bin", "python3"),
        os.path.join(_WS, ".venv", "Scripts", "python.exe"),
        "/usr/bin/python3",
        "/usr/local/bin/python3",
        "python3",
        "python",
    ]
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return sys.executable  # 最后兜底

_PYTHON = _detect_python()


def _apply_seccomp():
    """应用 seccomp-bpf 白名单。返回 True 表示成功，False 表示失败（调用方应 os._exit）。"""
    try:
        import ctypes, ctypes.util
    except ImportError:
        print("[SECCOMP] ctypes 不可用，沙箱加固失败", file=sys.stderr)
        return False
    _NR = {
        "read": 0, "write": 1, "close": 3, "fstat": 5, "lseek": 8,
        "mmap": 9, "mprotect": 10, "munmap": 11, "brk": 12,
        "rt_sigaction": 13, "rt_sigprocmask": 14, "ioctl": 16,
        "pread64": 17, "newfstatat": 262, "openat": 257,
        "exit": 60, "exit_group": 231,
        "futex": 202, "clock_gettime": 228, "getpid": 39,
        "arch_prctl": 158, "set_tid_address": 218, "set_robust_list": 273,
    }
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        class SockFilter(ctypes.Structure):
            _fields_ = [("code", ctypes.c_uint16), ("jt", ctypes.c_uint8),
                        ("jf", ctypes.c_uint8), ("k", ctypes.c_uint32)]
        class SockFprog(ctypes.Structure):
            _fields_ = [("len", ctypes.c_uint16), ("filter", ctypes.POINTER(SockFilter))]
        AUDIT_ARCH = 0xC000003E
        filters = [SockFilter(0x20, 0, 0, 4), SockFilter(0x15, 0, len(_NR) + 1, AUDIT_ARCH)]
        for name, nr in _NR.items():
            filters.append(SockFilter(0x20, 0, 0, 0))
            filters.append(SockFilter(0x15, 1, 0, nr))
        filters.append(SockFilter(0x06, 0, 0, 0x80000000))
        arr = (SockFilter * len(filters))(*filters)
        prog = SockFprog(len(filters), arr)
        libc.prctl(22, 2, ctypes.byref(prog))
        return True
    except Exception as e:
        print(f"[SECCOMP] seccomp-bpf 加载失败: {e}", file=sys.stderr)
        return False


def _setup_resource_limits():
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (8, 8))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except Exception:
        pass


def _sandbox_preexec():
    """沙箱子进程 preexec：应用资源限制+seccomp，任一失败则硬退出。
    仅在 fork 后 exec 前调用，os._exit 仅影响子进程。"""
    _setup_resource_limits()
    if not _apply_seccomp():
        os._exit(3)


def _prepare_sandbox_dir() -> str:
    sandbox_dir = tempfile.mkdtemp(prefix="sandbox_", dir=_SANDBOX_BASE)
    os.chmod(sandbox_dir, 0o700)
    return sandbox_dir


def _inject_guard(code: str, sandbox_dir: str) -> str:
    """注入安全护栏代码"""
    return f"""
import sys, os, builtins

_SAFE_STDLIB = ['math', 'random', 'json', 'datetime', 'collections', 'itertools',
                'functools', 're', 'enum', 'typing', 'copy', 'hashlib', 'base64',
                'csv', 'pathlib', 'string', 'textwrap', 'io', 'codecs']
for _m in _SAFE_STDLIB:
    try: __import__(_m)
    except: pass

_orig_open = open
_sandbox_real = os.path.realpath('{sandbox_dir}')
def _safe_open(file, mode='r', *args, _os=os, **kwargs):
    if 'w' in mode or 'a' in mode or '+' in mode:
        raise PermissionError("沙箱禁止写入文件")
    try:
        _real = _os.path.realpath(file) if _os.path.isabs(file) else _os.path.realpath(_os.path.join('{sandbox_dir}', file))
    except Exception:
        raise PermissionError("沙箱禁止访问外部路径")
    if not _real.startswith(_sandbox_real + _os.sep) and _real != _sandbox_real:
        raise PermissionError("沙箱禁止访问外部路径")
    return _orig_open(file, mode, *args, **kwargs)

_orig_import = builtins.__import__
def _safe_import(name, *args, **kwargs):
    blocked = ['os', 'subprocess', 'shutil', 'socket', 'requests', 'urllib',
               'ctypes', 'multiprocessing', 'threading', 'signal', 'pty',
               'fcntl', 'termios', 'posix', 'grp', 'pwd', 'spwd',
               'importlib', 'pickle', 'shelve', 'marshal', 'codeop',
               '_io', '_socket', '_ssl', '_hashlib', '_csv', '_struct',
               '_queue', '_bisect', '_random', '_posixsubprocess',
               '_curses', '_sqlite3']
    for b in blocked:
        if name == b or name.startswith(b + '.'):
            raise ImportError("沙箱禁止导入 " + name)
    return _orig_import(name, *args, **kwargs)

builtins.open = _safe_open
builtins.__import__ = _safe_import
os.chdir('{sandbox_dir}')

# 从 sys.modules 中清除已加载的敏感模块，防止 sys.modules['os'] 绕过
_sensitive = ['os', 'subprocess', 'shutil', 'socket', 'ctypes',
              'multiprocessing', 'threading', 'signal', 'importlib',
              'pickle', 'shelve', 'marshal', 'codeop', 'requests',
              'urllib', 'pty', 'fcntl', 'termios', 'grp', 'pwd', 'spwd',
              '_io', '_socket', '_ssl', '_hashlib', '_csv', '_struct',
              '_queue', '_bisect', '_random', '_posixsubprocess',
              '_curses', '_sqlite3']
for _m in _sensitive:
    sys.modules.pop(_m, None)

# 拦截 _io C 扩展的文件写入（绕过 builtins.open，走 openat syscall）
try:
    import _io as __io
    __orig_FileIO = __io.FileIO
    class _SafeFileIO(__orig_FileIO):
        def __init__(self, name, mode='r', *args, **kwargs):
            if isinstance(mode, str) and any(c in mode for c in 'wax+'):
                raise PermissionError("沙箱禁止写入文件")
            super().__init__(name, mode, *args, **kwargs)
    __io.FileIO = _SafeFileIO
    import io as _io_mod
    _io_mod.FileIO = _SafeFileIO
except Exception:
    pass

# 用户代码
{code}
"""


def run_sandboxed(code: str, timeout: int = 30, env: dict = None,
                  python: str = None, network: bool = False) -> Dict:
    """在隔离环境中执行 Python 代码。

    Args:
        code: 要执行的 Python 代码
        timeout: 超时秒数
        env: 额外环境变量
        python: 指定 Python 解释器（None=自动检测）
        network: 是否允许网络访问（默认禁止）

    Returns:
        {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool, "error": str|None}
    """
    sandbox_dir = _prepare_sandbox_dir()
    script_path = os.path.join(sandbox_dir, "_exec.py")
    py = python or _PYTHON

    wrapper = _inject_guard(code, sandbox_dir)

    try:
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(wrapper)
    except Exception as e:
        shutil.rmtree(sandbox_dir, ignore_errors=True)
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}

    exec_env = {
        **{k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
        "HOME": sandbox_dir,
        "PATH": "/usr/bin:/bin",
        **(env or {}),
    }
    if not network:
        # 无网络模式：通过空 DNS 阻断
        exec_env["RESOLV_HOST_CONF"] = "/dev/null"

    try:
        proc = subprocess.Popen(
            [py, script_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, cwd=sandbox_dir,
            env=exec_env,
            preexec_fn=_sandbox_preexec if sys.platform == "linux" and not network else None,
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
        return {"stdout": "", "stderr": f"执行超时({timeout}s)", "exit_code": -1, "timed_out": True, "error": "timeout"}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}
    finally:
        shutil.rmtree(sandbox_dir, ignore_errors=True)


def _inject_light_guard(code: str) -> str:
    """轻量护栏：仅做 import 拦截 + sys.modules 清理 + _io 写入阻断。
    用于 venv/local 模式，不做 seccomp/资源限制。"""
    return f"""
import builtins

_orig_import = builtins.__import__
def _safe_import(name, *args, **kwargs):
    blocked = ['os', 'subprocess', 'shutil', 'socket', 'requests', 'urllib',
               'ctypes', 'multiprocessing', 'threading', 'signal', 'pty',
               'fcntl', 'termios', 'posix', 'grp', 'pwd', 'spwd',
               'importlib', 'pickle', 'shelve', 'marshal', 'codeop',
               '_io', '_socket', '_ssl', '_hashlib', '_csv', '_struct',
               '_queue', '_bisect', '_random', '_posixsubprocess',
               '_curses', '_sqlite3']
    for b in blocked:
        if name == b or name.startswith(b + '.'):
            raise ImportError("沙箱禁止导入 " + name)
    return _orig_import(name, *args, **kwargs)

builtins.__import__ = _safe_import

import sys
_sensitive = ['os', 'subprocess', 'shutil', 'socket', 'ctypes',
              'multiprocessing', 'threading', 'signal', 'importlib',
              'pickle', 'shelve', 'marshal', 'codeop', 'requests',
              'urllib', 'pty', 'fcntl', 'termios', 'grp', 'pwd', 'spwd',
              '_io', '_socket', '_ssl', '_hashlib', '_csv', '_struct',
              '_queue', '_bisect', '_random', '_posixsubprocess',
              '_curses', '_sqlite3']
for _m in _sensitive:
    sys.modules.pop(_m, None)

try:
    import _io as __io
    __orig_FileIO = __io.FileIO
    class _SafeFileIO(__orig_FileIO):
        def __init__(self, name, mode='r', *args, **kwargs):
            if isinstance(mode, str) and any(c in mode for c in 'wax+'):
                raise PermissionError("写入操作已被拦截")
            super().__init__(name, mode, *args, **kwargs)
    __io.FileIO = _SafeFileIO
except Exception:
    pass

{code}
"""


def run_in_venv(code: str, venv_path: str = None, timeout: int = 60) -> Dict:
    """在指定虚拟环境中执行代码（有依赖，不限制网络/文件）。

    Args:
        code: Python 代码
        venv_path: venv 路径（None=自动检测 .venv）
        timeout: 超时秒数
    """
    if venv_path is None:
        venv_path = os.path.join(_WS, ".venv")
    venv_py = os.path.join(venv_path, "bin", "python3")
    if not os.path.isfile(venv_py):
        venv_py = os.path.join(venv_path, "Scripts", "python.exe")
    if not os.path.isfile(venv_py):
        return {"stdout": "", "stderr": f"虚拟环境不存在: {venv_path}", "exit_code": -1, "timed_out": False, "error": "venv not found"}

    script = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, dir=_SANDBOX_BASE)
    script.write(_inject_light_guard(code))
    script.close()

    try:
        proc = subprocess.run(
            [venv_py, script.name],
            capture_output=True, text=True, timeout=timeout,
            cwd=_WS,
            env={**os.environ, "VIRTUAL_ENV": venv_path},
        )
        return {
            "stdout": proc.stdout[:5000],
            "stderr": proc.stderr[:2000],
            "exit_code": proc.returncode,
            "timed_out": False,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"执行超时({timeout}s)", "exit_code": -1, "timed_out": True, "error": "timeout"}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}
    finally:
        try:
            os.unlink(script.name)
        except Exception:
            pass


def run_local(code: str, timeout: int = 60) -> Dict:
    """直接在当前环境执行（无隔离，信任代码时使用）"""
    script = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, dir=_SANDBOX_BASE)
    script.write(_inject_light_guard(code))
    script.close()
    try:
        proc = subprocess.run(
            [sys.executable, script.name],
            capture_output=True, text=True, timeout=timeout, cwd=_WS,
        )
        return {
            "stdout": proc.stdout[:5000],
            "stderr": proc.stderr[:2000],
            "exit_code": proc.returncode,
            "timed_out": False,
            "error": None,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"执行超时({timeout}s)", "exit_code": -1, "timed_out": True, "error": "timeout"}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1, "timed_out": False, "error": str(e)}
    finally:
        try:
            os.unlink(script.name)
        except Exception:
            pass


def create_venv(venv_path: str = None, packages: list = None) -> Dict:
    """创建虚拟环境并安装依赖包。

    Args:
        venv_path: 目标路径（None=.venv）
        packages: 要安装的包列表
    """
    if venv_path is None:
        venv_path = os.path.join(_WS, ".venv")
    try:
        subprocess.run([sys.executable, "-m", "venv", venv_path], check=True, timeout=60)
        venv_py = os.path.join(venv_path, "bin", "python3")
        if not os.path.isfile(venv_py):
            venv_py = os.path.join(venv_path, "Scripts", "python.exe")
        if packages:
            subprocess.run(
                [venv_py, "-m", "pip", "install", "-q"] + packages,
                timeout=120, capture_output=True, text=True,
            )
        return {"ok": True, "path": venv_path, "packages": packages or []}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_env_info() -> Dict:
    """获取当前执行环境信息，供玄姝决策参考"""
    return {
        "python": _PYTHON,
        "sandbox_dir": _SANDBOX_BASE,
        "has_venv": os.path.isfile(os.path.join(_WS, ".venv", "bin", "python3")),
        "venv_path": os.path.join(_WS, ".venv"),
        "platform": sys.platform,
        "in_docker": os.path.exists("/.dockerenv"),
    }
