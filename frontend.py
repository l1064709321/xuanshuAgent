"""玄姝多Agent API — Flask 后端 + 前端托管，单端口 8901"""
import os, sys, json, mimetypes, base64, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, request, jsonify, send_file
from core import ParentBot
from models import ModelPool

app = Flask(__name__, static_folder=".", static_url_path="")

# ── 记忆文件夹路径 ──
_MEMDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".memdir")
os.makedirs(_MEMDIR, exist_ok=True)
_ALLOWED_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 请求日志（调试用）──
import logging
import sys
logger = logging.getLogger()
logger.setLevel(logging.INFO)
fh = logging.FileHandler(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'req.log'))
fh.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
ch = logging.StreamHandler(sys.stderr)
ch.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
logger.handlers = [fh, ch]
@app.before_request
def log_request():
    if request.path.startswith('/model-key') or request.path.startswith('/set-key') or request.path == '/chat':
        data = request.get_json(silent=True) or {}
        logging.info(f"{request.method} {request.path} data={data}")

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
    return send_file("index.html")

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
    # 禁止为本地模拟模型配置 Key
    entry = pool.all_models.get(model_key)
    if entry and not entry.base_url:
        return jsonify({"ok": False, "error": "本地模拟模型不需要 Key"})
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
        model_entry = pool.all_models.get(resolved)
        if model_entry and not model_entry.base_url:
            for k, v in pool.all_models.items():
                if v.base_url:
                    resolved = k
                    break
        pool.set_default(resolved)
        return jsonify({"ok": True, "model": pool.all_models[pool.default_key].name})
    else:
        # 空 Key → 清除 Key 并回退到本地模拟
        pool.api_key = ""
        pool._clients.clear()
        pool.set_default("local")
        return jsonify({"ok": True, "model": "本地模拟", "local": True})

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
            result = bot.chat(msg)
            return jsonify({"reply": result["reply"], "thinking": result.get("thinking", []), "cmd": True, "model": _model()})
        return jsonify({"reply": _cmd(action, arg), "cmd": True, "model": _model()})

    agent_name = bot._route(msg)
    result = bot.chat(msg, image)
    return jsonify({
        "reply": result["reply"],
        "thinking": result.get("thinking", []),
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
    return pool.all_models[pool.default_key].name



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


# ── 技能管理 (Skills CRUD) ──
import uuid
from datetime import datetime

_SKILLSDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".skills")
os.makedirs(_SKILLSDIR, exist_ok=True)

def _skill_path(agent, sid):
    adir = os.path.join(_SKILLSDIR, agent.replace('/', '_').replace('..', ''))
    os.makedirs(adir, exist_ok=True)
    return os.path.join(adir, f"{sid}.json")

@app.route("/skills/list", methods=["POST"])
def skills_list():
    data = request.get_json() or {}
    agent = (data.get("agent") or "").strip()
    query = (data.get("query") or "").lower()
    result = []
    if agent:
        adir = os.path.join(_SKILLSDIR, agent.replace('/', '_').replace('..', ''))
        if os.path.isdir(adir):
            for fname in sorted(os.listdir(adir)):
                if fname.endswith('.json'):
                    try:
                        with open(os.path.join(adir, fname), 'r') as f:
                            sk = json.load(f)
                        if query and query not in sk.get('name', '').lower() and query not in sk.get('content', '').lower():
                            continue
                        result.append({"id": sk['id'], "name": sk['name'], "agent": sk['agent'], "created_at": sk.get('created_at', '')})
                    except Exception:
                        pass
    else:
        for root, dirs, files in os.walk(_SKILLSDIR):
            for fname in files:
                if fname.endswith('.json'):
                    try:
                        with open(os.path.join(root, fname), 'r') as f:
                            sk = json.load(f)
                        if query and query not in sk.get('name', '').lower() and query not in sk.get('content', '').lower():
                            continue
                        result.append({"id": sk['id'], "name": sk['name'], "agent": sk['agent'], "created_at": sk.get('created_at', '')})
                    except Exception:
                        pass
    return jsonify({"skills": result})

@app.route("/skills/read", methods=["POST"])
def skills_read():
    data = request.get_json() or {}
    agent = (data.get("agent") or "").strip()
    sid = (data.get("id") or "").strip()
    if not agent or not sid:
        return jsonify({"error": "agent 和 id 不能为空"}), 400
    fp = _skill_path(agent, sid)
    if not os.path.exists(fp):
        return jsonify({"error": "技能不存在"}), 404
    with open(fp, 'r') as f:
        return jsonify(json.load(f))

@app.route("/skills/create", methods=["POST"])
def skills_create():
    data = request.get_json() or {}
    agent = (data.get("agent") or "").strip()
    name = (data.get("name") or "").strip()
    content = (data.get("content") or "").strip()
    if not agent or not name:
        return jsonify({"ok": False, "error": "agent 和 name 不能为空"})
    sid = str(uuid.uuid4())[:8]
    sk = {
        "id": sid, "name": name, "agent": agent,
        "content": content, "created_at": datetime.now().isoformat()
    }
    with open(_skill_path(agent, sid), 'w') as f:
        json.dump(sk, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "id": sid})

