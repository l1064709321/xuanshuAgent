"""轻量文件浏览 + 静态服务 — 不依赖 core/model 等重模块"""
import os, json, mimetypes
from flask import Flask, request, jsonify, send_from_directory

_HERE = os.path.dirname(os.path.abspath(__file__))
_MEMDIR = os.path.join(_HERE, ".memdir")
_WS = os.path.dirname(_HERE)  # workspace root
os.makedirs(_MEMDIR, exist_ok=True)

app = Flask(__name__, static_folder=".", static_url_path="")

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/browse", methods=["POST"])
def browse_dir():
    data = request.get_json(silent=True) or {}
    req_path = data.get("path", "").strip()
    if not req_path:
        req_path = _WS

    # security: resolve and clamp
    abs_path = os.path.normpath(os.path.join(_WS, req_path))
    if not abs_path.startswith(os.path.normpath(_WS)):
        return jsonify({"ok": False, "error": "访问路径越界"})

    if not os.path.isdir(abs_path):
        return jsonify({"ok": False, "error": f"不是有效目录: {req_path}"})

    items = []
    try:
        for name in sorted(os.listdir(abs_path)):
            full = os.path.join(abs_path, name)
            is_dir = os.path.isdir(full)
            items.append({
                "name": name,
                "path": full,
                "dir": is_dir,
                "size": os.path.getsize(full) if not is_dir else 0,
            })
    except PermissionError:
        return jsonify({"ok": False, "error": "无权限访问该目录"})

    parent = os.path.dirname(abs_path)
    if not parent.startswith(os.path.normpath(_WS)):
        parent = None

    return jsonify({
        "ok": True,
        "path": abs_path,
        "entries": items,
        "parent": parent,
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8901, debug=False)
