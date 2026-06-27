"""
xuanshuAgent 反编译模块
支持多种二进制/字节码格式的反编译
"""

import os
import sys
import subprocess
import tempfile
import json
from pathlib import Path
from typing import Dict, List, Optional, Union, Any

__version__ = "0.1.0"
__all__ = ["Decompiler", "detect_format", "decompile_file", "get_supported_formats"]


class Decompiler:
    """统一反编译接口"""
    
    def __init__(self, tools_dir: Optional[str] = None):
        self.tools_dir = tools_dir or os.path.join(os.path.dirname(__file__), "tools")
        self.supported = self._detect_available_tools()
    
    def _detect_available_tools(self) -> Dict[str, bool]:
        """检测可用的工具"""
        tools = {
            "ghidra": self._check_ghidra(),
            "jadx": self._check_tool("jadx"),
            "cfr": self._check_tool("cfr"),
            "uncompyle6": self._check_tool("uncompyle6"),
            "decompile3": self._check_tool("decompile3"),
            "luadec": self._check_tool("luadec"),
            "wasm-decompile": self._check_tool("wasm2c"),
            "dnspy": self._check_tool("dnspy"),
        }
        return tools
    
    def _check_ghidra(self) -> bool:
        """检查 Ghidra 是否可用"""
        # 检查环境变量或默认路径
        ghidra_path = os.environ.get("GHIDRA_HOME")
        if ghidra_path and os.path.exists(os.path.join(ghidra_path, "ghidraRun")):
            return True
        # 检查常见安装路径
        common_paths = [
            "/opt/ghidra",
            "/usr/local/ghidra",
            "/home/marvis/ghidra",
            os.path.join(self.tools_dir, "ghidra"),
        ]
        return any(os.path.exists(os.path.join(p, "ghidraRun")) for p in common_paths)
    
    def _resolve_tool(self, tool_name: str) -> Optional[str]:
        """解析工具路径，搜索常见安装位置"""
        # 先尝试直接用命令名
        if self._try_cmd(tool_name):
            return tool_name
        # 搜索 ~/.local/bin
        local_bin = os.path.expanduser("~/.local/bin")
        local_path = os.path.join(local_bin, tool_name)
        if os.path.isfile(local_path) and os.access(local_path, os.X_OK):
            if self._try_cmd(local_path):
                return local_path
        # 搜索 /usr/local/bin
        usr_local = os.path.join("/usr/local/bin", tool_name)
        if os.path.isfile(usr_local) and os.access(usr_local, os.X_OK):
            if self._try_cmd(usr_local):
                return usr_local
        return None

    def _try_cmd(self, cmd: str) -> bool:
        """尝试运行命令检查是否可用"""
        try:
            subprocess.run([cmd, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3)
            return True
        except Exception:
            return False

    def _check_tool(self, tool_name: str) -> bool:
        """检查命令行工具是否可用"""
        return self._resolve_tool(tool_name) is not None

    def _get_tool_path(self, tool_name: str) -> str:
        """获取工具路径，找不到则返回原名（让 subprocess 报错）"""
        return self._resolve_tool(tool_name) or tool_name
    
    def detect_format(self, file_path: str) -> Dict[str, Any]:
        """检测文件格式"""
        from . import format_detector
        return format_detector.detect_file_format(file_path)
    
    def decompile(self, file_path: str, output_format: str = "text", **kwargs) -> Dict[str, Any]:
        """
        反编译文件
        
        Args:
            file_path: 输入文件路径
            output_format: 输出格式 (text, json, ast, ir)
            **kwargs: 额外参数
            
        Returns:
            Dict with keys: success, format, content, warnings, tool_used
        """
        # 1. 检测格式
        format_info = self.detect_format(file_path)
        if not format_info.get("detected"):
            return {
                "success": False,
                "error": f"无法识别文件格式: {file_path}",
                "format_info": format_info
            }
        
        # 2. 选择工具
        tool_result = self._select_tool(format_info)
        if not tool_result["available"]:
            return {
                "success": False,
                "error": f"没有可用的反编译工具: {tool_result['reason']}",
                "format": format_info["format"],
                "available_tools": self.supported
            }
        
        # 3. 执行反编译
        try:
            if tool_result["tool"] == "ghidra":
                content = self._decompile_ghidra(file_path, format_info, **kwargs)
            elif tool_result["tool"] == "jadx":
                content = self._decompile_jadx(file_path, **kwargs)
            elif tool_result["tool"] == "cfr":
                content = self._decompile_cfr(file_path, **kwargs)
            elif tool_result["tool"] in ["uncompyle6", "decompile3"]:
                content = self._decompile_python(file_path, tool_result["tool"], **kwargs)
            elif tool_result["tool"] == "luadec":
                content = self._decompile_lua(file_path, **kwargs)
            elif tool_result["tool"] == "wasm-decompile":
                content = self._decompile_wasm(file_path, **kwargs)
            elif tool_result["tool"] == "dnspy":
                content = self._decompile_dotnet(file_path, **kwargs)
            else:
                return {
                    "success": False,
                    "error": f"未实现的反编译工具: {tool_result['tool']}",
                    "format": format_info["format"]
                }
            
            # 4. 格式化输出
            formatted = self._format_output(content, output_format, format_info)
            
            return {
                "success": True,
                "format": format_info["format"],
                "tool_used": tool_result["tool"],
                "content": formatted,
                "warnings": tool_result.get("warnings", []),
                "metadata": format_info
            }
            
        except Exception as e:
            return {
                "success": False,
                "error": f"反编译失败: {str(e)}",
                "format": format_info["format"],
                "tool": tool_result["tool"]
            }
    
    def _select_tool(self, format_info: Dict) -> Dict:
        """根据格式选择最佳工具"""
        fmt = format_info["format"]
        primary = format_info.get("primary_format")
        
        tool_map = {
            # PE/ELF/Mach-O
            "pe": ("ghidra", ["radare2", "objdump"]),
            "elf": ("ghidra", ["radare2", "objdump"]),
            "macho": ("ghidra", ["radare2"]),
            # Android
            "apk": ("jadx", ["ghidra", "apktool"]),
            "dex": ("jadx", ["ghidra"]),
            # .NET
            "dotnet": ("dnspy", ["ilspy", "ghidra"]),
            # Java
            "java": ("cfr", ["fernflower", "procyon"]),
            "jar": ("cfr", ["fernflower", "procyon"]),
            # Python
            "pyc": ("uncompyle6", ["decompile3", "pycdc"]),
            "pyc_new": ("uncompyle6", ["decompile3", "pycdc"]),
            "pyc_legacy": ("uncompyle6", ["decompile3", "pycdc"]),
            # Lua
            "lua": ("luadec", ["ljd"]),
            # WebAssembly
            "wasm": ("wasm-decompile", ["ghidra", "wasm2c"]),
            # 固件/二进制
            "firmware": ("ghidra", ["binwalk", "radare2"]),
            "binary": ("ghidra", ["radare2", "objdump"]),
        }
        
        # 查找匹配的工具
        for fmt_key, (primary_tool, fallbacks) in tool_map.items():
            if fmt == fmt_key or (primary and primary == fmt_key):
                # 检查主工具
                if self.supported.get(primary_tool, False):
                    return {"tool": primary_tool, "available": True}
                # 检查备选工具
                for fallback in fallbacks:
                    if self.supported.get(fallback, False):
                        return {"tool": fallback, "available": True, "warnings": [f"使用备选工具 {fallback}"]}
        
        return {
            "available": False,
            "reason": f"没有支持 {fmt} 格式的工具",
            "suggested_tools": [t for t, avail in self.supported.items() if avail]
        }
    
    def _decompile_ghidra(self, file_path: str, format_info: Dict, **kwargs) -> str:
        """使用 Ghidra 反编译"""
        # 创建临时项目
        with tempfile.TemporaryDirectory() as tmpdir:
            project_dir = os.path.join(tmpdir, "project")
            project_name = "decompile_temp"
            
            # Ghidra 脚本路径
            script_dir = os.path.join(os.path.dirname(__file__), "scripts")
            os.makedirs(script_dir, exist_ok=True)
            
            # 生成 Ghidra 脚本
            script_path = os.path.join(script_dir, "decompile.py")
            if not os.path.exists(script_path):
                self._create_ghidra_script(script_path)
            
            # 执行 Ghidra Headless
            ghidra_home = self._find_ghidra()
            if not ghidra_home:
                raise RuntimeError("Ghidra 未找到")
            
            cmd = [
                os.path.join(ghidra_home, "support", "analyzeHeadless"),
                project_dir,
                project_name,
                "-import", file_path,
                "-scriptPath", script_dir,
                "-postScript", "decompile.py",
                "-deleteProject"
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            
            # 从输出中提取反编译结果
            output_file = os.path.join(project_dir, f"{os.path.basename(file_path)}.decompiled.c")
            if os.path.exists(output_file):
                with open(output_file, "r", encoding="utf-8", errors="ignore") as f:
                    return f.read()
            else:
                # 尝试从 stdout 提取
                lines = result.stdout.split("\n")
                decompiled = []
                in_decomp = False
                for line in lines:
                    if "DECOMPILED CODE:" in line:
                        in_decomp = True
                        continue
                    if in_decomp and line.strip():
                        decompiled.append(line)
                return "\n".join(decompiled) if decompiled else result.stdout[:5000]
    
    def _decompile_jadx(self, file_path: str, **kwargs) -> str:
        """使用 Jadx 反编译 APK/DEX"""
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = os.path.join(tmpdir, "output")
            cmd = ["jadx", "-d", output_dir, file_path]
            
            subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            
            # 收集所有 Java 文件
            java_files = []
            for root, _, files in os.walk(output_dir):
                for file in files:
                    if file.endswith(".java"):
                        java_files.append(os.path.join(root, file))
            
            # 合并内容
            content = []
            for jfile in sorted(java_files):
                with open(jfile, "r", encoding="utf-8", errors="ignore") as f:
                    content.append(f"// File: {os.path.relpath(jfile, output_dir)}")
                    content.append(f.read())
                    content.append("\n" + "="*80 + "\n")
            
            return "\n".join(content)
    
    def _decompile_cfr(self, file_path: str, **kwargs) -> str:
        """使用 CFR 反编译 Java"""
        cmd = ["cfr", file_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return result.stdout
    
    def _decompile_python(self, file_path: str, tool: str, **kwargs) -> str:
        """反编译 Python .pyc — 外部工具 + 内置 dis 降级"""
        tool_path = self._get_tool_path(tool)
        if tool_path:
            try:
                result = subprocess.run([tool_path, file_path], capture_output=True, text=True, timeout=30)
                stdout = result.stdout.strip()
                # 外部工具输出了有效代码（非 "Unsupported" 等报错行）→ 直接返回
                if stdout and "Unsupported" not in stdout and "Can't uncompile" not in stdout:
                    return stdout
            except Exception:
                pass
        
        # 降级：使用 Python 内置 dis 模块反汇编
        return self._disassemble_pyc(file_path)

    def _disassemble_pyc(self, file_path: str) -> str:
        """使用 dis 模块反汇编 .pyc 文件（内置降级方案，无需外部工具）"""
        import dis, marshal, struct, sys, types
        try:
            with open(file_path, "rb") as f:
                magic = f.read(4)
                if magic[:2] == b'\xa7\r':
                    f.read(12)
                else:
                    f.read(8) if sys.version_info >= (3, 7) else f.read(8)
                code = marshal.load(f)
            
            lines = []
            lines.append(f"# Python bytecode disassembly (built-in dis module)")

            def _dis_code(co, indent=0):
                prefix = "  " * indent
                name = co.co_name or "<module>"
                lines.append(f"\n{prefix}## {name}")
                if indent == 0:
                    lines.append(f"{prefix}# 常量: {co.co_consts}")
                    lines.append(f"{prefix}# 变量: {co.co_varnames}")
                for instr in dis.get_instructions(co):
                    lines.append(f"{prefix}{instr.offset:4d}  {instr.opname:<20s} {instr.argrepr}")
                # 递归展开嵌套函数
                for const in co.co_consts:
                    if isinstance(const, types.CodeType):
                        _dis_code(const, indent + 1)

            _dis_code(code)
            return "\n".join(lines)
        except Exception as e:
            import traceback
            return f"# dis 反汇编失败: {e}\n# {traceback.format_exc()}"
    
    def _decompile_lua(self, file_path: str, **kwargs) -> str:
        """反编译 Lua 字节码"""
        cmd = ["luadec", file_path]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.stdout
    
    def _decompile_wasm(self, file_path: str, **kwargs) -> str:
        """反编译 WebAssembly"""
        # 尝试 wasm-decompile
        try:
            cmd = ["wasm-decompile", file_path]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode == 0:
                return result.stdout
        except:
            pass
        
        # 备选: wasm2c
        cmd = ["wasm2c", file_path, "-o", "/dev/stdout"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.stdout
    
    def _decompile_dotnet(self, file_path: str, **kwargs) -> str:
        """反编译 .NET"""
        # dnSpy 控制台版本
        cmd = ["dnspy", file_path, "--export-all"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return result.stdout
    
    def _find_ghidra(self) -> Optional[str]:
        """查找 Ghidra 安装路径"""
        paths = [
            os.environ.get("GHIDRA_HOME"),
            "/opt/ghidra",
            "/usr/local/ghidra",
            "/home/marvis/ghidra",
            os.path.join(self.tools_dir, "ghidra"),
        ]
        
        for path in paths:
            if path and os.path.exists(os.path.join(path, "ghidraRun")):
                return path
        return None
    
    def _create_ghidra_script(self, script_path: str):
        """创建 Ghidra 反编译脚本"""
        script = '''#!/usr/bin/env python
# Ghidra 反编译脚本

import sys
import os
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

def decompile_current():
    program = currentProgram
    ifc = DecompInterface()
    ifc.openProgram(program)
    
    output = []
    monitor = ConsoleTaskMonitor()
    
    # 反编译所有函数
    fm = currentProgram.getFunctionManager()
    functions = fm.getFunctions(True)
    
    for func in functions:
        try:
            results = ifc.decompileFunction(func, 60, monitor)
            if results.decompileCompleted():
                output.append("// Function: " + func.getName())
                output.append(results.getDecompiledFunction().getC())
                output.append("\\n")
        except:
            output.append("// Failed to decompile: " + func.getName())
            output.append("\\n")
    
    # 保存到文件
    output_file = os.path.join(currentProgram.getExecutablePath() + ".decompiled.c")
    with open(output_file, "w") as f:
        f.write("\\n".join(output))
    
    print("DECOMPILED CODE:")
    print("\\n".join(output[:100]))  # 预览前100行

if __name__ == "__main__":
    decompile_current()
'''
        with open(script_path, "w") as f:
            f.write(script)
    
    def _format_output(self, content: str, output_format: str, format_info: Dict) -> Any:
        """格式化输出"""
        if output_format == "text":
            return content
        elif output_format == "json":
            return {
                "raw": content,
                "format": format_info["format"],
                "size": len(content),
                "lines": content.count("\n") + 1
            }
        elif output_format == "ast":
            return {
                "type": "lines",
                "lines": content.split("\n"),
                "format": format_info["format"]
            }
        else:
            return content


# 便捷函数
def detect_format(file_path: str) -> Dict:
    """检测文件格式"""
    decompiler = Decompiler()
    return decompiler.detect_format(file_path)


def decompile_file(file_path: str, output_format: str = "text", **kwargs) -> Dict:
    """反编译文件"""
    decompiler = Decompiler()
    return decompiler.decompile(file_path, output_format, **kwargs)


def get_supported_formats() -> Dict[str, List[str]]:
    """获取支持的反编译格式"""
    return {
        "executable": ["pe", "elf", "macho"],
        "android": ["apk", "dex"],
        "dotnet": ["dotnet", "il"],
        "java": ["java", "jar", "class"],
        "python": ["pyc"],
        "lua": ["lua"],
        "webassembly": ["wasm"],
        "firmware": ["firmware", "binary"],
    }