@app.route("/skills/delete", methods=["POST"])
def skills_delete():
    data = request.get_json() or {}
    agent = (data.get("agent") or "").strip()
    sid = (data.get("id") or "").strip()
    if not agent or not sid:
        return jsonify({"ok": False, "error": "agent 和 id 不能为空"})
    fp = _skill_path(agent, sid)
    if os.path.exists(fp):
        os.remove(fp)
    return jsonify({"ok": True})


# ── 工具适配器 (/api/*) ──
def _available_tools():
    """检测本地可用的命令行工具"""
    tools = {}
    check_list = [
        ("python3", "Python 3", "dnf install python3"),
        ("git", "Git", "dnf install git"),
        ("curl", "cURL", "dnf install curl"),
        ("ffmpeg", "FFmpeg", "dnf install ffmpeg"),
        ("node", "Node.js", "dnf install nodejs"),
        ("sqlite3", "SQLite", "dnf install sqlite"),
        ("pandoc", "Pandoc", "dnf install pandoc"),
        ("jq", "jq (JSON processor)", "dnf install jq"),
        ("unzip", "unzip", "dnf install unzip"),
        ("tree", "tree", "dnf install tree"),
    ]
    for cmd, desc, hint in check_list:
        found = False
        path = ""
        for p in [f"/usr/bin/{cmd}", f"/usr/local/bin/{cmd}", f"/bin/{cmd}"]:
            if os.path.exists(p) and os.access(p, os.X_OK):
                found = True
                path = p
                break
        tools[cmd] = {"available": found, "path": path, "description": desc, "install_hint": hint if not found else ""}
    return tools

@app.route("/api/check_env", methods=["GET"])
def api_check_env():
    return jsonify(_available_tools())

@app.route("/api/presets", methods=["GET"])
def api_presets():
    tool = request.args.get("tool", "")
    presets_db = {
        "curl": {
            "get": {"label": "GET 请求", "desc": "发送 GET 请求获取网页内容",
                    "params": [{"key": "url", "label": "URL", "placeholder": "https://example.com"}]},
            "post_json": {"label": "POST JSON", "desc": "发送带 JSON 数据的 POST 请求",
                          "params": [{"key": "url", "label": "URL", "placeholder": "https://api.example.com"},
                                     {"key": "data", "label": "JSON 数据", "placeholder": '{"key":"value"}'}]},
            "download": {"label": "下载文件", "desc": "下载文件到本地",
                         "params": [{"key": "url", "label": "文件链接", "placeholder": "https://example.com/file.zip"}]},
        },
        "git": {
            "clone": {"label": "克隆仓库", "desc": "克隆远程 Git 仓库",
                      "params": [{"key": "url", "label": "仓库地址", "placeholder": "https://github.com/user/repo.git"}]},
            "status": {"label": "查看状态", "desc": "查看当前仓库文件变更状态"},
            "log": {"label": "提交记录", "desc": "查看最近提交历史"},
        },
        "ffmpeg": {
            "convert": {"label": "格式转换", "desc": "转换视频/音频格式",
                        "params": [{"key": "input", "label": "输入文件", "placeholder": "input.mp4"},
                                   {"key": "output", "label": "输出文件", "placeholder": "output.avi"}]},
        },
        "python3": {
            "script": {"label": "运行脚本", "desc": "执行 Python 脚本",
                       "params": [{"key": "file", "label": "脚本路径", "placeholder": "script.py"}]},
            "eval": {"label": "单行代码", "desc": "执行一行 Python 代码",
                     "params": [{"key": "code", "label": "Python 代码", "placeholder": "print('hello')"}]},
        },
        "node": {
            "script": {"label": "运行脚本", "desc": "执行 Node.js 脚本",
                       "params": [{"key": "file", "label": "脚本路径", "placeholder": "app.js"}]},
        },
        "sqlite3": {
            "query": {"label": "SQL 查询", "desc": "对数据库执行查询",
                      "params": [{"key": "db", "label": "数据库文件", "placeholder": "data.db"},
                                 {"key": "sql", "label": "SQL 语句", "placeholder": "SELECT * FROM users;"}]},
        },
        "pandoc": {
            "convert": {"label": "文档转换", "desc": "转换文档格式",
                        "params": [{"key": "input", "label": "输入文件", "placeholder": "input.md"},
                                   {"key": "output", "label": "输出文件", "placeholder": "output.docx"}]},
        },
        "jq": {
            "filter": {"label": "JSON 过滤", "desc": "用 jq 表达式过滤 JSON",
                       "params": [{"key": "file", "label": "JSON 文件", "placeholder": "data.json"},
                                  {"key": "expr", "label": "表达式", "placeholder": ".[].name"}]},
        },
    }
    return jsonify(presets_db.get(tool, {}))

