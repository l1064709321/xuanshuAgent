// ========== 前端入口：聚合所有模块并挂载全局（兼容 index.html 内联 onclick） ==========
import { state } from "./state.js";
import { $ } from "./dom.js";

// 账号
import * as auth from "./auth.js";
// 对话 / TTS / 持久化
import * as chat from "./chat.js";
// 模型管理
import * as models from "./models.js";
// 工具适配层
import * as tools from "./tools.js";
// 技能市场
import * as skills from "./skills.js";
// 记忆 / 头像
import * as memory from "./memory.js";
// 头像抽屉
import * as drawer from "./drawer.js";
// 文件树
import * as files from "./files.js";
// 权限弹窗
import * as permission from "./permission.js";
// 主题
import * as theme from "./theme.js";
// 面板 / 路由
import * as panels from "./panels.js";
// 菜单
import * as menu from "./menu.js";
// 工作流
import * as workflow from "./workflow.js";
// 监控
import * as monitor from "./monitor.js";
// Linux 虚拟机
import * as vm from "./vm.js";
// 心跳 / 连接状态
import * as status from "./status.js";
// 粒子云
import { initParticles } from "./particles.js";
// 移动端视口（键盘自动收放）
import { initViewport } from "./viewport.js";

// ── 挂载 HTML 内联事件所需的全局函数 ──
function mountGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  const g: Record<string, unknown> = {
    // auth
    checkAuth: auth.checkAuth, hideAuth: auth.hideAuth,
    // chat
    syncTTSButton: chat.syncTTSButton, toggleTTS: chat.toggleTTS, readAloud: chat.readAloud,
    send: chat.send, uploadFiles: chat.uploadFiles, clearConv: chat.clearConv,
    startVoiceInput: chat.startVoiceInput, askSubmit: chat.askSubmit, askCancel: chat.askCancel,
    // models
    loadModels: models.loadModels, filterModels: models.filterModels, pickModel: models.pickModel,
    switchChip: models.switchChip, applyKey: models.applyKey, resetKey: models.resetKey,
    onModelChange: models.onModelChange, showModelQuickPicker: models.showModelQuickPicker,
    toggleInlineKey: models.toggleInlineKey, applyInlineKey: models.applyInlineKey,
    toggleKeyVis: models.toggleKeyVis, clearKeyStatus: models.clearKeyStatus,
    copyModelKey: models.copyModelKey, clearAllModelKeys: models.clearAllModelKeys,
    showCustomModel: models.showCustomModel, hideCustomModel: models.hideCustomModel,
    autoDetectUrl: models.autoDetectUrl, addCustomModel: models.addCustomModel, delModel: models.delModel,
    // tools
    checkToolEnv: tools.checkToolEnv, selectTool: tools.selectTool, loadPreset: tools.loadPreset,
    previewCmd: tools.previewCmd, runPreset: tools.runPreset, runCustomCmd: tools.runCustomCmd,
    updateCustomTool: tools.updateCustomTool, loadAgentConfig: tools.loadAgentConfig,
    showDownloadPermInfo: tools.showDownloadPermInfo,
    // skills
    loadSkillMarket: skills.loadSkillMarket, showNewSkillDialog: skills.showNewSkillDialog,
    viewLearnedSkill: skills.viewLearnedSkill, exportAll: skills.exportAll, importAll: skills.importAll,
    refreshSkills: skills.refreshSkills, readSkill: skills.readSkill, deleteSkill: skills.deleteSkill,
    newSkill: skills.newSkill, submitNewSkill: skills.submitNewSkill, fillSkillTemplate: skills.fillSkillTemplate,
    renderSkillMarketPage: skills.renderSkillMarketPage, installBuiltinSkill: skills.installBuiltinSkill,
    editLearnedSkill: skills.editLearnedSkill,
    // memory / drawer
    loadSidebarAvatar: memory.loadSidebarAvatar, uploadProfileAvatar: memory.uploadProfileAvatar,
    readSidebarMemdir: memory.readSidebarMemdir,
    loadSidebarMemTree: memory.loadSidebarMemTree, viewMemFile: memory.viewMemFile,
    openMemoryPage: memory.openMemoryPage, backFromMemoryView: memory.backFromMemoryView,
    restoreAvatar: memory.restoreAvatar,
    openAvatarDrawer: drawer.openAvatarDrawer, closeAvatarDrawer: drawer.closeAvatarDrawer,
    loadDrawerMemList: drawer.loadDrawerMemList, uploadAvatarFromFile: drawer.uploadAvatarFromFile,
    // files
    loadWorkspaceFiles: files.loadWorkspaceFiles, openFileInViewer: files.openFileInViewer,
    closeFileViewer: files.closeFileViewer,
    // permission
    showPermission: permission.showPermission, hidePermission: permission.hidePermission,
    permitReply: permission.permitReply,
    // theme
    setMode: theme.setMode, setAccent: theme.setAccent, initTheme: theme.initTheme,
    toggleThemeQuickPanel: theme.toggleThemeQuickPanel, applyQuick: theme.applyQuick,
    // panels / menu
    collapseLeft: panels.collapseLeft, toggleLeft: panels.toggleLeft,
    toggleSettings: panels.toggleSettings, closeAllPanels: panels.closeAllPanels,
    navigateTo: panels.navigateTo, switchPanelTab: panels.switchPanelTab,
    toggleMoreMenu: menu.toggleMoreMenu, closeMoreMenu: menu.closeMoreMenu,
    // workflow
    renderCanvas: workflow.renderCanvas, refreshCanvas: workflow.refreshCanvas,
    showWFCreate: workflow.showWFCreate, editWF: workflow.editWF, toggleWF: workflow.toggleWF,
    deleteWF: workflow.deleteWF, saveCanvasWF: workflow.saveCanvasWF,
    openNodeEditor: workflow.openNodeEditor, applyNodeEdit: workflow.applyNodeEdit,
    closeNodeEdit: workflow.closeNodeEdit, onCanvasTriggerChange: workflow.onCanvasTriggerChange,
    onCanvasClick: workflow.onCanvasClick, onPaletteDrag: workflow.onPaletteDrag,
    onCanvasDragOver: workflow.onCanvasDragOver, onCanvasDrop: workflow.onCanvasDrop,
    // monitor
    openMonitor: monitor.openMonitor, closeMonitor: monitor.closeMonitor,
    initMonitor: monitor.initMonitor, toggleInlineMonitor: monitor.toggleInlineMonitor,
    toggleAutoRefresh: monitor.toggleAutoRefresh, fetchTokenStats: monitor.fetchTokenStats,
    startAutoRefresh: monitor.startAutoRefresh, stopAutoRefresh: monitor.stopAutoRefresh,
    // vm
    initVM: vm.initVM, openVMApp: vm.openVMApp, closeVMWindow: vm.closeVMWindow,
    // heartbeat
    startHeartbeat: status.startHeartbeat, stopHeartbeat: status.stopHeartbeat, doPing: status.doPing,
    // particles
    initParticles,
  };
  Object.assign(w, g);
}

