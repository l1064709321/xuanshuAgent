// ========== 对话 / TTS / 持久化 ==========
import { state, CONV_KEY, META_KEY, SESSION_KEY } from "./state.js";
import { $, escapeHtml, showToast } from "./dom.js";
import { postJSON } from "./api.js";
import { buildModelChips } from "./models.js";
import { showPermission } from "./permission.js";
import { loadWorkspaceFiles, showFileContent } from "./files.js";
import type { ChatResponse, ThinkingStep, RestoredMsg } from "./types.js";
import { toSpeakable } from "./speakable.js";

const TOOL_META: Record<string, { icon: string; tag: string; cls: string }> = {
  "anysearch": { icon: "🔍", tag: "搜索", cls: "tc-tag-search" },
  "web_search": { icon: "🌐", tag: "搜索", cls: "tc-tag-search" },
  "search_wikipedia": { icon: "📖", tag: "百科", cls: "tc-tag-search" },
  "web_fetch": { icon: "🕷️", tag: "抓取", cls: "tc-tag-search" },
  "get_weather": { icon: "🌤️", tag: "天气", cls: "tc-tag-search" },
  "run_code": { icon: "⚡", tag: "代码", cls: "tc-tag-code" },
  "read_file": { icon: "📄", tag: "文件", cls: "tc-tag-file" },
  "list_files": { icon: "📂", tag: "文件", cls: "tc-tag-file" },
  "write_file": { icon: "✏️", tag: "文件", cls: "tc-tag-file" },
  "edit_file": { icon: "✏️", tag: "文件", cls: "tc-tag-file" },
  "decompile": { icon: "🔬", tag: "逆向", cls: "tc-tag-code" },
  "decompile_detect": { icon: "🔬", tag: "逆向", cls: "tc-tag-code" },
  "browser_navigate": { icon: "🧭", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_extract": { icon: "📑", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_click": { icon: "👆", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_type": { icon: "⌨️", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_screenshot": { icon: "📸", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_scroll": { icon: "🔄", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_get_state": { icon: "📋", tag: "浏览器", cls: "tc-tag-browser" },
  "browser_wait": { icon: "⏳", tag: "浏览器", cls: "tc-tag-browser" },
  "sys_info": { icon: "🖥️", tag: "系统", cls: "tc-tag-system" },
  "process_list": { icon: "📊", tag: "进程", cls: "tc-tag-system" },
  "process_kill": { icon: "💀", tag: "进程", cls: "tc-tag-system" },
  "disk_usage": { icon: "💾", tag: "磁盘", cls: "tc-tag-system" },
  "memory_usage": { icon: "🧠", tag: "内存", cls: "tc-tag-system" },
  "cpu_info": { icon: "⚙️", tag: "CPU", cls: "tc-tag-system" },
  "network_info": { icon: "🌐", tag: "网络", cls: "tc-tag-system" },
  "pkg_install": { icon: "📦", tag: "包管理", cls: "tc-tag-system" },
  "pkg_search": { icon: "🔎", tag: "包管理", cls: "tc-tag-system" },
  "pkg_remove": { icon: "🗑️", tag: "包管理", cls: "tc-tag-system" },
  "adb_check": { icon: "📱", tag: "ADB", cls: "tc-tag-system" },
  "adb_screenshot": { icon: "📸", tag: "ADB", cls: "tc-tag-system" },
  "adb_tap": { icon: "👆", tag: "ADB", cls: "tc-tag-system" },
  "adb_swipe": { icon: "👉", tag: "ADB", cls: "tc-tag-system" },
  "adb_type": { icon: "⌨️", tag: "ADB", cls: "tc-tag-system" },
  "git_log": { icon: "📜", tag: "Git", cls: "tc-tag-file" },
  "git_revert": { icon: "⏪", tag: "Git", cls: "tc-tag-file" },
  "git_status": { icon: "📋", tag: "Git", cls: "tc-tag-file" },
  "memdir_read": { icon: "🧠", tag: "记忆", cls: "tc-tag-memory" },
  "memdir_write": { icon: "💾", tag: "记忆", cls: "tc-tag-memory" },
  "memdir_search": { icon: "🔍", tag: "记忆", cls: "tc-tag-memory" },
};

function convEl(): HTMLElement { return $("#conv"); }
function inpEl(): HTMLTextAreaElement { return $("#msg-input") as HTMLTextAreaElement; }

// ── 思考链 HTML（Codex 风格深灰只读块，无警号） ──
function buildThinkingChainHtml(thinkings: ThinkingStep[]): string {
  if (!thinkings || thinkings.length === 0) return "";
  const defaultMeta = { icon: "🔧", tag: "工具", cls: "tc-tag-code" };
  const steps = thinkings.map(t => {
    const tools = (t.tool || "").split(",").filter(Boolean).map(s => s.trim());
    const toolBadges = tools.map(tn => {
      const m = TOOL_META[tn] || defaultMeta;
      return '<span class="tc-tool-icon">' + m.icon + '</span><span class="tc-tool-name">' + tn + '</span><span class="tc-tool-tag ' + m.cls + '">' + m.tag + "</span>";
    }).join("");
    const thoughtText = escapeHtml(t.thought || "");
    return '<div class="tc-step">' +
      '<div class="tc-tool-bar"><span class="tc-round">#' + t.round + "</span>" + toolBadges + "</div>" +
      '<div class="tc-thought">' + thoughtText + "</div></div>";
  }).join("");
  return '<details class="thinking-chain">' +
    "<summary><span>✦ 思考链</span><span class=\"tc-badge\">" + thinkings.length + " 步</span></summary>" +
    '<div class="thinking-timeline">' + steps + "</div></details>";
}

// ── 思考过程按钮：位于气泡头「玄姝」右侧，点击展开/收起独立思考面板 ──
function buildThinkToggleHtml(): string {
  return '<button class="btn-think-toggle" type="button" aria-label="展开/收起思考过程">' +
    '<span class="btn-think-label">思考过程</span><span class="btn-think-arrow">▸</span></button>';
}

// 绑定按钮 ↔ 思考链展开状态；思考面板独立于回复正文（默认折叠，点击才展开）
function wireThinkToggle(d: HTMLElement): void {
  const btn = d.querySelector(".btn-think-toggle") as HTMLButtonElement | null;
  const details = d.querySelector("details.thinking-chain") as HTMLDetailsElement | null;
  if (!btn || !details) return;
  const arrow = btn.querySelector(".btn-think-arrow") as HTMLElement | null;
  const sync = () => {
    const open = details.open;
    if (arrow) arrow.textContent = open ? "▾" : "▸";
    btn.classList.toggle("think-open", open);
  };
  btn.disabled = false;
  sync();
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    details.open = !details.open;
    sync();
  });
}

// ── 询问弹窗：Agent 需要用户拍板时弹出（[ASK:问题] 协议） ──
let _askResolve: ((answer: string | null) => void) | null = null;

function showAskDialog(question: string): Promise<string | null> {
  const overlay = $("#askOverlay") as HTMLElement | null;
  const qEl = $("#askQuestion") as HTMLElement | null;
  const inp = $("#askInput") as HTMLTextAreaElement | null;
  if (!overlay || !qEl || !inp) return Promise.resolve(null);
  qEl.textContent = question;
  inp.value = "";
  overlay.classList.add("show");
  return new Promise<string | null>((resolve) => {
    _askResolve = resolve;
    setTimeout(() => inp.focus(), 50);
  });
}

export function askSubmit(): void {
  const overlay = $("#askOverlay") as HTMLElement | null;
  const inp = $("#askInput") as HTMLTextAreaElement | null;
  const r = _askResolve;
  _askResolve = null;
  if (overlay) overlay.classList.remove("show");
  const ans = inp?.value.trim() || "";
  if (r) r(ans);
}

export function askCancel(): void {
  const overlay = $("#askOverlay") as HTMLElement | null;
  const r = _askResolve;
  _askResolve = null;
  if (overlay) overlay.classList.remove("show");
  if (r) r(null);
}

// 检测回复中的 [ASK:...] 标记，弹出询问弹窗；用户答复后自动续问
async function handleAskIfAny(content: string): Promise<boolean> {
  const m = content.match(/\[ASK:([\s\S]*?)\]/);
  if (!m) return false;
  const question = m[1].trim();
  const answer = await showAskDialog(question);
  if (answer) {
    inpEl().value = answer;
    void send();
  }
  return true;
}

// ── 超长消息自动转 txt：>3000 字时生成 txt 文件卡片，完整内容交给 Agent 读取 ──
async function autoLongMsgToTxt(raw: string): Promise<string> {
  const name = "long-msg-" + Date.now() + ".txt";
  // 1) 前端生成可下载 txt 文件
  const blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  // 2) 上传到后端 workspace，供 Agent 读取完整内容
  let filePath = "";
  try {
    const fd = new FormData();
    fd.append("files", new File([raw], name, { type: "text/plain;charset=utf-8" }));
    const r = await fetch(state.API + "/api/workspace/upload-batch", { method: "POST", body: fd });
    const d = (await r.json()) as { ok?: boolean; uploaded?: { path: string }[]; error?: string };
    if (d.ok && d.uploaded && d.uploaded[0]) filePath = d.uploaded[0].path;
  } catch { /* 上传失败则仅前端展示 */ }

  // 3) 前端气泡显示 txt 文件卡片（可下载）
  const d = document.createElement("div");
  d.className = "bubble user longmsg-card";
  d.innerHTML = '<div class="longmsg-head">📄 长消息已转 txt（' + raw.length + ' 字）</div>' +
    '<div class="longmsg-file"><span class="longmsg-name">' + name + '</span>' +
    '<a class="longmsg-dl" href="' + url + '" download="' + name + '">下载</a></div>' +
    (filePath ? '<div class="longmsg-path">' + filePath + "</div>" : "");
  convEl().appendChild(d);
  scrollConvToBottom(true);

  // 4) 发给 Agent 的消息：文件路径 + 简短摘要
  const preview = raw.slice(0, 120);
  return "[用户发送了超长文本，已保存为文件 " + name + (filePath ? "（" + filePath + "）" : "（前端附件）") + "，共 " + raw.length + " 字。请先读取该文件获取完整内容再作答。文件开头预览：" + preview + "...]";
}

// ── 对话区滚动：显式 scrollTop 方案，兼容移动端 WebView，避免 scrollIntoView 失效/动画被打断 ──
export function scrollConvToBottom(smooth = false): void {
  requestAnimationFrame(() => {
    const el = convEl();
    if (smooth && "scrollTo" in el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  });
}

// ── 语音朗读 ──
export function syncTTSButton(): void {
  const btn = $("#ttsToggleBtn") as HTMLElement | null;
  if (!btn) return;
  btn.classList.toggle("tts-on", state.ttsEnabled);
  btn.textContent = state.ttsEnabled ? "🔉" : "🔊";
  btn.title = state.ttsEnabled ? "语音朗读：开" : "语音朗读：关";
}

export function toggleTTS(): void {
  state.ttsEnabled = !state.ttsEnabled;
  localStorage.setItem("xuanshu_tts", state.ttsEnabled ? "on" : "off");
  syncTTSButton();
  if (!state.ttsEnabled && state.ttsAudio) {
    state.ttsAudio.pause();
    state.ttsAudio = null;
  }
}

export async function readAloud(btn: HTMLElement): Promise<void> {
  // 朗读对象是气泡里的正文：先剥掉 Markdown 语法与代码块本体，避免把 ``` 和代码逐字念出来
  const raw = decodeURIComponent((btn.dataset.text || "").replace(/\+/g, "%20"));
  const text = toSpeakable(raw);
  if (!text) return;
  if (state.ttsAudio) {
    state.ttsAudio.pause();
    state.ttsAudio = null;
  }
  btn.style.opacity = "0.5";
  try {
    const r = await fetch(state.API + "/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, speed: 1.0 }),
    });
    if (!r.ok) throw new Error("TTS failed");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    state.ttsAudio = new Audio(url);
    const done = () => {
      URL.revokeObjectURL(url);
      state.ttsAudio = null;
      btn.style.opacity = "";
    };
    state.ttsAudio.onended = done;
    state.ttsAudio.onerror = done;
    await state.ttsAudio.play();
  } catch (e) {
    console.error("朗读失败:", e);
    btn.style.opacity = "";
    state.ttsAudio = null;
  }
}

// ── 语音输入（Web Speech API） ──
let _recognition: unknown = null;
let _recording = false;

export function startVoiceInput(): void {
  const w = window as unknown as Record<string, unknown>;
  const SR = (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onend: (() => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
  }) | undefined;
  if (!SR) {
    showToast("当前浏览器不支持语音输入");
    return;
  }
  const micBtn = $("#micBtn") as HTMLElement | null;
  const inp = inpEl();

  if (_recording) {
    (_recognition as { stop(): void }).stop();
    return;
  }

  try {
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.interimResults = true;
    rec.continuous = false;

    rec.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i] as unknown as { isFinal: boolean; 0: { transcript: string } };
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) final += t;
        else interim += t;
      }
      const cur = inp.value.trim();
      inp.value = final || interim || cur;
      inp.style.height = "auto";
      inp.style.height = inp.scrollHeight + "px";
    };

    rec.onend = () => {
      _recording = false;
      if (micBtn) micBtn.classList.remove("recording");
      if (inp.value.trim()) inp.focus();
    };

    rec.onerror = (e) => {
      _recording = false;
      if (micBtn) micBtn.classList.remove("recording");
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        showToast("未获得麦克风权限");
      } else if (e.error !== "aborted" && e.error !== "no-speech") {
        showToast("语音识别失败: " + e.error);
      }
    };

    _recognition = rec;
    _recording = true;
    if (micBtn) micBtn.classList.add("recording");
    rec.start();
  } catch (e) {
    _recording = false;
    if (micBtn) micBtn.classList.remove("recording");
    showToast("语音输入启动失败");
  }
}

