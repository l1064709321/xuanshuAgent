// ========== 移动端视口适配：输入区随键盘自动收放 ==========
// 监听 visualViewport，键盘弹出时高度收缩 → 输入区自动顶起贴近键盘；
// 键盘收起时恢复贴底。桌面端无 visualViewport 变化，不受影响。

function applyViewportHeight(): void {
  const vv = window.visualViewport;
  const docEl = document.documentElement;
  let h: number;
  if (vv) {
    h = Math.round(vv.height);
  } else {
    // 不支持 visualViewport 的浏览器（部分内置 webview）：
    // 直接使用布局视口高度，保证 .app 始终有明确 px 高度
    h = window.innerHeight;
  }
  const winH = window.innerHeight;
  // 键盘收起 / 窗口还原 / 切回前台时：显式设置 --vvh = innerHeight(px)，
  // 不再 removeProperty 回退到 100dvh —— 部分内置 webview 对 dvh 解析异常
  // （可能返回文档高度或无效值），导致 .app 高度失真、输入区被挤出视口。
  if (!vv || h >= winH - 1) {
    docEl.style.setProperty("--vvh", winH + "px");
    return;
  }
  // 键盘弹出时 visualViewport.height < layout viewport 高度
  docEl.style.setProperty("--vvh", h + "px");
  // 同步滚动位置，避免键盘弹出时页面被顶乱
  if (vv.offsetTop > 0) {
    window.scrollTo(0, window.scrollY);
  }
}

export function initViewport(): void {
  const vv = window.visualViewport;
  if (vv) {
    applyViewportHeight();
    vv.addEventListener("resize", applyViewportHeight, { passive: true });
    vv.addEventListener("scroll", applyViewportHeight, { passive: true });
    window.addEventListener("orientationchange", () => setTimeout(applyViewportHeight, 200), { passive: true });
  }
  // 浏览器窗口缩放 / 最小化后还原：visualViewport 可能不触发 resize，需主动重算
  window.addEventListener("resize", applyViewportHeight, { passive: true });
  // 切回前台（移动端切后台再回来 / 桌面端最小化还原）时强制重算高度
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      requestAnimationFrame(applyViewportHeight);
    }
  }, { passive: true });
  // 首帧后 / 资源加载完成后各重算一次：部分内置 webview 初始 innerHeight
  // 偏小或 dvh 解析异常，延迟重算可确保输入区贴底可见
  requestAnimationFrame(applyViewportHeight);
  window.addEventListener("load", () => setTimeout(applyViewportHeight, 100), { passive: true });
}
