"""最小静态服务器 — 只跑前端页面，不依赖 openai 等"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, send_file, jsonify, request

app = Flask(__name__, static_folder=".", static_url_path="")

@app.route("/")
def index():
    return send_file("index.html")

@app.route("/models", methods=["GET"])
def list_models():
    return jsonify({"models": [], "providers": [], "current_model": "local"})

@app.route("/model-key/status", methods=["GET"])
def model_key_status():
    return jsonify({"keys": {}, "current_model": "local"})

@app.route("/agents", methods=["GET"])
def list_agents():
    return jsonify({"agents": []})

@app.route("/context", methods=["GET"])
def get_context():
    return jsonify({"ok": True, "shared_msgs": [], "agent_contexts": {}, "context_summary": "", "coordinator_mode": True})

@app.route("/context/save", methods=["POST", "OPTIONS"])
def save_context():
    if request.method == "OPTIONS":
        return jsonify({})
    return jsonify({"ok": True})

@app.route("/workflow/list", methods=["GET"])
def workflow_list():
    return jsonify({"ok": True, "workflows": [], "available_actions": {}})

@app.route("/metrics", methods=["GET"])
def get_metrics():
    return jsonify({"uptime_seconds": 0, "total_messages": 0})

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": "local", "agents": 0})

@app.route("/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return jsonify({})
    data = request.get_json() or {}
    msg = data.get("msg", "")
    # 返回模拟的思考链数据供前端预览
    mock_thinking = [
        {"tool": "anysearch", "thought": "用户发送了消息，我先搜索相关信息获取上下文。", "round": 1},
        {"tool": "web_fetch, read_file", "thought": "搜索结果有3条相关，抓取详情页获取完整内容。同时读取本地配置文件确认参数。", "round": 2},
        {"tool": "run_code", "thought": "信息足够了，编写代码处理数据并验证结果。", "round": 3},
    ]
    return jsonify({
        "reply": f"收到你的消息：「{msg}」\n\n这是模拟回复。完整后端需要安装 openai 依赖后启动。\n当前为纯前端预览模式，思考链数据为模拟数据。",
        "thinking": mock_thinking,
        "agent": "搜索Agent",
        "model": "Preview Mode",
        "coordinator_mode": True,
    })

@app.route("/auth/send-code", methods=["POST"])
def auth_send_code():
    return jsonify({"ok": True, "message": "预览模式，无需验证码", "mock": True, "code": "000000"})

@app.route("/auth/register", methods=["POST"])
def auth_register():
    return jsonify({"ok": True, "user_id": 1, "phone": "00000000000", "token": "preview-token"})

@app.route("/auth/login", methods=["POST"])
def auth_login():
    return jsonify({"ok": True, "user_id": 1, "phone": "00000000000", "token": "preview-token"})

@app.route("/auth/me", methods=["GET"])
def auth_me():
    return jsonify({"ok": True, "user": {"id": 1, "phone": "00000000000"}})

@app.route("/set-key", methods=["POST", "OPTIONS"])
def set_key():
    if request.method == "OPTIONS":
        return jsonify({})
    return jsonify({"ok": True, "model": "Preview Mode"})

@app.route("/switch-model", methods=["POST", "OPTIONS"])
def switch_model():
    if request.method == "OPTIONS":
        return jsonify({})
    return jsonify({"ok": True, "model": "local", "name": "Preview", "has_key": False})

# 通配：其他 API 路径返回空
@app.route("/api/<path:path>", methods=["GET", "POST"])
def api_catchall(path):
    return jsonify({"ok": True, "preview": True})

@app.route("/workspace/list", methods=["POST"])
def workspace_list():
    return jsonify({"ok": True, "entries": []})

@app.route("/skills/list", methods=["POST"])
def skills_list():
    return jsonify({"skills": []})

@app.route("/memory/list", methods=["GET"])
def memory_list():
    return jsonify({"ok": True, "entries": []})

@app.route("/bind-model", methods=["GET"])
def bind_model():
    return jsonify({"bindings": {}, "default": "local"})

@app.route("/coordinator-mode", methods=["POST", "OPTIONS"])
def coordinator_mode():
    if request.method == "OPTIONS":
        return jsonify({})
    return jsonify({"ok": True, "coordinator_mode": True})

if __name__ == "__main__":
    print("✦ 玄姝前端预览模式 — http://0.0.0.0:8901")
    print("  思考链数据为模拟数据，用于检查 UI 渲染")
    app.run(host="0.0.0.0", port=8901, debug=False)
