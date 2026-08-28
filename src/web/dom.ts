// ========== DOM 辅助 ==========

export function $(id: string): HTMLElement {
  const el = document.getElementById(id.replace(/^#/, ""));
  if (!el) throw new Error("缺少 DOM 节点: #" + id.replace(/^#/, ""));
  return el;
}

export function $q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function fmtTk(n: number): string {
  return n > 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

export function maskKeyText(key: string): string {
  if (!key || key.length < 8) return "••••";
  return key.slice(0, 6) + "•••" + key.slice(-4);
}

export function showToast(msg: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}