// ── 历史携带方式（Phase 1 起已变更）──
// 此前：前端从 DOM 抽取最近 24 轮文本回传（buildHistoryMessages，已移除）；
// 现在：服务端按 session_id 从磁盘恢复结构化消息链，前端仅发送 session_id + msg。
// ── 发送消息 ──
export async function send(): Promise<void> {
  const raw = inpEl().value.trim();
  const btn = document.querySelector(".pill-send") as HTMLButtonElement | null;
  if (!raw) { showToast("请输入消息内容"); return; }
  inpEl().value = "";
  inpEl().style.height = "auto";

  // 超长消息（>3000 字）自动转为 txt 文件：前端生成下载文件并显示为文件卡片
  let text = raw;
  if (raw.length > 3000) {
    text = await autoLongMsgToTxt(raw);
    if (!text) { showToast("长文本处理失败"); return; }
  }
  addBubble("user", text);
  if (!state.hasKey) {
    addBubble("system", "未配置 API Key，请先在设置面板中填写 Key");
    return;
  }
  if (btn) btn.disabled = true;
  const img = state.pendingImage;
  if (img) {
    state.pendingImage = null;
    const prev = $("#imagePreview");
    prev.style.display = "none";
    prev.innerHTML = "";
  }

  // 优先 SSE 流式：思考过程实时展示
  const streamed = await streamSend(text, img);
  if (!streamed) {
    // 回退非流式
    const typingEl = addTyping();
    try {
      const body: Record<string, unknown> = { msg: text, session_id: state.currentSessionId };
      if (img) body.image = img;
      const d = await postJSON<ChatResponse>("/api/chat", body);
      typingEl.remove();
      state.totalTokens += text.length;
      if (d.session_id) { state.currentSessionId = d.session_id; localStorage.setItem(SESSION_KEY, d.session_id); }
      renderChatResponse(d);
    } catch (e) {
      typingEl.remove();
      addBubble("system", "请求失败 — 请检查 API Key 或当前模型");
    }
  }
  if (btn) btn.disabled = false;
  inpEl().focus();
}

