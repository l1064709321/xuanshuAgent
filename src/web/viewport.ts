// ========== 移动端视口适配：输入区随键盘自动收放 ==========
// 监听 visualViewport，键盘弹出时高度收缩 → 输入区自动顶起贴近键盘；
// 键盘收起时恢复贴底。桌面端无 visualViewport 变化，不受影响。

function applyViewportHeight(): void {
  const vv = window.visualViewport;
  const docEl = document.documentElement;
  if (!vv) {
    // 不支持 visualViewport 的浏览器：回退 100dvh（已是默认）
    docEl.style.removeProperty("--vvh");
    return;
  }
  // 键盘弹出时 visualViewport.height < layout viewport 高度
  const h = Math.round(vv.height);
  docEl.style.setProperty("--vvh", h + "px");
  // 同步滚动位置，避免键盘弹出时页面被顶乱
  if (vv.offsetTop > 0) {
    window.scrollTo(0, window.scrollY);
  }
}

export function initViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  applyViewportHeight();
  vv.addEventListener("resize", applyViewportHeight, { passive: true });
  vv.addEventListener("scroll", applyViewportHeight, { passive: true });
  window.addEventListener("orientationchange", () => setTimeout(applyViewportHeight, 200), { passive: true });
}
