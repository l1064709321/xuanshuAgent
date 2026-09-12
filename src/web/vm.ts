// ========== Linux 虚拟机模块（Web 桌面） ==========
// Ubuntu 风格虚拟桌面：终端 / 文件 / 代码编辑器 / 系统信息
// 后端：/api/vm/*（真实 bash 会话 + 工作区文件读写）
import { state } from "./state.js";
import { $ } from "./dom.js";
import { get, postJSON } from "./api.js";

declare global {
  interface Window { Terminal: unknown; }
}

const XTERM_CDN = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js";

type WindowId = string;
const windows = new Map<WindowId, { z: number; timer: ReturnType<typeof setInterval> | null; sessionId: string }>();
let zTop = 100;
let term: { open: (el: HTMLElement) => void; write: (s: string) => void; onData: (cb: (s: string) => void) => void; dispose: () => void; fit?: () => void } | null = null;
let termEl: HTMLElement | null = null;
let editorPath = "";
let fileStack: string[] = [];

// ── 入口：进入虚拟机页面时初始化桌面（检测桌面已构建则跳过，避免重复监听） ──
export function initVM(): void {
  const desk = $("#vmDesktop");
  if (!desk) return;
  if (desk.querySelector(".vm-topbar")) return;

  desk.innerHTML = `
    <div class="vm-topbar" id="vmTopbar">
      <div class="vm-topbar-left">
        <span class="vm-topbar-logo">&#9679;&#9679;&#9679;</span>
        <span class="vm-topbar-title">玄姝 Linux</span>
      </div>
      <div class="vm-topbar-right">
        <button class="vm-back-btn" id="vmBackBtn" title="返回对话">&#8592; 返回对话</button>
        <span id="vmClock"></span>
      </div>
    </div>
    <div class="vm-icons" id="vmIcons">
      <div class="vm-app-icon" data-app="terminal"><span class="vm-ico">&#9608;</span><span class="vm-ico-label">终端</span></div>
      <div class="vm-app-icon" data-app="files"><span class="vm-ico">&#128193;</span><span class="vm-ico-label">文件</span></div>
      <div class="vm-app-icon" data-app="editor"><span class="vm-ico">&#9998;</span><span class="vm-ico-label">代码编辑器</span></div>
      <div class="vm-app-icon" data-app="monitor"><span class="vm-ico">&#128200;</span><span class="vm-ico-label">系统监视器</span></div>
      <div class="vm-app-icon" data-app="info"><span class="vm-ico">&#9881;</span><span class="vm-ico-label">系统信息</span></div>
      <div class="vm-app-icon" data-app="vm2"><span class="vm-ico">&#128421;</span><span class="vm-ico-label">虚拟机</span></div>
    </div>
    <div class="vm-windows" id="vmWindows"></div>
  `;

  // 返回对话：清空桌面并回聊天页（下次再进入重新构建）
  const backBtn = desk.querySelector<HTMLElement>("#vmBackBtn");
  backBtn?.addEventListener("click", () => {
    for (const id of Array.from(windows.keys())) closeVMWindow(id);
    desk.innerHTML = "";
    window.location.hash = "#chat";
  });

  desk.querySelectorAll(".vm-app-icon").forEach((el) => {
    el.addEventListener("click", () => openVMApp((el as HTMLElement).dataset.app || ""));
  });

  // 时钟
  const tick = () => {
    const c = $("#vmClock");
    if (c) c.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  };
  tick();
  setInterval(tick, 1000);

  // 首次进入自动打开终端
  setTimeout(() => openVMApp("terminal"), 100);
}

