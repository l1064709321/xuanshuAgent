// ========== 技能市场 / 技能管理 / 快照 ==========
import { state } from "./state.js";
import { $, escapeHtml, showToast } from "./dom.js";
import { postJSON } from "./api.js";
import { loadSidebarMemTree } from "./memory.js";

// 等宽安全图标（避免 Linux 无 emoji 字体时渲染成乱码方块）
const SK_ICONS: Record<string, string> = {
  search: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/></svg>',
  code: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 3L1.5 8L5 13M11 3l3.5 5L11 13"/></svg>',
  file: '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5h4l1.6 2h7.4a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"/></svg>',
  browser: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2 1.8 3 4 3 6.5s-1 4.7-3 6.5c-2-1.8-3-4-3-6.5s1-4.7 3-6.5z"/></svg>',
  system: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M5.5 12v1.8h5V12M8 7v2"/></svg>',
  phone: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.6h2"/></svg>',
  memory: '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5L14.5 5v6L8 14.5 1.5 11V5L8 1.5zM8 3.5L3.5 5.8v4.4L8 12.5l4.5-2.3V5.8L8 3.5z"/></svg>',
  git: '<svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="4.5" cy="4" r="2.2"/><circle cx="4.5" cy="12" r="2.2"/><path d="M4.5 6.2v3.6M4.5 8h7a2 2 0 0 0 2-2"/></svg>',
  book: '<svg class="mi" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1H13a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3.5A1.5 1.5 0 0 0 2 14.5v-12zM3.5 2.5V13H13V2.5H3.5z"/></svg>',
};

const BUILTIN_SKILLS = [
  { name: "联网搜索", desc: "使用搜索引擎获取实时信息", icon: SK_ICONS.search, agent: "搜索Agent" },
  { name: "代码执行", desc: "在沙箱中运行 Python 代码", icon: SK_ICONS.code, agent: "代码Agent" },
  { name: "文件管理", desc: "读写、编辑、删除文件", icon: SK_ICONS.file, agent: "文件Agent" },
  { name: "浏览器操控", desc: "打开网页、点击、输入、截图", icon: SK_ICONS.browser, agent: "浏览器Agent" },
  { name: "系统管理", desc: "进程、磁盘、网络、包管理", icon: SK_ICONS.system, agent: "电脑Agent" },
  { name: "手机控制", desc: "ADB 操控 Android 设备", icon: SK_ICONS.phone, agent: "手机Agent" },
  { name: "记忆管理", desc: "读写 Agent 长期记忆文件", icon: SK_ICONS.memory, agent: "全部" },
  { name: "Git 版本", desc: "查看提交、回滚、恢复", icon: SK_ICONS.git, agent: "代码Agent" },
  // ── 市面常用技能补充（可按需增删；未内置的技能可用下方「自定义技能」写 MD 定义） ──
  { name: "文档解析", desc: "PDF / Word / Excel / PPT 内容提取", icon: SK_ICONS.file, agent: "文件Agent" },
  { name: "OCR 识别", desc: "图片文字识别、发票/截图提取", icon: SK_ICONS.system, agent: "文件Agent" },
  { name: "翻译", desc: "多语言互译、术语统一", icon: SK_ICONS.search, agent: "搜索Agent" },
  { name: "数据分析", desc: "表格统计、可视化图表生成", icon: SK_ICONS.code, agent: "代码Agent" },
  { name: "网页抓取", desc: "批量采集公开网页内容", icon: SK_ICONS.browser, agent: "浏览器Agent" },
  { name: "定时任务", desc: "按计划执行脚本/提醒", icon: SK_ICONS.system, agent: "电脑Agent" },
  { name: "邮件助手", desc: "撰写、发送、整理邮件", icon: SK_ICONS.file, agent: "电脑Agent" },
  { name: "AI 绘图", desc: "文生图、图生图", icon: SK_ICONS.code, agent: "代码Agent" },
];

// 编辑态引用：newSkill(prefill 含 id) 时记录，submitNewSkill 据此走 update 接口
let skillEditRef: { id: string | number; agent: string } | null = null;