// ── SSE 流式对话：思考实时展示（无警号，正常推导过程） ──
// ── 多 Agent 协同群聊：每个子 Agent 以独立消息块冒泡（名字行+思考过程+正文），样式对齐主 Agent ──
interface SubAgentBox {
  root: HTMLElement;        // .agent-msg.sub-agent-msg
  thinkSlot: HTMLElement | null;
  liveEl: HTMLElement | null;   // thinking-live（实时灰块），收尾后替换为 details
  liveText: HTMLElement | null;
  toolLog: HTMLElement | null;  // .agent-tool-log（工具调用过程）
  replyEl: HTMLElement | null;  // .agent-sub-reply（最终汇报正文）
  stateEl: HTMLElement | null;
  thinkBtn: HTMLElement | null;
  thinkRound: number;
  hasReasoning: boolean;
  /** 断点暂停信息（轮数上限 / 无进展熔断），由 markAgentPaused 写入、markAgentDone 渲染 */
  paused?: { reason: string; rounds: number; detail: string };
}
const subAgentBoxes = new Map<string, SubAgentBox>();

function agentFriendlyName(name: string): string {
  return name;
}

/** 子 Agent 收到派发：以独立"群聊成员"身份在消息流冒泡 */
function showAgentWorking(agent: string, task: string): void {
  const key = agent;
  const name = agentFriendlyName(agent);
  const taskBrief = task.length > 80 ? task.slice(0, 80) + "…" : task;
  const box: SubAgentBox = {
    root: null as never, thinkSlot: null, liveEl: null, liveText: null,
    toolLog: null, replyEl: null, stateEl: null, thinkBtn: null,
    thinkRound: 0, hasReasoning: false,
  };
  const d = document.createElement("div");
  d.className = "agent-msg sub-agent-msg";
  const liveToggleHtml = buildThinkToggleHtml()
    .replace('class="btn-think-toggle"', 'class="btn-think-toggle think-open"')
    .replace('>▸<', '>▾<');
  d.innerHTML =
    '<div class="agent-label">' +
    '<span class="agent-sub-tag">子任务</span>' +
    '<span class="agent-work-avatar">' + name.charAt(0) + '</span>' +
    '<span class="agent-name agent-work-name">@' + name + '</span>' +
    '<span class="agent-work-state">工作中…</span>' + liveToggleHtml +
    '</div>' +
    '<div class="agent-think-slot"></div>' +
    '<div class="bubble agent">' +
    '<div class="agent-work-task">任务：' + escapeHtml(taskBrief) + "</div>" +
    '<div class="agent-tool-log"></div>' +
    '<div class="agent-sub-reply"></div>' +
    "</div>";
  box.root = d;
  box.thinkSlot = d.querySelector(".agent-think-slot");
  box.toolLog = d.querySelector(".agent-tool-log");
  box.replyEl = d.querySelector(".agent-sub-reply");
  box.stateEl = d.querySelector(".agent-work-state");
  box.thinkBtn = d.querySelector(".btn-think-toggle");

  // 实时思考灰块（与主 Agent 同一套 thinking-live）
  const thinkEl = document.createElement("div");
  thinkEl.className = "thinking-live";
  thinkEl.innerHTML = '<div class="tc-live-header"><span class="tc-live-dot"></span><span>思考中</span></div><div class="tc-thought-live"></div>';
  box.thinkSlot?.appendChild(thinkEl);
  box.liveEl = thinkEl;
  box.liveText = thinkEl.querySelector(".tc-thought-live");
  // 思考中可点击折叠/展开实时面板
  const liveBtn = box.thinkBtn as HTMLButtonElement | null;
  liveBtn?.addEventListener("click", () => {
    if (!thinkEl.isConnected) return;
    const hidden = thinkEl.style.display === "none";
    thinkEl.style.display = hidden ? "" : "none";
    liveBtn.classList.toggle("think-open", hidden);
    const arrow = liveBtn.querySelector(".btn-think-arrow") as HTMLElement | null;
    if (arrow) arrow.textContent = hidden ? "▾" : "▸";
  });
  // 群聊位置：追加在会话流末尾（可能紧跟在派发方主消息之后）
  convEl().appendChild(d);
  subAgentBoxes.set(key, box);
  scrollConvToBottom(true);
}