// ── 初始化 ──
function init(): void {
  theme.initTheme();

  // 移动端视口适配（键盘弹出自动收放输入区）
  initViewport();

  // 页面加载即启动心跳
  status.startHeartbeat();

  // 认证
  void auth.checkAuth();
  auth.initAuthInputs();

  // 工具栏头像 → 个人页
  $("#toolbarAvatar").addEventListener("click", () => panels.toggleLeft());

  // 工作区文件树 / 粒子 / 路由
  void files.loadWorkspaceFiles();
  initParticles();
  panels.initRouter();

  // 初始化即加载模型列表（保证首次进入 #chat 点闪电按钮时弹层有完整模型数据）
  void models.loadModels();

  // 对话恢复
  if (!chat.loadConv()) { void chat.restoreFromServer(); }

  // 延时加载
  setTimeout(() => { void skills.refreshSkills(); }, 1200);
  setTimeout(() => {
    const tab = document.getElementById("tab-tools");
    if (tab && tab.offsetParent !== null) { void tools.checkToolEnv(); }
  }, 2000);

  // 输入唤醒心跳
  const input = document.getElementById("msg-input") as HTMLTextAreaElement | null;
  if (input) {
    input.addEventListener("input", status.onUserInputWake);
    input.addEventListener("keydown", status.onUserInputWake);
  }
  const sendBtn = document.querySelector(".pill-send");
  if (sendBtn) sendBtn.addEventListener("click", status.onUserInputWake);

  // 工作流快捷键
  workflow.initWorkflowShortcuts();

  // 常驻 Token 命中率监控（对话下方内嵌）
  monitor.initMonitor();

  // 兜底：首次进入工作流面板时渲染空画布
  setTimeout(() => { if (state.wfCanvasNodes.length === 0) workflow.renderCanvas(); }, 800);
}

mountGlobals();
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
