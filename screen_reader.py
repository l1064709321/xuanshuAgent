"""
屏幕阅读器 — 截取屏幕并用 AI 分析内容
支持: Linux(X11/Wayland) / AidLux(Android) / macOS / Windows
"""

import os, sys, tempfile, base64, subprocess, time
from datetime import datetime


def _capture_linux():
    """Linux 截图，依次尝试多种方式"""
    tmp = os.path.join(tempfile.gettempdir(), f"screen_{int(time.time())}.png")

    # 方式1: gnome-screenshot
    try:
        subprocess.run(["gnome-screenshot", "-f", tmp], timeout=5, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(tmp) and os.path.getsize(tmp) > 100:
            return tmp
    except Exception:
        pass

    # 方式2: import (ImageMagick)
    try:
        subprocess.run(["import", "-window", "root", tmp], timeout=5, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(tmp) and os.path.getsize(tmp) > 100:
            return tmp
    except Exception:
        pass

    # 方式3: mss (Python)
    try:
        import mss
        with mss.mss() as sct:
            monitor = sct.monitors[0]
            sct.shot(mon=-1, output=tmp)
        if os.path.exists(tmp) and os.path.getsize(tmp) > 100:
            return tmp
    except Exception:
        pass

    # 方式4: scrot
    try:
        subprocess.run(["scrot", tmp], timeout=5, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(tmp) and os.path.getsize(tmp) > 100:
            return tmp
    except Exception:
        pass

    # 方式5: PyAutoGUI
    try:
        import pyautogui
        img = pyautogui.screenshot()
        img.save(tmp)
        if os.path.exists(tmp) and os.path.getsize(tmp) > 100:
            return tmp
    except Exception:
        pass

    return None


def _capture_aidlux():
    """AidLux (Android) 截图"""
    tmp = os.path.join(tempfile.gettempdir(), f"screen_{int(time.time())}.png")

    # 方式1: screencap (Android 原生)
    try:
        raw = "/sdcard/screen_raw.png"
        subprocess.run(["screencap", "-p", raw], timeout=5, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(raw):
            os.rename(raw, tmp)
            return tmp
    except Exception:
        pass

    # 方式2: fb2png / fbdump
    try:
        subprocess.run(["fb2png"], timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for f in os.listdir(tempfile.gettempdir()):
            if f.startswith("fb") and f.endswith(".png"):
                return os.path.join(tempfile.gettempdir(), f)
    except Exception:
        pass

    # 方式3: adb 截图 (如果 adb 可用)
    try:
        subprocess.run(["adb", "exec-out", "screencap", "-p"], timeout=5,
                       capture_output=True, check=True)
        # 需要解析 raw 数据——跳过这个复杂路径
    except Exception:
        pass

    return None


def capture():
    """截取当前屏幕，返回图片文件路径。失败返回 None"""
    # 检测是否为 AidLux
    if os.path.exists("/usr/bin/aid") or os.path.exists("/aidlux"):
        return _capture_aidlux()

    return _capture_linux()


def to_base64(path):
    """图片转 base64 data URL"""
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:image/png;base64,{b64}"


def read_screen(api_base="http://localhost:8900", model=None, prompt="请描述屏幕上显示的内容"):
    """
    截屏并用 AI 分析，返回文本描述。
    
    参数:
        api_base: API 地址（默认本机 8900）
        model: 模型名（默认自动选择支持视觉的模型）
        prompt: 分析提示词
    """
    path = capture()
    if not path:
        return {"ok": False, "error": "截图失败：未找到可用的截图工具。请安装 scrot / mss / gnome-screenshot 之一"}
    
    b64 = to_base64(path)
    size = os.path.getsize(path)
    
    # 尝试调用 API 的视觉分析（如果支持）
    # 如果后端不支持图片，返回截图路径和 base64 供手动查看
    result = {
        "ok": True,
        "path": path,
        "size": size,
        "base64": b64[:100] + "..." if len(b64) > 100 else b64,  # 摘要
        "hint": "截图已保存，可使用 /screen 命令在对话中分析此图片"
    }
    
    # 清理旧截图（保留最近3张）
    _cleanup(tempfile.gettempdir(), keep=3)
    
    return result


def read_and_analyze(api_base="http://localhost:8900", model=None, prompt="请描述屏幕上显示的内容"):
    """
    截屏 + AI 分析的完整流程。
    要求后端 /chat 接口支持 image 字段（base64）。
    """
    import requests, json
    
    path = capture()
    if not path:
        return "截图失败：未找到可用的截图工具。"
    
    b64 = to_base64(path)
    
    try:
        resp = requests.post(
            f"{api_base}/chat",
            json={"msg": prompt, "image": b64, "model": model} if model else {"msg": prompt, "image": b64},
            timeout=30
        )
        data = resp.json()
        reply = data.get("reply", str(data))
        return reply
    except Exception as e:
        return f"截图成功 ({path})，但 AI 分析失败: {e}"


def _cleanup(directory, keep=3):
    """清理旧截图文件，只保留最近 keep 张"""
    try:
        files = []
        for f in os.listdir(directory):
            fp = os.path.join(directory, f)
            if f.startswith("screen_") and f.endswith(".png"):
                files.append((os.path.getmtime(fp), fp))
        files.sort(reverse=True)
        for _, fp in files[keep:]:
            os.remove(fp)
    except Exception:
        pass


# ========== CLI ==========
if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="屏幕阅读器")
    p.add_argument("--analyze", action="store_true", help="截图后调用 AI 分析")
    p.add_argument("--prompt", default="请描述屏幕上显示的内容", help="分析提示词")
    p.add_argument("--api", default="http://localhost:8900", help="API地址")
    args = p.parse_args()

    if args.analyze:
        result = read_and_analyze(api_base=args.api, prompt=args.prompt)
        print(result)
    else:
        result = read_screen()
        if result["ok"]:
            print(f"截图成功: {result['path']} ({result['size']} bytes)")
        else:
            print(f"失败: {result['error']}")