// ── 窗口管理 ──
export function openVMApp(app: string): void {
  const host = $("#vmWindows");
  if (!host) return;
  // 同应用窗口去重：已存在则置顶聚焦
  const existing = Array.from(host.querySelectorAll<HTMLElement>(".vm-window"))
    .find(w => (w.dataset.wid || "").startsWith("vmw_" + app + "_"));
  if (existing) {
    bringTop(existing.dataset.wid || "");
    return;
  }
  const id = "vmw_" + app + "_" + Date.now().toString(36);

  const titles: Record<string, string> = { terminal: "终端", files: "文件", editor: "代码编辑器", monitor: "系统监视器", info: "系统信息", vm2: "虚拟机管理器" };
  const win = document.createElement("div");
  win.className = "vm-window";
  win.dataset.wid = id;
  win.style.zIndex = String(++zTop);
  win.innerHTML = `
    <div class="vm-win-titlebar">
      <span class="vm-win-title">${titles[app] || app}</span>
      <button class="vm-win-close" title="关闭">&#10005;</button>
    </div>
    <div class="vm-win-body"></div>
  `;
  win.querySelector(".vm-win-close")!.addEventListener("click", () => closeVMWindow(id));

  // 标题栏拖拽（仅指针设备）
  const tb = win.querySelector(".vm-win-titlebar") as HTMLElement;
  tb.addEventListener("mousedown", (e) => {
    const startX = e.clientX, startY = e.clientY;
    const r = win.getBoundingClientRect();
    win.style.position = "absolute";
    win.style.left = r.left + "px";
    win.style.top = r.top + "px";
    const mv = (ev: MouseEvent) => {
      win.style.left = r.left + (ev.clientX - startX) + "px";
      win.style.top = r.top + (ev.clientY - startY) + "px";
    };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
    bringTop(id);
  });
  win.addEventListener("mousedown", () => bringTop(id));

  const body = win.querySelector(".vm-win-body") as HTMLElement;
  switch (app) {
    case "terminal": renderTerminal(body, id); break;
    case "files": renderFiles(body); break;
    case "editor": renderEditor(body, ""); break;
    case "monitor": renderMonitor(body, id); break;
    case "info": renderInfo(body); break;
    case "vm2": renderVm2(body); break;
  }
  host.appendChild(win);
  bringTop(id);
}

export function closeVMWindow(id: string): void {
  const w = document.querySelector(`.vm-window[data-wid="${id}"]`);
  w?.remove();
  const rec = windows.get(id);
  if (rec) {
    if (rec.timer) clearInterval(rec.timer);
    if (rec.sessionId) void postJSON("/api/vm/session/" + rec.sessionId, {}).catch(() => undefined);
    windows.delete(id);
  }
  // 终端窗口关闭时销毁 xterm 实例：同一 Terminal 实例二次 open() 不会挂载（导致二次进入终端空白）
  if (id.startsWith("vmw_terminal_")) {
    try { term?.dispose?.(); } catch { /* noop */ }
    term = null;
    termEl = null;
  }
  // 关闭最后一个窗口时自动返回对话页，避免停留在空白桌面
  if (windows.size === 0 && window.location.hash === "#vm") {
    const desk = $("#vmDesktop");
    if (desk) desk.innerHTML = "";
    window.location.hash = "#chat";
  }
}

function bringTop(id: string): void {
  const w = document.querySelector(`.vm-window[data-wid="${id}"]`) as HTMLElement | null;
  if (w) w.style.zIndex = String(++zTop);
}

// ── 终端窗口 ──
async function renderTerminal(body: HTMLElement, winId: string): Promise<void> {
  body.innerHTML = '<div class="vm-term-root"></div>';
  termEl = body.querySelector(".vm-term-root")!;
  const status = document.createElement("div");
  status.className = "vm-term-status";
  status.textContent = "连接中…";
  body.appendChild(status);

  try {
    const { ok, id } = await postJSON<{ ok: boolean; id: string }>("/api/vm/session", {});
    if (!ok) { status.textContent = "会话创建失败"; return; }
    await ensureTerm();
    const t = term!;
    const root = body.querySelector(".vm-term-root")!;
    t.open(root as HTMLElement);
    t.onData((d: string) => { void postJSON("/api/vm/session/" + id + "/write", { data: d }).catch(() => undefined); });
    status.textContent = "bash — 真实 Linux 会话（cd / 写代码 / 跑命令均可）";
    status.classList.add("vm-term-status-ok");

    const timer = setInterval(() => {
      void get<{ ok: boolean; data: string }>("/api/vm/session/" + id + "/read").then((r) => {
        if (r.ok && r.data && term) term.write(r.data);
      }).catch(() => undefined);
    }, 100);
    windows.set(winId, { z: ++zTop, timer, sessionId: id });
    termEl = body.querySelector(".vm-term-root");
    void t.fit?.();
  } catch (e) {
    status.textContent = "终端连接失败: " + String(e);
  }
}

