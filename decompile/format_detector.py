"""
文件格式检测器
通过魔数(magic bytes)和扩展名识别二进制/字节码格式
"""

import os
import struct
from typing import Dict, Optional, Tuple


# 魔数签名数据库
MAGIC_SIGNATURES = {
    # PE (Windows 可执行文件)
    "pe": {
        "magic": b"MZ",
        "offset": 0,
        "extensions": [".exe", ".dll", ".sys", ".ocx", ".cpl", ".scr", ".efi", ".mui"],
        "description": "Windows PE 可执行文件"
    },
    # ELF (Linux 可执行文件)
    "elf": {
        "magic": b"\x7fELF",
        "offset": 0,
        "extensions": [".elf", ".o", ".so", ".ko", ".bin", ".out"],
        "description": "ELF 可执行文件/共享库"
    },
    # Mach-O (macOS/iOS)
    "macho": {
        "magic": (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"),
        "offset": 0,
        "extensions": [".macho", ".dylib", ".bundle"],
        "description": "Mach-O 可执行文件"
    },
    # DEX (Android Dalvik)
    "dex": {
        "magic": b"dex\n",
        "offset": 0,
        "extensions": [".dex"],
        "description": "Android DEX 文件"
    },
    # APK (Android 安装包)
    "apk": {
        "magic": b"PK\x03\x04",
        "offset": 0,
        "extensions": [".apk", ".xapk"],
        "description": "Android APK 安装包"
    },
    # .NET PE (C#/VB.NET)
    "dotnet": {
        "magic": b"MZ",
        "offset": 0,
        "extensions": [".exe", ".dll"],
        "description": ".NET 托管程序集",
        "condition": "has_dotnet_header",  # 需要额外检测
    },
    # Java Class
    "java_class": {
        "magic": b"\xca\xfe\xba\xbe",
        "offset": 0,
        "extensions": [".class"],
        "description": "Java 字节码文件"
    },
    # Java JAR/WAR
    "jar": {
        "magic": b"PK\x03\x04",
        "offset": 0,
        "extensions": [".jar", ".war", ".ear"],
        "description": "Java JAR 存档"
    },
    # Python .pyc (3.0-3.2)
    "pyc_old": {
        "magic": b"\x03\xf3\x0d\x0a",
        "offset": 0,
        "extensions": [".pyc"],
        "description": "Python 字节码 (3.0-3.2)"
    },
    # Python .pyc (3.3-3.7)
    "pyc": {
        "magic": (b"\x42\x0d\x0d\x0a", b"\x55\x0d\x0d\x0a", b"\x61\x0d\x0d\x0a"),
        "offset": 0,
        "extensions": [".pyc"],
        "description": "Python 字节码 (3.3+)"
    },
    # Python .pyc (最新 format)
    "pyc_new": {
        "magic": b"\xa7\x0d\x0d\x0a",  # 3.12+
        "offset": 0,
        "extensions": [".pyc"],
        "description": "Python 字节码 (3.12+)"
    },
    # Lua 字节码
    "lua": {
        "magic": b"\x1bLua",
        "offset": 0,
        "extensions": [".luac", ".lua"],
        "description": "Lua 字节码"
    },
    # WebAssembly
    "wasm": {
        "magic": b"\x00asm",
        "offset": 0,
        "extensions": [".wasm"],
        "description": "WebAssembly 模块"
    },
    # LLVM Bitcode
    "llvm_bitcode": {
        "magic": b"\xde\xc0\x17\x0b",
        "offset": 0,
        "extensions": [".bc"],
        "description": "LLVM 位码"
    },
    # ZIP 包含文件
    "zip": {
        "magic": b"PK\x03\x04",
        "offset": 0,
        "extensions": [".zip", ".aar", ".jar", ".apk"],
        "description": "ZIP 压缩包"
    },
}

# 扩展名到格式映射（用于魔数不明确时）
EXTENSION_MAP = {
    ".exe": "pe",
    ".dll": "pe",
    ".sys": "pe",
    ".ocx": "pe",
    ".so": "elf",
    ".elf": "elf",
    ".o": "elf",
    ".ko": "elf",
    ".macho": "macho",
    ".dylib": "macho",
    ".apk": "apk",
    ".dex": "dex",
    ".class": "java_class",
    ".jar": "jar",
    ".war": "jar",
    ".ear": "jar",
    ".pyc": "pyc",
    ".luac": "lua",
    ".wasm": "wasm",
    ".bc": "llvm_bitcode",
    ".aar": "zip",
}


def read_magic(file_path: str, length: int = 16) -> Optional[bytes]:
    """读取文件头部魔数"""
    try:
        with open(file_path, "rb") as f:
            return f.read(length)
    except (IOError, OSError):
        return None


def check_dotnet_header(file_path: str) -> bool:
    """检查 PE 文件是否包含 .NET 头"""
    try:
        with open(file_path, "rb") as f:
            # 读取 DOS 头
            dos_header = f.read(64)
            if dos_header[:2] != b"MZ":
                return False
            
            # 读取 PE 签名偏移 (offset 0x3C)
            pe_offset = struct.unpack("<I", dos_header[0x3C:0x40])[0]
            
            # 跳转到 PE 头
            f.seek(pe_offset)
            pe_sig = f.read(4)
            if pe_sig != b"PE\x00\x00":
                return False
            
            # 读取可选头
            optional_header = f.read(224)
            if len(optional_header) < 224:
                return False
            
            # .NET 数据目录在 optional header 的第 15 个条目 (offset 0xE8)
            clr_rva = struct.unpack("<I", optional_header[0xE8:0xEC])[0]
            clr_size = struct.unpack("<I", optional_header[0xEC:0xF0])[0]
            
            return clr_rva != 0 and clr_size != 0
            
    except (IOError, OSError, struct.error):
        return False


def detect_file_format(file_path: str) -> Dict:
    """
    检测文件格式
    
    Returns:
        {
            "detected": bool,
            "format": str,           # 通用格式名
            "specific": str,         # 具体格式
            "extension": str,
            "description": str,
            "confidence": float,     # 0-1
            "file_size": int,
            "is_executable": bool,
        }
    """
    if not os.path.exists(file_path):
        return {"detected": False, "error": f"文件不存在: {file_path}"}
    
    file_size = os.path.getsize(file_path)
    extension = os.path.splitext(file_path)[1].lower()
    magic_bytes = read_magic(file_path, 64)
    
    if not magic_bytes:
        return {"detected": False, "error": "无法读取文件"}
    
    # 按魔数检测
    matches = []
    
    for fmt_key, sig_info in MAGIC_SIGNATURES.items():
        magic = sig_info["magic"]
        offset = sig_info["offset"]
        magic_len = len(magic) if isinstance(magic, bytes) else len(magic[0])
        
        # 检查魔数
        matched = False
        if isinstance(magic, bytes):
            matched = magic_bytes[offset:offset+len(magic)] == magic
        else:  # tuple of alternatives
            for alt in magic:
                if magic_bytes[offset:offset+len(alt)] == alt:
                    matched = True
                    break
        
        if matched:
            confidence = 0.9
            
            # 额外条件检测
            condition = sig_info.get("condition")
            if condition == "has_dotnet_header":
                if check_dotnet_header(file_path):
                    confidence = 0.95
                    description = ".NET 托管程序集 (PE + CLR)"
                else:
                    # 普通 PE 文件
                    if fmt_key == "dotnet":
                        continue  # 不是 .NET，跳过
            else:
                description = sig_info["description"]
            
            # 扩展名匹配加分
            if extension and extension in sig_info.get("extensions", []):
                confidence += 0.05
            
            matches.append({
                "format": fmt_key,
                "description": description,
                "confidence": min(confidence, 1.0)
            })
    
    # 没有魔数匹配，尝试按扩展名
    if not matches:
        if extension in EXTENSION_MAP:
            return {
                "detected": True,
                "format": EXTENSION_MAP[extension],
                "primary_format": EXTENSION_MAP[extension],
                "specific": extension,
                "description": f"按扩展名识别: {extension}",
                "confidence": 0.4,
                "file_size": file_size,
                "is_executable": EXTENSION_MAP[extension] in ("pe", "elf", "macho"),
                "detection_method": "extension_only",
                "note": "魔数未匹配，仅通过扩展名识别，结果可能不准确"
            }
        else:
            return {
                "detected": True,
                "format": "binary",
                "primary_format": "binary",
                "specific": "unknown",
                "description": "未知二进制文件",
                "confidence": 0.1,
                "file_size": file_size,
                "is_executable": False,
                "detection_method": "unknown",
                "hex_preview": magic_bytes[:16].hex(" "),
                "note": "魔数和扩展名均未识别，可能需要手动指定格式"
            }
    
    # 选择置信度最高的匹配
    best = max(matches, key=lambda x: x["confidence"])
    
    # 判断通用格式分类
    primary_format = best["format"]
    
    return {
        "detected": True,
        "format": best["format"],
        "primary_format": primary_format,
        "specific": best["format"],
        "extension": extension,
        "description": best["description"],
        "confidence": best["confidence"],
        "file_size": file_size,
        "is_executable": primary_format in ("pe", "elf", "macho", "dotnet"),
        "detection_method": "magic_bytes",
        "hex_preview": magic_bytes[:16].hex(" "),
        "all_matches": [m["format"] for m in matches]
    }
