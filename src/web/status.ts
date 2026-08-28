// ========== 连接状态 / 心跳 ==========
import { state, HEARTBEAT_MAX_FAIL } from "./state.js";
import { $ } from "./dom.js";

export function setStatus(state_: string, label: string): void {
  $("#statusDot").className = "status-dot " + state_;
  $("#statusLabel").textContent = label;
  $("#panelStatusDot").className = "status-dot " + state_;
  $("#panelStatusLabel").textContent = label;
}

export function startHeartbeat(): void {
  stopHeartbeat();
  state.heartbeatFailCount = 0;
  state.heartbeatStopped = false;
  void doPing();
  state.heartbeatTimer = setInterval(() => { void doPing(); }, 5000);
}

export function stopHeartbeat(): void {
  if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
  if (state.heartbeatRetryTimer) { clearInterval(state.heartbeatRetryTimer); state.heartbeatRetryTimer = null; }
}

function startRetry(): void {
  // 断线后自动重连：每 8s 探测一次，成功即恢复心跳（无需等待用户输入）
  if (state.heartbeatRetryTimer) return;
  state.heartbeatRetryTimer = setInterval(async () => {
    if (state.heartbeatStopped && state.heartbeatRetryTimer) {
      const ok = await tryPingOnce();
      if (ok) {
        if (state.heartbeatRetryTimer) { clearInterval(state.heartbeatRetryTimer); state.heartbeatRetryTimer = null; }
        state.heartbeatStopped = false;
        state.heartbeatFailCount = 0;
        startHeartbeat();
        updateConnBanner(false);
        void import("./models.js").then(m => m.loadModels()).catch(() => {});
      }
    }
  }, 8000);
}

async function tryPingOnce(): Promise<boolean> {
  try {
    const r = await fetch(state.API + "/ping", { signal: AbortSignal.timeout(8000) });
    return r.ok;
  } catch (e) {
    return false;
  }
}

export async function doPing(): Promise<void> {
  if (state.heartbeatStopped) return;
  const start = performance.now();
  try {
    const r = await fetch(state.API + "/ping", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("bad status");
    const d = (await r.json()) as { ok?: boolean };
    void d;
    const latency = Math.round(performance.now() - start);
    state.heartbeatFailCount = 0;
    updateHeartbeatUI("alive", latency);
    updateConnBanner(false);
  } catch (e) {
    state.heartbeatFailCount++;
    updateHeartbeatUI("dead", 0);
    if (state.heartbeatFailCount >= HEARTBEAT_MAX_FAIL) {
      stopHeartbeat();
      state.heartbeatStopped = true;
      updateConnBanner(true, true);
      startRetry();
    }
  }
}

export function updateHeartbeatUI(state_: string, latency: number): void {
  const dot = $("#heartbeatDot");
  const msg = $("#heartbeatMsg");
  const lat = $("#heartbeatLat");
  const bar = $("#heartbeatBar");
  if (!dot || !bar) return;
  if (state_ === "alive") {
    bar.className = "heartbeat-bar";
    dot.style.cssText = "background:var(--ok);animation:pulse-dot 2s infinite;";
    msg.textContent = "心跳正常 · 每5秒";
    lat.textContent = latency + "ms";
  } else {
    bar.className = "heartbeat-bar dead";
    dot.style.cssText = "background:var(--err);animation:none;";
    msg.textContent = "心跳超时";
    lat.textContent = "—";
  }
}

export function updateConnBanner(show: boolean, paused?: boolean): void {
  const banner = $("#connBanner");
  const statusDot = $("#statusDot");
  const statusLabel = $("#statusLabel");
  const panelDot = $("#panelStatusDot");
  if (show) {
    banner.style.display = "flex";
    if (paused) {
      banner.className = "conn-banner retrying";
      const msg = banner.querySelector(".conn-banner-msg");
      if (msg) msg.textContent = "连接已断开 · 输入消息自动重连";
    } else {
      banner.className = "conn-banner";
    }
    if (statusDot) statusDot.className = "status-dot offline";
    if (statusLabel) statusLabel.textContent = "连接断开";
    if (panelDot) panelDot.className = "status-dot offline";
  } else {
    banner.style.display = "none";
    if (statusDot) statusDot.className = "status-dot online";
    if (statusLabel) statusLabel.textContent = "已连接";
    if (panelDot) panelDot.className = "status-dot online";
  }
}

export function onUserInputWake(): void {
  if (state.heartbeatStopped) {
    updateConnBanner(false);
    startHeartbeat();
  }
}
