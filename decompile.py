"""反编译/二进制分析模块 - 支持 ELF/PE/Mach-O/APK/DEX/pyc/Java/.NET/Lua/WASM"""

import os
import subprocess
import json
import struct
import dis
import marshal
import sys
from pathlib import Path

# ── 格式魔数映射 ──────────────────────────────────
_MAGIC_SIGNATURES = {
    "\x7fELF": ("ELF", "Executable and Linkable Format"),
    "MZ": ("PE", "Portable Executable (Windows)"),
    "\xca\xfe\xba\xbe": ("Mach-O", "Mach Object (macOS)"),
    "\xcf\xfa\xed\xfe": ("Mach-O", "Mach Object 64-bit (macOS)"),
    "\xfe\xed\xfa\xce": ("Mach-O", "Mach Object 64-bit reversed"),
    "\xfe\xed\xfa\xcf": ("Mach-O", "Mach Object reversed"),
    "PK\x03\x04": ("ZIP", "ZIP Archive (可能是 APK/JAR)"),
    "\x00asm": ("WASM", "WebAssembly Binary"),
    "\x1b\x4c\x4a": ("Lua", "Lua Bytecode (LuaJIT)"),
    "\x1b\x4a\x4d": ("Lua", "Lua Bytecode (LuaJIT 2.1+)"),
}

# Python pyc magic: 4 bytes + 4 bytes timestamp = variable prefix
_PYC_MAGIC_BYTES = [
    (b"\xee\x0c\x0d\x0a", "Python 2.7"),
    (b"\x33\x0d\x0d\x0a", "Python 3.3"),
    (b"\x4e\x0d\x0d\x0a", "Python 3.4"),
    (b"\xb3\x0d\x0d\x0a", "Python 3.5"),
    (b"\xd1\x0d\x0d\x0a", "Python 3.6"),
    (b"\x42\x0d\x0d\x0a", "Python 3.7"),
    (b"\x55\x0d\x0d\x0a", "Python 3.8"),
    (b"\x61\x0d\x0d\x0a", "Python 3.9"),
    (b"\x6f\x0d\x0d\x0a", "Python 3.10"),
    (b"\xa7\x0d\x0d\x0a", "Python 3.11"),
    (b"\xcb\x0d\x0d\x0a", "Python 3.12"),
    (b"\xf3\x0d\x0d\x0a", "Python 3.13"),
]

# .NET PE: CLR 头检测
_DOTNET_GUIDS = [b"BSJB"]  # CLR header signature

# Java class magic
_JAVA_MAGIC = b"\xca\xfe\xba\xbe"

# DEX magic
_DEX_MAGIC = b"dex\n"

# .apk 内的 classes.dex
_APK_SIGNAL_FILES = ["classes.dex", "AndroidManifest.xml", "META-INF/", "res/"]


