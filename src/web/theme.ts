// ========== 主题切换 ==========
import { state } from "./state.js";
import { $ } from "./dom.js";

export function setMode(mode: string): void {
  document.documentElement.setAttribute("data-mode", mode);
  localStorage.setItem("marvis-mode", mode);
  const dark = $("#modeDark");
  const light = $("#modeLight");
  dark?.classList.toggle("active", mode === "dark");
  light?.classList.toggle("active", mode === "light");
}

export function setAccent(accent: string): void {
  document.documentElement.setAttribute("data-accent", accent);
  localStorage.setItem("marvis-accent", accent);
  ["Cyber", "Forest", "Sakura", "Leather"].forEach(a => {
    $("#chip" + a)?.classList.toggle("active", a.toLowerCase() === accent);
  });
}

export function initTheme(): void {
  let savedMode = localStorage.getItem("marvis-mode");
  let savedAccent = localStorage.getItem("marvis-accent");
  // 兼容旧键（快速面板历史版本写入 marvis-theme-*），读取后迁移
  if (!savedMode) savedMode = localStorage.getItem("marvis-theme-mode");
  if (!savedAccent) savedAccent = localStorage.getItem("marvis-theme-accent");
  if (!savedMode) savedMode = "dark";
  if (!savedAccent) savedAccent = "cyber";
  setMode(savedMode);
  setAccent(savedAccent);
  localStorage.removeItem("marvis-theme-mode");
  localStorage.removeItem("marvis-theme-accent");
}

export function toggleThemeQuickPanel(e?: Event): void {
  if (e) e.stopPropagation();
  const panel = $("#themeQuickPanel");
  if (state.themePanelOpen) {
    panel.style.display = "none";
    state.themePanelOpen = false;
  } else {
    panel.style.display = "flex";
    state.themePanelOpen = true;
    // 面板互斥：关闭全局设置面板
    const sp = $("#settingsPanel");
    const so = $("#settingsOverlay");
    if (sp) sp.classList.remove("open");
    if (so) so.classList.remove("show");
    const mm = $("#moreMenu");
    if (mm) mm.style.display = "none";
    state.moreMenuOpen = false;
    const curAccent = document.documentElement.getAttribute("data-accent") || "cyber";
    const curMode = document.documentElement.getAttribute("data-mode") || "dark";
    document.querySelectorAll<HTMLElement>(".tqp-chip").forEach(c => {
      c.classList.toggle("active", c.dataset.accent === curAccent && c.dataset.mode === curMode);
    });
    setTimeout(() => {
      document.addEventListener("click", () => {
        panel.style.display = "none";
        state.themePanelOpen = false;
      }, { once: true });
    }, 10);
  }
}

export function applyQuick(accent: string, mode: string): void {
  setAccent(accent);
  setMode(mode);
  document.querySelectorAll<HTMLElement>(".tqp-chip").forEach(c => c.classList.toggle("active", c.dataset.accent === accent && c.dataset.mode === mode));
  const accSel = document.getElementById("themeAccent") as HTMLSelectElement | null;
  const modeSel = document.getElementById("themeMode") as HTMLSelectElement | null;
  if (accSel) accSel.value = accent;
  if (modeSel) modeSel.value = mode;
  const panel = $("#themeQuickPanel");
  if (panel) { panel.style.display = "none"; state.themePanelOpen = false; }
}
