// ========== 前端全局状态（单例） ==========
import type { ModelItem, ToolInfo, WorkflowNode } from "./types.js";

// 同源优先：手机经 cloudflared 隧道访问时 127.0.0.1 指向手机自身，必须用 location.origin
const DEFAULT_API = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8902";
function resolveApi(): string {
  const q = new URLSearchParams(location.search).get("api");
  if (q) return q.replace(/\/+$/, "");
  return localStorage.getItem("xuanshu_api") || DEFAULT_API;
}

export const state = {
  API: resolveApi(),
  currentModel: "deepseek-v3",
  hasKey: false,
  savedKey: "",
  totalTokens: 0,
  currentSessionId: "sess_" + Date.now(),
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