function ensureTerm(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (term) return resolve();
    const w = window as unknown as { Terminal?: unknown };
    const opts = {
      fontFamily: "'JetBrains Mono', monospace", fontSize: 13,
      theme: { background: "#0d0f17", foreground: "#e6e6e6", cursor: "#8b5cf6" },
      scrollback: 5000, cursorBlink: true,
    };
    if (w.Terminal) { term = new (w.Terminal as new (opts: object) => typeof term)(opts); resolve(); return; }
    const s = document.createElement("script");
    s.src = XTERM_CDN;
    s.onload = () => {
      const w2 = window as unknown as { Terminal?: unknown };
      if (!w2.Terminal) { reject(new Error("xterm 加载失败")); return; }
      term = new (w2.Terminal as new (opts: object) => typeof term)(opts);
      resolve();
    };
    s.onerror = () => reject(new Error("xterm CDN 加载失败，请检查网络"));
    document.head.appendChild(s);
  });
}

// ── 文件窗口 ──
async function renderFiles(body: HTMLElement): Promise<void> {
  body.innerHTML = `
    <div class="vm-files-head">
      <button class="vm-btn vm-btn-sm" data-act="up">&#8593; 上级</button>
      <span class="vm-files-path" data-role="path">/</span>
    </div>
    <div class="vm-files-list" data-role="list"><div class="vm-files-empty">加载中…</div></div>
  `;
  const listEl = body.querySelector('[data-role="list"]') as HTMLElement;
  const pathEl = body.querySelector('[data-role="path"]') as HTMLElement;
  const upBtn = body.querySelector('[data-act="up"]') as HTMLElement;

  let curPath = "";    // 服务端返回的真实当前目录
  let rootPath = "";   // 工作区根（不可再上溯）

  const load = async (path: string) => {
    listEl.innerHTML = '<div class="vm-files-empty">加载中…</div>';
    try {
      const d = await postJSON<{ ok: boolean; path?: string; root?: string; entries?: { name: string; path: string; type: "file" | "dir"; size: number }[]; error?: string }>("/api/vm/ls", { path });
      if (!d.ok) { pathEl.textContent = curPath || "/"; listEl.innerHTML = '<div class="vm-files-empty">' + (d.error || "加载失败") + "</div>"; return; }
      curPath = d.path || curPath;
      rootPath = d.root || rootPath;
      pathEl.textContent = curPath && curPath !== rootPath ? curPath : "/";
      listEl.innerHTML = (d.entries || []).map((e) =>
        '<div class="vm-file-row" data-type="' + e.type + '" data-path="' + e.path.replace(/"/g, "&quot;") + '">' +
        '<span class="vm-file-ico">' + (e.type === "dir" ? "&#128193;" : "&#128196;") + "</span>" +
        '<span class="vm-file-name">' + e.name + "</span>" +
        '<span class="vm-file-size">' + (e.type === "file" ? (e.size > 1024 ? (e.size / 1024).toFixed(1) + " KB" : e.size + " B") : "") + "</span></div>"
      ).join("") || '<div class="vm-files-empty">空目录</div>';

      listEl.querySelectorAll(".vm-file-row").forEach((row) => {
        row.addEventListener("dblclick", () => openRow(row as HTMLElement));
        row.addEventListener("click", () => openRow(row as HTMLElement));
      });
    } catch {
      listEl.innerHTML = '<div class="vm-files-empty">服务未启动</div>';
    }
  };

  const openRow = (row: HTMLElement) => {
    const path = row.dataset.path || "";
    if (row.dataset.type === "dir") {
      fileStack.push(curPath);
      void load(path);
    } else {
      const name = row.querySelector(".vm-file-name")?.textContent || path.split("/").pop() || "";
      openVMApp("editor");
      setTimeout(() => openEditorFile(path, name), 50);
    }
  };

  upBtn.addEventListener("click", () => {
    fileStack = [];
    // 已在工作区根：不再上溯（平台源码不可见）
    if (!curPath || curPath === rootPath) { void load(""); return; }
    const idx = curPath.lastIndexOf("/");
    void load(idx > 0 ? curPath.slice(0, idx) : "");
  });

  void load("");
}

// ── 编辑器窗口 ──
function renderEditor(body: HTMLElement, path: string): void {
  editorPath = path;
  body.innerHTML = `
    <div class="vm-ed-head">
      <input class="vm-ed-path" data-role="path" value="${path}" placeholder="/项目内路径，如 src/server.ts" spellcheck="false">
      <button class="vm-btn vm-btn-primary vm-btn-sm" data-act="save">保存</button>
      <span class="vm-ed-status" data-role="status"></span>
    </div>
    <textarea class="vm-ed-textarea" data-role="code" placeholder="// 在这里写代码…" spellcheck="false"></textarea>
  `;
  const status = body.querySelector('[data-role="status"]') as HTMLElement;
  const pathInput = body.querySelector('[data-role="path"]') as HTMLInputElement;
  const code = body.querySelector('[data-role="code"]') as HTMLTextAreaElement;

  (body.querySelector('[data-act="save"]') as HTMLElement).addEventListener("click", async () => {
    const p = pathInput.value.trim();
    if (!p) { status.textContent = "请先填写文件路径"; return; }
    status.textContent = "保存中…";
    try {
      const d = await postJSON<{ ok: boolean; error?: string; size?: number }>("/api/vm/write", { path: p, content: code.value });
      if (!d.ok) status.textContent = "保存失败: " + (d.error || "未知错误");
      else { status.textContent = "已保存 " + d.size + " B"; editorPath = p; }
    } catch { status.textContent = "保存失败: 服务未启动"; }
  });

  if (path) void openEditorFile(path, path.split("/").pop() || "");
}

async function openEditorFile(path: string, _name: string): Promise<void> {
  const body = document.querySelector('.vm-window:last-of-type .vm-ed-textarea') as HTMLTextAreaElement | null;
  if (!body) return;
  const pathInput = document.querySelector('.vm-window:last-of-type [data-role="path"]') as HTMLInputElement | null;
  const status = document.querySelector('.vm-window:last-of-type [data-role="status"]') as HTMLElement | null;
  if (pathInput) pathInput.value = path;
  if (status) status.textContent = "读取中…";
  try {
    const d = await postJSON<{ ok: boolean; binary?: boolean; content?: string; size?: number; error?: string }>("/api/vm/read", { path });
    if (!d.ok) { if (status) status.textContent = "读取失败: " + (d.error || ""); return; }
    if (d.binary) { if (status) status.textContent = "二进制文件，无法编辑"; return; }
    body.value = d.content ?? "";
    if (status) status.textContent = d.size + " B · 可编辑保存";
  } catch { if (status) status.textContent = "读取失败: 服务未启动"; }
}

// ── 系统监视器窗口（实时资源 + 进程） ──
interface StatsResp {
  ok?: boolean; ts?: number;
  cpu?: { pct: number; cores: number; loadavg: number[] };
  mem?: { total: number; used: number; free: number; pct: number };
  disk?: { total: number; used: number; free: number; pct: number } | null;
  procs?: { pid: number; user: string; cpu: number; mem: number; rss: number; cmd: string }[];
}

function fmtSize(kb: number): string {
  if (!kb || kb <= 0) return "0";
  const mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(0) + " MB";
  return (mb / 1024).toFixed(1) + " GB";
}

function renderMonitor(body: HTMLElement, winId: string): void {
  body.innerHTML = `
    <div class="vm-mon" data-role="mon">
      <div class="vm-mon-gauges">
        <div class="vm-mon-gauge">
          <div class="vm-mon-g-label">CPU</div>
          <div class="vm-mon-bar"><div class="vm-mon-bar-fill vm-mon-cpu" style="width:0%"></div></div>
          <div class="vm-mon-g-val" data-role="cpu">0%</div>
        </div>
        <div class="vm-mon-gauge">
          <div class="vm-mon-g-label">内存</div>
          <div class="vm-mon-bar"><div class="vm-mon-bar-fill vm-mon-mem" style="width:0%"></div></div>
          <div class="vm-mon-g-val" data-role="mem">0%</div>
        </div>
        <div class="vm-mon-gauge">
          <div class="vm-mon-g-label">磁盘</div>
          <div class="vm-mon-bar"><div class="vm-mon-bar-fill vm-mon-disk" style="width:0%"></div></div>
          <div class="vm-mon-g-val" data-role="disk">0%</div>
        </div>
      </div>
      <div class="vm-mon-sub" data-role="sub"></div>
      <div class="vm-mon-procs">
        <div class="vm-mon-proc-head"><span>进程</span><span class="vm-mon-refresh">每 2s 刷新</span></div>
        <div class="vm-mon-proc-list" data-role="procs"></div>
      </div>
    </div>
  `;
  const cpuEl = body.querySelector('[data-role="cpu"]') as HTMLElement;
  const memEl = body.querySelector('[data-role="mem"]') as HTMLElement;
  const diskEl = body.querySelector('[data-role="disk"]') as HTMLElement;
  const subEl = body.querySelector('[data-role="sub"]') as HTMLElement;
  const procsEl = body.querySelector('[data-role="procs"]') as HTMLElement;

  const paint = (d: StatsResp) => {
    if (!d.ok) { subEl.textContent = "监控接口不可用"; return; }
    const cpu = d.cpu || { pct: 0, cores: 0, loadavg: [] };
    const mem = d.mem || { total: 0, used: 0, free: 0, pct: 0 };
    const disk = d.disk;
    cpuEl.textContent = cpu.pct + "%";
    (body.querySelector(".vm-mon-cpu") as HTMLElement).style.width = Math.min(100, cpu.pct) + "%";
    memEl.textContent = mem.pct + "%";
    (body.querySelector(".vm-mon-mem") as HTMLElement).style.width = Math.min(100, mem.pct) + "%";
    diskEl.textContent = (disk ? disk.pct : 0) + "%";
    (body.querySelector(".vm-mon-disk") as HTMLElement).style.width = Math.min(100, disk ? disk.pct : 0) + "%";
    subEl.innerHTML =
      "CPU " + cpu.cores + " 核 · 负载 " + (cpu.loadavg || []).join(" / ") + "<br>" +
      "内存 " + fmtSize(mem.used) + " / " + fmtSize(mem.total) + "（空闲 " + fmtSize(mem.free) + "）<br>" +
      "磁盘 " + (disk ? fmtSize(disk.used) + " / " + fmtSize(disk.total) + "（可用 " + fmtSize(disk.free) + "）" : "n/a");
    procsEl.innerHTML = (d.procs || []).map((p) =>
      '<div class="vm-mon-proc"><span class="vm-mon-pid">' + p.pid + "</span>" +
      '<span class="vm-mon-puser">' + p.user + "</span>" +
      '<span class="vm-mon-pcpu">' + p.cpu.toFixed(1) + "%</span>" +
      '<span class="vm-mon-pmem">' + p.mem.toFixed(1) + "%</span>" +
      '<span class="vm-mon-pcmd">' + p.cmd + "</span></div>"
    ).join("") || '<div class="vm-files-empty">无数据</div>';
  };

  const timer = setInterval(() => {
    void get<StatsResp>("/api/vm/stats").then(paint).catch(() => undefined);
  }, 2000);
  windows.set(winId, { z: ++zTop, timer, sessionId: "" });
  void get<StatsResp>("/api/vm/stats").then(paint).catch(() => undefined);
}

// ── 系统信息窗口 ──
async function renderInfo(body: HTMLElement): Promise<void> {
  body.innerHTML = '<div class="vm-info-loading">加载中…</div>';
  try {
    const d = await get<{
      ok: boolean; hostname?: string; platform?: string; arch?: string; release?: string;
      uptime?: number; loadavg?: number[]; cpus?: number; memTotal?: number; memFree?: number;
      disk?: string; cwd?: string; uname?: string;
    }>("/api/vm/info");
    if (!d.ok) { body.innerHTML = '<div class="vm-info-loading">获取失败</div>'; return; }
    const upt = d.uptime || 0;
    const hh = Math.floor(upt / 3600), mm = Math.floor((upt % 3600) / 60);
    const rows: [string, string][] = [
      ["主机名", d.hostname || "n/a"],
      ["系统", (d.platform || "") + " " + (d.arch || "") + " · " + (d.release || "")],
      ["内核", d.uname || "n/a"],
      ["运行时间", hh + "h " + mm + "m"],
      ["负载(1/5/15)", (d.loadavg || []).join(" / ")],
      ["CPU", d.cpus + " 核"],
      ["内存", d.memFree + " MB 空闲 / " + d.memTotal + " MB 总量"],
      ["磁盘(已用/可用/使用%/挂载)", d.disk || "n/a"],
      ["工作目录", d.cwd || "n/a"],
    ];
    body.innerHTML = '<div class="vm-info-grid">' + rows.map(([k, v]) =>
      '<div class="vm-info-row"><span class="vm-info-k">' + k + '</span><span class="vm-info-v">' + v + "</span></div>"
    ).join("") + "</div>";
  } catch {
    body.innerHTML = '<div class="vm-info-loading">服务未启动</div>';
  }
}

// ── 虚拟机管理器窗口（VM2：QEMU 真机虚拟化 / Bash 降级） ──
interface Vm2Engine { engine: string; accel: string; qemuPath: string | null; native: boolean; platform: string; detail: string; }
interface Vm2Item { name: string; memMb: number; diskGb: number; iso: string | null; engine: string; running: boolean; pid: number | null; vncPort: number | null; }
interface Vm2Iso { file: string; path: string; }

const ACCEL_LABEL: Record<string, string> = {
  kvm: "KVM 硬件加速", whpx: "WHPX 硬件加速", hvf: "HVF 硬件加速", tcg: "TCG 软件模拟", none: "无",
};

async function renderVm2(body: HTMLElement): Promise<void> {
  body.innerHTML = '<div class="vm2-loading">检测虚拟化引擎…</div>';
  let eng: Vm2Engine | null = null;
  try { eng = await get<Vm2Engine>("/api/vm2/engine"); } catch { /* noop */ }

  body.innerHTML = `
    <div class="vm2-wrap">
      <div class="vm2-engine ${eng?.engine === "qemu" ? "vm2-engine-ok" : "vm2-engine-warn"}">
        <b>虚拟化引擎：</b>
        <span class="vm2-badge">${eng?.engine ?? "none"}</span>
        <span class="vm2-badge vm2-badge-accel">${ACCEL_LABEL[eng?.accel ?? "none"] ?? eng?.accel ?? "none"}</span>
        <span class="vm2-engine-detail">${eng?.detail ?? "引擎检测失败"}</span>
      </div>
      <div class="vm2-tools">
        <button id="vm2Refresh" class="vm2-btn">刷新</button>
        <button id="vm2New" class="vm2-btn vm2-btn-primary">新建虚拟机</button>
      </div>
      <div id="vm2List" class="vm2-list"></div>
      <div id="vm2Create" class="vm2-create hidden">
        <div class="vm2-create-title">新建虚拟机</div>
        <label>名称 <input id="vm2Name" class="vm2-input" placeholder="如 alpine-vm" /></label>
        <label>内存 <select id="vm2Mem" class="vm2-input">
          <option value="1024">1 GB</option><option value="2048" selected>2 GB</option><option value="3072">3 GB</option>
        </select></label>
        <label>磁盘 <select id="vm2Disk" class="vm2-input">
          <option value="10">10 GB</option><option value="20">20 GB</option><option value="40">40 GB</option><option value="60" selected>60 GB</option>
        </select></label>
        <label>安装镜像(ISO) <select id="vm2Iso" class="vm2-input"><option value="">无（空磁盘）</option></select></label>
        <div class="vm2-create-actions">
          <button id="vm2CreateBtn" class="vm2-btn vm2-btn-primary">创建并启动</button>
          <button id="vm2CreateCancel" class="vm2-btn">取消</button>
        </div>
      </div>
    </div>
  `;

  // ISO 下拉
  try {
    const isos = await get<Vm2Iso[]>("/api/vm2/iso");
    const sel = body.querySelector<HTMLSelectElement>("#vm2Iso");
    if (sel && Array.isArray(isos)) {
      sel.innerHTML = '<option value="">无（空磁盘）</option>' + isos.map((i) =>
        `<option value="${i.file}">${i.file}</option>`).join("");
    }
  } catch { /* noop */ }

  const loadList = async (): Promise<void> => {
    let list: Vm2Item[] = [];
    try { list = await get<Vm2Item[]>("/api/vm2/list"); } catch { /* noop */ }
    const box = body.querySelector<HTMLElement>("#vm2List");
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div class="vm2-empty">还没有虚拟机。点"新建虚拟机"创建一台（有 QEMU 时启动独立系统，无 QEMU 时自动降级内置终端）。</div>';
      return;
    }
    box.innerHTML = list.map((v) => `
      <div class="vm2-item">
        <div class="vm2-item-head">
          <b>${v.name}</b>
          <span class="vm2-state ${v.running ? "vm2-state-on" : "vm2-state-off"}">${v.running ? "运行中" : "已停止"}</span>
          <span class="vm2-item-meta">${v.memMb}MB · ${v.diskGb}GB${v.iso ? " · ISO:" + v.iso : ""} · ${v.engine}</span>
        </div>
        <div class="vm2-item-actions">
          ${v.running
            ? `<button class="vm2-btn vm2-btn-stop" data-act="stop" data-name="${v.name}">停止</button>
               <button class="vm2-btn" data-act="shot" data-name="${v.name}">截图</button>`
            : `<button class="vm2-btn vm2-btn-primary" data-act="start" data-name="${v.name}">启动</button>`}
          <button class="vm2-btn vm2-btn-del" data-act="del" data-name="${v.name}">删除</button>
        </div>
        ${v.running ? `<div class="vm2-shot" id="shot-${v.name}"></div>` : ""}
      </div>
    `).join("");
    box.querySelectorAll<HTMLElement>("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act, name = btn.dataset.name || "";
        if (act === "start") {
          btn.textContent = "启动中…";
          try {
            const r = await postJSON<{ ok: boolean; error?: string; engine?: Vm2Engine }>("/api/vm2/start", { name });
            if (!r.ok) { alert(r.error || "启动失败"); }
          } catch { alert("启动失败"); }
          await loadList();
        } else if (act === "stop") {
          await postJSON("/api/vm2/stop", { name });
          await loadList();
        } else if (act === "del") {
          if (!confirm("删除虚拟机 " + name + "？其磁盘镜像将一并删除（不可恢复）")) return;
          await postJSON("/api/vm2/delete", { name });
          await loadList();
        } else if (act === "shot") {
          const img = body.querySelector<HTMLImageElement>(`#shot-${name} img`);
          if (img) { img.src = "/api/vm2/screenshot?name=" + encodeURIComponent(name) + "&t=" + Date.now(); }
          else {
            const box2 = body.querySelector<HTMLElement>(`#shot-${name}`);
            if (box2) { box2.innerHTML = '<img src="/api/vm2/screenshot?name=' + encodeURIComponent(name) + '&t=' + Date.now() + '" alt="screen" />'; }
          }
        }
      });
    });
  };
  await loadList();

  body.querySelector<HTMLElement>("#vm2Refresh")?.addEventListener("click", () => void loadList());
  body.querySelector<HTMLElement>("#vm2New")?.addEventListener("click", () => {
    body.querySelector<HTMLElement>("#vm2Create")?.classList.remove("hidden");
  });
  body.querySelector<HTMLElement>("#vm2CreateCancel")?.addEventListener("click", () => {
    body.querySelector<HTMLElement>("#vm2Create")?.classList.add("hidden");
  });
  body.querySelector<HTMLElement>("#vm2CreateBtn")?.addEventListener("click", async () => {
    const name = (body.querySelector<HTMLInputElement>("#vm2Name")?.value || "").trim();
    if (!name) { alert("请输入名称"); return; }
    const memMb = Number(body.querySelector<HTMLSelectElement>("#vm2Mem")?.value || 2048);
    const diskGb = Number(body.querySelector<HTMLSelectElement>("#vm2Disk")?.value || 60);
    const iso = body.querySelector<HTMLSelectElement>("#vm2Iso")?.value || "";
    const btn = body.querySelector<HTMLElement>("#vm2CreateBtn");
    if (btn) btn.textContent = "创建中…";
    try {
      const r = await postJSON<{ ok: boolean; error?: string }>("/api/vm2/create", { name, memMb, diskGb, iso: iso || undefined });
      if (!r.ok) { alert(r.error || "创建失败"); if (btn) btn.textContent = "创建并启动"; return; }
      await postJSON("/api/vm2/start", { name });
      body.querySelector<HTMLElement>("#vm2Create")?.classList.add("hidden");
      await loadList();
    } catch { alert("创建失败"); if (btn) btn.textContent = "创建并启动"; }
  });
}
