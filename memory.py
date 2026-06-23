"""
Agent 自主记忆系统
- Agent 自动写入、更新、遗忘，用户不可直接修改
- 记忆分三级：短期（会话内）、中期（摘要）、长期（压缩归档）
"""
import json
import time
from dataclasses import dataclass, field
from typing import List, Dict, Optional
from datetime import datetime


@dataclass
class MemoryItem:
    """单条记忆"""
    id: str
    content: str
    created_at: float
    last_access: float
    access_count: int = 0
    importance: float = 0.5  # 0-1，Agent 自动评估


class AgentMemory:
    """Agent 自主记忆管理器"""

    def __init__(self, max_short_term: int = 20, session_id: str = ""):
        self.short_term: List[MemoryItem] = []  # 短期记忆
        self.medium_term: List[MemoryItem] = []  # 中期摘要
        self.long_term: List[MemoryItem] = []  # 长期压缩
        self.max_st = max_short_term
        self.session_id = session_id or str(int(time.time()))
        self.summary: str = ""  # 会话摘要，Agent 自动生成

    def add(self, content: str, importance: float = 0.5) -> str:
        """Agent 写入新记忆"""
        mid = f"mem_{int(time.time() * 1000)}_{len(self.short_term)}"
        item = MemoryItem(
            id=mid, content=content,
            created_at=time.time(), last_access=time.time(),
            importance=importance
        )
        self.short_term.append(item)
        self._compact_if_needed()
        return mid

    def recall(self, query: str = "", top_k: int = 5) -> List[MemoryItem]:
        """Agent 检索记忆"""
        all_items = self.short_term + self.medium_term + self.long_term
        if not query:
            return all_items[-top_k:]

        # 简单关键词匹配 + 重要性加权
        scored = []
        for item in all_items:
            score = 0
            for word in query:
                if word in item.content:
                    score += 1
            score += item.importance * 2 + item.access_count * 0.1
            scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored[:top_k]]

    def forget(self, memory_id: str) -> bool:
        """Agent 主动遗忘"""
        for lst in [self.short_term, self.medium_term, self.long_term]:
            for item in lst:
                if item.id == memory_id:
                    lst.remove(item)
                    return True
        return False

    def update_importance(self, memory_id: str, new_importance: float):
        """Agent 更新记忆重要性"""
        for lst in [self.short_term, self.medium_term, self.long_term]:
            for item in lst:
                if item.id == memory_id:
                    item.importance = max(0.0, min(1.0, new_importance))
                    return

    def summarize(self) -> str:
        """Agent 生成会话摘要，归档到中期记忆"""
        if not self.short_term and not self.summary:
            return ""
        recent = [m.content for m in self.short_term[-10:]]
        old_summary = self.summary
        new_summary = f"[{datetime.now().strftime('%H:%M')}] " + "; ".join(recent[-5:])
        self.summary = (old_summary + " | " + new_summary) if old_summary else new_summary
        if len(self.short_term) > 5:
            # 归档旧的短期记忆
            archived = self.short_term[:-5]
            self.short_term = self.short_term[-5:]
            self.medium_term.extend(archived)
        return self.summary

    def _compact_if_needed(self):
        """短期记忆超限自动压缩"""
        if len(self.short_term) > self.max_st:
            self.summarize()

    def to_context(self, max_items: int = 8) -> str:
        """输出给 Agent 的上下文记忆"""
        items = self.recall(top_k=max_items)
        if not items:
            return ""
        lines = ["[自主记忆]"]
        for item in items:
            lines.append(f"  [{item.importance:.1f}] {item.content}")
        return "\n".join(lines)

    def get_stats(self) -> dict:
        """Agent 查看自身记忆状态"""
        return {
            "短期记忆": len(self.short_term),
            "中期记忆": len(self.medium_term),
            "长期记忆": len(self.long_term),
            "会话摘要": self.summary[-200:] if self.summary else "无",
        }
