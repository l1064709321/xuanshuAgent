// ========== 头像抽屉 ==========
import { state } from "./state.js";
import { $, formatSize, showToast } from "./dom.js";
import { postJSON } from "./api.js";
import { viewMemFile } from "./memory.js";

export function openAvatarDrawer(): void {
  $("#avatarDrawer").classList.add("open");
  $("#avatarDrawerOverlay").classList.add("show");
  void loadDrawerMemList();
  const mainAvatar = $("#toolbarAvatar").textContent || "玄";
  $("#drawerAvatar").textContent = mainAvatar;
  const phone = localStorage.getItem("xuanshu_phone") || "—";
  $("#drawerPhone").textContent = phone;
  $("#drawerTokens").textContent = state.totalTokens + " tk";
}

export function closeAvatarDrawer(): void {
  $("#avatarDrawer").classList.remove("open");
  $("#avatarDrawerOverlay").classList.remove("show");
}

export async function loadDrawerMemList(): Promise<void> {
  const el = $("#drawerMemList");
  try {
    const d = await postJSON<{ ok?: boolean; entries?: { rel: string; size: number }[] }>("/api/memory/list", {});
    if (!d.ok || !d.entries || !d.entries.length) {
      el.innerHTML = '<div class="file-tree-loading">暂无记忆文件</div>';
      return;
    }
    el.innerHTML = d.entries.map(e => {
      const isDir = e.rel.endsWith("/");
      const name = isDir ? e.rel.replace(/\/$/, "").split("/").pop() || "" : e.rel.split("/").pop() || "";
      const ext = name.split(".").pop()?.toLowerCase() || "";
      // 等宽安全图标（避免 Linux 无 emoji 字体时渲染成乱码方块）
      const icoDir = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5h4l1.6 2h7.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/></svg>';
      const icoMd = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm-.5 1.7L12.8 6H9V2.7z"/></svg>';
      const icoJson = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 1H3a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 3 15h10a1.5 1.5 0 0 0 1.5-1.5V5L10 1H6zm.8 1.9L11 7H6.8V2.9zm-2.3 7h7v1.4h-7v-1.4z"/></svg>';
      const icoTxt = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm-.5 1.7L12.8 6H9V2.7zM5 8.4h6v1.3H5V8.4zm0 2.6h6v1.3H5V11z"/></svg>';
      const icoFile = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1z"/></svg>';
      const icon = isDir ? icoDir : ext === "md" ? icoMd : ext === "json" ? icoJson : ext === "txt" ? icoTxt : icoFile;
      const sizeHtml = isDir ? "" : '<span class="mem-tree-size">' + formatSize(e.size) + "</span>";
      return '<div class="drawer-mem-item" onclick="viewMemFile(\'' + e.rel.replace(/'/g, "\\'") + '\')">' +
        '<span class="mem-tree-icon">' + icon + "</span>" +
        '<span class="mem-tree-name">' + name + "</span>" +
        sizeHtml + "</div>";
    }).join("");
  } catch (e) {
    el.innerHTML = '<div class="file-tree-loading">加载失败</div>';
  }
}

export function uploadAvatarFromFile(input: HTMLInputElement): void {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = String(e.target?.result);
    const initial = file.name.charAt(0).toUpperCase();
    $("#toolbarAvatar").textContent = initial;
    $("#drawerAvatar").textContent = initial;
    const profileEl = document.getElementById("profileAvatar");
    if (profileEl) profileEl.textContent = initial;
    $("#sidebarAvatar").textContent = initial;
    localStorage.setItem("xuanshu_avatar", dataUrl);
    ["toolbarAvatar", "drawerAvatar", "profileAvatar", "sidebarAvatar"].forEach(id => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) {
        el.style.backgroundImage = "url(" + dataUrl + ")";
        el.style.backgroundSize = "cover";
        el.style.backgroundPosition = "center";
        el.style.color = "transparent";
        el.style.fontSize = "0";
      }
    });
    showToast("头像已更新");
  };
  reader.readAsDataURL(file);
  input.value = "";
}
