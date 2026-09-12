// ========== 左侧边栏分区折叠 ==========
// 侧栏「会话 / 文件 / 记忆 / 技能市场」四个分区支持点击标题折叠/展开，
// 状态持久化到 localStorage，刷新后保持。
// 默认：会话展开；文件 / 记忆 / 技能市场 收起——避免侧栏被长列表撑满、必须滚动才能看到下面的分区。
// 说明：分区正文外层用 .sidebar-sec-body(display:contents) 包裹，展开时不改变原有 flex 布局，收起时整块 display:none。

const LS_KEY = "xs.sidebar.secs";

/** 各分区默认展开状态 */
const DEFAULT_OPEN: Record<string, boolean> = {
  sessions: true,
  files: false,
  memory: false,
  skills: false,
};

let secState: Record<string, boolean> = { ...DEFAULT_OPEN };

function loadState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_OPEN };
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    const merged: Record<string, boolean> = { ...DEFAULT_OPEN };
    for (const k of Object.keys(DEFAULT_OPEN)) {
      if (typeof parsed[k] === "boolean") merged[k] = parsed[k];
    }
    return merged;
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

function saveState(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(secState));
  } catch {
    /* 隐私模式等写入失败可忽略，仅本次会话生效 */
  }
}

/** 把某个分区的展开态同步到 DOM */
function applySection(sec: string): void {
  const open = secState[sec] === true;
  document.querySelectorAll<HTMLElement>(`.sidebar-section-label[data-sec="${sec}"]`).forEach((btn) => {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("title", open ? "收起" : "展开");
  });
  document.querySelectorAll<HTMLElement>(`.sidebar-sec-body[data-sec-body="${sec}"]`).forEach((body) => {
    body.classList.toggle("sec-collapsed", !open);
  });
}

export function toggleSidebarSection(sec: string): void {
  secState[sec] = !(secState[sec] === true);
  applySection(sec);
  saveState();
}

export function initSidebarSections(): void {
  secState = loadState();
  const btns = document.querySelectorAll<HTMLElement>(".sidebar-section-label[data-sec]");
  btns.forEach((btn) => {
    const sec = btn.dataset.sec ?? "";
    if (!sec) return;
    applySection(sec);
    if (btn.dataset.secBound === "1") return;
    btn.dataset.secBound = "1";
    btn.addEventListener("click", () => toggleSidebarSection(sec));
  });
  // 视图内树异步渲染不改变外层显隐；此处兜底重放一次，避免其他模块重建 DOM 后状态丢失
  window.addEventListener("hashchange", () => {
    Object.keys(DEFAULT_OPEN).forEach(applySection);
  });
}
