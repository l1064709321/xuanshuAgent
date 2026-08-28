// ========== 模型管理 / API Key ==========
import { state } from "./state.js";
import { $, escapeHtml, maskKeyText, showToast } from "./dom.js";
import { get, postJSON } from "./api.js";
import { setStatus } from "./status.js";
import { closeAllPanels, navigateTo } from "./panels.js";

interface ModelsResp {
  ok?: boolean;
  models?: import("./types.js").ModelItem[];
  providers?: string[];
  current_model?: string;
}

interface KeyStatusResp {
  ok?: boolean;
  keys?: Record<string, string>;
}

interface ModelOpResp {
  ok?: boolean;
  model?: string;
  local?: boolean;
  current_model?: string;
  has_key?: boolean;
  error?: string;
}

// 前端本地密钥缓存：与后端 keys.json 双向同步，后端重启/隧道抖动时自动恢复
const LOCAL_KEYS_KEY = "xuanshu_model_keys";

function loadLocalKeys(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEYS_KEY) || "{}") as Record<string, string>; }
  catch (e) { return {}; }
}

function saveLocalKey(model: string, key: string): void {
  const all = loadLocalKeys();
  if (key) all[model] = key; else delete all[model];
  localStorage.setItem(LOCAL_KEYS_KEY, JSON.stringify(all));
}

export async function loadModels(): Promise<void> {
  try {
    const d = await get<ModelsResp>("/api/models");
    state.allModels = (d.models || []).map(m => ({ ...m, model_id: m.model_id ?? (m as unknown as Record<string, unknown>).modelId as string }));
    state.allProviders = d.providers || [];
    if (d.current_model) state.currentModel = d.current_model;
    buildProviderFilter();
    filterModels();
    buildModelChips();
    void loadKeyValues();
  } catch (e) { console.log("加载模型列表失败"); }
}

async function loadKeyValues(): Promise<void> {
  try {
    const d = await get<KeyStatusResp>("/api/model-key/status");
    // 后端 keys 同步到前端本地缓存（浏览器留存副本，后端重启/隧道抖动时可自动恢复）
    if (d.keys && Object.keys(d.keys).length > 0) {
      const merged = { ...d.keys, ...loadLocalKeys() };
      localStorage.setItem(LOCAL_KEYS_KEY, JSON.stringify(merged));
    }
    // 后端 keys 与前端本地缓存合并（本地优先）
    state.modelKeyValues = { ...(d.keys || {}), ...loadLocalKeys() };
    filterModels();
    // 后端缺 key 但本地有 → 自动推送到后端，恢复"已连接"
    const local = loadLocalKeys();
    const miss = Object.keys(local).filter(m => !(d.keys || {})[m] && local[m]);
    if (miss.length > 0) {
      for (const m of miss) {
        await postJSON<ModelOpResp>("/api/model-key", { model: m, key: local[m] }).catch(() => { /* 后端暂不可达时忽略 */ });
      }
      const d2 = await get<KeyStatusResp>("/api/model-key/status").catch(() => null);
      if (d2 && d2.keys) state.modelKeyValues = { ...d2.keys, ...loadLocalKeys() };
      filterModels();
    }
  } catch (e) {
    // 后端不可达：仅用本地缓存展示，待心跳恢复后由重连流程重新同步
    state.modelKeyValues = loadLocalKeys();
    filterModels();
  }
}

function buildProviderFilter(): void {
  const sel = $("#providerFilter") as HTMLSelectElement;
  const providers = state.allProviders.length
    ? state.allProviders
    : [...new Set(state.allModels.map(m => m.provider).filter(Boolean))];
  sel.innerHTML = '<option value="">全部厂商</option>';
  providers.forEach(p => {
    sel.innerHTML += '<option value="' + p + '">' + p + "</option>";
  });
}

export function filterModels(): void {
  const search = (($("#modelSearch") as HTMLInputElement).value || "").toLowerCase();
  const provider = ($("#providerFilter") as HTMLSelectElement).value;
  let filtered = state.allModels;
  if (provider) filtered = filtered.filter(m => m.provider === provider);
  if (search) filtered = filtered.filter(m =>
    m.name.toLowerCase().includes(search) ||
    m.provider.toLowerCase().includes(search) ||
    m.model_id.toLowerCase().includes(search) ||
    (m.description || "").toLowerCase().includes(search)
  );
  renderModelList(filtered);
}