/** 子 Agent 思考链更新：实时灰块直接替换文本（多轮到达则展示最新一轮） */
function appendAgentThink(agent: string, thought: string): void {
  const box = subAgentBoxes.get(agent);
  if (!box) return;
  box.hasReasoning = true;
  box.thinkRound += 1;
  if (box.liveText) box.liveText.textContent = thought;
  scrollConvToBottom(true);
}

/** 子 Agent 工具调用/结果：追加到正文顶部日志区 */
function appendAgentLog(agent: string, type: "tool" | "tool_done", payload: { round?: number; tool?: string; args?: string; result?: string }): void {
  const box = subAgentBoxes.get(agent);
  if (!box || !box.toolLog) return;
  const round = payload.round ? "第" + payload.round + "轮 " : "";
  let row: HTMLElement;
  if (type === "tool") {
    row = document.createElement("div");
    row.className = "awl-row awl-tool";
    const argsBrief = (payload.args ?? "").length > 120 ? (payload.args ?? "").slice(0, 120) + "…" : (payload.args ?? "");
    row.innerHTML = '<span class="awl-tag">工具</span>' + round + escapeHtml(payload.tool ?? "?") + '<span class="awl-args"> ' + escapeHtml(argsBrief) + "</span>";
  } else {
    row = document.createElement("div");
    row.className = "awl-row awl-result";
    const resultBrief = (payload.result ?? "").length > 180 ? (payload.result ?? "").slice(0, 180) + "…" : (payload.result ?? "");
    row.innerHTML = '<span class="awl-tag">结果</span>' + round + escapeHtml(payload.tool ?? "") + " → " + escapeHtml(resultBrief);
  }
  box.toolLog.appendChild(row);
  scrollConvToBottom(true);
}

/** 子 Agent 断点暂停（轮数上限 / 无进展熔断）：先挂状态，最终渲染交给 markAgentDone */
function markAgentPaused(agent: string, reason: string, rounds: number, detail: string): void {
  const box = subAgentBoxes.get(agent);
  if (!box) return;
  box.paused = { reason, rounds, detail };
  if (box.stateEl) {
    box.stateEl.textContent = reason === "stall" ? "⏸ 无进展熔断" : "⏸ 达轮数上限";
    box.stateEl.classList.remove("done", "fail");
    box.stateEl.classList.add("paused");
  }
  scrollConvToBottom(true);
}

