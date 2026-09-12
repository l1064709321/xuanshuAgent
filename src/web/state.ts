// ========== 前端全局状态（单例） ==========
import type { ModelItem, ToolInfo, WorkflowNode } from "./types.js";

// 同源优先：手机经 cloudflared 隧道访问时 127.0.0.1 指向手机自身，必须用 location.origin
const DEFAULT_API = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8902";
function resolveApi(): string {
  const q = new URLSearchParams(location.search).get("api");
  if (q) return q.replace(/\/+$/, "");
  return localStorage.getItem("xuanshu_api") || DEFAULT_API;
}

// ── 会话 ID（Phase 1：服务端按 session_id 持久化消息链）──
// 刷新/重开页面后复用同一 ID，让服务端继续从磁盘恢复上下文；
// clearConv 清空会话时轮换新 ID。
export const SESSION_KEY = "xuan_session";

function resolveSessionId(): string {
  try {
    const cur = localStorage.getItem(SESSION_KEY);
    if (cur && /^[A-Za-z0-9_-]{1,128}$/.test(cur)) return cur;
  } catch { /* 存储不可用时走新建 */ }
  const id = "sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* ignore */ }
  return id;
}

export const state = {
  API: resolveApi(),
  currentModel: "agnes-2.0-flash",
  hasKey: false,
  savedKey: "",
  totalTokens: 0,
  currentSessionId: resolveSessionId(),
  pendingImage: null as string | null,
  authToken: localStorage.getItem("xuanshu_token") || "",

  // 模型管理
  allModels: [] as ModelItem[],
  allProviders: [] as string[],
  modelKeyValues: {} as Record<string, string>,

  // 工具适配层
  toolAdapterBase: "",
  cachedTools: {} as Record<string, ToolInfo>,
  activeToolId: "",
  currentPreset: null as { template?: string; params?: { label: string; key: string; placeholder: string }[] } | null,
  currentPresetId: "",

  // TTS
  ttsAudio: null as HTMLAudioElement | null,
  ttsEnabled: localStorage.getItem("xuanshu_tts") === "on",

  // 工作流
  wfEditingId: null as string | null,
  wfCanvasNodes: [] as WorkflowNode[],
  wfNodeIdSeq: 0,
  wfDragNode: null as { nodeId: string; offsetX: number; offsetY: number } | null,
  wfSelectedNode: null as string | null,
  wfEditTarget: null as string | null,

  // 菜单
  themePanelOpen: false,
  moreMenuOpen: false,

  // 监控
  monitorTimer: null as ReturnType<typeof setInterval> | null,
  autoRefreshOn: true,
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  heartbeatRetryTimer: null as ReturnType<typeof setInterval> | null,
  heartbeatFailCount: 0,
  heartbeatStopped: false,
};

export const CONV_KEY = "xuan_conv";
export const META_KEY = "xuan_meta";
export const HEARTBEAT_MAX_FAIL = 5;
export const IS_MOBILE = window.matchMedia("(max-width: 768px)");