export async function loadSkillMarket(): Promise<void> {
  const el = $("#sidebarSkillMarket");
  try {
    const d = await postJSON<{ ok?: boolean; skills?: { id: number | string; name: string; agent: string }[] }>("/api/skills/list", {});
    const skills = d.skills || [];
    let html = '<div class="skill-market-section"><div class="skill-market-label">内置技能</div>';
    BUILTIN_SKILLS.forEach(s => {
      html += '<div class="skill-market-item">' +
        '<span class="skill-market-icon">' + s.icon + "</span>" +
        '<div class="skill-market-info"><div class="skill-market-name">' + s.name + '</div><div class="skill-market-desc">' + s.desc + "</div></div>" +
        '<span class="skill-market-badge">' + s.agent + "</span></div>";
    });
    html += "</div>";
    if (skills.length) {
      html += '<div class="skill-market-section"><div class="skill-market-label">已学习 (' + skills.length + ")</div>";
      skills.forEach(s => {
        html += '<div class="skill-market-item learned" onclick="viewLearnedSkill(\'' + s.agent + '\',\'' + s.id + '\')">' +
          '<span class="skill-market-icon">' + SK_ICONS.book + "</span>" +
          '<div class="skill-market-info"><div class="skill-market-name">' + escapeHtml(s.name) + '</div><div class="skill-market-desc">' + s.agent + "</div></div></div>";
      });
      html += "</div>";
    }
    html += '<div class="skill-market-add" onclick="newSkill()">+ 自定义技能</div>';
    html += '<div class="skill-market-tip">技能即 Markdown 文件（.skills/&lt;Agent&gt;/&lt;名称&gt;.md），内置列表之外的能力均可自行编写。</div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="file-tree-loading">加载失败</div>';
  }
}

// ========== 独立技能市场页（#skillmarket） ==========
type MarketCard = {
  name: string; desc: string; icon: string; agent: string;
  isBuiltin: boolean; learned: boolean; id?: string | number;
};