/** 子 Agent 工作结束：状态更新 + 思考链折叠(与主 Agent 一致) + 最终汇报入正文 */
function markAgentDone(agent: string, ok: boolean, summary: string): void {
  const box = subAgentBoxes.get(agent);
  if (!box || !box.root) return;
  const paused = box.paused;
  if (box.stateEl) {
    if (paused) {
      box.stateEl.textContent = paused.reason === "stall" ? "⏸ 无进展熔断" : "⏸ 达轮数上限";
      box.stateEl.classList.remove("done", "fail");
      box.stateEl.classList.add("paused");
    } else {
      box.stateEl.textContent = ok ? "✓ 完成" : "✗ 失败";
      box.stateEl.classList.toggle("done", ok);
      box.stateEl.classList.toggle("fail", !ok);
    }
  }
  const nameEl = box.root.querySelector(".agent-name.agent-work-name") as HTMLElement | null;
  if (!ok && !paused && nameEl) nameEl.classList.add("fail");

  // 思考链收尾：thinking-live → 折叠 details（与主 Agent 同款灰块链）
  if (box.liveEl && box.hasReasoning) {
    const liveText = box.liveText?.textContent?.trim() ?? "";
    if (liveText) {
      const wrap = document.createElement("div");
      wrap.innerHTML = buildThinkingChainHtml([{ round: 1, thought: liveText }]);
      const details = wrap.firstElementChild as HTMLDetailsElement;
      box.liveEl.replaceWith(details);
      details.open = false;
      // 复用主 Agent 的按钮↔思考链联动
      const btn = box.thinkBtn as HTMLButtonElement | null;
      if (btn) wireThinkToggle(box.root);
    } else {
      box.liveEl.remove();
      const btn = box.thinkBtn as HTMLElement | null;
      if (btn) btn.remove();
    }
  } else if (box.liveEl) {
    box.liveEl.remove();
    const btn = box.thinkBtn as HTMLElement | null;
    if (btn) btn.remove();
  }

  // 最终汇报正文
  if (box.replyEl) {
    const brief = summary.length > 500 ? summary : summary;
    if (paused) {
      // 断点暂停：展示暂停说明 + 一键续轮（已完成的产物保留，接着做而不是从头重跑）
      const title = paused.reason === "stall"
        ? "已连续多轮无进展，自动熔断暂停"
        : "已达到单次执行轮数上限，暂停待续轮";
      const wrap = document.createElement("div");
      wrap.style.cssText = "border-left:3px solid #d29922;background:rgba(210,153,34,.08);padding:10px 12px;border-radius:6px;margin:4px 0";
      const tEl = document.createElement("div");
      tEl.style.cssText = "font-weight:600;margin-bottom:4px";
      tEl.textContent = title;
      const dsc = document.createElement("div");
      dsc.style.cssText = "font-size:12px;opacity:.8;margin-bottom:6px";
      dsc.textContent = `${paused.detail || ""}（已执行 ${paused.rounds} 轮）`;
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:12px;opacity:.8;margin-bottom:8px";
      hint.textContent = "已完成的产物已保留，续轮会接着做，不会从头重写。";
      const btn = document.createElement("button");
      btn.className = "btn btn-primary";
      btn.style.cssText = "font-size:12px;padding:4px 10px";
      btn.textContent = "继续执行";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        const inp = inpEl();
        inp.value = "继续";
        void send();
      });
      wrap.append(tEl, dsc, hint, btn);
      box.replyEl.appendChild(wrap);
      if (brief.trim()) {
        const det = document.createElement("details");
        det.style.cssText = "margin-top:6px;font-size:12px;opacity:.85";
        const sm = document.createElement("summary");
        sm.textContent = "断点详情";
        const pre = document.createElement("pre");
        pre.style.cssText = "white-space:pre-wrap;margin:6px 0 0";
        pre.textContent = brief.trim();
        det.append(sm, pre);
        box.replyEl.appendChild(det);
      }
    } else if (ok && brief.trim()) {
      box.replyEl.innerHTML = renderMarkdown(brief.trim());
    } else if (!ok && brief.trim()) {
      box.replyEl.innerHTML = '<span style="color:#f85149">' + escapeHtml(brief) + "</span>";
    }
  }
  subAgentBoxes.delete(agent);
  scrollConvToBottom(true);
}

