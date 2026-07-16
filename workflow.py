"""
工作流引擎 —— 自动化规则 + 指标统计 + 缓存层
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

# ═══════════════════════ 缓存层 ═══════════════════════
_cache = {
    "data": None,          # 缓存的规则列表
    "mtime": 0,            # 上次加载时间戳
    "ttl": 5.0,            # 缓存有效期（秒），设为 0 表示每次强制刷新
    "hits": 0,             # 缓存命中
    "misses": 0,           # 缓存未命中
}

def _dir_mtime() -> float:
    """返回 workflows 目录的最新修改时间（用于缓存失效判断）"""
    try:
        return max(
            (os.path.getmtime(os.path.join(_WF_DIR, fn))
             for fn in os.listdir(_WF_DIR) if fn.endswith(".json")),
            default=0
        )
    except Exception:
        return 0

def invalidate_cache():
    _cache["data"] = None
    _cache["mtime"] = 0

def _load_from_cache_or_disk() -> list:
    """带缓存的规则加载"""
    now = time.time()
    dirmt = _dir_mtime()

    if _cache["data"] is not None and dirmt <= _cache["mtime"] and (now - _cache["mtime"]) < _cache["ttl"]:
        _cache["hits"] += 1
        return _cache["data"]

    _cache["misses"] += 1
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
    _cache["data"] = result
    _cache["mtime"] = now
    return result

# ═══════════════════════ 指标统计 ═══════════════════════
_metrics = {
    "total_messages": 0,       # 总处理消息数
    "total_matches": 0,        # 匹配到的规则总次数（跨消息累加）
    "matched_messages": 0,     # 至少命中一条规则的消息数
    "rule_match_counts": {},   # {rule_id: count} 各规则命中次数
    "started_at": time.time(),
}

def reset_metrics():
    _metrics["total_messages"] = 0
    _metrics["total_matches"] = 0
    _metrics["matched_messages"] = 0
    _metrics["rule_match_counts"] = {}
    _metrics["started_at"] = time.time()

def get_metrics() -> dict:
    total_checks = _cache["hits"] + _cache["misses"]
    return {
        "uptime_seconds": round(time.time() - _metrics["started_at"], 1),
        "total_messages": _metrics["total_messages"],
        "matched_messages": _metrics["matched_messages"],
        "hit_rate": round(_metrics["matched_messages"] / max(_metrics["total_messages"], 1), 4),
        "total_matches": _metrics["total_matches"],
        "avg_matches_per_msg": round(_metrics["total_matches"] / max(_metrics["total_messages"], 1), 2),
        "rule_match_counts": dict(_metrics["rule_match_counts"]),
        "cache": {
            "hits": _cache["hits"],
            "misses": _cache["misses"],
            "total": total_checks,
            "cache_rate": round(_cache["hits"] / max(total_checks, 1), 4),
            "ttl": _cache["ttl"],
            "cached_entries": len(_cache["data"]) if _cache["data"] else 0,
        },
    }


def _file_path(wf_id: str) -> str:
    safe = wf_id.replace("/", "_").replace("..", "_")
    return os.path.join(_WF_DIR, f"{safe}.json")


def list_workflows() -> list:
    """列出所有工作流规则（带缓存）"""
    return _load_from_cache_or_disk()


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
    invalidate_cache()
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
    invalidate_cache()
    return wf


def delete_workflow(wf_id: str) -> bool:
    """删除工作流"""
    path = _file_path(wf_id)
    if os.path.exists(path):
        os.remove(path)
        invalidate_cache()
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
        mode = trigger.get("mode", "any")
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
    """查找所有匹配当前消息的已启用工作流（同时记录指标）"""
    _metrics["total_messages"] += 1
    matches = []
    for wf in _load_from_cache_or_disk():
        if not wf.get("enabled", True):
            continue
        if match_trigger(wf, user_message):
            matches.append(wf)
            rid = wf["id"]
            _metrics["rule_match_counts"][rid] = _metrics["rule_match_counts"].get(rid, 0) + 1

    if matches:
        _metrics["matched_messages"] += 1
        _metrics["total_matches"] += len(matches)

    return matches
