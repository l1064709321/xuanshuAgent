// ========== 账号系统 ==========
// 【2026-08-23】手机号登录功能已按需求临时移除（登录/注册/退出/门禁校验均禁用）。
// 恢复方法：还原下方被注释的旧实现（switchAuthTab/doSendCode/doRegister/doLogin/doLogout），
// 并在 index.html 恢复 authOverlay DOM、main.ts 恢复挂载即可。
import { state } from "./state.js";
import { $ } from "./dom.js";

export function showAuth(): void {
  // 登录门禁已禁用：保留空实现仅为兼容调用方
}

export function hideAuth(): void {
  const app = document.querySelector(".app") as HTMLElement | null;
  if (app) app.style.display = "flex";
}

export async function checkAuth(): Promise<void> {
  // 手机号登录已移除：直接放行进入主界面，不再校验 token
  hideAuth();
}

export function initAuthInputs(): void {
  const inp = $("#msg-input") as HTMLTextAreaElement;

  // 粘贴图片：保留（聊天输入功能，与登录无关）
  inp.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          state.pendingImage = String(reader.result);
          const preview = $("#imagePreview");
          preview.innerHTML = '<img src="' + state.pendingImage + '" style="max-height:60px;border-radius:6px;border:2px solid var(--cinnabar);vertical-align:middle">';
          preview.style.display = "inline-block";
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });
}