export async function renderSkillMarketPage(): Promise<void> {
  const grid = $("#skillMarketGrid");
  if (!grid) return;
  const searchEl = $("#skillMarketSearch") as HTMLInputElement | null;
  const filterEl = $("#skillMarketFilter") as HTMLSelectElement | null;
  const kw = (searchEl?.value || "").trim().toLowerCase();
  const filter = filterEl?.value || "all";
  try {
    const d = await postJSON<{ ok?: boolean; skills?: { id: number | string; name: string; agent: string }[] }>("/api/skills/list", {});
    const learned = d.skills || [];
    const cards: MarketCard[] = [];
    BUILTIN_SKILLS.forEach(s => {
      const hit = learned.find(l => l.name.toLowerCase() === s.name.toLowerCase());
      if (hit) cards.push({ name: s.name, desc: s.desc, icon: s.icon, agent: s.agent, isBuiltin: true, learned: true, id: hit.id });
      else cards.push({ name: s.name, desc: s.desc, icon: s.icon, agent: s.agent, isBuiltin: true, learned: false });
    });
    learned.forEach(l => {
      if (!BUILTIN_SKILLS.some(b => b.name.toLowerCase() === l.name.toLowerCase())) {
        cards.push({ name: l.name, desc: "自定义技能 · " + l.agent, icon: SK_ICONS.book, agent: l.agent, isBuiltin: false, learned: true, id: l.id });
      }
    });
    const list = cards.filter(c => {
      if (kw && !(c.name.toLowerCase().includes(kw) || c.desc.toLowerCase().includes(kw) || c.agent.toLowerCase().includes(kw))) return false;
      if (filter === "builtin" && !c.isBuiltin) return false;
      if (filter === "learned" && !c.learned) return false;
      if (filter === "available" && !(c.isBuiltin && !c.learned)) return false;
      return true;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="skillmarket-empty">没有匹配的技能' + (kw ? '（关键词："' + escapeHtml(kw) + '"）' : "") + "</div>";
      return;
    }
    grid.innerHTML = list.map(c => {
      const status = c.learned
        ? '<span class="skillmarket-status learned">已学习</span>'
        : '<span class="skillmarket-status available">可学习</span>';
      const actions = c.learned
        ? '<button class="btn btn-ghost skillmarket-btn" onclick="viewLearnedSkill(\'' + c.agent + '\',\'' + c.id + '\')">查看</button>' +
          '<button class="btn btn-ghost skillmarket-btn" onclick="editLearnedSkill(\'' + c.agent + '\',\'' + c.id + '\',\'' + escapeHtml(c.name).replace(/'/g, "\\'") + '\')">编辑</button>' +
          '<button class="btn btn-ghost skillmarket-btn danger" onclick="deleteSkill(\'' + c.id + '\',\'' + c.agent + '\')">删除</button>'
        : '<button class="btn btn-primary skillmarket-btn" onclick="installBuiltinSkill(\'' + escapeHtml(c.name).replace(/'/g, "\\'") + '\')">一键学习</button>';
      return '<div class="skillmarket-card">' +
        '<div class="skillmarket-card-icon">' + c.icon + "</div>" +
        '<div class="skillmarket-card-body">' +
        '<div class="skillmarket-card-title">' + escapeHtml(c.name) + ' <span class="skill-market-badge">' + escapeHtml(c.agent) + "</span></div>" +
        '<div class="skillmarket-card-desc">' + escapeHtml(c.desc) + "</div>" +
        '<div class="skillmarket-card-foot">' + status + "</div>" +
        "</div>" +
        '<div class="skillmarket-card-actions">' + actions + "</div>" +
        "</div>";
    }).join("");
  } catch (e) {
    grid.innerHTML = '<div class="file-tree-loading">加载失败</div>';
  }
}

export async function installBuiltinSkill(name: string): Promise<void> {
  const s = BUILTIN_SKILLS.find(x => x.name === name);
  if (!s) { showToast("未找到该技能"); return; }
  if (!confirm("一键学习「" + s.name + "」？将生成对应的 Markdown 技能定义文件，可随时编辑或删除。")) return;
  const content = "# " + s.name + "\n\n" +
    "## 触发场景\n\n- 用户提到：" + s.desc + "\n\n" +
    "## 执行步骤\n\n1. 分析用户意图，确认适用场景\n2. 调用 " + s.agent + " 对应能力执行\n3. 校验结果并输出\n\n" +
    "## 注意事项\n\n- 本技能由技能市场「一键学习」生成，可按需编辑完善。";
  try {
    const d = await postJSON<{ ok?: boolean; error?: string }>("/api/skills/create", { agent: s.agent, name: s.name, content });
    if (d.ok) { showToast("已学习：" + s.name); await refreshSkills(); }
    else { showToast(d.error || "学习失败"); }
  } catch (e) { showToast("学习失败"); }
}

export async function editLearnedSkill(agent: string, id: number | string, name: string): Promise<void> {
  try {
    const d = await postJSON<{ error?: string; content?: string }>("/api/skills/read", { agent, id });
    if (d.error) { showToast(d.error); return; }
    newSkill({ id, agent, name, content: d.content || "" });
  } catch (e) { showToast("读取失败"); }
}

export function showNewSkillDialog(): void {
  const name = prompt("技能名称:");
  if (!name) return;
  const agent = prompt("绑定 Agent (搜索Agent/代码Agent/文件Agent/浏览器Agent/电脑Agent/手机Agent):", "代码Agent");
  if (!agent) return;
  const content = prompt("技能描述 (Markdown):", "# " + name + "\n\n## 使用方法\n\n1. ...");
  if (!content) return;
  void createSkill(agent, name, content);
}

export async function createSkill(agent: string, name: string, content: string): Promise<void> {
  try {
    const d = await postJSON<{ ok?: boolean; error?: string }>("/api/skills/create", { agent, name, content });
    if (d.ok) { showToast("技能已创建"); void loadSkillMarket(); }
    else { showToast(d.error || "创建失败"); }
  } catch (e) { showToast("创建失败"); }
}

export async function viewLearnedSkill(agent: string, id: number | string): Promise<void> {
  try {
    const d = await postJSON<{ error?: string; name?: string; content?: string }>("/api/skills/read", { agent, id });
    if (d.error) { showToast(d.error); return; }
    const content = d.content || "";
    const name = d.name || String(id);
    // 展示 + 编辑/删除
    const overlay = document.createElement("div");
    overlay.className = "skill-form-overlay";
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = '<div class="skill-form-panel">' +
      '<h2 style="font-family:var(--serif);font-size:20px;color:var(--text-paper);margin-bottom:12px">' + escapeHtml(name) +
      ' <span style="font-size:11px;background:var(--surface-hover);padding:2px 8px;border-radius:99px;color:var(--text-muted)">' + escapeHtml(agent) + "</span></h2>" +
      '<div style="max-height:40vh;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;white-space:pre-wrap;color:var(--text-secondary);margin-bottom:14px">' + escapeHtml(content) + "</div>" +
      '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">' +
      '<button class="btn btn-ghost" onclick="deleteSkill(\'' + id + '\',\'' + agent + '\');this.closest(\'.skill-form-overlay\').remove()">删除</button>' +
      '<button class="btn btn-ghost" onclick="this.closest(\'.skill-form-overlay\').remove();newSkill({id:\'' + id + '\',agent:\'' + agent + '\',name:\'' + name.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + '\',content:SKILL_EDIT_CONTENT})">编辑</button>' +
      '<button class="btn btn-primary" onclick="this.closest(\'.skill-form-overlay\').remove()">关闭</button></div></div>';
    document.body.appendChild(overlay);
    (window as unknown as Record<string, unknown>).SKILL_EDIT_CONTENT = content;
  } catch (e) { showToast("读取失败"); }
}

export async function exportAll(): Promise<void> {
  try {
    const r = await fetch(state.API + "/api/snapshots/export", { method: "POST" });
    const d = (await r.json()) as { ok?: boolean };
    showToast(d.ok ? "快照已导出" : "导出失败");
  } catch (e) { showToast("导出失败"); }
}

export async function importAll(): Promise<void> {
  try {
    const r = await fetch(state.API + "/api/snapshots/import", { method: "POST" });
    const d = (await r.json()) as { ok?: boolean; imported?: number };
    showToast(d.ok ? "快照已导入 (+" + (d.imported || 0) + "条)" : "导入失败");
    void loadSidebarMemTree();
  } catch (e) { showToast("导入失败"); }
}

export async function refreshSkills(_agent?: string): Promise<void> {
  // 技能列表统一由 loadSkillMarket 渲染到侧栏"技能市场"；独立技能市场页同步刷新
  await Promise.all([loadSkillMarket(), renderSkillMarketPage()]);
}

export async function readSkill(id: number | string, agent: string): Promise<void> {
  const res = await fetch(state.API + "/api/skills/read", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, id }),
  });
  const d = (await res.json()) as { ok?: boolean; skill?: { name: string; content: string } };
  if (!d.ok) { showToast("读取失败"); return; }
  const s = d.skill;
  if (!s) { showToast("读取失败"); return; }
  const overlay = document.createElement("div");
  overlay.className = "skill-viewer-overlay";
  overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = '<div class="skill-viewer-panel"><button class="skill-viewer-close" onclick="this.closest(\'.skill-viewer-overlay\').remove()">&times;</button>' +
    "<h2>" + escapeHtml(s.name) + ' <span class="skill-agent-badge" style="font-size:11px;background:var(--ink-hover);padding:2px 8px;border-radius:99px;color:var(--text-muted)">' + agent + "</span></h2>" +
    "<p>" + escapeHtml(s.content) + "</p></div>";
  document.body.appendChild(overlay);
}

