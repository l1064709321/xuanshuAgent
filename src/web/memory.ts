// ========== 记忆（侧栏 + 个人主页 + 独立记忆库页） ==========
import { state } from "./state.js";
import { $, escapeHtml, formatSize, showToast } from "./dom.js";
import { postJSON } from "./api.js";

type MemEntry = { rel: string; size: number };
type MemNode = { rel: string; name: string; size: number; isDir: boolean; children: MemNode[] };

let memBackHash = "#chat";

// 等宽安全图标（避免 Linux 无 emoji 字体时渲染成乱码方块）
const ICO_FOLDER = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5h4l1.6 2h7.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/></svg>';
const ICO_FILE = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1z"/></svg>';
const ICO_MD = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm-.5 1.7L12.8 6H9V2.7z"/></svg>';
const ICO_JSON = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 1H3a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 3 15h10a1.5 1.5 0 0 0 1.5-1.5V5L10 1H6zm.8 1.9L11 7H6.8V2.9zm-2.3 7h7v1.4h-7v-1.4z"/></svg>';
const ICO_TXT = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm-.5 1.7L12.8 6H9V2.7zM5 8.4h6v1.3H5V8.4zm0 2.6h6v1.3H5V11z"/></svg>';

export function loadSidebarAvatar(): void {
  const base64 = localStorage.getItem("avatar");
  const profileEl = $("#profileAvatar") as HTMLElement | null;
  const toolbarEl = $("#toolbarAvatar") as HTMLElement;
  if (base64) {
    if (profileEl) { profileEl.style.backgroundImage = "url(" + base64 + ")"; profileEl.textContent = ""; }
    toolbarEl.style.backgroundImage = "url(" + base64 + ")";
    toolbarEl.textContent = "";
  } else {
    if (profileEl) { profileEl.style.backgroundImage = ""; profileEl.textContent = "玄"; }
    toolbarEl.style.backgroundImage = "";
    toolbarEl.textContent = "玄";
  }
}

export function uploadProfileAvatar(): void {
  const uploadEl = document.getElementById("profileAvatarUpload") as HTMLInputElement | null;
  const file = uploadEl?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 200;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const minDim = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - minDim) / 2, (img.height - minDim) / 2, minDim, minDim, 0, 0, 200, 200);
      const base64 = canvas.toDataURL("image/jpeg", 0.85);
      localStorage.setItem("avatar", base64);
      loadSidebarAvatar();
      showToast("头像已更新");
    };
    img.src = String(e.target?.result);
  };
  reader.readAsDataURL(file);
}

export async function readSidebarMemdir(rel: string): Promise<void> {
  try {
    const d = await postJSON<{ ok?: boolean; content?: string; error?: string }>("/api/memory/read", { rel });
    if (!d.ok) { showToast(d.error || "读取失败"); return; }
    showToast(rel + " 已复制到剪贴板");
    try { await navigator.clipboard.writeText(d.content || ""); } catch (e) { /* 忽略 */ }
  } catch (e) { showToast("读取失败"); }
}

// ── 树构建：将扁平 entries 组装为层级（目录 rel 以 / 结尾） ──
function buildMemTree(entries: MemEntry[]): MemNode[] {
  const root: MemNode[] = [];
  const dirMap = new Map<string, MemNode>();
  // 确保路径上的目录存在，返回叶子目录的 children
  const ensureDir = (parts: string[]): MemNode[] => {
    let cur = root;
    let acc = "";
    for (const p of parts) {
      acc = acc ? acc + "/" + p : p;
      const key = acc + "/";
      let d = dirMap.get(key);
      if (!d) {
        d = { rel: key, name: p, size: 0, isDir: true, children: [] };
        dirMap.set(key, d);
        cur.push(d);
      }
      cur = d.children;
    }
    return cur;
  };
  for (const e of entries) {
    const isDir = e.rel.endsWith("/");
    const rel = e.rel.replace(/\/+$/, "");
    const parts = rel.split("/");
    if (isDir) {
      const parents = ensureDir(parts.slice(0, -1));
      const key = rel + "/";
      if (!dirMap.has(key)) {
        const d: MemNode = { rel: key, name: parts[parts.length - 1], size: 0, isDir: true, children: [] };
        dirMap.set(key, d);
        parents.push(d);
      }
    } else {
      const parents = ensureDir(parts.slice(0, -1));
      parents.push({ rel: e.rel, name: parts[parts.length - 1], size: e.size, isDir: false, children: [] });
    }
  }
  return root;
}