function renderModelList(models: import("./types.js").ModelItem[]): void {
  const list = $("#modelList");
  if (!models.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-muted);text-align:center;font-size:13px">无匹配模型</div>';
    return;
  }
  const groups: Record<string, import("./types.js").ModelItem[]> = {};
  models.forEach(m => {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  });
  let html = "";
  for (const [provider, items] of Object.entries(groups)) {
    const count = items.length;
    html += '<div style="display:flex;align-items:center;padding:10px 4px 4px;font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:0.5px;text-transform:uppercase">' +
      provider + ' <span style="font-weight:400;margin-left:4px">' + count + "个</span></div>";
    html += items.map(m => {
      const isActive = m.key === state.currentModel;
      const border = isActive ? "var(--cinnabar)" : "var(--rule)";
      const bg = isActive ? "background:var(--cinnabar-smoke);" : "";
      const marker = isActive
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--cinnabar);margin-right:8px;flex-shrink:0"></span>'
        : '<span style="display:inline-block;width:7px;height:7px;margin-right:8px;flex-shrink:0"></span>';
      const desc = m.description ? ' <span style="color:var(--text-muted)">' + m.description + "</span>" : "";
      const delBtn = m.custom
        ? '<button onclick="event.stopPropagation();delModel(\'' + m.key + '\')" title="删除" style="background:none;border:none;color:var(--cinnabar);cursor:pointer;font-size:16px;padding:0 4px;line-height:1">&times;</button>'
        : "";
      const areaId = "k_" + m.key.replace(/[^a-zA-Z0-9]/g, "_");
      const esName = m.name.replace(/'/g, "\\'");

      if (m.has_key) {
        const keyVal = state.modelKeyValues[m.key] || "";
        const masked = keyVal ? maskKeyText(keyVal) : "••••••••";
        return '<div onclick="pickModel(\'' + m.key + '\',\'' + esName + '\')" style="padding:10px 12px;border-radius:8px;border:1px solid ' + border + ";cursor:pointer;font-size:13px;transition:all var(--transition);" + bg + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
          '<div style="display:flex;align-items:center;flex:1;min-width:0">' + marker +
          '<span style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.name + "</span>" + desc + "</div>" +
          '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:8px">' +
          '<span style="font-size:10px;color:var(--success);background:var(--success-bg);padding:2px 8px;border-radius:10px;white-space:nowrap">已配置</span>' + delBtn + "</div></div>" +
          '<div style="display:flex;align-items:center;gap:6px;font-size:11px">' +
          '<code style="font-family:var(--mono);color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + masked + "</code>" +
          (keyVal ? '<button onclick="event.stopPropagation();copyModelKey(\'' + m.key + '\')" title="复制Key" style="background:none;border:none;color:var(--cinnabar);cursor:pointer;font-size:12px;white-space:nowrap">复制</button>' : "") +
          "</div></div>";
      }

      const keyArea = '<div id="' + areaId + '" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--rule)" onclick="event.stopPropagation()">' +
        '<div style="display:flex;gap:6px;align-items:flex-start">' +
        '<div style="position:relative;flex:1">' +
        '<input id="' + areaId + '_inp" type="password" placeholder="输入 API Key" ' +
        'style="width:100%;padding:8px 34px 8px 12px;border-radius:6px;border:1px solid var(--rule);background:var(--ink-deep);color:var(--text-body);font-size:13px;font-family:var(--mono);transition:border-color var(--transition)" ' +
        'onkeydown="if(event.key===\'Enter\'){applyInlineKey(\'' + areaId + '\',\'' + m.key + '\',\'' + esName + '\')}" ' +
        'oninput="clearKeyStatus(\'' + areaId + '\')">' +
        '<span onclick="toggleKeyVis(\'' + areaId + '\')" title="显示/隐藏" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted);font-size:14px;user-select:none">&#9673;</span>' +
        "</div>" +
        '<button onclick="applyInlineKey(\'' + areaId + '\',\'' + m.key + '\',\'' + esName + '\')" id="' + areaId + '_btn" ' +
        'style="padding:8px 14px;border-radius:6px;border:none;background:var(--cinnabar);color:var(--text-paper);font-size:13px;cursor:pointer;white-space:nowrap;transition:opacity var(--transition)">验证连接</button>' +
        "</div>" +
        '<div id="' + areaId + '_status" style="font-size:11px;margin-top:6px;min-height:18px"></div>' +
        "</div>";

      return '<div onclick="toggleInlineKey(\'' + areaId + '\')" style="padding:10px 12px;border-radius:8px;border:1px solid ' + border + ";cursor:pointer;font-size:13px;transition:all var(--transition);" + bg + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div style="display:flex;align-items:center;flex:1;min-width:0">' + marker +
        '<div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + m.name + desc + "</div>" +
        '<div style="color:var(--text-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (m.base_url || "") + "</div></div></div>" +
        '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:8px">' +
        '<span style="color:var(--text-muted);font-size:12px;white-space:nowrap">未配置</span>' + delBtn + "</div></div>" +
        keyArea + "</div>";
    }).join("");
  }
  list.innerHTML = html;
}

