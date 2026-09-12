// ========== 面板控制 / Hash 路由 ==========
import { state, IS_MOBILE } from "./state.js";
import { $, showToast } from "./dom.js";
import { closeMoreMenu } from "./menu.js";
import { closeAvatarDrawer, loadDrawerMemList } from "./drawer.js";
import { loadSkillMarket } from "./skills.js";
import { loadSidebarMemTree } from "./memory.js";
import { syncTTSButton } from "./chat.js";
import { loadModels } from "./models.js";
import { loadWorkflows } from "./workflow.js";

export function collapseLeft(): void {
  const sb = $("#leftSidebar");
  if (IS_MOBILE.matches) {
    sb.classList.remove("open");
    $("#overlay").classList.remove("show");
  } else {
    sb.classList.add("collapsed");
  }
}

export function toggleLeft(): void {
  const sb = $("#leftSidebar");
  if (IS_MOBILE.matches) {
    const isOpen = sb.classList.contains("open");
    sb.classList.toggle("open", !isOpen);
    $("#overlay").classList.toggle("show", !isOpen);
  } else {
    sb.classList.toggle("collapsed");
  }
}

export function toggleSettings(): void {
  const panel = $("#settingsPanel");
  const overlay = $("#settingsOverlay");
  const isOpen = !panel.classList.contains("open");
  if (isOpen) {
    panel.classList.add("open");
    overlay.classList.add("show");
    // 面板互斥：关闭主题快速面板与更多菜单
    const tqp = $("#themeQuickPanel");
    if (tqp) { tqp.style.display = "none"; state.themePanelOpen = false; }
    closeMoreMenu();
    void loadModels();
  } else {
    panel.classList.remove("open");
    overlay.classList.remove("show");
  }
}

export function closeAllPanels(): void {
  $("#overlay").classList.remove("show");
  $("#leftSidebar").classList.remove("open");
  $("#settingsPanel").classList.remove("open");
  $("#settingsOverlay").classList.remove("show");
  closeMoreMenu();
  closeAvatarDrawer();
}

export function navigateTo(hash: string): void {
  if (window.location.hash === hash) {
    document.querySelectorAll(".sidebar-nav-item, .bottom-nav-item").forEach(el => {
      el.classList.add("nav-pulse");
      setTimeout(() => el.classList.remove("nav-pulse"), 400);
    });
    return;
  }
  if (IS_MOBILE.matches) closeAllPanels();
  window.location.hash = hash;
}