async function streamSend(text: string, img: string | null | undefined): Promise<boolean> {
  const typingEl = addTyping();
  // 外层 .agent-msg：三层分离 —— 名字行(玄姝+思考过程按钮) / 思考面板(灰块) / 正文气泡
  const d = document.createElement("div");
  d.className = "agent-msg";
  // 思考中按钮呈展开态（▾ 灰块实时可见），可点击折叠/展开实时面板；收尾后由 wireThinkToggle 接管
  const liveToggleHtml = buildThinkToggleHtml()
    .replace('class="btn-think-toggle"', 'class="btn-think-toggle think-open"')
    .replace('>▸<', '>▾<');
  d.innerHTML = '<div class="agent-label"><span class="agent-name">玄姝</span>' + liveToggleHtml + '<button class="btn-tts-read" title="朗读" onclick="readAloud(this)" data-text=""></button></div>' +
    '<div class="agent-think-slot"></div>' +
    '<div class="bubble agent"><div class="agent-body"></div></div>';
  convEl().appendChild(d);
  typingEl.remove();

  const bodyEl = d.querySelector(".bubble.agent .agent-body") as HTMLElement;
  const thinkSlot = d.querySelector(".agent-think-slot") as HTMLElement;
  const thinkEl = document.createElement("div");
  thinkEl.className = "thinking-live";
  thinkEl.innerHTML = '<div class="tc-live-header"><span class="tc-live-dot"></span><span>思考中</span></div><div class="tc-thought-live"></div>';
  thinkSlot.appendChild(thinkEl);
  const liveText = thinkEl.querySelector(".tc-thought-live") as HTMLElement;
  // 思考中：按钮已呈展开态，点击折叠/展开实时灰块（收尾后 details 替换 live，isConnected=false 即失效）
  const liveBtn = d.querySelector(".btn-think-toggle") as HTMLButtonElement | null;
  const liveArrow = liveBtn?.querySelector(".btn-think-arrow") as HTMLElement | null;
  liveBtn?.addEventListener("click", () => {
    if (!thinkEl.isConnected) return;
    const hidden = thinkEl.style.display === "none";
    thinkEl.style.display = hidden ? "" : "none";
    liveBtn.classList.toggle("think-open", hidden);
    if (liveArrow) liveArrow.textContent = hidden ? "▾" : "▸";
  });
  const replyEl = document.createElement("div");
  replyEl.className = "stream-reply";
  bodyEl.appendChild(replyEl);

  let reasoning = "";
  let content = "";
  let rafPending = false;
  let lastRender = 0;

  const render = () => {
    rafPending = false;
    liveText.textContent = reasoning;
    const now = Date.now();
    if (now - lastRender > 120) {
      lastRender = now;
      replyEl.innerHTML = renderMarkdown(content.replace(/\[ASK:[\s\S]*?\](?=\n|$)/g, ""));
    }
    // 流式期间强制置底（非平滑），确保气泡随内容实时增高并始终可见最新文字
    convEl().scrollTop = convEl().scrollHeight;
  };

  // 断流看门狗：模型思考链与正文之间可能长时间无数据（隧道/移动网络还可能静默断连），
  // 超过 60s 无任何 SSE 数据即 abort，回退非流式，避免界面永久卡死。
  const ctrl = new AbortController();
  let lastDataAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > 60000) ctrl.abort();
  }, 5000);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = state.authToken;
    if (auth) headers["Authorization"] = "Bearer " + auth;
    const body: Record<string, unknown> = { msg: text, stream: "true", session_id: state.currentSessionId };
    if (img) body.image = img;
    const r = await fetch(state.API + "/api/chat", { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok || !r.body) { clearInterval(watchdog); return false; }
    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") { void reader.cancel().catch(() => {}); break outer; }
        try {
          const j = JSON.parse(payload) as {
            type?: string;
            session_id?: string;
            agent?: string;
            task?: string;
            ok?: boolean;
            summary?: string;
            round?: number;
            thought?: string;
            tool?: string;
            args?: string;
            result?: string;
            reason?: string;
            detail?: string;
            choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            error?: string;
          };
          if (j.error) throw new Error(j.error);
          // 服务端确认/分配会话 ID（Phase 1：写入本地并持久化，刷新后继续同一会话）
          if (j.type === "session" && j.session_id) {
            state.currentSessionId = j.session_id;
            localStorage.setItem(SESSION_KEY, j.session_id);
            continue;
          }
          // 多 Agent 协同事件：子 Agent 开始/完成真实工作
          if (j.type === "agent_start" && j.agent) {
            showAgentWorking(j.agent, j.task || "");
            continue;
          }
          if (j.type === "agent_done" && j.agent) {
            markAgentDone(j.agent, Boolean(j.ok), j.summary || "");
            continue;
          }
          if (j.type === "agent_think" && j.agent) {
            appendAgentThink(j.agent, j.thought || "");
            continue;
          }
          if (j.type === "agent_tool" && j.agent) {
            appendAgentLog(j.agent, "tool", { round: j.round, tool: j.tool, args: j.args || "" });
            continue;
          }
          if (j.type === "agent_tool_done" && j.agent) {
            appendAgentLog(j.agent, "tool_done", { round: j.round, tool: j.tool, result: j.result || "" });
            continue;
          }
          if (j.type === "agent_paused" && j.agent) {
            // 断点暂停：轮数上限 / 无进展熔断，等用户拍板是否续轮
            markAgentPaused(j.agent, j.reason || "", Number(j.round || 0), j.detail || "");
            continue;
          }
          const delta = j.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) content += delta.content;
          if ((delta.reasoning_content || delta.content) && !rafPending) {
            rafPending = true;
            requestAnimationFrame(render);
          }
        } catch { /* 单帧解析失败忽略 */ }
      }
    }
    if (!rafPending) requestAnimationFrame(render);

    // 收尾：思考块转为折叠思考链（单步推导），激活「思考过程」按钮
    if (reasoning.trim()) {
      const wrap = document.createElement("div");
      wrap.innerHTML = buildThinkingChainHtml([{ round: 1, thought: reasoning.trim() }]);
      const details = wrap.firstElementChild as HTMLDetailsElement;
      thinkEl.replaceWith(details);
      details.open = false;
      wireThinkToggle(d);
    } else {
      thinkEl.remove();
      const btn = d.querySelector(".btn-think-toggle") as HTMLElement | null;
      if (btn) btn.remove();
    }
    // 收尾：剥离 [ASK:...] 标记后再渲染正文（问题由弹窗展示）
    const hasAsk = /\[ASK:/.test(content);
    const cleanContent = content.replace(/\[ASK:[\s\S]*?\]/g, "").trim();
    if (!cleanContent && !hasAsk) {
      // 流式正常结束但模型只输出了思考链、未给正文（偶发）：移除半成品，
      // 交由调用方回退非流式补答，避免界面停留在"思考完无答案"。
      clearInterval(watchdog);
      d.remove();
      return false;
    }
    replyEl.innerHTML = renderMarkdown(cleanContent) || "";
    const ttsBtn = d.querySelector(".btn-tts-read") as HTMLElement | null;
    if (ttsBtn && cleanContent) {
      ttsBtn.dataset.text = encodeURIComponent(cleanContent);
      if (state.ttsEnabled) {
        const lastBubble = convEl().lastElementChild;
        const b = lastBubble?.querySelector(".btn-tts-read") as HTMLElement | null;
        if (b) void readAloud(b);
      }
    }
    scrollConvToBottom(true);
    state.totalTokens += text.length + content.length;
    updateTokenBadge();
    saveConv();
    // Agent 需要用户拍板时弹出询问弹窗
    if (/\[ASK:/.test(content)) {
      void handleAskIfAny(content);
    }
    clearInterval(watchdog);
    return true;
  } catch (e) {
    // 流式失败：移除半成品，交由调用方回退非流式
    clearInterval(watchdog);
    d.remove();
    return false;
  }
}

