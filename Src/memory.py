"""
Agent 自主记忆系统 v3
- 三层记忆：短期（会话内）/ 中期（摘要归档）/ 长期（压缩）
- 磁盘持久化：JSON 文件自动保存/加载
- 关键词召回 + 重要性加权 + 访问追踪 + 时间衰减
- 自动去重、自动压缩、自动遗忘
- 快照机制：项目级记忆共享
"""
import json
import time
import os
import hashlib
from dataclasses import dataclass, field
from typing import List, Optional
from datetime import datetime


@dataclass
class MemoryItem:
    id: str
    content: str
    created_at: float
    last_access: float
    access_count: int = 0
    importance: float = 0.5


class AgentMemory:
    """Agent 自主记忆管理器 — 带磁盘持久化 + 快照共享"""

    def __init__(self, max_short_term: int = 20, session_id: str = "",
                 persist_path: str = ""):
        self.short_term: List[MemoryItem] = []
        self.medium_term: List[MemoryItem] = []
        self.long_term: List[MemoryItem] = []
        self.max_st = max_short_term
        self.session_id = session_id or str(int(time.time()))
        self.summary: str = ""
        self.persist_path = persist_path
        self._dirty = False

    # ── 持久化 ──
    def save(self, path: str = ""):
        """保存到磁盘"""
        target = path or self.persist_path
        if not target:
            return
        data = {
            "session_id": self.session_id,
            "summary": self.summary,
            "short_term": self._serialize(self.short_term),
            "medium_term": self._serialize(self.medium_term),
            "long_term": self._serialize(self.long_term),
        }
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        self._dirty = False

    def load(self, path: str = ""):
        """从磁盘加载"""
        target = path or self.persist_path
        if not target or not os.path.exists(target):
            return False
        try:
            with open(target, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.session_id = data.get("session_id", self.session_id)
            self.summary = data.get("summary", "")
            self.short_term = self._deserialize(data.get("short_term", []))
            self.medium_term = self._deserialize(data.get("medium_term", []))
            self.long_term = self._deserialize(data.get("long_term", []))
            self._dirty = False
            return True
        except Exception:
            return False

    def _serialize(self, items: List[MemoryItem]) -> list:
        return [{"id": i.id, "content": i.content, "created_at": i.created_at,
                 "last_access": i.last_access, "access_count": i.access_count,
                 "importance": i.importance} for i in items]

    def _deserialize(self, raw: list) -> List[MemoryItem]:
        return [MemoryItem(
            id=r.get("id", self._gen_id(r["content"])),
            content=r["content"],
            created_at=r.get("created_at", time.time()),
            last_access=r.get("last_access", time.time()),
            access_count=r.get("access_count", 0),
            importance=r.get("importance", 0.5),
        ) for r in raw]

    def _gen_id(self, content: str) -> str:
        h = hashlib.md5(content.encode()).hexdigest()[:12]
        return f"mem_{h}"

    def _mark_dirty(self):
        self._dirty = True
        if self.persist_path:
            self.save()

    # ── CRUD ──
    def add(self, content: str, importance: float = 0.5) -> str:
        """写入记忆 — 自动去重"""
        content = content.strip()
        if not content:
            return ""
        for item in self.short_term:
            if content in item.content or item.content in content:
                item.last_access = time.time()
                item.access_count += 1
                item.importance = max(item.importance, importance)
                self._mark_dirty()
                return item.id
        mid = self._gen_id(content)
        item = MemoryItem(
            id=mid, content=content,
            created_at=time.time(), last_access=time.time(),
            importance=importance
        )
        self.short_term.append(item)
        self._compact_if_needed()
        self._mark_dirty()
        return mid

    def recall(self, query: str = "", top_k: int = 5) -> List[MemoryItem]:
        """检索记忆 — 基于子串匹配 + 重要性加权 + 时间衰减"""
        all_items = self.short_term + self.medium_term + self.long_term
        if not query:
            all_items.sort(key=lambda x: x.last_access, reverse=True)
            return all_items[:top_k]

        query_lower = query.lower()
        scored = []
        for item in all_items:
            content_lower = item.content.lower()
            score = 0.0
            if query_lower in content_lower:
                score += 3.0
            elif content_lower in query_lower:
                score += 2.0
            for chunk in self._tokenize(query_lower):
                if chunk and len(chunk) >= 2 and chunk in content_lower:
                    score += 1.0
            score += item.importance * 2.0 + item.access_count * 0.1
            hours_ago = (time.time() - item.last_access) / 3600
            decay = max(0.05, 2.0 ** (-hours_ago / 24.0))
            score *= decay
            if score > 0:
                scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        results = [item for _, item in scored[:top_k]]
        for item in results:
            item.last_access = time.time()
            item.access_count += 1
        if results:
            self._mark_dirty()
        return results

    def _tokenize(self, text: str) -> list:
        import re
        return re.split(r'[，,。.！!？?\s]+', text)

    def forget(self, memory_id: str) -> bool:
        for lst in [self.short_term, self.medium_term, self.long_term]:
            for item in lst:
                if item.id == memory_id:
                    lst.remove(item)
                    self._mark_dirty()
                    return True
        return False

    def update_importance(self, memory_id: str, new_importance: float):
        for lst in [self.short_term, self.medium_term, self.long_term]:
            for item in lst:
                if item.id == memory_id:
                    item.importance = max(0.0, min(1.0, new_importance))
                    self._mark_dirty()
                    return

    # ── 自动管理 ──
    def summarize(self) -> str:
        """生成摘要 — 短期→中期归档"""
        if not self.short_term:
            return self.summary or ""
        recent = [m.content for m in self.short_term[-10:]]
        ts = datetime.now().strftime('%H:%M')
        chunk = f"[{ts}] " + " | ".join(recent[-3:])
        self.summary = f"{chunk}\n{self.summary}" if self.summary else chunk
        if len(self.summary) > 2000:
            self.summary = self.summary[:2000]
        if len(self.short_term) > 5:
            archived = self.short_term[:-5]
            self.short_term = self.short_term[-5:]
            for item in archived:
                item.importance *= 0.7
            self.medium_term.extend(archived)
            if len(self.medium_term) > 30:
                excess = self.medium_term[:-30]
                self.medium_term = self.medium_term[-30:]
                self.long_term.extend(excess)
            if len(self.long_term) > 50:
                self.long_term.sort(key=lambda x: x.importance)
                self.long_term = self.long_term[-50:]
        self._mark_dirty()
        return self.summary

    def _compact_if_needed(self):
        if len(self.short_term) > self.max_st:
            self.summarize()

    # ── 上下文输出 ──
    def to_context(self, max_items: int = 8) -> str:
        items = self.recall(top_k=max_items)
        if not items:
            return ""
        lines = ["[记忆上下文]"]
        for item in items:
            lines.append(f"  [{item.importance:.1f}] {item.content}")
        return "\n".join(lines)

    # ── 快照机制（项目级共享）──
    def export_snapshot(self, snapshot_dir: str) -> bool:
        """导出记忆快照到共享目录，供团队成员导入"""
        try:
            os.makedirs(snapshot_dir, exist_ok=True)
            # 写入主数据文件
            snapshot_file = os.path.join(snapshot_dir, "snapshot.json")
            self.save(snapshot_file)
            # 写入时间戳元数据
            meta = {
                "updated_at": datetime.now().isoformat(),
                "source": self.session_id,
                "total_items": len(self.short_term) + len(self.medium_term) + len(self.long_term),
            }
            meta_path = os.path.join(snapshot_dir, "snapshot-meta.json")
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            return False

    def import_snapshot(self, snapshot_dir: str) -> bool:
        """从共享目录导入记忆快照"""
        snapshot_file = os.path.join(snapshot_dir, "snapshot.json")
        if not os.path.exists(snapshot_file):
            return False
        try:
            # 先读取元数据检查是否需要更新
            meta_path = os.path.join(snapshot_dir, "snapshot-meta.json")
            if os.path.exists(meta_path):
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                existing = self.get_stats()
                if existing.get("snapshot_synced") == meta.get("updated_at"):
                    return False  # 已是最新，无需导入

            # 加载快照数据
            with open(snapshot_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            # 合并策略：快照记忆追加到当前记忆，自动去重
            snap_items = self._deserialize(data.get("short_term", [])) + \
                         self._deserialize(data.get("medium_term", [])) + \
                         self._deserialize(data.get("long_term", []))

            existing_ids = {i.id for i in self.short_term + self.medium_term + self.long_term}
            new_count = 0
            for item in snap_items:
                if item.id not in existing_ids:
                    # 快照记忆标记为中度重要
                    item.importance = min(0.7, item.importance + 0.2)
                    self.short_term.append(item)
                    existing_ids.add(item.id)
                    new_count += 1

            if new_count:
                self.summarize()
                self._mark_dirty()

            # 记录同步时间
            if os.path.exists(meta_path):
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                self._last_snapshot_sync = meta.get("updated_at", "")
            return True
        except Exception:
            return False

    def check_snapshot(self, snapshot_dir: str) -> dict:
        """检查快照是否需要更新"""
        result = {"action": "none"}
        meta_path = os.path.join(snapshot_dir, "snapshot-meta.json")
        if not os.path.exists(meta_path):
            return result

        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)

            snapshot_ts = meta.get("updated_at", "")
            last_sync = getattr(self, "_last_snapshot_sync", "")

            if not last_sync:
                result = {"action": "initialize", "snapshot_timestamp": snapshot_ts}
            elif snapshot_ts > last_sync:
                result = {"action": "update", "snapshot_timestamp": snapshot_ts}
        except Exception:
            pass
        return result

    def get_stats(self) -> dict:
        return {
            "session": self.session_id,
            "short": len(self.short_term),
            "medium": len(self.medium_term),
            "long": len(self.long_term),
            "summary_len": len(self.summary) if self.summary else 0,
            "dirty": self._dirty,
            "persist": bool(self.persist_path and os.path.exists(self.persist_path)),
            "snapshot_synced": getattr(self, "_last_snapshot_sync", ""),
            # 兼容旧前端
            "短期记忆": len(self.short_term),
            "中期记忆": len(self.medium_term),
        }
