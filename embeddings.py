"""
轻量级向量编码 & 余弦相似度检索
基于 sklearn TfidfVectorizer + character n-grams，适配中文语义匹配
无需 GPU，无需下载大模型，比原关键词匹配显著提升命中精度
"""

import os
import time
import numpy as np
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity


class SkillEmbedder:
    """Skill 向量编码 & 相似度检索器

    使用 TF-IDF + 字符级 n-gram (1~3) 捕捉中文语义，
    在无 GPU 环境下实现比纯关键词匹配更精准的召回。
    """

    def __init__(self, skill_dir: str):
        self.skill_dir = Path(skill_dir)
        self._files: list = []               # [(path, content), ...]
        self._file_mtimes: dict = {}         # path -> mtime
        self._vectorizer: TfidfVectorizer = None
        self._doc_matrix = None              # (n_docs, n_features) sparse matrix
        self._build_index()

    # ── 构建 / 增量更新索引 ──

    def _build_index(self):
        """全量构建 TF-IDF 索引"""
        if not self.skill_dir.exists():
            self._files = []
            self._vectorizer = None
            self._doc_matrix = None
            return

        self._files = []
        mtimes = {}
        docs: list[str] = []

        for sf in sorted(self.skill_dir.glob("*.md")):
            try:
                content = sf.read_text(encoding="utf-8")
            except Exception:
                continue
            if not content.strip():
                continue
            self._files.append((str(sf), content))
            # 文件名拼入索引文本（重复3次加权），提升短文档匹配精度
            stem = sf.stem
            boosted = f"{stem}\n{stem}\n{stem}\n{content}"
            docs.append(boosted)
            mtimes[str(sf)] = sf.stat().st_mtime

        if not self._files:
            self._vectorizer = None
            self._doc_matrix = None
            self._file_mtimes = mtimes
            return

        # 字符级 n-gram (1~3): char 分析器逐字切分，适配中文无空格文本
        self._vectorizer = TfidfVectorizer(
            analyzer="char",
            ngram_range=(1, 3),
            max_features=5000,
            max_df=0.9,
            min_df=1,
        )
        self._doc_matrix = self._vectorizer.fit_transform(docs)
        self._file_mtimes = mtimes

    def _maybe_refresh(self):
        """检查文件是否变更，按需增量重建索引"""
        if not self.skill_dir.exists():
            if self._files:
                self._build_index()
            return

        current_files = set()
        for sf in self.skill_dir.glob("*.md"):
            current_files.add(str(sf))
            mtime = sf.stat().st_mtime
            if self._file_mtimes.get(str(sf)) != mtime:
                self._build_index()
                return

        # 文件增删检测
        indexed = {p for p, _ in self._files}
        if current_files != indexed:
            self._build_index()

    # ── 公开 API ──

    def search(self, query: str, top_k: int = 2, min_score: float = 0.05) -> list[str]:
        """按语义相似度检索最相关的 Skill 全文

        Args:
            query: 用户输入文本
            top_k: 返回最多 top_k 个 Skill
            min_score: 最低余弦相似度阈值 (0~1)，低于此值的 Skill 会被过滤

        Returns:
            匹配的 Skill 全文列表（按相似度降序）
        """
        self._maybe_refresh()

        if not self._files or self._vectorizer is None:
            return []

        try:
            query_vec = self._vectorizer.transform([query])
            sims = cosine_similarity(query_vec, self._doc_matrix)[0]
        except Exception:
            return []

        # 按相似度降序取 top_k，过滤低于阈值的
        ranked = []
        for i, score in enumerate(sims):
            if score < min_score:
                continue
            ranked.append((score, self._files[i][1]))

        ranked.sort(key=lambda x: x[0], reverse=True)
        return [content for _, content in ranked[:top_k]]

    def search_with_info(self, query: str, top_k: int = 2, min_score: float = 0.05) -> list[dict]:
        """同 search()，但返回更丰富的信息（含文件名和相似度）"""
        self._maybe_refresh()

        if not self._files or self._vectorizer is None:
            return []

        try:
            query_vec = self._vectorizer.transform([query])
            sims = cosine_similarity(query_vec, self._doc_matrix)[0]
        except Exception:
            return []

        ranked = []
        for i, score in enumerate(sims):
            if score < min_score:
                continue
            ranked.append({
                "file": self._files[i][0],
                "score": round(float(score), 4),
                "content": self._files[i][1],
            })

        ranked.sort(key=lambda x: x["score"], reverse=True)
        return ranked[:top_k]