export async function deleteSkill(id: number | string, agent: string): Promise<void> {
  if (!confirm("删除此技能？")) return;
  const res = await fetch(state.API + "/api/skills/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, id }),
  });
  const d = (await res.json()) as { ok?: boolean };
  if (d.ok) { showToast("已删除"); void refreshSkills(); }
  else { showToast("删除失败"); }
}

export function newSkill(prefill?: { id?: string | number; agent?: string; name?: string; content?: string }): void {
  skillEditRef = prefill && prefill.id !== undefined ? { id: prefill.id, agent: prefill.agent || "" } : null;
  const overlay = document.createElement("div");
  overlay.className = "skill-form-overlay";
  overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
  const agentNames: string[] = [];
  document.querySelectorAll(".skill-agent-badge").forEach(b => {
    const n = b.textContent?.trim() || "";
    if (n && !agentNames.includes(n)) agentNames.push(n);
  });
  if (agentNames.length === 0) {
    BUILTIN_SKILLS.forEach(s => { if (!agentNames.includes(s.agent)) agentNames.push(s.agent); });
  }
  const preAgent = prefill?.agent || agentNames[0] || "代码Agent";
  const preName = prefill?.name || "";
  const preContent = prefill?.content || "";
  overlay.innerHTML = '<div class="skill-form-panel">' +
    '<h2 style="font-family:var(--serif);font-size:20px;color:var(--text-paper);margin-bottom:20px">' + (prefill ? "编辑技能" : "新建技能") + "</h2>" +
    '<div class="form-group"><label class="form-label">Agent</label>' +
    '<select id="skillFormAgent" class="form-input">' +
    (agentNames.map(n => '<option value="' + n + '"' + (n === preAgent ? " selected" : "") + ">" + n + "</option>").join("")) +
    "</select></div>" +
    '<div class="form-group"><label class="form-label">技能名称</label>' +
    '<input id="skillFormName" class="form-input" placeholder="如: pdf-parser、excel-layout" value="' + escapeHtml(preName) + '"></div>' +
    '<div class="form-group"><label class="form-label">技能内容 (Markdown)</label>' +
    '<textarea id="skillFormContent" class="form-input" placeholder="# 技能名称&#10;&#10;## 触发场景&#10;&#10;## 执行步骤&#10;&#10;1. ...&#10;2. ..." style="min-height:140px">' + escapeHtml(preContent) + "</textarea></div>" +
    '<div class="skill-template-bar">' +
    '<button type="button" class="btn btn-ghost" style="font-size:12px;padding:2px 10px" onclick="fillSkillTemplate()">填入 MD 模板</button>' +
    '<span style="font-size:11px;color:var(--text-muted)">技能保存为 Markdown 文件，随时可再编辑</span></div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '<button class="btn btn-ghost" onclick="this.closest(\'.skill-form-overlay\').remove()">取消</button>' +
    '<button class="btn btn-primary" onclick="submitNewSkill()">' + (prefill ? "保存" : "创建") + "</button></div></div>";
  document.body.appendChild(overlay);
}

