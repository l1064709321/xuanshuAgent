"""玄姝多Agent API — Flask 后端 + 前端托管，单端口 8900"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, request, jsonify, send_file
from core import ParentBot
from models import ModelPool

app = Flask(__name__, static_folder=".", static_url_path="")

@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS,DELETE"
    return resp

pool = ModelPool(default_key="local")
bot = ParentBot(pool=pool, verbose=False)

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
    return jsonify({"models": models, "providers": pool.providers()})

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

    if msg.startswith("/"):
        parts = msg.split(maxsplit=1)
        action = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""
        return jsonify({"reply": _cmd(action, arg), "cmd": True, "model": _model()})

    agent_name = bot._route(msg)
    reply = bot.chat(msg)
    return jsonify({"reply": reply, "agent": agent_name, "model": _model()})

# ── 命令 ──
def _cmd(action, arg):
    cmds = {
        "/help":   "命令: /model [编号|别名] | /new | /status | /agents | /mem | /kb",
        "/new":    (bot.reset(), "新对话已开始")[1],
        "/status": bot.status(),
        "/agents": "\n".join(
            f"{n}: {pool.get_model(n).name} | 插件:{len(c.tools)} | 记忆:{c.memory.get_stats()['短期记忆']}短"
            for n, c in bot.children.items()
        ),
        "/model":  _model_cmd(arg),
        "/mem":    "\n".join(c.memory.to_context(5) for c in bot.children.values() if c.memory.to_context(5)) or "无记忆",
        "/kb":     "\n".join(
            f"[{n}]:\n" + "\n".join(f"  - {k[:80]}" for k in c.knowledge)
            for n, c in bot.children.items() if c.knowledge
        ) or "知识库为空",
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


if __name__ == "__main__":
    print("扣子多Agent API → http://0.0.0.0:8900")
    app.run(host="0.0.0.0", port=8900, debug=False)