export function pickModel(key: string, name: string): void {
  state.currentModel = key;
  $("#panelModel").textContent = name;
  filterModels();
  buildModelChips();
  void applyModelSwitch();
}

export function showModelQuickPicker(e: Event): void {
  e.stopPropagation();
  const old = document.getElementById("modelQuickPicker");
  if (old) { old.remove(); return; }
  const btn = $("#pillModelBtn");
  const rect = btn.getBoundingClientRect();
  const picker = document.createElement("div");
  picker.id = "modelQuickPicker";
  picker.className = "model-quick-picker mqm-wide";

  let curProvider = "";
  let kw = "";

  const available = state.allModels.filter(m => m.has_key || m.key === state.currentModel);
  const providers = state.allProviders.length
    ? [...state.allProviders].sort((a, b) => a.localeCompare(b, "zh"))
    : [...new Set(available.map(m => m.provider))];

  function renderProviders(): void {
    const row = $("#mqmProviders");
    let html = '<span class="mqm-provider-chip' + (curProvider === "" ? " active" : "") + '" data-provider="">全部</span>';
    providers.forEach(p => {
      html += '<span class="mqm-provider-chip' + (curProvider === p ? " active" : "") + '" data-provider="' + escapeHtml(p) + '">' + escapeHtml(p) + "</span>";
    });
    row.innerHTML = html;
  }

  function renderList(): void {
    let list = available;
    if (curProvider) list = list.filter(m => m.provider === curProvider);
    if (kw) list = list.filter(m =>
      m.name.toLowerCase().includes(kw) ||
      m.model_id.toLowerCase().includes(kw) ||
      (m.description || "").toLowerCase().includes(kw)
    );
    const shown = list.slice(0, 20);
    let html = "";
    if (!shown.length) html = '<div class="mqm-empty">无匹配模型</div>';
    shown.forEach(m => {
      const active = m.key === state.currentModel ? " active" : "";
      html += '<div class="mqm-item' + active + '" data-key="' + m.key + '">' +
        '<span class="mqm-name">' + escapeHtml(m.name) + "</span>" +
        '<span class="mqm-provider">' + escapeHtml(m.provider) + "</span>" +
        "</div>";
    });
    $("#mqmList").innerHTML = html;
  }

  picker.innerHTML =
    '<div class="mqm-provider-row" id="mqmProviders"></div>' +
    '<input class="mqm-search" id="mqmSearch" placeholder="搜索模型…" autocomplete="off">' +
    '<div class="mqm-list" id="mqmList"></div>' +
    '<div class="mqm-all" id="mqmAll">全部模型 →</div>';

  picker.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    // 内部交互（chips/模型项/全部模型）阻止冒泡，避免触发 document 的 closePicker 误关闭
    if (t.closest(".mqm-provider-chip") || t.closest(".mqm-item") || t.closest("#mqmAll")) {
      ev.stopPropagation();
    }
    const chip = t.closest(".mqm-provider-chip") as HTMLElement | null;
    if (chip) {
      curProvider = chip.dataset.provider || "";
      renderProviders();
      renderList();
      return;
    }
    const item = t.closest(".mqm-item") as HTMLElement | null;
    if (item && item.dataset.key) {
      switchChip(item.dataset.key);
      picker.remove();
      return;
    }
    if (t.closest("#mqmAll")) {
      navigateTo("#settings");
      picker.remove();
    }
  });
  picker.addEventListener("input", (ev) => {
    const inp = ev.target as HTMLInputElement;
    if (inp && inp.id === "mqmSearch") {
      kw = inp.value.trim().toLowerCase();
      renderList();
    }
  });

  document.body.appendChild(picker);
  const pickerRect = picker.getBoundingClientRect();
  picker.style.position = "fixed";
  picker.style.bottom = (window.innerHeight - rect.top + 8) + "px";
  picker.style.left = (rect.left + rect.width / 2 - pickerRect.width / 2) + "px";
  renderProviders();
  renderList();
  setTimeout(() => {
    const s = $("#mqmSearch") as HTMLInputElement | null;
    if (s) s.focus();
  }, 30);
  setTimeout(() => {
    document.addEventListener("click", function closePicker(ev) {
      const p = document.getElementById("modelQuickPicker");
      if (p && !p.contains(ev.target as Node)) {
        p.remove();
        document.removeEventListener("click", closePicker);
      }
    }, { once: true });
  }, 50);
}

