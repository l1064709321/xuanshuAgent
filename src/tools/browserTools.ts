/**
 * src/tools/browserTools.ts — 浏览器Agent 工具
 *
 * 依赖 playwright（可选）。未安装时返回清晰提示，Agent 可引导用户安装。
 * 使用 createRequire 延迟加载，避免启动即报错；类型用 any 简化（playwright 为可选依赖）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: { agent: string }) => string | Promise<string> };

const require = createRequire(import.meta.url);
const SHOT_DIR = path.join(PROJECT_ROOT, 'output', 'browser');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browserHandle: { newPage(): Promise<{ close(): Promise<void> }>; close(): Promise<void> } | null = null;
let playwrightErr: string | null = null;

async function getBrowser() {
  if (playwrightErr) return null;
  if (browserHandle) return browserHandle;
  try {
    const { chromium } = require('playwright') as { chromium: { launch(o: object): Promise<unknown> } };
    const b = (await chromium.launch({ headless: true, args: ['--no-sandbox'] })) as { newPage(): Promise<{ close(): Promise<void> }>; close(): Promise<void> };
    browserHandle = b;
    return b;
  } catch (e) {
    playwrightErr = `[playwright 未安装] ${(e as Error).message.split('\n')[0]}. 安装方式: npm install playwright && npx playwright install chromium`;
    return null;
  }
}

const NOT_READY = () => playwrightErr ?? '[浏览器引擎不可用]';

// 页面对象的最小结构化视图（any 兼容 playwright 完整 API）
type PageView = {
  goto(u: string, o?: object): Promise<unknown>;
  title(): Promise<string>;
  content(): Promise<string>;
  click(s: string): Promise<void>;
  type(s: string, t: string, o?: object): Promise<void>;
  screenshot(o: object): Promise<Buffer>;
  close(): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
};

async function withPage<T>(fn: (page: PageView) => Promise<T>): Promise<T | string> {
  const b = await getBrowser();
  if (!b) return NOT_READY();
  const page = (await b.newPage()) as unknown as PageView;
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function stripHtml(html: string, max = 4000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const browserTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'browser_open', description: '打开指定 URL，等待页面加载后返回标题与摘要文本', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页 URL' } }, required: ['url'] } } },
    handler: (args: Record<string, unknown>) => withPage(async (page) => {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//.test(url)) return '[browser_open 失败] URL 必须以 http(s):// 开头';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(800);
      const title = await page.title().catch(() => '(无标题)');
      const text = stripHtml(await page.content());
      return `[已打开] ${title}\n[URL] ${url}\n\n${text || '(页面无文本)'}`;
    }),
  },
  {
    schema: { type: 'function', function: { name: 'browser_click', description: '点击页面元素（CSS 选择器）', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] } } },
    handler: (args: Record<string, unknown>) => withPage(async (page) => {
      await page.click(String(args.selector ?? ''));
      await page.waitForTimeout(600);
      return `[已点击] ${args.selector}`;
    }),
  },
  {
    schema: { type: 'function', function: { name: 'browser_type', description: '向输入框输入文本（CSS 选择器）', parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '输入文本' } }, required: ['selector', 'text'] } } },
    handler: (args: Record<string, unknown>) => withPage(async (page) => {
      await page.type(String(args.selector ?? ''), String(args.text ?? ''), { delay: 20 });
      return `[已输入] ${String(args.text ?? '').slice(0, 100)} → ${args.selector}`;
    }),
  },
  {
    schema: { type: 'function', function: { name: 'browser_extract', description: '提取当前页面正文文本', parameters: { type: 'object', properties: {} } } },
    handler: () => withPage(async (page) => {
      const text = stripHtml(await page.content());
      return text || '(页面无文本)';
    }),
  },
  {
    schema: { type: 'function', function: { name: 'browser_screenshot', description: '对当前页面截图并保存 PNG', parameters: { type: 'object', properties: {} } } },
    handler: () => withPage(async (page) => {
      const out = path.join(SHOT_DIR, `browser_${Date.now()}.png`);
      await page.screenshot({ path: out, fullPage: false });
      return `[截图完成] ${out}`;
    }),
  },
];
