// ========== 工作流（自动化规则 + 可视画布） ==========
import { state } from "./state.js";
import { $, escapeHtml } from "./dom.js";
import { postJSON } from "./api.js";
import type { WorkflowNode, WorkflowItem } from "./types.js";

export const WF_ACTIONS = [
  { value: "web_search", label: "联网搜索", color: "#3b82f6" },
  { value: "ai_summary", label: "AI 总结", color: "#8b5cf6" },
  { value: "write_file", label: "写文件", color: "#10b981" },
  { value: "notify", label: "通知", color: "#f59e0b" },
];

const NODE_W = 130, NODE_H = 48;

function getDefaultParams(action: string): Record<string, string> {
  switch (action) {
    case "web_search": return { query: "{user_message}" };
    case "ai_summary": return { prompt: "帮我总结上面的内容" };
    case "write_file": return { filename: "output.txt", content: "{ai_output}" };
    case "notify": return { message: "工作流执行完成" };
    default: return {};
  }
}

// ── 画布渲染 ──
export function renderCanvas(): void {
  const svg = $("#wfCanvas") as unknown as SVGSVGElement;
  const defs = svg.querySelector("defs");
  svg.innerHTML = "";
  if (defs) svg.appendChild(defs);

  for (let i = 0; i < state.wfCanvasNodes.length - 1; i++) {
    const a = state.wfCanvasNodes[i], b = state.wfCanvasNodes[i + 1];
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const cx1 = x1 + Math.abs(x2 - x1) * 0.4, cx2 = x2 - Math.abs(x2 - x1) * 0.4;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "wf-connector-group");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1},${y1} C ${cx1},${y1} ${cx2},${y2} ${x2},${y2}`);
    path.setAttribute("class", "wf-connector-line");
    g.appendChild(path);
    svg.appendChild(g);
  }

  state.wfCanvasNodes.forEach((node, idx) => {
    const act = WF_ACTIONS.find(a => a.value === node.action) || { color: "#888", label: node.action };
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "wf-canvas-node" + (node.id === state.wfSelectedNode ? " selected" : ""));
    g.setAttribute("transform", `translate(${node.x},${node.y})`);
    g.setAttribute("data-id", node.id);

    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("width", String(NODE_W)); r.setAttribute("height", String(NODE_H));
    r.setAttribute("class", "node-body"); r.setAttribute("rx", "6");
    g.appendChild(r);

    const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bar.setAttribute("x", "0"); bar.setAttribute("y", "0");
    bar.setAttribute("width", "3"); bar.setAttribute("height", String(NODE_H));
    bar.setAttribute("fill", act.color || "#888"); bar.setAttribute("rx", "3");
    g.appendChild(bar);

    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", "12"); t.setAttribute("y", "20");
    t.setAttribute("class", "node-label");
    t.textContent = node.label || act.label || node.action;
    g.appendChild(t);

    const s = document.createElementNS("http://www.w3.org/2000/svg", "text");
    s.setAttribute("x", "12"); s.setAttribute("y", "36");
    s.setAttribute("class", "node-sub");
    s.textContent = "步骤 " + (idx + 1);
    g.appendChild(s);

    if (idx < state.wfCanvasNodes.length - 1) {
      const h = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      h.setAttribute("cx", String(NODE_W)); h.setAttribute("cy", String(NODE_H / 2));
      h.setAttribute("r", "4"); h.setAttribute("class", "wf-canvas-handle");
      g.appendChild(h);
    }

    g.addEventListener("mousedown", (e) => onNodeMouseDown(e, node.id));
    g.addEventListener("dblclick", (e) => { e.stopPropagation(); openNodeEditor(node.id); });

    svg.appendChild(g);
  });
}

export function refreshCanvas(): void {
  const startX = 80, startY = 30, gapY = 80;
  state.wfCanvasNodes.forEach((n, i) => {
    n.x = startX;
    n.y = startY + i * (NODE_H + gapY);
  });
  renderCanvas();
}

// ── 画布交互 ──
function onNodeMouseDown(e: MouseEvent, nodeId: string): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  const node = state.wfCanvasNodes.find(n => n.id === nodeId);
  if (!node) return;
  state.wfSelectedNode = nodeId;
  const svgEl = $("#wfCanvas");
  const rect = svgEl.getBoundingClientRect();
  state.wfDragNode = { nodeId, offsetX: e.clientX - rect.left - node.x, offsetY: e.clientY - rect.top - node.y };
  renderCanvas();
  document.addEventListener("mousemove", onCanvasMouseMove);
  document.addEventListener("mouseup", onCanvasMouseUp);
}

function onCanvasMouseMove(e: MouseEvent): void {
  if (!state.wfDragNode) return;
  const svgEl = $("#wfCanvas");
  const rect = svgEl.getBoundingClientRect();
  const node = state.wfCanvasNodes.find(n => n.id === state.wfDragNode?.nodeId);
  if (!node || !state.wfDragNode) return;
  node.x = Math.max(0, e.clientX - rect.left - state.wfDragNode.offsetX);
  node.y = Math.max(0, e.clientY - rect.top - state.wfDragNode.offsetY);
  renderCanvas();
}

function onCanvasMouseUp(): void {
  state.wfDragNode = null;
  document.removeEventListener("mousemove", onCanvasMouseMove);
  document.removeEventListener("mouseup", onCanvasMouseUp);
}

export function onCanvasClick(e: MouseEvent): void {
  if (e.target instanceof Element && e.target.closest(".wf-canvas-node")) return;
  state.wfSelectedNode = null;
  renderCanvas();
}

export function onPaletteDrag(e: DragEvent): void {
  const el = e.target as Element;
  const src = el.closest(".wf-palette-node");
  if (src) e.dataTransfer?.setData("action", src.getAttribute("data-action") || "");
}

export function onCanvasDragOver(e: DragEvent): void { e.preventDefault(); }

export function onCanvasDrop(e: DragEvent): void {
  e.preventDefault();
  const action = e.dataTransfer?.getData("action") || "";
  if (!action || !WF_ACTIONS.find(a => a.value === action)) return;
  const act = WF_ACTIONS.find(a => a.value === action);
  if (!act) return;
  const svgEl = $("#wfCanvas");
  const rect = svgEl.getBoundingClientRect();
  state.wfNodeIdSeq++;
  state.wfCanvasNodes.push({
    id: "node_" + state.wfNodeIdSeq,
    action,
    label: act.label,
    x: Math.max(0, e.clientX - rect.left - 65),
    y: Math.max(0, e.clientY - rect.top - 24),
    params: getDefaultParams(action),
  });
  state.wfCanvasNodes.sort((a, b) => a.y - b.y);
  refreshCanvas();
}

// ── 节点参数编辑浮层 ──
export function openNodeEditor(nodeId: string): void {
  const node = state.wfCanvasNodes.find(n => n.id === nodeId);
  if (!node) return;
  state.wfEditTarget = nodeId;
  const act = WF_ACTIONS.find(a => a.value === node.action);
  $("#wfNodeEditorTitle").textContent = "编辑: " + (act?.label || node.action);
  const body = $("#wfNodeEditorBody");
  const params = node.params || getDefaultParams(node.action);
  let html = "";
  switch (node.action) {
    case "web_search":
      html = '<div class="form-group"><label class="form-label">搜索关键词</label><input id="wfEdit_query" class="form-input" value="' + escapeHtml(params.query || "") + '" placeholder="支持 {user_message} 变量"></div>';
      break;
    case "ai_summary":
      html = '<div class="form-group"><label class="form-label">分析提示词</label><input id="wfEdit_prompt" class="form-input" value="' + escapeHtml(params.prompt || "") + '" placeholder="支持 {search_result} 等变量"></div>';
      break;
    case "write_file":
      html = '<div class="form-group"><label class="form-label">文件名</label><input id="wfEdit_filename" class="form-input" value="' + escapeHtml(params.filename || "") + '"></div>' +
        '<div class="form-group"><label class="form-label" style="margin-top:4px">文件内容</label><input id="wfEdit_content" class="form-input" value="' + escapeHtml(params.content || "") + '" placeholder="支持 {ai_output} 变量"></div>';
      break;
    case "notify":
      html = '<div class="form-group"><label class="form-label">通知内容</label><input id="wfEdit_message" class="form-input" value="' + escapeHtml(params.message || "") + '"></div>';
      break;
  }
  body.innerHTML = html;
  $("#wfNodeEditor").style.display = "block";
  $("#wfNodeOverlay").style.display = "block";
}

export function applyNodeEdit(): void {
  if (!state.wfEditTarget) return;
  const node = state.wfCanvasNodes.find(n => n.id === state.wfEditTarget);
  if (!node) return;
  node.params = {};
  switch (node.action) {
    case "web_search": node.params.query = ($("#wfEdit_query") as HTMLInputElement | null)?.value || ""; break;
    case "ai_summary": node.params.prompt = ($("#wfEdit_prompt") as HTMLInputElement | null)?.value || ""; break;
    case "write_file":
      node.params.filename = ($("#wfEdit_filename") as HTMLInputElement | null)?.value || "";
      node.params.content = ($("#wfEdit_content") as HTMLInputElement | null)?.value || "";
      break;
    case "notify": node.params.message = ($("#wfEdit_message") as HTMLInputElement | null)?.value || ""; break;
  }
  closeNodeEdit();
  renderCanvas();
}

export function closeNodeEdit(): void {
  $("#wfNodeEditor").style.display = "none";
  $("#wfNodeOverlay").style.display = "none";
  state.wfEditTarget = null;
}

// ── 触发条件 UI ──
export function onCanvasTriggerChange(): void {
  const t = ($("#wfCanvasTriggerType") as HTMLSelectElement).value;
  const v = $("#wfCanvasTriggerVal") as HTMLInputElement;
  const m = $("#wfCanvasTriggerMode") as HTMLSelectElement;
  if (t === "keyword") {
    v.placeholder = "关键词，逗号分隔"; v.value = "";
    m.parentElement!.style.display = "";
  } else if (t === "prefix") {
    v.placeholder = "前缀字符，如 /search"; v.value = "";
    m.parentElement!.style.display = "none";
  } else {
    v.placeholder = "正则表达式"; v.value = "";
    m.parentElement!.style.display = "none";
  }
}

// ── 构建 payload ──
function buildCanvasPayload(): { name: string; trigger: Record<string, unknown>; steps: { action: string; params: Record<string, string> }[]; enabled: boolean } {
  const name = ($("#wfCanvasName") as HTMLInputElement).value.trim();
  const triggerType = ($("#wfCanvasTriggerType") as HTMLSelectElement).value;
  const triggerVal = ($("#wfCanvasTriggerVal") as HTMLInputElement).value.trim();
  const triggerMode = ($("#wfCanvasTriggerMode") as HTMLSelectElement).value;
  const enabled = ($("#wfCanvasEnabled") as HTMLInputElement).checked;

  const trigger: Record<string, unknown> = { type: triggerType };
  if (triggerType === "keyword") {
    trigger.keywords = triggerVal.split(",").map(s => s.trim()).filter(Boolean);
    trigger.mode = triggerMode;
  } else if (triggerType === "prefix") {
    trigger.prefix = triggerVal;
  } else if (triggerType === "regex") {
    trigger.pattern = triggerVal;
  }

  const steps = state.wfCanvasNodes.map(n => ({ action: n.action, params: n.params || getDefaultParams(n.action) }));
  return { name, trigger, steps, enabled };
}

export async function saveCanvasWF(): Promise<void> {
  const payload = buildCanvasPayload();
  if (!payload.name) { alert("请输入规则名称"); return; }
  if (!payload.steps.length) { alert("请从左侧拖入至少一个动作节点"); return; }
  const url = state.wfEditingId ? "/api/workflow/update" : "/api/workflow/create";
  try {
    const d = await postJSON<{ ok?: boolean; error?: string }>(url, state.wfEditingId ? { ...payload, id: state.wfEditingId } : payload);
    if (d.ok) {
      state.wfEditingId = null;
      void loadWorkflows();
    } else {
      alert("保存失败: " + (d.error || "未知错误"));
    }
  } catch (e) { alert("网络错误: " + (e as Error).message); }
}

export function showWFCreate(): void {
  state.wfEditingId = null;
  state.wfCanvasNodes = [];
  state.wfNodeIdSeq = 0;
  state.wfSelectedNode = null;
  ($("#wfCanvasName") as HTMLInputElement).value = "";
  ($("#wfCanvasTriggerType") as HTMLSelectElement).value = "keyword";
  ($("#wfCanvasTriggerVal") as HTMLInputElement).value = "";
  ($("#wfCanvasTriggerMode") as HTMLSelectElement).value = "any";
  ($("#wfCanvasEnabled") as HTMLInputElement).checked = true;
  $("#wfCanvasTriggerMode").parentElement!.style.display = "";
  renderCanvas();
}

export function editWF(id: string): void {
  state.wfEditingId = id;
  void postJSON<{ workflows?: WorkflowItem[] }>("/api/workflow/list", {}).then((d: { workflows?: WorkflowItem[] }) => {
    const wf = (d.workflows || []).find(x => x.id === id);
    if (!wf) return;
    ($("#wfCanvasName") as HTMLInputElement).value = wf.name;
    ($("#wfCanvasTriggerType") as HTMLSelectElement).value = wf.trigger.type || "keyword";
    if (wf.trigger.type === "keyword") {
      ($("#wfCanvasTriggerVal") as HTMLInputElement).value = (wf.trigger.keywords || []).join(", ");
      ($("#wfCanvasTriggerMode") as HTMLSelectElement).value = wf.trigger.mode || "any";
      $("#wfCanvasTriggerMode").parentElement!.style.display = "";
    } else if (wf.trigger.type === "prefix") {
      ($("#wfCanvasTriggerVal") as HTMLInputElement).value = wf.trigger.prefix || "";
      $("#wfCanvasTriggerMode").parentElement!.style.display = "none";
    } else if (wf.trigger.type === "regex") {
      ($("#wfCanvasTriggerVal") as HTMLInputElement).value = wf.trigger.pattern || "";
      $("#wfCanvasTriggerMode").parentElement!.style.display = "none";
    }
    ($("#wfCanvasEnabled") as HTMLInputElement).checked = wf.enabled !== false;
    state.wfCanvasNodes = [];
    state.wfNodeIdSeq = 0;
    (wf.steps || []).forEach(s => {
      state.wfNodeIdSeq++;
      const act = WF_ACTIONS.find(a => a.value === s.action);
      state.wfCanvasNodes.push({
        id: "node_" + state.wfNodeIdSeq,
        action: s.action,
        label: act ? act.label : s.action,
        x: 80, y: 0,
        params: s.params || getDefaultParams(s.action),
      });
    });
    refreshCanvas();
  });
}

// ── 规则列表 ──
function formatTrigger(t: { type?: string; keywords?: string[]; mode?: string; prefix?: string; pattern?: string } | null | undefined): string {
  if (!t) return "未知";
  if (t.type === "keyword") return `关键词[${t.mode || "any"}]: ${(t.keywords || []).join(", ")}`;
  if (t.type === "prefix") return `前缀: ${t.prefix}`;
  if (t.type === "regex") return `正则: ${t.pattern}`;
  return t.type || "未知";
}

export async function loadWorkflows(): Promise<void> {
  try {
    const d = await postJSON<{ ok?: boolean; workflows?: WorkflowItem[] }>("/api/workflow/list", {});
    if (!d.ok) return;
    const list = d.workflows || [];
    const el = $("#wfList");
    if (list.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">暂无自动化规则，点击「新建」开始编排</div>';
      return;
    }
    el.innerHTML = list.map(wf => {
      const triggerDesc = formatTrigger(wf.trigger);
      const stepsDesc = (wf.steps || []).map(s => {
        const a = WF_ACTIONS.find(x => x.value === s.action);
        return a ? a.label : s.action;
      }).join(" → ");
      const badge = wf.enabled ? '<span style="font-size:11px;color:#10b981">● 启用</span>' : '<span style="font-size:11px;color:var(--text-muted)">○ 停用</span>';
      return `<div style="padding:12px;border-radius:var(--radius-sm);border:1px solid var(--rule);background:var(--ink-surface)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:600;color:var(--text-paper)">${escapeHtml(wf.name)}</span>
          <span>${badge}</span>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">触发: ${triggerDesc}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">步骤: ${stepsDesc || "无"}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="editWF('${wf.id}')">加载到画布</button>
          <button class="btn btn-ghost btn-sm" onclick="toggleWF('${wf.id}')">${wf.enabled ? "停用" : "启用"}</button>
          <button class="btn btn-ghost btn-sm" style="color:#ef4444" onclick="deleteWF('${wf.id}')">删除</button>
        </div>
      </div>`;
    }).join("");
  } catch (e) { console.error("loadWorkflows", e); }
}

export async function toggleWF(id: string): Promise<void> {
  try {
    const d = await postJSON<{ workflows?: WorkflowItem[] }>("/api/workflow/list", {});
    const wf = (d.workflows || []).find(x => x.id === id);
    if (!wf) return;
    await postJSON("/api/workflow/update", { id, enabled: !wf.enabled });
    void loadWorkflows();
  } catch (e) { console.error(e); }
}

export async function deleteWF(id: string): Promise<void> {
  if (!confirm("确定删除此规则？")) return;
  try {
    await postJSON("/api/workflow/delete", { id });
    void loadWorkflows();
  } catch (e) { console.error(e); }
}

export function initWorkflowShortcuts(): void {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Delete" && state.wfSelectedNode && $("#tab-workflow").style.display !== "none") {
      state.wfCanvasNodes = state.wfCanvasNodes.filter(n => n.id !== state.wfSelectedNode);
      state.wfSelectedNode = null;
      refreshCanvas();
    }
  });
}
