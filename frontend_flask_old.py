"""Flask前端 - 扣子风格 父Bot+子Agent架构"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, request, jsonify, render_template_string
from core import ParentBot
from models import ModelPool

app = Flask(__name__)
pool = ModelPool(default_key="local")
bot = ParentBot(pool=pool, verbose=False)

HTML = '''<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>扣子 多Agent</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f1a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}
.header{background:#1a1a2e;padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #2a2a4a;flex-shrink:0}
.header .logo{font-size:15px;font-weight:700;color:#7c3aed}
.header .info{font-size:11px;color:#666;margin-left:auto}
.chat{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:90%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.5;word-wrap:break-word}
.msg.user{align-self:flex-end;background:#7c3aed;color:#fff;border-bottom-right-radius:3px}
.msg.agent{align-self:flex-start;background:#1a1a2e;color:#ccc;border:1px solid #2a2a4a;border-bottom-left-radius:3px}
.msg.system{align-self:center;background:transparent;color:#555;font-size:11px;padding:3px 8px}
.agent-tag{font-size:10px;color:#7c3aed;margin-bottom:3px;font-weight:600}
.input-area{display:flex;padding:10px 12px;gap:8px;background:#1a1a2e;border-top:1px solid #2a2a4a;flex-shrink:0}
.input-area input{flex:1;padding:8px 12px;border-radius:16px;border:1px solid #2a2a4a;background:#0f0f1a;color:#e0e0e0;font-size:13px;outline:none}
.input-area input:focus{border-color:#7c3aed}
.input-area button{padding:8px 16px;border-radius:16px;border:none;background:#7c3aed;color:#fff;font-size:13px;cursor:pointer;white-space:nowrap}
.input-area button:active{opacity:.8}
.loading{align-self:flex-start;display:flex;align-items:center;gap:6px;padding:8px 12px}
.loading span{width:6px;height:6px;background:#7c3aed;border-radius:50%;animation:bounce 1.4s infinite ease-in-out}
.loading span:nth-child(2){animation-delay:.2s}
.loading span:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}
</style>
</head>
<body>
<div class="header">
<span class="logo">父Bot → 子Agent</span>
<span class="info" id="info">本地模拟</span>
</div>
<div class="chat" id="chat">
<div class="msg system">/help 查看命令 | /agents 查看子Agent</div>
</div>
<div class="input-area">
<input id="input" placeholder="输入消息..." autofocus onkeydown="if(event.key==='Enter')send()">
<button onclick="send()">发送</button>
</div>
<script>
async function send(){
  const inp=document.getElementById("input");
  const text=inp.value.trim();
  if(!text)return;
  inp.value="";
  addMsg("user",text);
  const loading=addLoading();
  try{
    const r=await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({msg:text})});
    const d=await r.json();
    loading.remove();
    if(d.cmd) addMsg("system",d.reply.replace(/\n/g,"<br>"));
    else addMsg("agent",d.reply,d.agent);
    document.getElementById("info").textContent=d.model||"本地模拟";
  }catch(e){loading.remove();addMsg("system","请求失败")}
}
function addMsg(role,content,agentName){
  const d=document.createElement("div");
  d.className="msg "+role;
  if(agentName) d.innerHTML=`<div class="agent-tag">${agentName} →</div>${content}`;
  else d.innerHTML=content;
  document.getElementById("chat").appendChild(d);
  d.scrollIntoView({behavior:"smooth"});
}
function addLoading(){
  const d=document.createElement("div");
  d.className="loading";
  d.innerHTML="<span></span><span></span><span></span>";
  document.getElementById("chat").appendChild(d);
  d.scrollIntoView({behavior:"smooth"});
  return d;
}
</script>
</body>
</html>'''


@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/chat", methods=["POST"])
def chat():
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


def _cmd(action, arg):
    if action == "/help":
        return "命令: /model [编号|别名] | /new | /status | /agents | /mem | /kb"
    if action == "/new":
        bot.reset()
        return "新对话已开始"
    if action == "/status":
        return bot.status()
    if action == "/agents":
        lines = []
        for name, child in bot.children.items():
            m = pool.get_model(name)
            s = child.memory.get_stats()
            lines.append(f"{name}: {m.name} | 插件:{len(child.tools)} | 记忆:{s['短期记忆']}短")
        return "\n".join(lines)
    if action == "/model":
        if not arg or arg == "list":
            return pool.table()
        resolved = pool.resolve(arg)
        if resolved:
            pool.set_default(resolved)
            return f"已切换: {resolved}"
        return f"未找到: {arg}"
    if action == "/mem":
        lines = []
        for name, child in bot.children.items():
            ctx = child.memory.to_context(5)
            if ctx:
                lines.append(ctx)
        return "\n".join(lines) or "无记忆"
    if action == "/kb":
        lines = []
        for name, child in bot.children.items():
            if child.knowledge:
                lines.append(f"[{name}]:")
                for k in child.knowledge:
                    lines.append(f"  - {k[:80]}")
        return "\n".join(lines) or "知识库为空"
    return f"未知命令: {action}"


def _model():
    return pool.get_model("搜索Agent").name


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=False)