export function buildModelChips(): void {
  const container = $("#modelChips");
  let chips = state.allModels.filter(m => m.has_key || m.key === state.currentModel || m.key === "deepseek-v3");
  const seen = new Set<string>();
  chips = chips.filter(m => { if (seen.has(m.key)) return false; seen.add(m.key); return true; });
  if (chips.length > 8) chips = chips.slice(0, 8);
  const cur = state.allModels.find(m => m.key === state.currentModel);
  const curName = cur ? cur.name : state.currentModel;
  const dotClass = cur && cur.has_key ? "ok" : "no";
  container.innerHTML =
    '<span style="font-size:11px;color:var(--text-muted);flex-shrink:0;margin-right:2px;display:flex;align-items:center;gap:4px">' +
    '<span class="chip-dot ' + dotClass + '"></span> ' + curName +
    "</span>" +
    chips.map(m => {
      const active = m.key === state.currentModel ? " active" : "";
      const dot = m.has_key ? "ok" : "no";
      const shortName = m.name.length > 10 ? m.name.slice(0, 9) + "…" : m.name;
      return '<button class="model-chip' + active + '" onclick="switchChip(\'' + m.key + '\')" title="' + (m.has_key ? "已配Key" : "未配Key") + " | " + m.provider + '">' +
        '<span class="chip-dot ' + dot + '"></span>' +
        "<span>" + shortName + "</span>" +
        "</button>";
    }).join("");
}

export function switchChip(key: string): void {
  const m = state.allModels.find(x => x.key === key);
  if (!m) return;
  pickModel(key, m.name);
}

export async function applyModelSwitch(): Promise<void> {
  const m = state.allModels.find(x => x.key === state.currentModel);
  if (!m) {
    state.hasKey = false;
    setStatus("offline", "离线");
    return;
  }
  try {
    const d = await postJSON<ModelOpResp>("/api/switch-model", { model: state.currentModel });
    if (d.ok) {
      state.hasKey = d.has_key || false;
      setStatus(state.hasKey ? "online" : "offline", state.hasKey ? ("已连接 " + m.name) : ("未配Key: " + m.name));
    }
  } catch (e) {
    state.hasKey = false;
    setStatus("offline", "API 未启动");
  }
}

export async function applyKey(): Promise<void> {
  let key = ($("#keyInput") as HTMLInputElement).value.trim();
  if (!key) key = state.savedKey;
  if (!key) { showToast("请输入 API Key"); return; }
  if (state.currentModel === "local") {
    showToast("请先在模型列表中选择一个真实模型");
    return;
  }
  setStatus("offline", "验证中…");
  try {
    const d = await postJSON<ModelOpResp & { model?: string }>("/api/set-key", { key, model: state.currentModel });
    if (d.ok) {
      state.hasKey = true;
      state.savedKey = key;
      saveLocalKey(state.currentModel, key);
      setStatus("online", "已连接 " + d.model);
      showToast("已连接 " + d.model);
      ($("#keyInput") as HTMLInputElement).value = "";
      closeAllPanels();
      void loadModels();
    } else {
      setStatus("offline", d.error || "连接失败");
      showToast("失败: " + (d.error || "未知错误"));
    }
  } catch (e) {
    setStatus("offline", "API 服务未启动");
    showToast("API 服务未启动 (端口8900)");
  }
}