export function fillSkillTemplate(): void {
  const ta = $("#skillFormContent") as HTMLTextAreaElement | null;
  if (!ta) return;
  const name = ($("#skillFormName") as HTMLInputElement | null)?.value?.trim() || "技能名";
  ta.value = "# " + name + "\n\n" +
    "## 触发场景\n\n- 用户提到：...（填写关键词）\n\n" +
    "## 执行步骤\n\n1. 第一步\n2. 第二步\n3. 输出结果\n\n" +
    "## 注意事项\n\n- ...\n";
}

export async function submitNewSkill(): Promise<void> {
  const agent = ($("#skillFormAgent") as HTMLInputElement | null)?.value?.trim();
  const name = ($("#skillFormName") as HTMLInputElement | null)?.value?.trim();
  const content = ($("#skillFormContent") as HTMLInputElement | null)?.value?.trim();
  if (!agent || !name || !content) { showToast("请填写完整"); return; }
  const editing = skillEditRef !== null;
  // 编辑时 Agent 固定为原值，避免目录错位导致 404；改名走 update 内部新文件逻辑
  const finalAgent = editing ? skillEditRef!.agent : agent;
  const url = editing ? "/api/skills/update" : "/api/skills/create";
  const body = editing ? { agent: finalAgent, id: skillEditRef!.id, name, content } : { agent, name, content };
  const res = await fetch(state.API + url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = (await res.json()) as { ok?: boolean; error?: string };
  if (d.ok) {
    showToast(editing ? "技能已保存" : "技能已创建");
    skillEditRef = null;
    document.querySelector(".skill-form-overlay")?.remove();
    void refreshSkills();
  } else {
    showToast(d.error || (editing ? "保存失败" : "创建失败"));
  }
}
