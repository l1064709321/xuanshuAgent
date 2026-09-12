/**
 * src/tools/webTools.ts — 搜索Agent 联网工具
 *
 * 纯 Node 实现（内置 fetch）：
 *  - web_search：对 Bing/DuckDuckGo 的 HTML 搜索页做解析，返回标题/链接/摘要
 *  - web_fetch：抓取网页正文（剥离 script/style/tag，提取主要文本）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const exec = promisify(execFile);

async function httpGet(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
      redirect: 'follow',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** DuckDuckGo HTML 搜索解析（无 API Key，稳定可用） */
async function ddgSearch(query: string, max: number): Promise<SearchHit[]> {
  const html = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const hits: SearchHit[] = [];
  const resultRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
  let m: RegExpExecArray | null;
  while ((m = resultRe.exec(html)) !== null && hits.length < max) {
    const rawUrl = m[1];
    let url = rawUrl;
    if (rawUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
      url = decodeURIComponent(rawUrl.replace('//duckduckgo.com/l/?uddg=', ''));
    } else if (rawUrl.startsWith('http')) {
      url = rawUrl;
    } else {
      continue;
    }
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    hits.push({ title, url, snippet: '' });
  }
  let i = 0;
  while ((m = snippetRe.exec(html)) !== null && i < hits.length) {
    hits[i].snippet = m[1].replace(/<[^>]+>/g, '').trim();
    i++;
  }
  return hits.slice(0, max);
}

/** Bing 搜索解析（备选源）— 适配新版结构：h2 class="" + b_caption p */
async function bingSearch(query: string, max: number): Promise<SearchHit[]> {
  const html = await httpGet(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`);
  const hits: SearchHit[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let blk: RegExpExecArray | null;
  while ((blk = blockRe.exec(html)) !== null && hits.length < max) {
    const li = blk[0];
    const am = li.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!am) continue;
    const url = am[1];
    const title = am[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    const pm = li.match(/<p[^>]*class="[^"]*(?:b_lineclamp|b_paractl|b_caption)[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const snippet = pm ? pm[1].replace(/<[^>]+>/g, '').replace(/&ensp;/g, ' ').trim() : '';
    hits.push({ title, url, snippet });
  }
  return hits.slice(0, max);
}

/** 提取 HTML 正文文本 */
function extractText(html: string, maxLen = 6000): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.slice(0, maxLen);
}

export const webTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'web_search', description: '联网搜索关键词，返回标题/链接/摘要（多源聚合）', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, max_results: { type: 'integer', description: '最大结果数，默认8' } }, required: ['query'] } } },
    handler: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '');
      const max = Math.min(Number(args.max_results ?? 8) || 8, 20);
      if (!query) return '[web_search 失败] 缺少 query';
      let hits: SearchHit[] = [];
      let source = 'duckduckgo';
      try {
        hits = await ddgSearch(query, max);
      } catch {
        try {
          hits = await bingSearch(query, max);
          source = 'bing';
        } catch (e) {
          return `[web_search 失败] 搜索源不可用: ${(e as Error).message}`;
        }
      }
      if (!hits.length) {
        // 双源兜底
        try {
          hits = await bingSearch(query, max);
          source = 'bing';
        } catch (e) {
          return `[web_search 失败] 搜索源不可用: ${(e as Error).message}`;
        }
      }
      if (!hits.length) return '[web_search] 无搜索结果';
      const lines = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet || '(无摘要)'}`);
      return `[搜索来源: ${source}] 关键词: ${query}\n\n${lines.join('\n')}`;
    },
  },
  {
    schema: { type: 'function', function: { name: 'web_fetch', description: '抓取指定 URL 的网页正文内容', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } } },
    handler: async (args: Record<string, unknown>) => {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//.test(url)) return '[web_fetch 失败] URL 必须以 http(s):// 开头';
      try {
        const html = await httpGet(url);
        const text = extractText(html);
        if (!text) return '[web_fetch] 页面无有效正文（可能为 JS 渲染页面）';
        return `[页面] ${url}\n\n${text}`;
      } catch (e) {
        return `[web_fetch 失败] ${(e as Error).message}`;
      }
    },
  },
];
