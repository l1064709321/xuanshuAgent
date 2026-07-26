"""玄姝多Agent API — Flask 后端 + 前端托管，单端口"""
import os, sys, json, mimetypes, base64, subprocess, signal, time, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, request, jsonify, send_file
from core import ParentBot
from models import ModelPool
from auth import send_sms, generate_code, store_code, verify_code, check_sms_rate, set_sms_rate, user_register, user_login, get_user_from_request
from config import config
import structured_logger as slog

app = Flask(__name__, static_folder=".", static_url_path="")

# ── 全局异常捕获（输出 traceback）──
import traceback as _tb
@app.errorhandler(Exception)
def _global_error_handler(e):
    _tb.print_exc()
    return jsonify({"error": str(e), "traceback": _tb.format_exc()}), 500

# ── 记忆文件夹路径 ──
_MEMDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".memdir")
os.makedirs(_MEMDIR, exist_ok=True)
_ALLOWED_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_WORKSPACE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workspace_files")
os.makedirs(_WORKSPACE_DIR, exist_ok=True)

# ── 限流器 ──
class RateLimiter:
    def __init__(self, per_minute, burst):
        self.rate = per_minute / 60.0
        self.burst = burst
        self.tokens = collections.defaultdict(lambda: burst)
        self.last = collections.defaultdict(float)

    def allow(self, key: str) -> bool:
        now = time.time()
        elapsed = now - self.last[key]
        self.tokens[key] = min(self.burst, self.tokens[key] + elapsed * self.rate)
        self.last[key] = now
        if self.tokens[key] >= 1:
            self.tokens[key] -= 1
            return True
        return False

_rl = RateLimiter(config.RL_CHAT_PER_MIN, config.RL_CHAT_BURST)

# ── 请求级结构化日志（含 trace_id）──
@app.before_request
def _before_request():
    slog.set_trace_id()
    request._start_ms = time.time()
    slog.request_start(request.method, request.path,
                       client_ip=request.headers.get("X-Forwarded-For", request.remote_addr or "-"))

@app.after_request
def _after_request(resp):
    elapsed = (time.time() - getattr(request, "_start_ms", time.time())) * 1000
    slog.request_end(resp.status_code, elapsed)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS,DELETE"
    return resp

# ── 优雅停机 ──
_shutdown_flag = False

def _handle_shutdown(signum, frame):
    global _shutdown_flag
    slog.warn("shutdown_signal", signal=signum)
    _shutdown_flag = True

signal.signal(signal.SIGTERM, _handle_shutdown)
signal.signal(signal.SIGINT, _handle_shutdown)

pool = ModelPool(default_key="_custom_agnes")

# 启动时自动注册 Agnes 模型
pool.add_custom(
    name="Agnes",
    model_id="agnes-2.0-flash",
    base_url="https://apihub.agnes-ai.com/v1",
    provider="自定义",
)
pool.set_model_key(
    "_custom_agnes",
    "sk-LWNIQDlVgf3EBfr2JaQ1zRYcPQoF2YtUOIqLjOrlp5Pd3Eh0",
)
pool.set_default("_custom_agnes")

bot = ParentBot(pool=pool, verbose=False, coordinator_mode=True)

# ── 账号系统 ──
@app.route("/auth/send-code", methods=["POST"])
def auth_send_code():
    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    if not phone or not phone.isdigit() or len(phone) != 11:
        return jsonify({"ok": False, "error": "请输入正确的11位手机号"})
    wait = check_sms_rate(phone)
    if wait > 0:
        return jsonify({"ok": False, "error": f"发送太频繁，请{wait}秒后再试"})
    code = generate_code()
    store_code(phone, code)
    set_sms_rate(phone)
    result = send_sms(phone, code)
    if result.get("mock"):
        return jsonify({"ok": True, "message": f"验证码已发送（模拟模式）", "mock": True, "code": code})
    if result.get("ok"):
        return jsonify({"ok": True, "message": "验证码已发送"})
    return jsonify({"ok": False, "error": result.get("error", "发送失败")})

@app.route("/auth/register", methods=["POST"])
def auth_register():
    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    password = (data.get("password") or "").strip()
    code = (data.get("code") or "").strip()
    if not phone or len(phone) != 11:
        return jsonify({"ok": False, "error": "请输入正确的手机号"})
    if len(password) < 6:
        return jsonify({"ok": False, "error": "密码至少6位"})
    if len(code) != 6:
        return jsonify({"ok": False, "error": "请输入6位验证码"})
    return jsonify(user_register(phone, password, code))