// ── 渲染节点：目录可折叠（▸/▾），文件点击进独立阅读页 ──
function renderMemNodes(nodes: MemNode[], container: HTMLElement, indent: number): void {
  for (const n of nodes) {
    if (n.isDir) {
      const item = document.createElement("div");
      item.className = "mem-tree-folder";
      item.style.paddingLeft = (indent + 4) + "px";
      const arrow = document.createElement("span");
      arrow.className = "mem-tree-arrow";
      arrow.textContent = "▸";
      const icon = document.createElement("span");
      icon.className = "mem-tree-icon";
      icon.innerHTML = ICO_FOLDER;
      const name = document.createElement("span");
      name.className = "mem-tree-name";
      name.textContent = n.name;
      name.title = n.rel;
      item.append(arrow, icon, name);
      const kids = document.createElement("div");
      kids.className = "mem-tree-children";
      kids.style.display = "none";
      renderMemNodes(n.children, kids, indent + 14);
      item.addEventListener("click", () => {
        const open = kids.style.display !== "none";
        kids.style.display = open ? "none" : "block";
        arrow.textContent = open ? "▸" : "▾";
        item.classList.toggle("open", !open);
      });
      container.append(item, kids);
    } else {
      const item = document.createElement("div");
      item.className = "mem-tree-item";
      item.style.paddingLeft = (indent + 10) + "px";
      const icon = document.createElement("span");
      icon.className = "mem-tree-icon";
      const ext = n.name.split(".").pop()?.toLowerCase() || "";
      icon.innerHTML = ext === "md" ? ICO_MD : ext === "json" ? ICO_JSON : ext === "txt" ? ICO_TXT : ICO_FILE;
      const name = document.createElement("span");
      name.className = "mem-tree-name";
      name.textContent = n.name;
      name.title = n.rel;
      const size = document.createElement("span");
      size.className = "mem-tree-size";
      size.textContent = formatSize(n.size);
      item.addEventListener("click", () => viewMemFile(n.rel));
      item.append(icon, name, size);
      container.append(item);
    }
  }
}

async function fetchMemEntries(): Promise<MemEntry[]> {
  const d = await postJSON<{ ok?: boolean; entries?: MemEntry[]; error?: string }>("/api/memory/list", {});
  if (!d.ok || !d.entries) throw new Error(d.error || "加载失败");
  return d.entries;
}

export async function loadSidebarMemTree(): Promise<void> {
  const el = $("#sidebarMemTree");
  try {
    const entries = await fetchMemEntries();
    if (!entries.length) {
      el.innerHTML = '<div class="file-tree-loading">暂无记忆文件</div>';
      return;
    }
    el.innerHTML = "";
    renderMemNodes(buildMemTree(entries), el, 0);
  } catch (e) {
    el.innerHTML = '<div class="file-tree-loading">加载失败</div>';
  }
}

// ── 独立记忆库页（文件夹 + 记忆文件树形，类似扣子） ──
export async function openMemoryPage(): Promise<void> {
  const el = $("#memoryPageTree");
  el.innerHTML = '<div class="file-tree-loading">加载中…</div>';
  try {
    const entries = await fetchMemEntries();
    if (!entries.length) {
      el.innerHTML = '<div class="file-tree-loading">暂无记忆文件</div>';
      return;
    }
    el.innerHTML = "";
    renderMemNodes(buildMemTree(entries), el, 0);
  } catch (e) {
    el.innerHTML = '<div class="file-tree-loading">加载失败</div>';
  }
}

// ── 点文件 → 独立阅读页（全屏，含路径与返回） ──
export async function viewMemFile(rel: string): Promise<void> {
  try {
    const d = await postJSON<{ ok?: boolean; content?: string; error?: string }>("/api/memory/read", { rel });
    if (!d.ok) { showToast(d.error || "读取失败"); return; }
    memBackHash = location.hash && location.hash !== "#memory-view" ? location.hash : "#chat";
    $("#memoryViewPath").textContent = rel;
    const c = $("#memoryViewContent");
    c.textContent = d.content || "(空文件)";
    c.style.whiteSpace = "pre-wrap";
    c.style.fontFamily = "var(--mono)";
    c.style.fontSize = "13px";
    location.hash = "#memory-view";
  } catch (e) { showToast("读取失败"); }
}

export function backFromMemoryView(): void {
  location.hash = memBackHash && memBackHash !== "#memory-view" ? memBackHash : "#memory";
}

export function restoreAvatar(): void {
  const saved = localStorage.getItem("xuanshu_avatar");
  if (saved) {
    ["toolbarAvatar", "drawerAvatar", "profileAvatar", "sidebarAvatar"].forEach(id => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) {
        el.style.backgroundImage = "url(" + saved + ")";
        el.style.backgroundSize = "cover";
        el.style.backgroundPosition = "center";
        el.style.color = "transparent";
        el.style.fontSize = "0";
      }
    });
  }
}

export { escapeHtml };
