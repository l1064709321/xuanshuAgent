"""玄姝多Agent API — Flask 后端 + 前端托管，单端口 8900"""
import os, sys, json, mimetypes, base64
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, request, jsonify, send_file
from core import ParentBot
from models import ModelPool

app = Flask(__name__, static_folder=_BASE_DIR, static_url_path="")

# ── 记忆文件夹路径 ──
_MEMDIR = os.path.join(_BASE_DIR, ".memdir")
os.makedirs(_MEMDIR, exist_ok=True)
_ALLOWED_BASE = os.path.dirname(_BASE_DIR)

@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS,DELETE"
    return resp

pool = ModelPool(default_key="local")
bot = ParentBot(pool=pool, verbose=False, coordinator_mode=True)

@app.route("/")
def index():
    return send_file(os.path.join(_BASE_DIR, "index.html"))

# ── 模型管理 ──
@app.route("/models", methods=["GET"])
def list_models():
    provider = request.args.get("provider", "")
    models = pool.to_list()
    if provider:
        models = [m for m in models if m["provider"] == provider]
    return jsonify({"models": models, "providers": pool.providers(), "current_model": pool.default_key})

@app.route("/models", methods=["POST"])
def add_model():
    data = request.get_json()
    name = data.get("name", "").strip()
    model_id = data.get("model_id", "").strip()
    base_url = data.get("base_url", "").strip()
    provider = data.get("provider", "自定义").strip()
    if not name or not base_url:
        return jsonify({"ok": False, "error": "名称和API地址不能为空"})
    entry = pool.add_custom(name, model_id or name, base_url, provider)
    return jsonify({"ok": True, "model": {"key": entry.key, "name": entry.name,
                   "model_id": entry.model_id, "base_url": entry.base_url,
                   "provider": entry.provider, "custom": True}})

@app.route("/models/<key>", methods=["DELETE"])
def del_model(key):
    pool.remove_custom(key)
    return jsonify({"ok": True})

# ── 每模型独立 API Key ──
@app.route("/model-key", methods=["POST", "OPTIONS"])
def set_model_key():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    model_key = data.get("model", "").strip()
    api_key = data.get("key", "").strip()
    if not model_key:
        return jsonify({"ok": False, "error": "模型标识不能为空"})
    if not api_key:
        pool.remove_model_key(model_key)
        return jsonify({"ok": True, "model": model_key, "has_key": False})
    pool.set_model_key(model_key, api_key)
    # 自动切换当前模型
    pool.set_default(model_key)
    return jsonify({"ok": True, "model": model_key, "has_key": True, "current_model": pool.default_key})

@app.route("/model-key/status", methods=["GET"])
def model_key_status():
    """返回所有模型的 Key 配置状态（不暴露 Key 值）"""
    return jsonify({"keys": pool.per_model_keys, "current_model": pool.default_key})

@app.route("/switch-model", methods=["POST", "OPTIONS"])
def switch_model():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    model_key = data.get("model", "").strip()
    if not model_key or model_key not in pool.all_models:
        return jsonify({"ok": False, "error": "无效模型"})
    pool.set_default(model_key)
    model = pool.all_models[model_key]
    has_key = pool.model_has_key(model_key)
    return jsonify({"ok": True, "model": model_key, "name": model.name, "has_key": has_key})

# ── API Key ──
@app.route("/set-key", methods=["POST", "OPTIONS"])
def set_key():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    key = data.get("key", "").strip()
    model_key = data.get("model", "deepseek-v3").strip()
    if key:
        pool.api_key = key
        resolved = pool.resolve(model_key) or model_key
        pool.set_default(resolved)
        return jsonify({"ok": True, "model": pool.get_model("搜索Agent").name})
    return jsonify({"ok": False, "error": "Key不能为空"})