@app.route("/auth/login", methods=["POST"])
def auth_login():
    data = request.get_json() or {}
    phone = (data.get("phone") or "").strip()
    password = (data.get("password") or "").strip()
    if not phone or not password:
        return jsonify({"ok": False, "error": "手机号和密码不能为空"})
    return jsonify(user_login(phone, password))

@app.route("/auth/me", methods=["GET"])
def auth_me():
    user = get_user_from_request()
    if not user:
        return jsonify({"ok": False, "error": "未登录"})
    return jsonify({"ok": True, "user": {"id": user["uid"], "phone": user["phone"]}})

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
    try:
        pool.remove_custom(key)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
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
    # 支持通过模型名称（非 key）查找自定义模型
    resolved = model_key
    if model_key not in pool.all_models:
        for k, v in pool.all_models.items():
            if v.name == model_key or v.model_id == model_key:
                resolved = k
                break
    model_key = resolved
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

# ── Agent-模型绑定 ──
@app.route("/bind-model", methods=["POST", "OPTIONS"])
def bind_model():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    agent = data.get("agent", "").strip()
    model_key = data.get("model", "").strip()
    if not agent or not model_key:
        return jsonify({"ok": False, "error": "agent 和 model 必填"})
    if model_key not in pool.all_models:
        return jsonify({"ok": False, "error": f"未知模型: {model_key}"})
    pool.bind(agent, model_key)
    return jsonify({"ok": True, "agent": agent, "model": model_key})

@app.route("/bind-model", methods=["GET"])
def list_bindings():
    """列出所有 Agent 的模型绑定"""
    bindings = {a: pool.get_key(a) for a in bot.children}
    return jsonify({"bindings": bindings, "default": pool.default_key})

@app.route("/unbind-model", methods=["POST", "OPTIONS"])
def unbind_model():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json()
    agent = data.get("agent", "").strip()
    if not agent:
        return jsonify({"ok": False, "error": "agent 必填"})
    pool.unbind(agent)
    return jsonify({"ok": True, "agent": agent})

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
    client_key = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")
    if not _rl.allow(client_key):
        slog.warn("rate_limited", client_ip=client_key, path="/chat")
        return jsonify({"reply": "请求太频繁，请稍后再试", "rate_limited": True}), 429
    data = request.get_json()
    msg = data.get("msg", "")
    image = data.get("image", None)
    model = data.get("model", None)
    new_session = data.get("new_session", False)

    if msg.startswith("/"):
        parts = msg.split(maxsplit=1)
        action = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""
        # /screen 及所有权限命令交给 core 层处理（Agent 自主权限判断），不走 _cmd 路由
        if action == "/screen" or arg in ("allow", "deny"):
            result = bot.chat(msg)
            return jsonify({"reply": result["reply"], "thinking": result.get("thinking", []), "cmd": True, "model": _model()})
        return jsonify({"reply": _cmd(action, arg), "cmd": True, "model": _model()})

    target = data.get("target_agent", None)
    agent_name = target if (target and target in bot.children) else bot._route(msg)
    result = bot.chat(msg, image, model=model, new_session=new_session, target_agent=target)
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
    client_key = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown")
    if not _rl.allow(client_key):
        slog.warn("rate_limited", client_ip=client_key, path="/chat/stream")
        return Response("data: [错误] 请求太频繁\n\n", status=429, mimetype="text/event-stream")
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

# ── 生产环境 API ──
@app.route("/trace", methods=["GET"])
def list_traces():
    """全链路追踪回放：列出最近 20 个 trace"""
    from production import trace_store
    traces = trace_store.list_recent(20)
    return jsonify({"ok": True, "traces": traces})

@app.route("/trace/<trace_id>", methods=["GET"])
def get_trace(trace_id):
    """获取某个 trace 的完整 span 详情"""
    from production import trace_store
    spans = trace_store.get_trace(trace_id)
    return jsonify({"ok": True, "trace_id": trace_id, "spans": spans})

@app.route("/eval", methods=["GET"])
def eval_summary():
    """评测框架总览"""
    from production import eval_suite
    return jsonify({"ok": True, "summary": eval_suite.summary()})

@app.route("/eval/run", methods=["POST"])
def run_eval():
    """运行评测：传入 query + expected_patterns"""
    from production import eval_suite
    data = request.get_json()
    query = data.get("query", "")
    expected = data.get("expected_patterns", [])
    if not query:
        return jsonify({"ok": False, "error": "缺少 query"})
    # 添加临时 case
    case_id = f"eval_run_{int(time.time())}"
    eval_suite.add_case(query, expected)
    # 实际执行
    result = bot.chat(query)
    reply = result.get("reply", "") if isinstance(result, dict) else str(result)
    eval_result = eval_suite.evaluate(reply, case_id)
    return jsonify({"ok": True, "case_id": case_id, **eval_result})

