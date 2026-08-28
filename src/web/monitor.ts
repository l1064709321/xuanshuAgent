// ========== Token 监控面板 ==========
import { state } from "./state.js";
import { $, escapeHtml, fmtTk } from "./dom.js";
import { navigateTo } from "./panels.js";

export function openMonitor(): void {
  navigateTo("#chat");
  const panel = document.getElementById("inlineMonitor");
  const body = document.getElementById("inlineMonitorBody") as HTMLElement | null;
  if (panel) {
    panel.style.display = "block";
    if (body) body.style.display = "block";
    const btn = document.querySelector(".inline-monitor-toggle") as HTMLElement | null;
    if (btn) btn.textContent = "\u25B4";
  }
  void fetchTokenStats();
  startAutoRefresh();
}

export function closeMonitor(): void {
  const panel = document.getElementById("inlineMonitor");
  const body = document.getElementById("inlineMonitorBody") as HTMLElement | null;
  if (panel) panel.style.display = "none";
  if (body) body.style.display = "none";
  const btn = document.querySelector(".inline-monitor-toggle") as HTMLElement | null;
  if (btn) btn.textContent = "\u25BE";
  stopAutoRefresh();
  navigateTo("#chat");
}

export function initMonitor(): void {
  // 页面加载即常驻监控（桌面端右侧栏常显；移动端抽屉默认收起）
  const panel = document.getElementById("inlineMonitor");
  if (panel) panel.style.display = "block";
  void fetchTokenStats();
  startAutoRefresh();
}

export function toggleInlineMonitor(): void {
  const body = document.getElementById("inlineMonitorBody") as HTMLElement | null;
  const btn = document.querySelector(".inline-monitor-toggle") as HTMLElement | null;
  if (!body) return;
  const collapsed = body.style.display === "none";
  body.style.display = collapsed ? "block" : "none";
  if (btn) btn.textContent = collapsed ? "\u25B4" : "\u25BE";
}

export function toggleAutoRefresh(): void {
  state.autoRefreshOn = ($("#autoRefresh") as HTMLInputElement).checked;
  if (state.autoRefreshOn) startAutoRefresh();
  else stopAutoRefresh();
}

export function startAutoRefresh(): void {
  stopAutoRefresh();
  if (state.autoRefreshOn) {
    state.monitorTimer = setInterval(() => { void fetchTokenStats(); }, 3000);
  }
}

export function stopAutoRefresh(): void {
  if (state.monitorTimer) { clearInterval(state.monitorTimer); state.monitorTimer = null; }
}

interface TokenStatsResp {
  ok?: boolean;
  hit_rate?: number;
  tokens_per_minute?: number;
  total?: { prompt_tokens: number; completion_tokens: number; calls: number; cached_tokens?: number };
  by_agent?: Record<string, { calls: number; prompt_tokens: number; cached_tokens: number; completion_tokens: number }>;
  budget?: { remaining: number; used: number; limit: number };
  timeline?: { ts: number; prompt: number; cached: number; completion: number }[];
}

export async function fetchTokenStats(): Promise<void> {
  try {
    const r = await fetch(state.API + "/api/token-stats");
    const j = (await r.json()) as TokenStatsResp;
    if (!j.ok) return;
    renderMonitor(j);
  } catch (e) { /* 静默失败 */ }
}

function renderMonitor(j: TokenStatsResp): void {
  $("#mHitRate").textContent = (j.hit_rate ?? 0) + "%";
  const mainHit = document.getElementById("mHitRateMain");
  if (mainHit) mainHit.textContent = (j.hit_rate ?? 0) + "%";
  const total = j.total || { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
  const totalTk = total.prompt_tokens + total.completion_tokens;
  $("#mTotalTokens").textContent = totalTk > 1000 ? (totalTk / 1000).toFixed(1) + "k" : String(totalTk);
  $("#mRate").textContent = (j.tokens_per_minute ?? 0) + " tk/min";
  if (j.budget) {
    $("#mBudget").textContent = (j.budget.remaining / 1000).toFixed(0) + "k";
    const limit = j.budget.limit > 0 ? j.budget.limit : 1;
    const pct = ((j.budget.used / limit) * 100).toFixed(1);
    const usedK = (j.budget.used / 1000).toFixed(0);
    const limitK = (j.budget.limit / 1000).toFixed(0);
    $("#budgetBar").style.width = Math.min(Math.max(Number(pct), 0), 100) + "%";
    $("#budgetLabel").textContent = usedK + "k / " + limitK + "k (" + (j.budget.limit > 0 ? pct + "%" : "0%") + ")";
  }

  const tb = $("#monitorTableBody");
  const empty = $("#monitorEmpty");
  const agents = j.by_agent || {};
  const hasData = total.calls > 0;
  empty.style.display = hasData ? "none" : "";
  $("#monitorTable").style.display = hasData ? "" : "none";
  if (!hasData) return;
  tb.innerHTML = "";
  for (const [name, a] of Object.entries(agents)) {
    const hitPct = a.prompt_tokens > 0 ? ((a.cached_tokens / a.prompt_tokens) * 100).toFixed(1) : "0.0";
    tb.innerHTML += `<tr>
      <td>${escapeHtml(name)}</td><td>${a.calls}</td><td>${fmtTk(a.prompt_tokens)}</td>
      <td>${fmtTk(a.cached_tokens)}</td><td>${fmtTk(a.completion_tokens)}</td><td>${hitPct}%</td>
    </tr>`;
  }
  drawMonitorBar(j.timeline || []);
}

function drawMonitorBar(timeline: { ts: number; prompt: number; cached: number; completion: number }[]): void {
  const canvas = $("#monitorBar") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!timeline.length) return;

  const now = Date.now() / 1000;
  const bucketSize = 10;
  const maxBars = 40;
  const buckets: { prompt: number; cached: number; completion: number }[] = [];
  for (let i = 0; i < maxBars; i++) buckets.push({ prompt: 0, cached: 0, completion: 0 });
  for (const entry of timeline) {
    const idx = Math.floor((entry.ts - (now - maxBars * bucketSize)) / bucketSize);
    if (idx >= 0 && idx < maxBars) {
      buckets[idx].prompt += entry.prompt;
      buckets[idx].cached += entry.cached;
      buckets[idx].completion += entry.completion;
    }
  }

  const maxVal = Math.max(1, ...buckets.map(b => b.prompt + b.completion));
  const barW = (W - 4) / maxBars - 1;

  for (let i = 0; i < maxBars; i++) {
    const b = buckets[i];
    const x = 2 + i * (barW + 1);
    const h1 = (b.prompt / maxVal) * (H - 4);
    ctx.fillStyle = "var(--accent)";
    ctx.fillRect(x, H - 2 - h1, barW, h1);
    if (b.cached > 0) {
      const h2 = (b.cached / maxVal) * (H - 4);
      ctx.fillStyle = "rgba(167,139,250,0.7)";
      ctx.fillRect(x, H - 2 - h2, barW, h2);
    }
    if (b.completion > 0) {
      const h3 = (b.completion / maxVal) * (H - 4);
      ctx.fillStyle = "rgba(74,222,128,0.6)";
      ctx.fillRect(x, H - 2 - h1 - h3, barW, h3);
    }
  }
}
