// ========== 权限弹窗 ==========
import { $ } from "./dom.js";
import { postJSON } from "./api.js";
import { addBubble } from "./chat.js";

export function showPermission(permType: string, desc: string): void {
  $("#permTitle").textContent = "权限请求: " + permType;
  $("#permTypeVal").textContent = permType;
  const sep = desc.indexOf("||");
  const target = sep !== -1 ? desc.slice(0, sep).trim() : "&mdash;";
  const reason = sep !== -1 ? desc.slice(sep + 2).trim() : desc;
  $("#permTargetVal").textContent = target;
  $("#permReason").textContent = reason;
  $("#permOverlay").setAttribute("data-perm", permType);
  $("#permOverlay").classList.add("show");
}

export function hidePermission(): void {
  $("#permOverlay").classList.remove("show");
}

export function permitReply(action: string): void {
  const permType = $("#permOverlay").getAttribute("data-perm") || "screencap";
  hidePermission();
  const cmd = "/" + permType + " " + action;
  postJSON<{ reply?: string }>("/api/chat", { msg: cmd }).then(d => addBubble("system", d.reply || "")).catch(() => addBubble("system", "请求失败"));
}
