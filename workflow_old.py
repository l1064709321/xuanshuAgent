"""
工作流引擎 —— 自动化规则
当用户消息匹配触发条件时，自动执行预设的动作链。
"""
import os, json, time, re
from typing import Optional

_WF_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")
os.makedirs(_WF_DIR, exist_ok=True)

AVAILABLE_ACTIONS = {
    "web_search": {"label": "联网搜索", "params": {"query": "string"}},
    "ai_summary": {"label": "AI 总结分析", "params": {"prompt": "string"}},
    "write_file": {"label": "写入文件", "params": {"filename": "string", "content": "string"}},
    "notify": {"label": "发送通知", "params": {"message": "string"}},
}


def _file_path(wf_id: str) -> str:
    safe = wf_id.replace("/", "_").replace("..", "_")
    return os.path.join(_WF_DIR, f"{safe}.json")


def list_workflows() -> list:
    """列出所有工作流规则"""
    result = []
    for fn in sorted(os.listdir(_WF_DIR)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(_WF_DIR, fn), "r") as f:
                wf = json.load(f)
            result.append({
                "id": wf["id"],
                "name": wf.get("name", ""),
                "enabled": wf.get("enabled", True),
                "trigger": wf.get("trigger", {}),
                "steps": wf.get("steps", []),
                "created_at": wf.get("created_at", ""),
                "updated_at": wf.get("updated_at", ""),
            })
        except Exception:
            pass
    return result


def create_workflow(name: str, trigger: dict, steps: list, enabled: bool = True) -> dict:
    """创建新的工作流规则"""
    wf_id = f"wf_{int(time.time() * 1000)}"
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    wf = {
        "id": wf_id,
        "name": name,
        "enabled": enabled,
        "trigger": trigger,
        "steps": steps,
        "created_at": now,
        "updated_at": now,
    }
    with open(_file_path(wf_id), "w") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
    return wf


def update_workflow(wf_id: str, updates: dict) -> Optional[dict]:
    """更新工作流"""
    path = _file_path(wf_id)
    if not os.path.exists(path):
        return None
    with open(path, "r") as f:
        wf = json.load(f)
    for k in ("name", "enabled", "trigger", "steps"):
        if k in updates:
            wf[k] = updates[k]
    wf["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(path, "w") as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
    return wf


def delete_workflow(wf_id: str) -> bool:
    """删除工作流"""
    path = _file_path(wf_id)
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def match_trigger(wf: dict, user_message: str) -> bool:
    """检查用户消息是否匹配触发条件"""
    trigger = wf.get("trigger", {})
    if not trigger:
        return False

    msg = user_message.strip()
    if not msg:
        return False

    ttype = trigger.get("type", "keyword")

    if ttype == "keyword":
        keywords = trigger.get("keywords", [])
        if not keywords:
            return False
        mode = trigger.get("mode", "any")  # any / all
        lower_msg = msg.lower()
        if mode == "all":
            return all(kw.lower() in lower_msg for kw in keywords)
        return any(kw.lower() in lower_msg for kw in keywords)

    elif ttype == "regex":
        pattern = trigger.get("pattern", "")
        if not pattern:
            return False
        try:
            return bool(re.search(pattern, msg))
        except re.error:
            return False

    elif ttype == "prefix":
        prefix = trigger.get("prefix", "")
        if not prefix:
            return False
        return msg.startswith(prefix)

    return False


def find_matching_workflows(user_message: str) -> list:
    """查找所有匹配当前消息的已启用工作流"""
    matches = []
    for wf in list_workflows():
        if not wf.get("enabled", True):
            continue
        if match_trigger(wf, user_message):
            matches.append(wf)
    return matches