// ── 非流式响应渲染 ──
function renderChatResponse(d: ChatResponse): void {
  if (d.reply && d.reply.startsWith("[PERM:")) {
    const m = d.reply.match(/^\[PERM:(\w+)\]([\s\S]*)/);
    if (m) showPermission(m[1], m[2].trim());
    return;
  }
  if (d.reply && /\[ASK:/.test(d.reply)) {
    void handleAskIfAny(d.reply);
    return;
  }
  if (!d.reply) {
    // 模型未返回正文（含流式补答仍为空）：给出可见提示，避免"思考完无答案"的空界面
    addBubble("system", "本次未生成正文内容，请重试或换个问法");
    return;
  }
  const thinkings = d.thinking || [];
  if (d.cmd) {
    addBubble("system", d.reply || "");
  } else {
    const mainAgent = "玄姝";
    const subAgent = d.agent || d.dispatched_to || "";
    const agentLabel = subAgent ? mainAgent + " → @" + subAgent : mainAgent;
    addBubble("agent", d.reply || "", agentLabel, thinkings);
    if (state.ttsEnabled && d.reply) {
      const lastBubble = convEl().lastElementChild;
      const ttsBtn = lastBubble?.querySelector(".btn-tts-read") as HTMLElement | null;
      if (ttsBtn) void readAloud(ttsBtn);
    }
  }
  if (d.model) {
    state.currentModel = d.model;
    buildModelChips();
  }
  state.totalTokens += d.reply ? d.reply.length : 0;
  updateTokenBadge();
}

// ── 空态欢迎区控制：一旦对话区出现真实消息即隐藏，避免 200px 空态区压顶导致消息无法置顶 ──
function hideWelcomeIfHasMsgs(): void {
  const welcome = $("#welcome");
  if (!welcome || welcome.style.display === "none") return;
  if (convEl().querySelector(".bubble")) welcome.style.display = "none";
}

export function addBubble(role: "user" | "agent" | "system", content: string, agentName?: string, thinkings?: ThinkingStep[]): void {
  const welcome = $("#welcome");
  if (welcome) welcome.style.display = "none";
  const d = document.createElement("div");
  let html = renderMarkdown(content);
  if (agentName) {
    d.className = "agent-msg";
    const thinkingHtml = buildThinkingChainHtml(thinkings || []);
    if (thinkingHtml) {
      setTimeout(() => {
        const details = d.querySelector("details.thinking-chain") as HTMLDetailsElement | null;
        if (details && details.open) details.open = false;
        const btn = d.querySelector(".btn-think-toggle") as HTMLElement | null;
        const arrow = btn?.querySelector(".btn-think-arrow");
        if (btn) btn.classList.remove("think-open");
        if (arrow) arrow.textContent = "▸";
      }, 2500);
    }
    // 三层分离：名字行(玄姝+思考按钮) / 思考面板灰块(agent-think-slot) / 正文气泡(bubble.agent)
    d.innerHTML = '<div class="agent-label"><span class="agent-name">' + agentName + '</span>' + (thinkingHtml ? buildThinkToggleHtml() : '') + '<button class="btn-tts-read" title="朗读" onclick="readAloud(this)" data-text="' + encodeURIComponent(content) + '">&#x1f50a;</button></div>' +
      '<div class="agent-think-slot">' + (thinkingHtml || "") + "</div>" +
      '<div class="bubble agent"><div class="agent-body">' + html + "</div></div>";
    if (thinkingHtml) wireThinkToggle(d);
  } else {
    d.className = "bubble " + role;
    if (role === "system") {
      d.innerHTML = '<div style="text-align:center;color:var(--text-muted)">' + html + "</div>";
    } else {
      d.innerHTML = html;
    }
  }
  convEl().appendChild(d);
  scrollConvToBottom(true);
  saveConv();
}

// ── 长消息策略：不折叠截断，气泡随文字自适应增高 ──
// 超长内容（>3000字）由 autoLongMsgToTxt 转 txt 文件卡片展示，正文保持完整可读

export function renderMarkdown(text: string): string {
  // 消除回复正文的前导/尾随空白行：模型输出偶尔以换行开头，
  // 否则渲染成 <br> 会把正文首行推离气泡顶端（用户反馈"没顶到气泡框顶端"）。
  text = text.replace(/^\s+/, "").replace(/\s+$/, "");
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang: string, code: string) => {
    return '<pre class="code-block"><code>' + code.replace(/\n$/, "") + "</code></pre>";
  });
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/^### (.+)$/gm, '<h3 class="md-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="md-h2">$1</h2>');
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (m: string) => {
    return '<ul class="md-ul">' + m + "</ul>";
  });
  html = html.replace(/<\/ul>\n<ul class="md-ul">/g, "\n");
  html = html.replace(/^---$/gm, '<hr class="md-hr">');
  html = html.replace(/\n/g, "<br>");
  return html;
}

function addTyping(): HTMLElement {
  const d = document.createElement("div");
  d.className = "typing";
  d.innerHTML = "<span></span><span></span><span></span>";
  convEl().appendChild(d);
  scrollConvToBottom(true);
  return d;
}

export function updateTokenBadge(): void {
  const k = (state.totalTokens / 1000).toFixed(1);
  $("#tokenBadge").textContent = k + "k tk";
  const tc = $("#tokenCount") as HTMLElement | null;
  if (tc) tc.textContent = k + "k tk";
}

// ── 输入框文件上传 ──
export async function uploadFiles(): Promise<void> {
  const input = $("#fileInput") as HTMLInputElement;
  const files = input.files;
  if (!files || !files.length) return;
  const formData = new FormData();
  for (const f of Array.from(files)) formData.append("files", f);
  try {
    const r = await fetch(state.API + "/api/workspace/upload-batch", { method: "POST", body: formData });
    const d = (await r.json()) as { ok?: boolean; uploaded?: { path: string }[]; error?: string };
    if (!d.ok) { showToast("上传失败: " + (d.error || "未知错误")); return; }
    showToast("已上传 " + (d.uploaded || []).length + " 个文件");
    void loadWorkspaceFiles();
    const paths = (d.uploaded || []).map(u => u.path).join("\n");
    inpEl().value = (inpEl().value + "\n" + paths).trim();
  } catch (e) {
    showToast("上传失败: 服务未启动");
  }
  input.value = "";
}

