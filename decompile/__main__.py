#!/usr/bin/env python3
"""
反编译模块 CLI 入口
用法: python -m decompile <file_path> [--format text|json]
"""

import sys
import os
import json
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from decompile import Decompiler


def main():
    parser = argparse.ArgumentParser(description="xuanshuAgent 反编译工具")
    parser.add_argument("file", nargs="?", help="要反编译的文件路径")
    parser.add_argument("--format", choices=["text", "json", "ast"], default="text", help="输出格式")
    parser.add_argument("--detect", action="store_true", help="仅检测文件格式")
    parser.add_argument("--tools", action="store_true", help="显示可用工具")
    
    args = parser.parse_args()
    
    decompiler = Decompiler()
    
    if args.tools:
        print("可用反编译工具:")
        for tool, available in decompiler.supported.items():
            status = "已安装" if available else "未安装"
            print(f"  [{status}] {tool}")
        return
    
    if not args.file:
        parser.error("请指定要反编译的文件，或使用 --tools 查看可用工具")
    
    if args.detect:
        result = decompiler.detect_format(args.file)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    
    result = decompiler.decompile(args.file, output_format=args.format)
    
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result.get("success"):
            print(result["content"])
        else:
            print(f"错误: {result.get('error')}", file=sys.stderr)
            if result.get("available_tools"):
                print(f"可用工具: {result['available_tools']}", file=sys.stderr)


if __name__ == "__main__":
    main()