export async function resetKey(): Promise<void> {
  ($("#keyInput") as HTMLInputElement).value = "";
  state.savedKey = "";
  state.hasKey = false;
  saveLocalKey(state.currentModel, "");
  try {
    const d = await postJSON<ModelOpResp>("/api/set-key", { key: "", model: "local" });
    if (d.local) state.currentModel = "local";
  } catch (e) { /* 忽略 */ }
  setStatus("offline", "本地模拟模式");
  showToast("已切换为本地模拟");
  void loadModels();
}

export function onModelChange(val: string): void {
  state.currentModel = val;
  $("#panelModel").textContent = val;
  buildModelChips();
  if (state.hasKey) void applyKey();
}

export function toggleInlineKey(areaId: string): void {
  const area = $("#" + areaId) as HTMLElement | null;
  if (!area) return;
  const isHidden = area.style.display === "none" || !area.style.display;
  area.style.display = isHidden ? "" : "none";
  if (isHidden) {
    const inp = $("#" + areaId + "_inp") as HTMLInputElement | null;
    if (inp) setTimeout(() => inp.focus(), 100);
  }
}

export async function applyInlineKey(areaId: string, modelKey: string, modelName: string): Promise<void> {
  const inp = $("#" + areaId + "_inp") as HTMLInputElement | null;
  const btn = $("#" + areaId + "_btn") as HTMLButtonElement | null;
  const status = $("#" + areaId + "_status");
  if (!inp) return;
  const key = inp.value.trim();
  if (!key) { showToast("请输入 API Key"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "验证中…"; btn.style.opacity = "0.7"; }
  status.innerHTML = '<span style="color:var(--warning)">正在验证连接…</span>';
  try {
    const d = await postJSON<ModelOpResp>("/api/model-key", { model: modelKey, key });
    if (d.ok) {
      state.currentModel = d.current_model || modelKey;
      state.hasKey = true;
      setStatus("online", "已连接 " + modelName);
      status.innerHTML = '<span style="color:var(--success)">连接成功 — ' + modelName + "</span>";
      state.modelKeyValues[modelKey] = key;
      saveLocalKey(modelKey, key);
      if (inp) { inp.style.borderColor = "var(--success)"; inp.value = ""; }
      if (btn) btn.style.display = "none";
      setTimeout(() => { void loadModels(); }, 600);
    } else {
      setStatus("offline", d.error || "配置失败");
      status.innerHTML = '<span style="color:var(--cinnabar)">' + (d.error || "验证失败") + "</span>";
      if (inp) inp.style.borderColor = "var(--cinnabar)";
      if (btn) { btn.disabled = false; btn.textContent = "重试"; btn.style.opacity = "1"; }
      showToast("失败: " + (d.error || "未知错误"));
    }
  } catch (e) {
    status.innerHTML = '<span style="color:var(--cinnabar)">网络错误 — API 服务未启动</span>';
    if (inp) inp.style.borderColor = "var(--cinnabar)";
    if (btn) { btn.disabled = false; btn.textContent = "重试"; btn.style.opacity = "1"; }
  }
}

export function toggleKeyVis(areaId: string): void {
  const inp = $("#" + areaId + "_inp") as HTMLInputElement | null;
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
}

export function clearKeyStatus(areaId: string): void {
  const inp = $("#" + areaId + "_inp") as HTMLInputElement | null;
  const status = $("#" + areaId + "_status");
  if (inp) inp.style.borderColor = "var(--rule)";
  if (status) status.innerHTML = "";
  const btn = $("#" + areaId + "_btn") as HTMLButtonElement | null;
  if (btn) { btn.textContent = "验证连接"; btn.disabled = false; btn.style.opacity = "1"; }
}

export async function copyModelKey(modelKey: string): Promise<void> {
  const val = state.modelKeyValues[modelKey];
  if (!val) { showToast("Key 信息不可用"); return; }
  try {
    await navigator.clipboard.writeText(val);
    showToast("Key 已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = val; ta.style.position = "fixed"; ta.style.left = "-9999px";
    document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta);
    showToast("Key 已复制");
  }
}

export async function clearAllModelKeys(): Promise<void> {
  if (!confirm("确定要清除所有模型的独立 Key 配置吗？此操作不可撤销。")) return;
  for (const m of state.allModels) {
    if (m.has_key) {
      await postJSON("/api/model-key", { model: m.key, key: "" });
      saveLocalKey(m.key, "");
    }
  }
  state.hasKey = false;
  setStatus("offline", "本地模拟模式");
  showToast("已清除所有独立 Key");
  void loadModels();
}

export function showCustomModel(): void {
  const form = $("#customModelForm");
  if (form.style.display === "" || form.style.display === "block") {
    hideCustomModel();
    return;
  }
  $("#showCustomBtn").style.display = "none";
  form.style.display = "";
  ($("#customName") as HTMLInputElement).value = "";
  ($("#customUrl") as HTMLInputElement).value = "";
  ($("#customModelId") as HTMLInputElement).value = "";
  $("#urlDetect").textContent = "";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

export function hideCustomModel(): void {
  $("#customModelForm").style.display = "none";
  $("#showCustomBtn").style.display = "";
}

export function autoDetectUrl(): void {
  const url = ($("#customUrl") as HTMLInputElement).value.trim();
  if (!url) { $("#urlDetect").textContent = ""; return; }
  const map: Record<string, string> = {
    "api.openai.com": "OpenAI", "api.anthropic.com": "Anthropic",
    "generativelanguage.googleapis.com": "Google", "api.deepseek.com": "DeepSeek",
    "dashscope.aliyuncs.com": "阿里通义", "open.bigmodel.cn": "智谱",
    "api.moonshot.cn": "月之暗面", "ark.cn-beijing.volces.com": "字节豆包",
    "api.baichuan-ai.com": "百川", "api.minimax.chat": "Minimax",
    "api.lingyiwanwu.com": "零一万物", "spark-api": "讯飞星火",
    "hunyuan": "腾讯混元", "api.mistral.ai": "Mistral",
    "api.llama.com": "Meta", "api.x.ai": "xAI", "api.cohere.ai": "Cohere",
    "api.siliconflow.cn": "SiliconFlow", "openrouter.ai": "OpenRouter",
    "api.together.xyz": "Together AI", "integrate.api.nvidia.com": "NVIDIA",
    "ai.api.nvidia.com": "NVIDIA",
  };
  for (const [host, name] of Object.entries(map)) {
    if (url.includes(host)) {
      $("#urlDetect").textContent = "检测到: " + name;
      const cn = $("#customName") as HTMLInputElement;
      if (!cn.value) cn.placeholder = "如: " + name + "-custom";
      return;
    }
  }
  $("#urlDetect").textContent = "未识别的API地址，将作为通用配置";
}

export async function addCustomModel(): Promise<void> {
  const name = ($("#customName") as HTMLInputElement).value.trim();
  const base_url = ($("#customUrl") as HTMLInputElement).value.trim();
  const model_id = ($("#customModelId") as HTMLInputElement).value.trim();
  if (!name || !base_url) { showToast("名称和API地址不能为空"); return; }
  try {
    const d = await postJSON<ModelOpResp & { model?: import("./types.js").ModelItem }>("/models", {
      name, model_id: model_id || name, base_url, provider: "自定义"
    });
    if (d.ok && d.model) {
      state.currentModel = d.model.key;
      hideCustomModel();
      showToast("已添加: " + name);
      await loadModels();
    } else {
      showToast("添加失败: " + (d.error || "错误"));
    }
  } catch (e) { showToast("添加失败: " + (e instanceof Error ? e.message : "网络错误")); console.error(e); }
}

export async function delModel(key: string): Promise<void> {
  try {
    const r = await fetch(state.API + "/api/models/" + encodeURIComponent(key), { method: "DELETE" });
    const d = (await r.json()) as { ok?: boolean; error?: string };
    if (!d.ok) { showToast(d.error || "删除失败"); return; }
    if (state.currentModel === key) state.currentModel = "local";
    await loadModels();
    showToast("已删除");
  } catch (e) { showToast("删除失败: " + (e instanceof Error ? e.message : "网络错误")); }
}