// ── 对话持久化 ──
// opts.remote=false 时只写 localStorage，不回传服务端（用于"从服务端恢复"后落盘，避免把残缺快照覆盖回服务端）
export function saveConv(opts: { remote?: boolean } = {}): void {
  const bubbles = convEl().querySelectorAll(".bubble");
  const msgs: { r: string; a?: string; c: string; t?: string }[] = [];
  bubbles.forEach(b => {
    if (b.classList.contains("user")) msgs.push({ r: "user", c: b.innerHTML });
    else if (b.classList.contains("agent")) {
      // 新结构：label 在 .agent-msg 顶层（.bubble.agent 之外），取 .agent-name 纯文本
      const msgWrap = b.closest(".agent-msg");
      const nameEl = msgWrap?.querySelector(".agent-name");
      // 同时保存思考链 HTML（details.thinking-chain），供重新进入后恢复"思考过程"按钮
      const thinkSlot = msgWrap?.querySelector(".agent-think-slot");
      const thinkDetails = thinkSlot?.querySelector("details.thinking-chain");
      const thinkHtml = thinkDetails ? thinkDetails.outerHTML : "";
      const content = b.querySelector("div:last-child");
      const txt = content ? content.textContent || "" : "";
      // 仅当正文与思考链均为空才跳过（正文空但保留思考链的消息不应整条丢失）
      if (!txt.trim() && !thinkHtml) return;
      msgs.push({ r: "agent", a: nameEl ? nameEl.textContent || "" : "", c: content ? content.innerHTML : "", t: thinkHtml || undefined });
    } else if (b.classList.contains("system")) {
      const txt = b.textContent || "";
      if (!txt.trim()) return;
      msgs.push({ r: "system", c: b.innerHTML });
    }
  });
  const meta = { model: state.currentModel, tokens: state.totalTokens, at: Date.now() };
  try {
    localStorage.setItem(CONV_KEY, JSON.stringify(msgs));
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch (e) { /* 存储满时忽略 */ }
  if (opts.remote === false) return;
  // 提交完整会话快照（对象包装，与服务端 { shared_msgs } 契约一致；服务端做字段归一化）
  fetch(state.API + "/api/context/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shared_msgs: msgs.slice(-60) }) }).catch(() => { /* 忽略 */ });
}

export function loadConv(): boolean {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) return false;
    const msgs = JSON.parse(raw) as RestoredMsg[];
    msgs.forEach(m => renderRestoredMsg(m));
    hideWelcomeIfHasMsgs();
    const meta = JSON.parse(localStorage.getItem(META_KEY) || "{}") as { model?: string; tokens?: number };
    if (meta.model) state.currentModel = meta.model;
    if (meta.tokens) state.totalTokens = meta.tokens;
    updateTokenBadge();
    buildModelChips();
    scrollConvToBottom();
    return true;
  } catch (e) {
    localStorage.removeItem(CONV_KEY);
    return false;
  }
}

export async function restoreFromServer(): Promise<boolean> {
  try {
    const resp = await fetch(state.API + "/api/context");
    const data = (await resp.json()) as {
      ok?: boolean; shared_msgs?: { role: string; content: string; agent?: string; t?: string }[];
      model?: string; context_summary?: string;
    };
    if (!data.ok || !data.shared_msgs || !data.shared_msgs.length) return false;
    data.shared_msgs.forEach(m => {
      const role = String(m.role || "").toLowerCase();
      if (role === "user") renderRestoredMsg({ r: "user", c: m.content });
      else if (role === "agent" || role === "assistant") renderRestoredMsg({ r: "agent", a: m.agent || "玄姝", c: m.content, t: m.t });
      else if (role === "system") renderRestoredMsg({ r: "system", c: m.content });
    });
    if (data.model) state.currentModel = data.model;
    if (data.context_summary) {
      const d = document.createElement("div");
      d.className = "bubble system";
      d.innerHTML = "记忆摘要：" + data.context_summary;
      convEl().appendChild(d);
    }
    updateTokenBadge();
    buildModelChips();
    scrollConvToBottom();
    hideWelcomeIfHasMsgs();
    // 仅回写 localStorage；服务端刚读过，无需回传，避免残缺快照覆盖导致数据丢失
    saveConv({ remote: false });
    return true;
  } catch (e) { return false; }
}

export function renderRestoredMsg(m: RestoredMsg): void {
  const content = (m.c || "").trim();
  const thinkHtml = (m.t || "").trim();
  // 仅当正文与思考链均为空才跳过（正文空但保留思考链的消息仍可恢复按钮与内容）
  if (!content && !(m.r === "agent" && thinkHtml)) return;
  const d = document.createElement("div");
  if (m.r === "agent") {
    // 与新增消息一致的三层结构：label(顶层) / think-slot / bubble.agent
    // 历史消息若保存了思考链 HTML（m.t），恢复"思考过程"按钮与可展开内容
    d.className = "agent-msg";
    d.innerHTML = '<div class="agent-label"><span class="agent-name">' + m.a + '</span>' +
      (thinkHtml ? buildThinkToggleHtml() : '') +
      '<button class="btn-tts-read" title="朗读" onclick="readAloud(this)" data-text="' + encodeURIComponent(content) + '">&#x1f50a;</button></div>' +
      '<div class="agent-think-slot">' + thinkHtml + "</div>" +
      '<div class="bubble agent"><div class="agent-body" style="line-height:1.7">' + content + "</div></div>";
    if (thinkHtml) wireThinkToggle(d);
  } else {
    d.className = "bubble " + m.r;
    d.innerHTML = content;
  }
  convEl().appendChild(d);
}

export function clearConv(): void {
  const conv = convEl();
  // 先移出 welcome，避免被 innerHTML 清掉导致空态无法恢复
  const welcome = $("#welcome");
  if (welcome) welcome.remove();
  conv.innerHTML = "";
  if (welcome) conv.appendChild(welcome);
  localStorage.removeItem(CONV_KEY);
  localStorage.removeItem(META_KEY);
  // 清空会话后轮换新会话 ID：旧会话文件保留在服务端（可后续提供历史会话列表），新对话不再续写旧链
  const id = "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  state.currentSessionId = id;
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* ignore */ }
}

export { showFileContent };
