// ========== 更多菜单 ==========
import { state } from "./state.js";
import { $ } from "./dom.js";

export function toggleMoreMenu(e: Event): void {
  e.stopPropagation();
  const menu = $("#moreMenu");
  if (state.moreMenuOpen) {
    menu.style.display = "none";
    state.moreMenuOpen = false;
  } else {
    menu.style.display = "block";
    state.moreMenuOpen = true;
    const tp = $("#themeQuickPanel");
    if (tp) tp.style.display = "none";
    state.themePanelOpen = false;
    setTimeout(() => {
      document.addEventListener("click", closeMoreMenu, { once: true });
    }, 10);
  }
}

export function closeMoreMenu(): void {
  const menu = $("#moreMenu");
  if (menu) menu.style.display = "none";
  state.moreMenuOpen = false;
}