# ── 对话 ──
@app.route("/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    msg = data.get("msg", "")
    image = data.get("image", None)

    if msg.startswith("/"):
        parts = msg.split(maxsplit=1)
        action = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""
        # /screen 及所有权限命令交给 core 层处理（Agent 自主权限判断），不走 _cmd 路由
        if action == "/screen" or arg in ("allow", "deny"):
            reply = bot.chat(msg)
            return jsonify({"reply": reply, "cmd": True, "model": _model()})
        return jsonify({"reply": _cmd(action, arg), "cmd": True, "model": _model()})

    agent_name = bot._route(msg)
    reply = bot.chat(msg, image)
    return jsonify({
        "reply": reply,
        "agent": agent_name,
        "model": _model(),
        "coordinator_mode": bot.coordinator_mode,
    })

# ── 流式对话 (SSE) ──
@app.route("/chat/stream", methods=["POST"])
def chat_stream():
    from flask import Response, stream_with_context
    data = request.get_json()
    msg = data.get("msg", "")
    image = data.get("image", None)
    if not msg:
        return Response("data: [错误] 消息不能为空\n\n", mimetype="text/event-stream")

    def generate():
        try:
            for chunk in bot.chat_stream(msg, image):
                yield f"data: {chunk}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: [错误] {e}\n\n"
    return Response(stream_with_context(generate()), mimetype="text/event-stream")

# ── Agent 管理 ──
@app.route("/agents", methods=["GET"])
def list_agents():
    return jsonify({"agents": bot.list_agents()})

# ── 性能指标 ──
@app.route("/metrics", methods=["GET"])
def get_metrics_route():
    from monitor import get_metrics
    return jsonify(get_metrics().to_dict())

# ── 协调者模式开关 ──
@app.route("/coordinator-mode", methods=["POST", "OPTIONS"])
def toggle_coordinator():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    enabled = data.get("enabled", True)
    bot.coordinator_mode = enabled
    return jsonify({"ok": True, "coordinator_mode": enabled})

# ── 上下文恢复 ──
@app.route("/context", methods=["GET"])
def get_context():
    """返回持久化的对话上下文，前端关闭页面后重新打开时恢复"""
    ctx = bot.get_persisted_context()
    return jsonify({"ok": True, **ctx})

@app.route("/context/save", methods=["POST", "OPTIONS"])
def save_context():
    """前端每条消息后调用的持久化保存"""
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json(force=True, silent=True) or []
    bot._save_context_external(data)
    return jsonify({"ok": True})

# ── 快照管理 ──
@app.route("/snapshots/export", methods=["POST"])
def export_snapshots():
    success = bot.export_all_snapshots()
    return jsonify({"ok": success})

@app.route("/snapshots/import", methods=["POST"])
def import_snapshots():
    count = bot.import_all_snapshots()
    return jsonify({"ok": True, "imported": count})

# ── 本地文件夹浏览 ──
@app.route("/browse", methods=["POST"])
def browse_dir():
    data = request.get_json()
    path = (data.get("path") or _ALLOWED_BASE).strip()
    if not os.path.exists(path):
        path = _ALLOWED_BASE
    real = os.path.realpath(path)
    if not real.startswith(_ALLOWED_BASE):
        return jsonify({"ok": False, "error": "禁止访问该路径"})
    entries = []
    try:
        for name in sorted(os.listdir(real)):
            full = os.path.join(real, name)
            is_dir = os.path.isdir(full)
            try:
                size = os.path.getsize(full) if not is_dir else 0
            except OSError:
                size = 0
            mtime = int(os.path.getmtime(full) * 1000)
            entries.append({
                "name": name, "path": full, "dir": is_dir,
                "size": size, "mtime": mtime
            })
    except PermissionError:
        return jsonify({"ok": False, "error": "无权限访问"})
    parent = os.path.dirname(real)
    if not os.path.realpath(parent).startswith(_ALLOWED_BASE):
        parent = real
    return jsonify({"ok": True, "path": real, "parent": parent, "entries": entries})

@app.route("/file/read", methods=["POST"])
def read_local_file():
    data = request.get_json()
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"ok": False, "error": "路径不能为空"})
    real = os.path.realpath(path)
    if not real.startswith(_ALLOWED_BASE):
        return jsonify({"ok": False, "error": "禁止访问该路径"})
    if not os.path.isfile(real):
        return jsonify({"ok": False, "error": "不是文件"})
    mime, _ = mimetypes.guess_type(real)
    is_text = mime and (mime.startswith("text/") or mime in (
        "application/json", "application/javascript", "application/xml",
        "application/x-yaml", "application/x-sh"))
    if not is_text and mime is None:
        ext = os.path.splitext(real)[1].lower()
        text_exts = {".py", ".md", ".yaml", ".yml", ".toml", ".cfg", ".ini",
                     ".txt", ".log", ".json", ".js", ".ts", ".jsx", ".tsx",
                     ".css", ".html", ".xml", ".sh", ".bash", ".env", ".gitignore"}
        is_text = ext in text_exts
    size = os.path.getsize(real)
    if is_text or size < 50 * 1024:
        try:
            with open(real, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(50000)
            return jsonify({"ok": True, "path": real, "content": content, "size": size, "binary": False})
        except Exception:
            pass
    # 二进制文件 → base64
    try:
        with open(real, "rb") as f:
            raw = f.read(50000)
        return jsonify({"ok": True, "path": real, "content": base64.b64encode(raw).decode(),
                        "size": size, "binary": True, "mime": mime or "application/octet-stream"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

# ── 记忆文件夹（.memdir）管理 ──
@app.route("/memory/list", methods=["GET"])
def list_memory():
    entries = []
    try:
        for root, dirs, files in os.walk(_MEMDIR):
            for f in files:
                full = os.path.join(root, f)
                rel = os.path.relpath(full, _MEMDIR)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                entries.append({
                    "path": full, "rel": rel, "size": size,
                    "mtime": int(os.path.getmtime(full) * 1000)
                })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})
    return jsonify({"ok": True, "memdir": _MEMDIR, "entries": entries})

@app.route("/memory/read", methods=["POST"])
def read_memory():
    data = request.get_json()
    rel = (data.get("rel") or "").strip()
    if not rel:
        return jsonify({"ok": False, "error": "文件路径不能为空"})
    full = os.path.join(_MEMDIR, rel)
    real = os.path.realpath(full)
    if not real.startswith(os.path.realpath(_MEMDIR)):
        return jsonify({"ok": False, "error": "禁止访问"})
    if not os.path.isfile(real):
        return jsonify({"ok": False, "error": "文件不存在"})
    try:
        with open(real, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(100000)
        return jsonify({"ok": True, "path": real, "content": content})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/memory/write", methods=["POST"])
def write_memory():
    data = request.get_json()
    filename = (data.get("filename") or "").strip()
    content = data.get("content", "")
    if not filename:
        return jsonify({"ok": False, "error": "文件名不能为空"})
    full = os.path.join(_MEMDIR, filename)
    real = os.path.realpath(full)
    if not real.startswith(os.path.realpath(_MEMDIR)):
        return jsonify({"ok": False, "error": "禁止写入该路径"})
    os.makedirs(os.path.dirname(real), exist_ok=True)
    try:
        with open(real, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"ok": True, "path": real})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/memory/delete", methods=["POST"])
def delete_memory():
    data = request.get_json()
    rel = (data.get("rel") or "").strip()
    if not rel:
        return jsonify({"ok": False, "error": "文件路径不能为空"})
    full = os.path.join(_MEMDIR, rel)
    real = os.path.realpath(full)
    if not real.startswith(os.path.realpath(_MEMDIR)):
        return jsonify({"ok": False, "error": "禁止删除"})
    try:
        if os.path.isfile(real):
            os.remove(real)
        elif os.path.isdir(real):
            os.rmdir(real)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

# ── 命令 ──
def _cmd(action, arg):
    cmds = {
        "/help":   "命令: /model [编号|别名] | /new | /status | /agents | /mem | /kb | /coordinator | /snapshot",
        "/new":    (bot.reset(), "新对话已开始")[1],
        "/status": bot.status(),
        "/agents": "\n".join(
            f"{n}: {pool.get_model(n).name} | 插件:{len(c.tools)} | 记忆:{c.memory.get_stats()['短期记忆']}短 | 自校验:{'开' if c.self_verify else '关'}"
            for n, c in bot.children.items()
        ),
        "/model":  _model_cmd(arg),
        "/mem":    "\n".join(c.memory.to_context(5) for c in bot.children.values() if c.memory.to_context(5)) or "无记忆",
        "/kb":     "\n".join(
            f"[{n}]:\n" + "\n".join(f"  - {k[:80]}" for k in c.knowledge)
            for n, c in bot.children.items() if c.knowledge
        ) or "知识库为空",
        "/coordinator": _coordinator_cmd(arg),
        "/snapshot": _snapshot_cmd(arg),
    }
    return cmds.get(action, f"未知命令: {action}")



def _model_cmd(arg):
    if not arg or arg == "list":
        return pool.table()
    resolved = pool.resolve(arg)
    if resolved:
        pool.set_default(resolved)
        return f"已切换: {resolved}"
    return f"未找到: {arg}"


def _model():
    return pool.get_model("搜索Agent").name



def _coordinator_cmd(arg):
    if arg == "off" or arg == "关":
        bot.coordinator_mode = False
        return "协调者模式已关闭"
    elif arg == "on" or arg == "开":
        bot.coordinator_mode = True
        return "协调者模式已开启"
    return f"协调者模式: {'开启' if bot.coordinator_mode else '关闭'} (开/关)"


def _snapshot_cmd(arg):
    if arg == "export" or arg == "导出":
        success = bot.export_all_snapshots()
        return "快照已导出" if success else "快照导出失败"
    elif arg == "import" or arg == "导入":
        count = bot.import_all_snapshots()
        return f"快照导入完成，新增 {count} 条记忆" if count else "无需更新或导入失败"
    return "用法: /snapshot export|import"


if __name__ == "__main__":
    print("玄姝多Agent API → http://0.0.0.0:8900")
    app.run(host="0.0.0.0", port=8900, debug=False)