@app.route("/checkpoints", methods=["GET"])
def list_checkpoints():
    """列出当前 session 所有 checkpoint"""
    from production import checkpoint_mgr
    sid = getattr(bot, "_session_id", "default")
    return jsonify({"ok": True, "session_id": sid,
                    "checkpoints": checkpoint_mgr.list_checkpoints(sid)})

@app.route("/checkpoints/restore", methods=["POST"])
def restore_checkpoint():
    """恢复到指定 checkpoint"""
    from production import checkpoint_mgr
    data = request.get_json()
    ckpt_id = data.get("checkpoint_id", "")
    if not ckpt_id:
        return jsonify({"ok": False, "error": "缺少 checkpoint_id"})
    sid = getattr(bot, "_session_id", "default")
    state = checkpoint_mgr.restore(sid, ckpt_id)
    if not state:
        return jsonify({"ok": False, "error": "checkpoint 不存在"})
    # 恢复 shared_msgs
    bot.shared_msgs = state.get("shared_msgs", [])
    bot._context_summary = state.get("context_summary", "")
    bot._agent_contexts = state.get("agent_contexts", {})
    return jsonify({"ok": True, "restored": True,
                    "rounds": len(bot.shared_msgs) // 2})

@app.route("/token-budget", methods=["GET"])
def token_budget():
    """Token 预算查询"""
    from production import session_mgr
    sid = getattr(bot, "_session_id", "default")
    budget = getattr(bot, "_token_budget", None)
    if not budget:
        return jsonify({"ok": False, "error": "Token budget 未初始化"})
    return jsonify({"ok": True, "used": budget.remaining(), "limit": budget.daily_limit,
                    "remaining": budget.remaining()})

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

# ── 工作区文件管理（用户上传的文件，隔离在 workspace_files/）──

@app.route("/workspace/list", methods=["POST"])
def workspace_list():
    """列出 workspace_files 下的文件（仅一层，不支持子目录）"""
    entries = []
    try:
        for name in sorted(os.listdir(_WORKSPACE_DIR)):
            full = os.path.join(_WORKSPACE_DIR, name)
            if not os.path.isfile(full):
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                size = 0
            mtime = int(os.path.getmtime(full) * 1000)
            entries.append({
                "name": name,
                "path": full,
                "size": size,
                "mtime": mtime
            })
    except PermissionError:
        return jsonify({"ok": False, "error": "无权限访问"})
    return jsonify({"ok": True, "path": _WORKSPACE_DIR, "entries": entries})

@app.route("/workspace/upload", methods=["POST"])
def workspace_upload():
    """接收用户上传的文件，写入 workspace_files/"""
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "未选择文件"})
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "文件名为空"})
    # 防止路径穿越
    safe_name = os.path.basename(f.filename)
    if not safe_name:
        return jsonify({"ok": False, "error": "无效文件名"})
    dest = os.path.join(_WORKSPACE_DIR, safe_name)
    f.save(dest)
    size = os.path.getsize(dest)
    return jsonify({"ok": True, "name": safe_name, "path": dest, "size": size})

@app.route("/workspace/upload-batch", methods=["POST"])
def workspace_upload_batch():
    """批量上传多个文件"""
    if "files" not in request.files:
        return jsonify({"ok": False, "error": "未选择文件"})
    uploaded = []
    for f in request.files.getlist("files"):
        if not f.filename:
            continue
        safe_name = os.path.basename(f.filename)
        if not safe_name:
            continue
        dest = os.path.join(_WORKSPACE_DIR, safe_name)
        f.save(dest)
        uploaded.append({"name": safe_name, "path": dest, "size": os.path.getsize(dest)})
    return jsonify({"ok": True, "uploaded": uploaded})