export function onHashChange(): void {
  const hash = window.location.hash || "#chat";
  // 移动端进入任何路由先收起侧栏抽屉，避免遮挡主区
  if (IS_MOBILE.matches) closeAllPanels();
  if (hash !== "#settings") {
    $("#settingsPanel").classList.remove("open");
    $("#settingsOverlay").classList.remove("show");
  }
  document.querySelectorAll(".page-section").forEach(s => s.classList.remove("active"));
  // 对话舞台容器仅用于对话相关页；切到记忆库/阅读/虚拟机/技能市场等独立页时隐藏，避免把独立页挤到下半屏
  const stage = document.querySelector<HTMLElement>(".page-stage");
  const hideStage = hash === "#memory" || hash === "#memory-view" || hash === "#vm" || hash === "#skillmarket";
  if (stage) {
    stage.style.display = hideStage ? "none" : "";
  }
  const pageId = "page-" + (hash === "#settings" ? "chat" : hash.slice(1));
  const page = document.getElementById(pageId.replace(/^#/, ""));
  if (page) {
    page.classList.add("active");
  } else {
    // 未知 hash 回退对话页，避免整页空白
    if (hash !== "#chat") {
      window.location.hash = "#chat";
      return;
    }
    document.getElementById("page-chat")?.classList.add("active");
  }
  document.querySelectorAll(".sidebar-nav-item").forEach(a => {
    // 高亮判断：监控快捷项（含 openMonitor）不参与高亮；#memory-view 视为记忆库页高亮
    if (a.getAttribute("onclick")?.includes("openMonitor")) {
      a.classList.remove("active");
      return;
    }
    const navHash = hash === "#memory-view" ? "#memory" : hash;
    a.classList.toggle("active", a.getAttribute("href") === navHash);
  });
  document.querySelectorAll(".bottom-nav-item").forEach((b, i) => {
    b.classList.toggle("active", ["#chat", "#settings", "#profile"][i] === hash);
  });
  if (hash === "#settings") {
    const panel = $("#settingsPanel");
    const overlay = $("#settingsOverlay");
    if (!panel.classList.contains("open")) {
      panel.classList.add("open");
      overlay.classList.add("show");
    }
    void loadModels();
  }
  if (hash === "#vm") {
    // 动态加载 VM 桌面（避免与 panels 循环依赖）
    void import("./vm.js").then((m) => m.initVM());
  }
  if (hash === "#memory") {
    // 动态加载记忆库页（避免与 panels 循环依赖）
    void import("./memory.js").then((m) => m.openMemoryPage());
  }
  if (hash === "#skillmarket") {
    // 技能市场页由 skills 模块渲染（main.ts 已挂载到 window）
    const fn = (window as unknown as Record<string, unknown>).renderSkillMarketPage as (() => Promise<void>) | undefined;
    if (fn) void fn();
  }
}

export function switchPanelTab(el: HTMLElement, tab: string): void {
  document.querySelectorAll(".panel-tab").forEach(t => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
  });
  el.classList.add("active");
  el.setAttribute("aria-selected", "true");
  ["settings", "theme", "tools", "workflow"].forEach(id => {
    $("#tab-" + id).style.display = id === tab ? "" : "none";
  });
  if (tab === "workflow") { setTimeout(() => { void loadWorkflows(); }, 100); }
  if (tab === "tools") { void loadExecLimits(); }
}

// ── 多轮执行限制（子 Agent 轮数上限 / 无进展熔断阈值，后端持久化）──
const LIMITS_LS_KEY = "xs.exec.limits";

/** 读取后端当前限制并回填输入框；后端不可达时回退本地缓存/默认值 */
export async function loadExecLimits(silent = false): Promise<void> {
  const maxEl = $("#execMaxRounds") as HTMLInputElement | null;
  const stallEl = $("#execStallRounds") as HTMLInputElement | null;
  const statusEl = $("#execLimitsStatus") as HTMLElement | null;
  if (!maxEl || !stallEl) return;
  try {
    const r = await fetch(state.API + "/api/exec/limits");
    const j = (await r.json()) as { limits?: { maxRounds?: number; stallRounds?: number } };
    const lim = j.limits ?? {};
    maxEl.value = String(lim.maxRounds ?? 500);
    stallEl.value = String(lim.stallRounds ?? 5);
    try { localStorage.setItem(LIMITS_LS_KEY, JSON.stringify({ maxRounds: Number(maxEl.value), stallRounds: Number(stallEl.value) })); } catch { /* 忽略 */ }
    if (statusEl && !silent) statusEl.textContent = "";
  } catch {
    let cached: { maxRounds?: number; stallRounds?: number } = {};
    try { cached = JSON.parse(localStorage.getItem(LIMITS_LS_KEY) || "{}") as typeof cached; } catch { cached = {}; }
    maxEl.value = String(cached.maxRounds ?? 500);
    stallEl.value = String(cached.stallRounds ?? 5);
    if (statusEl && !silent) statusEl.textContent = "读取失败，已回退默认值";
  }
}

/** 保存限制到后端（越界值由后端按区间收敛） */
export async function saveExecLimits(): Promise<void> {
  const maxEl = $("#execMaxRounds") as HTMLInputElement | null;
  const stallEl = $("#execStallRounds") as HTMLInputElement | null;
  const statusEl = $("#execLimitsStatus") as HTMLElement | null;
  if (!maxEl || !stallEl) return;
  const maxRounds = Math.floor(Number(maxEl.value));
  const stallRounds = Math.floor(Number(stallEl.value));
  if (!Number.isFinite(maxRounds) || !Number.isFinite(stallRounds) || maxRounds < 1 || stallRounds < 1) {
    if (statusEl) statusEl.textContent = "请填写 ≥ 1 的整数";
    return;
  }
  if (statusEl) statusEl.textContent = "保存中…";
  try {
    const r = await fetch(state.API + "/api/exec/limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxRounds, stallRounds }),
    });
    const j = (await r.json()) as { limits?: { maxRounds?: number; stallRounds?: number } };
    const lim = j.limits ?? { maxRounds, stallRounds };
    maxEl.value = String(lim.maxRounds ?? maxRounds);
    stallEl.value = String(lim.stallRounds ?? stallRounds);
    try { localStorage.setItem(LIMITS_LS_KEY, JSON.stringify({ maxRounds: Number(maxEl.value), stallRounds: Number(stallEl.value) })); } catch { /* 忽略 */ }
    if (statusEl) statusEl.textContent = "已保存";
    showToast("执行限制已保存");
  } catch {
    if (statusEl) statusEl.textContent = "保存失败（后端不可达）";
  }
}

/** 恢复默认（500 轮 / 5 轮） */
export async function resetExecLimits(): Promise<void> {
  try {
    const r = await fetch(state.API + "/api/exec/limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    const j = (await r.json()) as { limits?: { maxRounds?: number; stallRounds?: number } };
    const maxEl = $("#execMaxRounds") as HTMLInputElement | null;
    const stallEl = $("#execStallRounds") as HTMLInputElement | null;
    if (maxEl) maxEl.value = String(j.limits?.maxRounds ?? 500);
    if (stallEl) stallEl.value = String(j.limits?.stallRounds ?? 5);
    const statusEl = $("#execLimitsStatus") as HTMLElement | null;
    if (statusEl) statusEl.textContent = "已恢复默认";
    showToast("已恢复默认：500 轮 / 5 轮");
  } catch {
    const statusEl = $("#execLimitsStatus") as HTMLElement | null;
    if (statusEl) statusEl.textContent = "恢复失败（后端不可达）";
  }
}

export function initRouter(): void {
  window.addEventListener("hashchange", onHashChange);
  if (!window.location.hash) window.location.hash = "#chat";
  onHashChange();
  void loadSidebarMemTree();
  void loadSkillMarket();
  syncTTSButton();
}
