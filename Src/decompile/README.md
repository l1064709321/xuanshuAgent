---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 0e1b95e548a05d7a5680b10b9bcd3bb3_d6aa78ff712f11f1986d525400d9a7a1
    ReservedCode1: BLJlrDxQWjqc28a3XtgPeI6bGmhbV9IN/XRj6H/CV8/VP1yIuCQzA6zF/wU4QR6bGmZD+N9OgnhOc0u9TIr97u/1IS7UNPQ7S0sl48MImsCSZv/W2I5xMlVFNxZtsOVYAPsALkecyZ11oeVgomX0jV1+erL9CLQUCMfeIXEzwFBTBlOY2D+QyRWHvA8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 0e1b95e548a05d7a5680b10b9bcd3bb3_d6aa78ff712f11f1986d525400d9a7a1
    ReservedCode2: BLJlrDxQWjqc28a3XtgPeI6bGmhbV9IN/XRj6H/CV8/VP1yIuCQzA6zF/wU4QR6bGmZD+N9OgnhOc0u9TIr97u/1IS7UNPQ7S0sl48MImsCSZv/W2I5xMlVFNxZtsOVYAPsALkecyZ11oeVgomX0jV1+erL9CLQUCMfeIXEzwFBTBlOY2D+QyRWHvA8=
---

# 反编译模块 (decompile)

xuanshuAgent 全能反编译引擎，支持多种二进制/字节码格式。

## 架构

```
decompile/
├── __init__.py           # 核心 Decompiler 类 + 统一接口
├── format_detector.py    # 魔数检测 (magic bytes + 扩展名)
├── __main__.py           # CLI 入口
└── README.md
```

## 支持格式

| 格式 | 类型 | 工具 | 状态 |
|------|------|------|------|
| PE/EXE/DLL | Windows 可执行文件 | Ghidra | 待安装 |
| ELF | Linux 可执行文件 | Ghidra | 待安装 |
| Mach-O | macOS 可执行文件 | Ghidra | 待安装 |
| APK/DEX | Android | Jadx | 待安装 |
| .NET/IL | C# 托管程序集 | dnSpy | 待安装 |
| Java Class/JAR | Java 字节码 | CFR | 待安装 |
| .pyc | Python 字节码 | uncompyle6 | 待安装 |
| Lua 字节码 | Lua | luadec | 待安装 |
| .wasm | WebAssembly | wabt | 待安装 |
| 固件/二进制 blob | 通用 | Ghidra | 待安装 |

## 使用

### Python API

```python
from decompile import Decompiler, decompile_file, detect_format

# 检测文件格式
fmt = detect_format("app.apk")
print(fmt["format"])  # "apk"

# 反编译
result = decompile_file("app.apk", output_format="text")
if result["success"]:
    print(result["content"])
```

### CLI

```bash
# 查看可用工具
python -m decompile --tools

# 检测格式
python -m decompile --detect app.apk

# 反编译
python -m decompile app.apk --format json
```

## 待安装工具

```bash
# Ghidra (推荐手动下载: https://ghidra-sre.org)
export GHIDRA_HOME=/opt/ghidra

# Java 工具 (需要 JRE)
# - jadx: https://github.com/skylot/jadx
# - cfr: https://github.com/leibnitz/cfr

# Python
pip install uncompyle6

# WebAssembly
# 安装 wabt: https://github.com/WebAssembly/wabt
```
*（内容由AI生成，仅供参考）*
