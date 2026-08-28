// ========== 工作区文件树 / 文件查看器 ==========
import { state } from "./state.js";
import { $, escapeHtml, formatSize } from "./dom.js";
import { postJSON } from "./api.js";

// 等宽安全图标（避免 Linux 无 emoji 字体时渲染成乱码方块）
const ICO_DIR = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5h4l1.6 2h7.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/></svg>';
const ICO_FILE = '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm-.5 1.7L12.8 6H9V2.7z"/></svg>';

export async function loadWorkspaceFiles(): Promise<void> {
  try {
    const d = await postJSON<{ ok?: boolean; entries?: { path: string; name: string; size: number; type?: string }[] }>("/api/vm/ls", {});
    const el = $("#sidebarFileTree");
    if (!d.ok) {
      el.innerHTML = '<div class="file-tree-loading">文件服务未启动</div>';
      return;
    }
    el.innerHTML = (d.entries || []).map(e =>
      e.type === "dir"
        ? '<div class="ft-item ft-dir">' + ICO_DIR + ' <span class="ft-name">' + escapeHtml(e.name) + "</span></div>"
        : '<div class="ft-item ft-file" onclick="openFileInViewer(\'' + e.path.replace(/'/g, "\\'") + '\',\'' + e.name.replace(/'/g, "\\'") + '\')">' +
        ICO_FILE + ' <span class="ft-name">' + escapeHtml(e.name) + "</span><span class=\"ft-size\">" + formatSize(e.size) + "</span></div>"
    ).join("") || '<div class="file-tree-loading">暂无上传文件，点击输入框旁的 + 上传</div>';
  } catch (e) {
    $("#sidebarFileTree").innerHTML = '<div class="file-tree-loading">文件服务未启动</div>';
  }
}

export async function openFileInViewer(path: string, name: string): Promise<void> {
  const panel = $("#fileViewerPanel");
  $("#fvPath").textContent = path;
  $("#fvMeta").textContent = "加载中…";
  $("#fvContent").innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">加载中…</div>';
  panel.style.display = "";
  try {
    const d = await postJSON<{ ok?: boolean; error?: string; size?: number; lines?: number; type?: string; ext?: string; content?: string; binary?: boolean }>("/api/vm/read", { path });
    if (!d.ok) {
      $("#fvMeta").textContent = "错误: " + (d.error || "未知错误");
      $("#fvContent").innerHTML = "";
      return;
    }
    $("#fvMeta").textContent = name + " — " + formatSize(d.size || 0) + " — " + (d.lines ?? 0) + " 行";
    if (d.binary) {
      $("#fvContent").innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">无法预览二进制文件 (' + (d.ext || "") + ")</div>";
    } else {
      $("#fvContent").innerHTML = '<pre class="fv-code">' + escapeHtml(d.content || "") + "</pre>";
    }
    panel.scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    $("#fvMeta").textContent = "加载失败: 服务未启动";
    $("#fvContent").innerHTML = "";
  }
}

export function closeFileViewer(): void {
  $("#fileViewerPanel").style.display = "none";
}

export function showFileContent(name: string, content: string, type: string): void {
  const panel = $("#fileViewerPanel");
  $("#fvPath").textContent = name;
  $("#fvMeta").textContent = content.length + " 字符 · 只读";
  const fvContent = $("#fvContent");
  if (type === "text") {
    fvContent.textContent = content;
    fvContent.style.whiteSpace = "pre-wrap";
    fvContent.style.fontFamily = "var(--mono)";
    fvContent.style.fontSize = "13px";
  }
  panel.style.display = "flex";
}
