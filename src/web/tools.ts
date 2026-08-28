// ========== 工具适配层 / Agent 配置 ==========
import { $, showToast } from "./dom.js";

let toolAdapterBase = "";
let cachedTools: Record<string, { available: boolean; path?: string; install_hint?: string }> = {};
let activeToolId = "";

export async function checkToolEnv(): Promise<void> {
  const status = $("#toolAdapterStatus") as HTMLElement;
  const result = $("#toolEnvResult") as HTMLElement;
  const grid = $("#toolGrid") as HTMLElement;
  const select = $("#customToolSelect") as HTMLSelectElement;
  toolAdapterBase = ($("#toolAdapterUrl") as HTMLInputElement).value.replace(/\/$/, "");
  status.textContent = "扫描中…";
  status.style.color = "var(--warning)";
  try {
    const resp = await fetch(toolAdapterBase + "/api/check_env");
    cachedTools = (await resp.json()) as typeof cachedTools;
    const available = Object.values(cachedTools).filter(t => t.available).length;
    const total = Object.keys(cachedTools).length;
    status.textContent = "已连接 (" + available + "/" + total + ")";
    status.style.color = "var(--success)";
    result.innerHTML = "";
    for (const [tid, t] of Object.entries(cachedTools)) {
      result.innerHTML += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;font-size:12px">' +
        '<span style="color:' + (t.available ? "var(--success)" : "var(--text-muted)") + '">' + (t.available ? "&#9679;" : "&#9675;") + "</span>" +
        "<span>" + (t.available ? "<b>" + tid + "</b>" : tid) + " " + (t.path || "") + "</span>" +
        (!t.available ? '<span style="font-size:11px;color:var(--text-muted)">' + (t.install_hint || "") + "</span>" : "") + "</div>";
    }
    buildToolGrid();
    select.innerHTML = '<option value="">选择工具</option>';
    for (const [tid, t] of Object.entries(cachedTools)) {
      select.innerHTML += '<option value="' + tid + '" ' + (t.available ? "" : "disabled") + ">" + tid + "</option>";
    }
  } catch (e) {
    status.textContent = "连接失败";
    status.style.color = "var(--cinnabar)";
    result.innerHTML = '<span style="color:var(--cinnabar);font-size:12px">无法连接适配层，请确认服务已启动</span>';
  }
}

function buildToolGrid(): void {
  const grid = $("#toolGrid") as HTMLElement;
  grid.innerHTML = "";
  for (const [tid, t] of Object.entries(cachedTools)) {
    grid.innerHTML += '<div class="tool-card" onclick="selectTool(\'' + tid + '\')" style="' +
      (t.available ? "" : "opacity:0.5;") + "cursor:pointer;transition:all var(--transition)\">" +
      '<div class="tool-card-header"><span class="tool-card-status ' + (t.available ? "online" : "offline") + '"></span>' +
      '<span class="tool-card-name">' + tid + "</span></div>" +
      '<div class="tool-card-desc">' + (t.available ? "已就绪" : "未安装") + "</div></div>";
  }
}

export async function selectTool(toolId: string): Promise<void> {
  activeToolId = toolId;
  ($("#customToolSelect") as HTMLSelectElement).value = toolId;
  const presetSection = $("#presetSection") as HTMLElement;
  const presetTitle = $("#presetTitle") as HTMLElement;
  const presetList = $("#presetList") as HTMLElement;
  try {
    const resp = await fetch(toolAdapterBase + "/api/presets?tool=" + toolId);
    const presets = (await resp.json()) as Record<string, { label: string; desc: string }>;
    if (Object.keys(presets).length === 0) { presetSection.style.display = "none"; return; }
    presetSection.style.display = "block";
    presetTitle.textContent = "预设操作 - " + toolId;
    presetList.innerHTML = "";
    for (const [pid, p] of Object.entries(presets)) {
      presetList.innerHTML += '<div class="preset-item" onclick="loadPreset(\'' + toolId + '\', \'' + pid + '\')" style="' +
        "padding:10px 12px;border-radius:8px;border:1px solid var(--rule);cursor:pointer;transition:all var(--transition);background:var(--ink-surface)\">" +
        '<div style="font-size:13px;font-weight:600;color:var(--text-body)">' + p.label + "</div>" +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + p.desc + "</div></div>";
    }
  } catch (e) { presetSection.style.display = "none"; }
}

let currentPreset: { template?: string; params?: { key: string; label: string; placeholder: string }[] } | null = null;

