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

@app.route("/read-file", methods=["POST"])
def read_file():
    data = request.get_json(silent=True) or {}
    req_path = data.get("path", "").strip()
    max_size = data.get("max_size", 200 * 1024)  # default 200KB

    abs_path = os.path.normpath(os.path.join(_WS, req_path))
    if not abs_path.startswith(os.path.normpath(_WS)):
        return jsonify({"ok": False, "error": "访问路径越界"})

    if not os.path.isfile(abs_path):
        return jsonify({"ok": False, "error": "不是有效文件"})

    try:
        fsize = os.path.getsize(abs_path)
        if fsize > max_size:
            return jsonify({"ok": False, "error": f"文件过大 ({fsize//1024}KB > {max_size//1024}KB)", "size": fsize})

        # 检测是否为文本
        text_exts = {'.txt','.md','.py','.js','.json','.xml','.yaml','.yml','.html','.css','.csv',
                     '.sh','.bat','.cfg','.ini','.toml','.log','.c','.cpp','.h','.java','.rs','.go',
                     '.ts','.tsx','.jsx','.vue','.sql','.r','.m','.swift','.kt','.scala','.rb','.php',
                     '.env','.gitignore','.dockerignore','.editorconfig'}
        ext = os.path.splitext(abs_path)[1].lower()
        name = os.path.basename(abs_path)

        if ext in text_exts or name.startswith('.') and '.' not in name[1:] or name in ('Makefile','Dockerfile','README','LICENSE'):
            with open(abs_path, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            return jsonify({
                "ok": True,
                "type": "text",
                "path": abs_path,
                "name": name,
                "size": fsize,
                "content": content,
                "lines": content.count('\n') + 1
            })
        else:
            return jsonify({
                "ok": True,
                "type": "binary",
                "path": abs_path,
                "name": name,
                "size": fsize,
                "ext": ext
            })
    except PermissionError:
        return jsonify({"ok": False, "error": "无权限读取"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8901, debug=False)