@app.route("/api/run", methods=["POST"])
def api_run():
    data = request.get_json() or {}
    tool = (data.get("tool") or "").strip()
    command = (data.get("command") or "").strip()
    if not command:
        return jsonify({"stdout": "", "stderr": "命令不能为空", "command": "", "returncode": -1})
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
        return jsonify({
            "stdout": result.stdout[:5000],
            "stderr": result.stderr[:5000],
            "command": command,
            "returncode": result.returncode,
        })
    except subprocess.TimeoutExpired:
        return jsonify({"stdout": "", "stderr": "执行超时 (30s)", "command": command, "returncode": -1})
    except Exception as e:
        return jsonify({"stdout": "", "stderr": str(e), "command": command, "returncode": -1})

# ── 文件预览（适配前端 /read-file 响应格式）──
@app.route("/read-file", methods=["POST"])
def read_file_v2():
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"ok": False, "error": "路径不能为空"})
    real = os.path.realpath(path)
    if not real.startswith(_ALLOWED_BASE):
        return jsonify({"ok": False, "error": "禁止访问该路径"})
    if not os.path.isfile(real):
        return jsonify({"ok": False, "error": "不是文件"})
    name = os.path.basename(real)
    ext = os.path.splitext(real)[1].lower()
    size = os.path.getsize(real)
    max_size = data.get("max_size", 200 * 1024)
    if size > max_size:
        return jsonify({"ok": False, "error": f"文件过大 ({size//1024}KB > {max_size//1024}KB)"})
    text_exts = {'.txt','.md','.py','.js','.json','.xml','.yaml','.yml','.html','.css','.csv',
                 '.sh','.bat','.cfg','.ini','.toml','.log','.c','.cpp','.h','.java','.rs','.go',
                 '.ts','.tsx','.jsx','.vue','.sql','.r','.m','.swift','.kt','.scala','.rb','.php',
                 '.env','.gitignore','.dockerignore','.editorconfig'}
    is_text = ext in text_exts or (name.startswith('.') and '.' not in name[1:]) or name in ('Makefile','Dockerfile','README','LICENSE')
    try:
        if is_text:
            with open(real, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            return jsonify({"ok": True, "type": "text", "path": real, "name": name, "size": size,
                            "content": content, "lines": content.count('\n') + 1})
        else:
            return jsonify({"ok": True, "type": "binary", "path": real, "name": name, "size": size, "ext": ext})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

# ── Git 版本回滚 ──
@app.route("/git-log", methods=["GET"])
def git_log():
    try:
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "log", "--oneline", "-15", "--format=%h|%s|%ai"],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(os.path.abspath(__file__))
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

@app.route("/git-status", methods=["GET", "POST"])
def git_status():
    try:
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(os.path.abspath(__file__))
        )
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.strip()})
        changes = [l.strip() for l in r.stdout.strip().split('\n') if l.strip()]
        return jsonify({"ok": True, "changes": changes, "dirty": len(changes) > 0})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/git-revert", methods=["POST"])
def git_revert():
    data = request.get_json(silent=True) or {}
    target = data.get("hash", "").strip()
    if not target:
        return jsonify({"ok": False, "error": "缺少目标 commit hash"})
    try:
        subprocess.run(["/home/marvis/local/bin/git", "stash", "push", "-u", "-m", "auto-stash-before-revert"],
                       capture_output=True, timeout=10,
                       cwd=os.path.dirname(os.path.abspath(__file__)))
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "reset", "--hard", target],
            capture_output=True, text=True, timeout=10,
            cwd=os.path.dirname(os.path.abspath(__file__))
        )
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.strip()})
        r2 = subprocess.run(
            ["/home/marvis/local/bin/git", "log", "--oneline", "-1", "--format=%h %s"],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(os.path.abspath(__file__))
        )
        return jsonify({"ok": True, "reset_to": r2.stdout.strip(), "stashed": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/git-revert-restore", methods=["POST"])
def git_revert_restore():
    try:
        r = subprocess.run(
            ["/home/marvis/local/bin/git", "stash", "list"],
            capture_output=True, text=True, timeout=5,
            cwd=os.path.dirname(os.path.abspath(__file__))
        )
        if not r.stdout.strip():
            return jsonify({"ok": False, "error": "没有可恢复的 stash"})
        subprocess.run(["/home/marvis/local/bin/git", "stash", "pop"], capture_output=True, timeout=10,
                       cwd=os.path.dirname(os.path.abspath(__file__)))
        return jsonify({"ok": True, "message": "已恢复回滚前状态"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

if __name__ == "__main__":
    print("玄姝多Agent API → http://0.0.0.0:8901")
    app.run(host="0.0.0.0", port=8901, debug=False)
