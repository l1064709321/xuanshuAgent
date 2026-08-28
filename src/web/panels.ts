// ========== 面板控制 / Hash 路由 ==========
import { state, IS_MOBILE } from "./state.js";
import { $ } from "./dom.js";
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
}

export function initRouter(): void {
  window.addEventListener("hashchange", onHashChange);
  if (!window.location.hash) window.location.hash = "#chat";
  onHashChange();
  void loadSidebarMemTree();
  void loadSkillMarket();
  syncTTSButton();
}
