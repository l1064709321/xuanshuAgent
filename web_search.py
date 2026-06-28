#!/usr/bin/env python3
"""
高质量联网搜索 — 域名信誉过滤 + 官方数据源优先
借鉴 Hermes Agent 的信息可靠性机制，防止大模型训练数据投毒。

使用:
  python web_search.py "查询词"
  python web_search.py "查询词" --max 3 --model qwen25-7b

核心策略:
  1. DDG 搜索 → 候选链接
  2. 域名信誉打分 → 排序
  3. 高分源深读 + LLM综合 → 标注来源
"""

import urllib.request, urllib.parse, re, os, sys, json

# ══════════ 域名信誉库 ══════════
# 借鉴 Hermes 的信任源理念: 官方 > 学术 > 维基 > 大媒体 > 其他
DOMAIN_REPUTATION = {
    # 官方/政府/学术
    ".gov": 10,
    ".edu": 8,
    ".ac.": 8,
    ".mil": 9,
    # 权威知识库
    "wikipedia.org": 9,
    "wikibooks.org": 8,
    "scholar.google": 8,
    "arxiv.org": 9,
    "paperswithcode.com": 8,
    "pubmed.ncbi.nlm.nih.gov": 9,
    # 官方文档/标准
    "docs.python.org": 9,
    "developer.mozilla.org": 9,
    "man7.org": 8,
    "w3.org": 9,
    "ietf.org": 9,
    "readthedocs.io": 7,
    "github.com": 7,
    "stackoverflow.com": 7,
    "serverfault.com": 7,
    # 权威媒体
    "reuters.com": 7,
    "apnews.com": 7,
    "bbc.com": 7,
    "bbc.co.uk": 7,
    "nature.com": 9,
    "science.org": 9,
    "bloomberg.com": 6,
    "economist.com": 7,
    "wsj.com": 6,
    "nytimes.com": 6,
    "theguardian.com": 6,
    # 国内权威
    "gov.cn": 10,
    "edu.cn": 8,
    "xinhuanet.com": 7,
    "people.com.cn": 7,
    "cctv.com": 7,
    "cnki.net": 8,
    # 技术
    "pypi.org": 7,
    "npmjs.com": 7,
    "crates.io": 7,
    "hub.docker.com": 6,
    # AI/研究
    "openai.com": 6,
    "anthropic.com": 6,
    "huggingface.co": 7,
    "tensorflow.org": 8,
    "pytorch.org": 8,
    # 低信誉 — 投毒重灾区
    "csdn.net": 3,       # 内容农场
    "jianshu.com": 3,    # 个人博客聚合
    "zhihu.com": 4,      # 质量参差
    "blog.csdn.net": 3,
    "bilibili.com": 3,
    "medium.com": 4,
    "dev.to": 4,
    "reddit.com": 4,
    "twitter.com": 3,
    "x.com": 3,
    "facebook.com": 2,
    "instagram.com": 1,
    "tiktok.com": 1,
    "youtube.com": 3,
    "quora.com": 3,
}


def score_domain(url: str) -> int:
    """域名信誉打分: 10=最高权威, 1=不可信"""
    host = urllib.parse.urlparse(url).netloc.lower()
    for pattern, score in sorted(DOMAIN_REPUTATION.items(), key=lambda x: -len(x[0])):
        if pattern in host:
            return score
    return 3  # 未知域名默认中等偏下


def search_web(query: str, max_results: int = 10) -> list:
    """DuckDuckGo Lite 搜索，返回 [{url, title, snippet, score}]"""
    try:
        q = urllib.parse.quote(query)
        req = urllib.request.Request(
            f"https://lite.duckduckgo.com/lite/?q={q}",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            html = r.read().decode("utf-8", errors="replace")

        # 解析结果
        results = re.findall(
            r'<a[^>]*href="(https?://[^"]+)"[^>]*class="result-link"[^>]*>(.*?)</a>'
            r'.*?class="result-snippet"[^>]*>(.*?)</td>',
            html, re.DOTALL
        )
        out = []
        for url, title, snippet in results:
            t = re.sub(r'<[^>]+>', '', title).strip()
            s = re.sub(r'<[^>]+>', '', snippet).strip()[:400]
            score = score_domain(url)
            out.append({"url": url, "title": t, "snippet": s, "score": score})

        # 按信誉分排序
        out.sort(key=lambda x: -x["score"])
        return out[:max_results]
    except Exception as e:
        return [{"url": "", "title": "搜索失败", "snippet": str(e), "score": 0}]


def fetch_page(url: str, max_chars: int = 5000) -> str:
    """抓取网页纯文本"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            html = r.read().decode("utf-8", errors="replace")
        text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text[:max_chars]
    except Exception as e:
        return f"[抓取失败: {e}]"


def deepen(query: str, top_k: int = 3, max_search: int = 10) -> list:
    """深度搜索: 搜索 → 信誉过滤 → 深读高分源 → 返回结构化结果"""
    results = search_web(query, max_search)
    if not results or results[0]["score"] == 0:
        return []

    deep = []
    for r in results[:top_k]:
        if r["score"] >= 5:  # 只深读高分源
            content = fetch_page(r["url"], 3000)
            r["content"] = content
        else:
            r["content"] = r["snippet"]  # 低分源只用摘要
        deep.append(r)
    return deep


def format_cli(results: list) -> str:
    """CLI 格式输出"""
    if not results:
        return "无结果。"

    lines = []
    for i, r in enumerate(results):
        badge = {9: "🏛", 8: "📚", 7: "✅", 6: "📰", 5: "📄", 4: "⚠️", 3: "❓", 2: "🚫", 1: "💀"}.get(r["score"], "❓")
        lines.append(f"\n{'-'*60}")
        lines.append(f"[{i+1}] {badge} 信誉分:{r['score']}/10  {r['title']}")
        lines.append(f"    来源: {r['url']}")
        if "content" in r and len(r["content"]) > len(r.get("snippet", "")):
            lines.append(f"    {r['content'][:600]}")
        else:
            lines.append(f"    {r.get('snippet', r.get('content', ''))[:400]}")
    lines.append(f"\n{'='*60}")
    lines.append(f"  信誉分说明: 9+🏛 官方/学术  7-8📚 权威源  5-6📄 一般  ≤4⚠️ 粗糙")
    lines.append(f"  防投毒策略: 只深读信誉分≥5的源，低分源仅取摘要")
    return "\n".join(lines)


# ══════════ CLI 入口 ══════════
if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="高质量联网搜索")
    p.add_argument("query", nargs="?", help="搜索词")
    p.add_argument("--max", type=int, default=3, help="深读数量")
    p.add_argument("--search-only", action="store_true", help="仅搜索不深读")
    p.add_argument("--raw", action="store_true", help="输出JSON")
    args = p.parse_args()

    if not args.query:
        print("用法: python web_search.py \"查询词\" [--max 3]")
        sys.exit(1)

    if args.search_only:
        results = search_web(args.query, 10)
    else:
        results = deepen(args.query, top_k=args.max, max_search=10)

    if args.raw:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(format_cli(results))