def _read_head(path, n=256):
    """安全读取文件头部字节"""
    try:
        with open(path, "rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _file_output(path):
    """调用 file 命令获取文件类型"""
    try:
        r = subprocess.run(["file", "-b", path], capture_output=True, text=True, timeout=10)
        return r.stdout.strip()
    except Exception:
        return "未知"


def _unzip_list(path):
    """列出 ZIP/APK 内文件"""
    try:
        r = subprocess.run(["unzip", "-l", path], capture_output=True, text=True, timeout=15)
        return r.stdout
    except Exception:
        return ""


class Decompiler:
    """通用反编译器，支持多种二进制/字节码格式"""

    def __init__(self):
        self.supported = {
            "elf": self._check_tool("objdump") or self._check_tool("readelf"),
            "pe": self._check_tool("objdump") or True,  # 检测即可
            "apk": self._check_tool("unzip"),
            "dex": self._check_tool("file"),
            "pyc": True,  # Python 内置 dis
            "java": self._check_tool("javap"),
            "dotnet": True,  # 检测即可
            "wasm": True,  # 检测即可
            "lua": True,  # 检测即可
            "macho": self._check_tool("otool") or self._check_tool("objdump"),
        }

    @staticmethod
    def _check_tool(name):
        try:
            subprocess.run(["which", name], capture_output=True, text=True, timeout=3, check=True)
            return True
        except Exception:
            return False

    def detect_format(self, file_path: str) -> dict:
        """检测二进制/字节码文件格式"""
        path = Path(file_path)
        if not path.exists():
            return {"error": f"文件不存在: {file_path}", "detected": False}

        head = _read_head(path, 256)
        if not head:
            return {"error": "无法读取文件", "detected": False}
        size = path.stat().st_size
        ext = path.suffix.lower()
        result = {"file": str(path), "size": size, "extension": ext, "detected": False}

        # 1. 文件扩展名快速判断
        ext_map = {
            ".apk": ("APK", "Android Application Package"),
            ".dex": ("DEX", "Dalvik Executable"),
            ".pyc": ("pyc", "Python Bytecode"),
            ".class": ("Java", "Java Class File"),
            ".wasm": ("WASM", "WebAssembly Binary"),
            ".dll": ("PE/DLL", "Windows Dynamic Link Library"),
            ".exe": ("PE/EXE", "Windows Executable"),
            ".o": ("Object", "Object File (ELF/Mach-O)"),
            ".so": ("ELF/SO", "Shared Object"),
            ".luac": ("Lua", "Lua Bytecode"),
        }
        if ext in ext_map:
            result["format"] = ext_map[ext][0]
            result["type"] = ext_map[ext][1]
            result["detected"] = True

        # 2. 魔数检测（优先级更高）
        for magic, (fmt, desc) in sorted(_MAGIC_SIGNATURES.items(), key=lambda x: -len(x[0])):
            h = head[:len(magic)]
            if isinstance(magic, str):
                magic = magic.encode("latin-1")
            if h == magic:
                result["format"] = fmt
                result["type"] = desc
                result["detected"] = True
                result["confidence"] = "high"

                # APK 深度检测
                if fmt == "ZIP" and (ext == ".apk" or ext == ".jar"):
                    result["format"] = "APK" if ext == ".apk" else "JAR"
                    result["type"] = "Android Application Package" if ext == ".apk" else "Java Archive"
                    zip_content = _unzip_list(path)
                    if "AndroidManifest.xml" in zip_content:
                        result["confidence"] = "high"
                        result["apk_signals"] = ["AndroidManifest.xml found"]
                    if "classes.dex" in zip_content:
                        result["apk_signals"] = result.get("apk_signals", []) + ["classes.dex found"]
                    if "META-INF/" in zip_content:
                        result["apk_signals"] = result.get("apk_signals", []) + ["META-INF/ found"]
                break

        # 3. Python pyc 特殊检测
        if not result["detected"]:
            for magic_bytes, version in _PYC_MAGIC_BYTES:
                if head[:4] == magic_bytes:
                    result["format"] = "pyc"
                    result["type"] = f"Python Bytecode ({version})"
                    result["detected"] = True
                    result["confidence"] = "high"
                    break

        # 4. DEX 检测
        if not result["detected"] and head[:4] == _DEX_MAGIC:
            result["format"] = "DEX"
            result["type"] = "Dalvik Executable"
            result["detected"] = True
            result["confidence"] = "high"

        # 5. Java class 检测
        if not result["detected"] and head[:4] == _JAVA_MAGIC:
            result["format"] = "Java"
            result["type"] = "Java Class File"
            result["detected"] = True
            result["confidence"] = "high"

        # 6. PE .NET 检测（CLR header）
        if result.get("format") in ("PE", "PE/DLL", "PE/EXE", "PE") and any(g in head[200:] for g in _DOTNET_GUIDS):
            result["format"] = "PE (.NET)"
            result["type"] = ".NET Assembly (CLR)"
            result["confidence"] = "high"

        # 7. Mach-O 细化
        if result.get("format") == "Mach-O":
            cpu_type = struct.unpack("<I", head[4:8])[0] if len(head) >= 8 else 0
            cpu_map = {7: "x86", 12: "ARM", 0x01000007: "x86_64", 0x0100000c: "ARM64"}
            result["cpu"] = cpu_map.get(cpu_type, f"unknown (0x{cpu_type:08x})")
            result["type"] = f"Mach-O {result['cpu']}"

        # 8. Lua 深度检测
        if not result["detected"] and (ext == ".luac" or head[:4] == b"\x1bLua"):
            result["format"] = "Lua"
            version = head[4] if len(head) > 4 else 0
            result["type"] = f"Lua Bytecode (version {version})"
            result["detected"] = True
            result["confidence"] = "medium"

        # 9. WASM 检测
        if not result["detected"] and head[:4] == b"\x00asm":
            result["format"] = "WASM"
            result["type"] = "WebAssembly Binary"
            result["detected"] = True
            result["confidence"] = "high"

        # 10. file 命令兜底
        if not result["detected"]:
            file_type = _file_output(path)
            result["file_output"] = file_type
            # 从 file 输出推断格式
            lower = file_type.lower()
            if "python" in lower and "bytecode" in lower:
                result["format"] = "pyc"
                result["type"] = file_type
                result["detected"] = True
            elif "elf" in lower:
                result["format"] = "ELF"
                result["type"] = file_type
                result["detected"] = True
            elif "pe32" in lower or "pe64" in lower:
                result["format"] = "PE/EXE"
                result["type"] = file_type
                result["detected"] = True
            elif "mach-o" in lower:
                result["format"] = "Mach-O"
                result["type"] = file_type
                result["detected"] = True
            elif "zip" in lower or "java archive" in lower:
                result["format"] = "ZIP/JAR"
                result["type"] = file_type
                result["detected"] = True
            elif "android" in lower:
                result["format"] = "APK"
                result["type"] = file_type
                result["detected"] = True

        return result

    def decompile(self, file_path: str, output_format: str = "text") -> str:
        """反编译文件，根据检测到的格式调用对应解码器"""
        fmt = self.detect_format(file_path)
        if not fmt.get("detected"):
            return fmt

        format_name = fmt.get("format", "").lower()

        try:
            if "elf" in format_name:
                return self._decompile_elf(file_path, output_format)
            elif "pe" in format_name and ".net" in format_name:
                return self._decompile_dotnet(file_path, output_format)
            elif "pe" in format_name or "dll" in format_name or "exe" in format_name:
                return self._decompile_pe(file_path, output_format)
            elif "apk" in format_name:
                return self._decompile_apk(file_path, output_format)
            elif "dex" in format_name:
                return self._decompile_dex(file_path, output_format)
            elif "pyc" in format_name or "python" in format_name:
                return self._decompile_pyc(file_path, output_format)
            elif "java" in format_name and "class" in format_name:
                return self._decompile_java(file_path, output_format)
            elif "mach-o" in format_name:
                return self._decompile_macho(file_path, output_format)
            elif "wasm" in format_name:
                return self._decompile_wasm(file_path, output_format)
            elif "lua" in format_name:
                return self._decompile_lua(file_path, output_format)
            else:
                return f"反编译: 格式 {format_name} 当前仅支持检测，不支持深度反编译。\n检测结果:\n{json.dumps(fmt, indent=2, ensure_ascii=False)}"
        except Exception as e:
            return f"反编译异常: {e}\n格式检测: {json.dumps(fmt, indent=2, ensure_ascii=False)}"

    def _decompile_elf(self, path, fmt):
        """ELF 反编译: objdump/readelf 提取符号表和反汇编"""
        output = []
        output.append(f"┌─ ELF 分析: {Path(path).name}")
        output.append(f"│ file: {_file_output(path)}")

        # readelf 获取段信息
        try:
            r = subprocess.run(["readelf", "-S", "-l", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                output.append(f"├─ 段/节头 ───")
                output.append(r.stdout[:3000])
        except Exception:
            pass

        # objdump 获取符号表
        try:
            r = subprocess.run(["objdump", "-t", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                symbols = [l for l in r.stdout.split("\n") if l.strip() and any(k in l for k in [" .text", " F ", " O "])]
                if symbols:
                    output.append(f"├─ 关键符号 ({len(symbols)}个) ───")
                    output.extend(symbols[:80])
        except Exception:
            pass

        # objdump 反汇编 .text
        try:
            r = subprocess.run(["objdump", "-d", "-M", "intel", path], capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                lines = r.stdout.split("\n")
                asm_lines = [l for l in lines if ":" in l and "\t" in l]
                output.append(f"├─ 反汇编 ({len(asm_lines)}条指令，显示前80) ───")
                output.extend(asm_lines[:80])
        except Exception:
            pass

        # strings 提取可读字符串
        try:
            r = subprocess.run(["strings", "-n", "6", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                strs = [l for l in r.stdout.strip().split("\n") if l.strip()]
                output.append(f"├─ 可读字符串 ({len(strs)}个，显示前40) ───")
                output.extend(strs[:40])
        except Exception:
            pass

        output.append("└─")
        return "\n".join(output)

    def _decompile_pe(self, path, fmt):
        """PE 分析"""
        output = []
        output.append(f"┌─ PE 分析: {Path(path).name}")
        output.append(f"│ file: {_file_output(path)}")

        try:
            r = subprocess.run(["objdump", "-p", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                output.append(f"├─ PE 头 ───")
                output.append(r.stdout[:3000])
        except Exception:
            pass

        try:
            r = subprocess.run(["strings", "-n", "6", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                strs = [l for l in r.stdout.strip().split("\n") if l.strip()]
                output.append(f"├─ 可读字符串 ({len(strs)}个，显示前40) ───")
                output.extend(strs[:40])
        except Exception:
            pass

        output.append("└─")
        return "\n".join(output)

    def _decompile_dotnet(self, path, fmt):
        """推测为 .NET 程序集"""
        output = [f"┌─ .NET Assembly: {Path(path).name}",
                  f"│ 检测到 CLR Header，推测为 .NET 程序集。",
                  f"│ 如需反编译，建议用 ILSpy / dnSpy 在 Windows 环境下操作。",
                  f"└─"]
        return "\n".join(output)

    def _decompile_apk(self, path, fmt):
        """APK 解包分析"""
        output = [f"┌─ APK 分析: {Path(path).name}",
                  f"│ file: {_file_output(path)}"]

        # 列出内容
        content = _unzip_list(path)
        if content:
            output.append("├─ 包内容 ───")
            output.append(content[:3000])

        # 提取 AndroidManifest.xml（二进制，仅列出结构）
        try:
            import tempfile
            import zipfile
            zf = zipfile.ZipFile(path, "r")
            names = zf.namelist()
            output.append(f"├─ 文件清单 ({len(names)}个文件) ───")
            # 分类展示
            manifest = [n for n in names if "AndroidManifest" in n]
            dex_files = [n for n in names if n.endswith(".dex")]
            so_files = [n for n in names if n.endswith(".so")]
            res_files = [n for n in names if n.startswith("res/")]
            assets = [n for n in names if n.startswith("assets/")]
            output.append(f"│  Manifest: {manifest}")
            output.append(f"│  DEX: {dex_files} ({sum(zf.getinfo(d).file_size for d in dex_files)} bytes)")
            output.append(f"│  SO: {len(so_files)}个")
            for s in so_files[:10]:
                output.append(f"│    {s}")
            output.append(f"│  Res: {len(res_files)}个文件")
            output.append(f"│  Assets: {len(assets)}个文件")
        except Exception as e:
            output.append(f"│ APK 解析异常: {e}")

        output.append("└─")
        return "\n".join(output)

    def _decompile_dex(self, path, fmt):
        """DEX 文件分析"""
        output = [f"┌─ DEX 分析: {Path(path).name}",
                  f"│ file: {_file_output(path)}",
                  f"│ Size: {Path(path).stat().st_size} bytes"]

        try:
            r = subprocess.run(["strings", "-n", "6", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                strs = [l for l in r.stdout.strip().split("\n") if l.strip()]
                # 过滤出类名/方法名
                classes = [s for s in strs if s.startswith("L") and "/" in s and ";" in s]
                methods = [s for s in strs if "(" in s and ")" in s and len(s) < 200]
                output.append(f"├─ 疑似类名 ({len(classes)}个) ───")
                output.extend(classes[:30])
                if methods:
                    output.append(f"├─ 疑似方法签名 ({len(methods)}个) ───")
                    output.extend(methods[:20])
        except Exception:
            pass

        output.append("└─")
        return "\n".join(output)

    def _decompile_pyc(self, path, fmt):
        """Python pyc 反编译"""
        output = [f"┌─ Python Bytecode: {Path(path).name}"]
        try:
            with open(path, "rb") as f:
                magic = f.read(4)
                f.read(4)  # timestamp
                f.read(4)  # size (3.3+)
                code = marshal.load(f)

            output.append(f"│ Python 版本: {self._guess_py_version(magic)}")
            output.append(f"│ Code Object: {code.co_name}")
            output.append(f"│ 文件名: {code.co_filename}")
            output.append(f"│ 参数: {code.co_argcount}个, 本地变量: {code.co_nlocals}个")
            output.append(f"│ 常量数: {len(code.co_consts)}, 变量名数: {len(code.co_names)}")
            output.append(f"│ 字节码长度: {len(code.co_code)} bytes")

            # 反汇编
            output.append("├─ 反汇编 ───")
            try:
                import io
                old_stdout = sys.stdout
                sys.stdout = io.StringIO()
                dis.dis(code)
                disasm = sys.stdout.getvalue()
                sys.stdout = old_stdout
                output.append(disasm[:4000])
            except Exception as e:
                output.append(f"│ 反汇编失败: {e}")

            # 常量列表
            output.append("├─ 常量 ───")
            for i, c in enumerate(code.co_consts[:30]):
                if isinstance(c, str) and len(c) < 100:
                    output.append(f"│  [{i}] '{c}'")
                elif isinstance(c, (int, float)):
                    output.append(f"│  [{i}] {c}")
                elif isinstance(c, type(code)):
                    output.append(f"│  [{i}] <code: {c.co_name}>")
                else:
                    output.append(f"│  [{i}] {type(c).__name__}: {str(c)[:60]}")

            # 变量名
            output.append("├─ 变量名 ───")
            output.append(f"│  {', '.join(code.co_names[:40])}")

        except Exception as e:
            output.append(f"│ 反编译失败: {e}")
            # 降级：用 strings 提取可读内容
            try:
                r = subprocess.run(["strings", "-n", "4", path], capture_output=True, text=True, timeout=10)
                if r.returncode == 0:
                    strs = [l for l in r.stdout.strip().split("\n") if l.strip() and len(l) < 80]
                    output.append(f"│ strings 提取 ({len(strs)}条) ───")
                    output.extend(strs[:30])
            except Exception:
                pass

        output.append("└─")
        return "\n".join(output)

    def _decompile_java(self, path, fmt):
        """Java class 反编译"""
        output = [f"┌─ Java Class: {Path(path).name}"]
        try:
            r = subprocess.run(["javap", "-c", "-p", "-verbose", path], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                output.append("├─ javap 输出 ───")
                output.append(r.stdout[:4000])
            else:
                output.append(f"│ javap 不可用: {r.stderr[:200]}")
                output.append(f"│ 建议安装 JDK: dnf install java-11-openjdk-devel")
        except FileNotFoundError:
            output.append(f"│ javap 未安装。建议安装 JDK。")
        except Exception as e:
            output.append(f"│ 反编译失败: {e}")

        output.append("└─")
        return "\n".join(output)

    def _decompile_macho(self, path, fmt):
        """Mach-O 分析"""
        output = [f"┌─ Mach-O: {Path(path).name}",
                  f"│ file: {_file_output(path)}"]

        for tool in ["objdump", "otool"]:
            try:
                if tool == "objdump":
                    r = subprocess.run(["objdump", "-d", "-M", "intel", path], capture_output=True, text=True, timeout=20)
                else:
                    r = subprocess.run(["otool", "-tV", path], capture_output=True, text=True, timeout=20)
                if r.returncode == 0 and r.stdout.strip():
                    lines = r.stdout.split("\n")
                    asm_lines = [l for l in lines if ":" in l and "\t" in l]
                    output.append(f"├─ {tool} 反汇编 ({len(asm_lines)}条，显示前60) ───")
                    output.extend(asm_lines[:60])
                    break
            except Exception:
                continue

        output.append("└─")
        return "\n".join(output)

    def _decompile_wasm(self, path, fmt):
        """WASM 分析（轻量）"""
        output = [f"┌─ WASM: {Path(path).name}",
                  f"│ 大小: {Path(path).stat().st_size} bytes"]

        # 读取 magic + version
        try:
            with open(path, "rb") as f:
                magic = f.read(4)
                version = struct.unpack("<I", f.read(4))[0]
            output.append(f"│ Magic: {magic.hex()}")
            output.append(f"│ Version: {version}")
        except Exception:
            pass

        # strings 提取导入函数名
        try:
            r = subprocess.run(["strings", "-n", "4", path], capture_output=True, text=True, timeout=10)
            if r.returncode == 0:
                strs = [l for l in r.stdout.strip().split("\n") if l.strip() and len(l) < 100]
                imports = [s for s in strs if "." in s and not s.startswith(".") and "(" not in s]
                if imports:
                    output.append(f"├─ 疑似导入/函数 ({len(imports)}个) ───")
                    output.extend(imports[:30])
        except Exception:
            pass

        output.append("└─ 深度反编译需 wasm-decompile / wasm2wat 工具")
        return "\n".join(output)

    def _decompile_lua(self, path, fmt):
        """Lua 字节码分析"""
        output = [f"┌─ Lua Bytecode: {Path(path).name}",
                  f"│ file: {_file_output(path)}"]

        try:
            with open(path, "rb") as f:
                head = f.read(20)
            signature = head[:4]
            version = head[4]
            format_byte = head[5]
            output.append(f"│ Signature: {signature}")
            output.append(f"│ Lua Version: {version}")
            output.append(f"│ Format: {format_byte}")
        except Exception:
            pass

        output.append("├─ 完整反编译需 luac 或 unluac 工具")
        output.append("└─")
        return "\n".join(output)

    def _guess_py_version(self, magic: bytes) -> str:
        for m, v in _PYC_MAGIC_BYTES:
            if magic == m:
                return v
        return f"未知 ({magic.hex()})"


# ── 模块级便捷函数 ──

_decompiler_instance = Decompiler()


def detect_format(path: str) -> dict:
    return _decompiler_instance.detect_format(path)


def get_supported_formats() -> dict:
    """返回支持格式及工具状态"""
    fmts = {
        "Linux 原生": ["ELF (.so/.o/无后缀)", "pyc (Python Bytecode)"],
        "Windows": ["PE (.exe/.dll)", "PE (.NET/CLR)"],
        "macOS": ["Mach-O (无后缀/.dylib)"],
        "Android": ["APK (.apk)", "DEX (.dex)"],
        "Java": ["Class (.class)"],
        "Web": ["WASM (.wasm)"],
        "其他": ["Lua Bytecode (.luac)"],
    }

    # 注入工具状态
    for fmt_name in fmts:
        fmts[fmt_name] = [f"{f} [{'OK' if _decompiler_instance.supported.get(f.split()[0].lower(), False) else 'DETECT ONLY'}]" for f in fmts[fmt_name]]

    return fmts