export async function loadPreset(toolId: string, presetId: string): Promise<void> {
  try {
    const resp = await fetch(toolAdapterBase + "/api/presets?tool=" + toolId);
    const presets = (await resp.json()) as Record<string, { template: string; params: { key: string; label: string; placeholder: string }[] }>;
    currentPreset = presets[presetId] || null;
    if (!currentPreset || !currentPreset.params) return;
    const paramsDiv = $("#presetParams") as HTMLElement;
    paramsDiv.style.display = "block";
    paramsDiv.innerHTML = "";
    for (const param of currentPreset.params) {
      paramsDiv.innerHTML += '<div class="form-group">' +
        '<label class="form-label">' + param.label + "</label>" +
        '<input class="preset-param form-input" data-key="' + param.key + '" placeholder="' + param.placeholder + '" style="font-family:var(--mono)"></div>';
    }
    paramsDiv.innerHTML += '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn btn-primary" onclick="runPreset(\'' + toolId + '\')" style="flex:1">执行</button>' +
      '<button class="btn btn-ghost" onclick="previewCmd(\'' + toolId + '\')">预览</button></div>';
  } catch (e) { /* 忽略 */ }
}

function buildCmd(): string {
  if (!currentPreset) return "";
  let cmd = currentPreset.template || "";
  document.querySelectorAll(".preset-param").forEach(el => {
    const input = el as HTMLInputElement;
    const val = input.value.trim() || input.placeholder;
    cmd = cmd.replace("{" + input.dataset.key + "}", val);
  });
  return cmd;
}

export function previewCmd(): void { const cmd = buildCmd(); showOutput(cmd, "", "(预览)", 0); }

export async function runPreset(toolId: string): Promise<void> { const cmd = buildCmd(); await runCommand(toolId, cmd); }

export async function runCustomCmd(): Promise<void> {
  const toolId = ($("#customToolSelect") as HTMLSelectElement).value;
  const cmd = ($("#customCmd") as HTMLTextAreaElement).value.trim();
  if (!toolId) { showToast("请先选择工具"); return; }
  if (!cmd) return;
  await runCommand(toolId, cmd);
}

async function runCommand(toolId: string, command: string): Promise<void> {
  const output = $("#toolOutput") as HTMLElement;
  const content = $("#toolOutputContent") as HTMLElement;
  const code = $("#toolExitCode") as HTMLElement;
  output.style.display = "block";
  content.textContent = "执行中…";
  code.textContent = "";
  try {
    const resp = await fetch(toolAdapterBase + "/api/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: toolId, command }),
    });
    const data = (await resp.json()) as { stdout?: string; stderr?: string; command?: string; returncode?: number };
    showOutput(data.stdout || "", data.stderr || "", data.command || "", data.returncode ?? 0);
  } catch (e) { content.textContent = "请求失败: " + (e as Error).message; code.textContent = "(网络错误)"; }
}

function showOutput(stdout: string, stderr: string, cmd: string, code: number): void {
  const output = $("#toolOutput") as HTMLElement;
  const content = $("#toolOutputContent") as HTMLElement;
  const exitCode = $("#toolExitCode") as HTMLElement;
  output.style.display = "block";
  let text = "";
  if (cmd) text += "$ " + cmd + "\n" + "\u2500".repeat(40) + "\n";
  if (stdout) text += stdout;
  if (stderr) text += (stdout ? "\n" : "") + "\u2500\u2500 STDERR \u2500\u2500\n" + stderr;
  if (!stdout && !stderr) text += "(无输出)";
  content.textContent = text;
  exitCode.textContent = code === 0 ? "(成功)" : "(退出码: " + code + ")";
  exitCode.style.color = code === 0 ? "var(--success)" : "var(--warning)";
}

export function updateCustomTool(): void {
  const toolId = ($("#customToolSelect") as HTMLSelectElement).value;
  if (toolId) void selectTool(toolId);
}

// ========== Agent 配置 ==========
export function loadAgentConfig(): void {
  const config = {
    name: "玄姝 Agent",
    version: "1.0.0",
    description: "多模型智能助手，支持文件管理、联网搜索、代码分析等",
    permissions: { fileAccess: true, webSearch: true, toolExecution: true, download: false },
    created: "2026-07-08", lastUpdated: "2026-07-08",
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "agent_config.json"; a.click();
  URL.revokeObjectURL(url);
  showToast("Agent 配置已下载");
}

export function showDownloadPermInfo(): void {
  const overlay = document.createElement("div");
  overlay.className = "permission-overlay show";
  overlay.innerHTML = '<div class="permission-dialog">' +
    "<h3>下载权限</h3>" +
    "<p>当前 Agent 仅拥有下载权限（仅可下载文件，不可上传或修改）。如需完整文件管理权限，请在设置中授权文件夹。</p>" +
    '<div class="perm-detail">' +
    '<div class="perm-row"><span class="perm-label">权限类型</span><span class="perm-value">下载</span></div>' +
    '<div class="perm-row"><span class="perm-label">范围</span><span class="perm-value">仅限 Agent 生成的文件</span></div>' +
    '<div class="perm-row"><span class="perm-label">状态</span><span class="perm-value">已启用</span></div></div>' +
    '<div class="perm-actions"><button class="btn btn-primary" onclick="this.parentElement.parentElement.parentElement.remove()">知道了</button></div></div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}