@app.route("/workspace/read", methods=["POST"])
def workspace_read():
    """读取工作区文件内容"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "文件名不能为空"})
    safe_name = os.path.basename(name)
    real = os.path.realpath(os.path.join(_WORKSPACE_DIR, safe_name))
    if not real.startswith(_WORKSPACE_DIR):
        return jsonify({"ok": False, "error": "禁止访问"})
    if not os.path.isfile(real):
        return jsonify({"ok": False, "error": "文件不存在"})
    size = os.path.getsize(real)
    text_exts = {
        ".py", ".md", ".yaml", ".yml", ".toml", ".cfg", ".ini",
        ".txt", ".log", ".json", ".js", ".ts", ".jsx", ".tsx",
        ".css", ".html", ".xml", ".sh", ".bash", ".env", ".gitignore",
        ".csv", ".c", ".cpp", ".h", ".java", ".rs", ".go", ".vue",
        ".sql", ".r", ".m", ".swift", ".kt", ".rb", ".php"
    }
    ext = os.path.splitext(real)[1].lower()
    is_text = ext in text_exts
    if is_text or size < 50 * 1024:
        try:
            with open(real, "r", encoding="utf-8", errors="replace") as f:
                content = f.read(50000)
            return jsonify({"ok": True, "path": real, "name": safe_name,
                            "content": content, "size": size, "lines": content.count("\n") + 1})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})
    return jsonify({"ok": True, "path": real, "name": safe_name,
                    "type": "binary", "size": size, "ext": ext})

@app.route("/workspace/delete", methods=["POST"])
def workspace_delete():
    """删除工作区文件"""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "文件名不能为空"})
    safe_name = os.path.basename(name)
    real = os.path.realpath(os.path.join(_WORKSPACE_DIR, safe_name))
    if not real.startswith(_WORKSPACE_DIR):
        return jsonify({"ok": False, "error": "禁止访问"})
    if not os.path.isfile(real):
        return jsonify({"ok": False, "error": "文件不存在"})
    os.remove(real)
    return jsonify({"ok": True, "deleted": safe_name})

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
    ov = getattr(bot, '_model_override', '') or ''
    if ov and ov in pool.all_models:
        return pool.all_models[ov].name
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

# ── 文件预览（适配前端 /read-file 响应格式，仅限工作区）──
@app.route("/read-file", methods=["POST"])
def read_file_v2():
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"ok": False, "error": "路径不能为空"})
    real = os.path.realpath(path)
    if not real.startswith(_WORKSPACE_DIR):
        return jsonify({"ok": False, "error": "只能预览工作区文件"})
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

# ── 工作流（自动化规则）──
from workflow import list_workflows, create_workflow, update_workflow, delete_workflow, AVAILABLE_ACTIONS, get_metrics, reset_metrics

@app.route("/workflow/list", methods=["GET"])
def workflow_list():
    return jsonify({"ok": True, "workflows": list_workflows(), "available_actions": AVAILABLE_ACTIONS})

@app.route("/workflow/create", methods=["POST"])
def workflow_create():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    trigger = data.get("trigger", {})
    steps = data.get("steps", [])
    enabled = data.get("enabled", True)
    if not name:
        return jsonify({"ok": False, "error": "规则名称不能为空"})
    if not trigger.get("type"):
        return jsonify({"ok": False, "error": "触发条件不能为空"})
    if not steps:
        return jsonify({"ok": False, "error": "至少需要一个执行步骤"})
    try:
        wf = create_workflow(name, trigger, steps, enabled)
        return jsonify({"ok": True, "workflow": wf})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

@app.route("/workflow/update", methods=["POST"])
def workflow_update():
    data = request.get_json() or {}
    wf_id = (data.get("id") or "").strip()
    if not wf_id:
        return jsonify({"ok": False, "error": "工作流 ID 不能为空"})
    updates = data.get("updates", {}) or {}
    wf = update_workflow(wf_id, updates)
    if wf is None:
        return jsonify({"ok": False, "error": "工作流不存在"})
    return jsonify({"ok": True, "workflow": wf})

@app.route("/workflow/delete", methods=["POST"])
def workflow_delete():
    data = request.get_json() or {}
    wf_id = (data.get("id") or "").strip()
    if not wf_id:
        return jsonify({"ok": False, "error": "工作流 ID 不能为空"})
    ok = delete_workflow(wf_id)
    return jsonify({"ok": ok})

@app.route("/workflow/metrics", methods=["GET"])
def workflow_metrics():
    return jsonify(get_metrics())

@app.route("/workflow/metrics/reset", methods=["POST"])
def workflow_metrics_reset():
    reset_metrics()
    return jsonify({"ok": True, "message": "指标已重置"})


# ── 健康检查 ──
@app.route("/health", methods=["GET"])
def health():
    """生产环境健康检查：自愈状态 + 延迟 P50/P95 + 错误率 + 基础状态"""
    from production import watchdog, health_monitor
    wh = watchdog.get_health()
    stats = health_monitor.get_stats()
    return jsonify({
        "status": "degraded" if stats["is_degraded"] else "ok",
        "model": pool.default_key,
        "agents": len(bot.children),
        **stats,
        "watchdog": wh,
    })

if __name__ == "__main__":
    print(f"玄姝多Agent API → http://{config.HOST}:{config.PORT}")
    app.run(host=config.HOST, port=config.PORT, debug=config.DEBUG)
