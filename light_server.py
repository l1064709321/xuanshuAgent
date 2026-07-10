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

@app.route("/git-log", methods=["GET"])
def git_log():
    """返回最近 15 条提交记录"""
    import subprocess
    try:
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "log", "--oneline", "-15", "--format=%h|%s|%ai"],
            capture_output=True, text=True, timeout=5,
            cwd=_HERE
        )
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.strip()})
        commits = []
        for line in r.stdout.strip().split('\n'):
            if not line: continue
            parts = line.split('|', 2)
            commits.append({"hash": parts[0], "message": parts[1], "date": parts[2] if len(parts)>2 else ""})
        return jsonify({"ok": True, "commits": commits, "head": commits[0]["hash"] if commits else ""})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/git-revert", methods=["POST"])
def git_revert():
    """回滚到指定 commit（git reset --hard）"""
    import subprocess
    data = request.get_json(silent=True) or {}
    target = data.get("hash", "").strip()
    if not target:
        return jsonify({"ok": False, "error": "缺少目标 commit hash"})
    try:
        # 先备份当前状态为 stash
        subprocess.run(["/home/marvis/local/bin/git", "stash", "push", "-u", "-m", "auto-stash-before-revert"], capture_output=True, timeout=10, cwd=_HERE)
        # reset --hard
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "reset", "--hard", target],
            capture_output=True, text=True, timeout=10,
            cwd=_HERE
        )
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.strip()})
        # 获取新 HEAD
        r2 = subprocess.run(
            ["/home/marvis/local/bin/git", "log", "--oneline", "-1", "--format=%h %s"],
            capture_output=True, text=True, timeout=5,
            cwd=_HERE
        )
        return jsonify({"ok": True, "reset_to": r2.stdout.strip(), "stashed": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/git-revert-restore", methods=["POST"])
def git_revert_restore():
    """撤销回滚：恢复 stash"""
    import subprocess
    try:
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "stash", "list"],
            capture_output=True, text=True, timeout=5,
            cwd=_HERE
        )
        if not r.stdout.strip():
            return jsonify({"ok": False, "error": "没有可恢复的 stash"})
        subprocess.run(["/home/marvis/local/bin/git", "stash", "pop"], capture_output=True, timeout=10, cwd=_HERE)
        return jsonify({"ok": True, "message": "已恢复回滚前状态"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8901, debug=False)
