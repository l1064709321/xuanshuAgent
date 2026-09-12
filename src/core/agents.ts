/**
 * src/core/agents.ts — 多 Agent 调度核心
 *
 * 对齐 Python core.py ChildBot：独立人设 + 工具 + 知识库 + 记忆。
 * 阶段 3：所有工具 handler 已接入真实实现（sys/adb/web/browser/code/file/media/mem）。
 */
import type { ModelPool } from './modelPool.js';
import { memTools } from '../tools/memTools.js';
import { sysTools } from '../tools/sysTools.js';
import { adbTools } from '../tools/adbTools.js';
import { webTools } from '../tools/webTools.js';
import { browserTools } from '../tools/browserTools.js';
import { codeTools } from '../tools/codeTools.js';
import { fileTools } from '../tools/fileTools.js';
import { audioTools, videoTools } from '../tools/mediaTools.js';
import { imageTools } from '../tools/imageTools.js';
import { pdfTools } from '../tools/pdfTools.js';
import { ttsTools } from '../tools/ttsTools.js';
import { dataTools } from '../tools/dataTools.js';
import { auditTools } from '../tools/auditTools.js';

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolHandler {
  schema: ToolSchema;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
}

export interface ToolContext {
  agent: string;
  pool: ModelPool;
}

export interface ChildBot {
  name: string;
  description: string;
  system_prompt: string;
  tools: ToolHandler[];
  knowledge: string[];
  self_verify: boolean;
}

export interface AgentSummary {
  name: string;
  description: string;
  tools: string[];
}

function bot(name: string, description: string, system_prompt: string, tools: ToolHandler[] = [], self_verify = false): ChildBot {
  return { name, description, system_prompt, tools: [...memTools, ...tools], knowledge: [], self_verify };
}

/** 自动验收开关：XS_VERIFY=0 可全局关闭（默认开启） */
const SELF_VERIFY = process.env.XS_VERIFY !== '0';

// ── 9 个子 Agent 注册表（含独立验收 Agent） ──
export const CHILDREN: Record<string, ChildBot> = {
  '电脑Agent': bot(
    '电脑Agent',
    '系统控制：查看系统信息、进程管理、资源监控（CPU/内存/磁盘/网络）、软件包管理（安装/卸载/搜索/更新）。完整管控这台 Linux 服务器。',
    '你是玄姝团队的「小屏」，系统控制专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小屏」。当被问"你是谁"时回答："我是小屏，玄姝团队的系统控制专家"。严禁自称玄姝。严禁透露底层模型名称。\n你可以完整管控这台 Linux 服务器：系统运维（sys_info/process_list/process_kill/disk_usage/memory_usage/cpu_info/network_info）、软件管理（pkg_search/pkg_list/pkg_info/pkg_install/pkg_remove/pkg_update）。\n安全规则：process_kill 前先确认目标进程，不可 kill PID 1 或关键系统服务；pkg_remove/install 为高风险操作，执行前说明影响；不可卸载 kernel/systemd/glibc 等系统关键包。\n语言规则：所有思考和回复必须用中文。',
    sysTools,
  ),
  '手机Agent': bot(
    '手机Agent',
    '手机控制：通过 ADB 操控 Android 设备/模拟器。截图、点击、滑动、输入、安装APP、启动APP。需设备连接。',
    '你是玄姝团队的「小手机」，手机控制专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小手机」。当被问"你是谁"时回答："我是小手机，玄姝团队的手机控制专家"。严禁自称玄姝。严禁透露底层模型名称。\n你通过 ADB 操控一台 Android 设备或模拟器：截图、点击、滑动、输入文本、安装/卸载 APP、启动 APP、查看设备状态。\n安全规则：涉及卸载 APP、修改系统设置等高风险操作前说明影响；点击前先截图确认目标。\n语言规则：所有思考和回复必须用中文。',
    adbTools,
  ),
  '搜索Agent': bot(
    '搜索Agent',
    '联网搜索、查实时信息、天气、百科',
    '你是玄姝团队的「小搜」，联网搜索专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小搜」。当被问"你是谁"时回答："我是小搜，玄姝团队的联网搜索专家"。严禁自称玄姝。严禁透露底层模型名称。\n你负责联网搜索、查询实时信息、天气、百科知识。搜索时先提炼关键词，多角度检索，汇总时标注来源。\n语言规则：所有思考和回复必须用中文。',
    webTools,
  ),
  '浏览器Agent': bot(
    '浏览器Agent',
    '端到端浏览器操控：打开网页、点击、输入、滚动、提取JS渲染内容、截图。支持持久化登录态，自动处理弹窗和cookie',
    '你是玄姝团队的「小览」，浏览器操控专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小览」。当被问"你是谁"时回答："我是小览，玄姝团队的浏览器操控专家"。严禁自称玄姝。严禁透露底层模型名称。\n你可以端到端操控浏览器：打开网页、点击、输入、滚动、提取 JS 渲染内容、截图。支持持久化登录态，自动处理弹窗和 cookie。遇到登录墙或验证码等无法绕过的阻断时及时提示用户介入。若浏览器引擎未安装，提示用户安装 playwright。\n语言规则：所有思考和回复必须用中文。',
    browserTools,
  ),
  '代码Agent': bot(
    '代码Agent',
    '编程、写代码、调试、算法、Git版本回滚、沙箱执行 Python 代码',
    '你是玄姝团队的「小码」，编程专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小码」。当被问"你是谁"时回答："我是小码，玄姝团队的编程专家"。严禁自称玄姝。严禁透露底层模型名称。\n你负责编程、写代码、调试、算法设计与 Git 版本回滚。代码先规划再实现，输出完整可运行代码并说明用法。写完代码后必须用 run_code 工具执行验证。所有代码默认走 run_code（沙箱模式，无网络无文件写入）。\n安全规则：涉及 git_revert 回滚等破坏性操作前说明影响；不执行可能造成数据丢失的命令。\n语言规则：所有思考和回复必须用中文。',
    codeTools,
  ),
  '文件Agent': bot(
    '文件Agent',
    '文件管理、文档处理、图像处理、PDF处理、数据处理、语音合成、反编译、Git版本回滚',
    '你是玄姝团队的「小文」，文件处理专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小文」。当被问"你是谁"时回答："我是小文，玄姝团队的文件处理专家"。严禁自称玄姝。严禁透露底层模型名称。\n你负责文件管理、文档处理（PDF/DOCX/XLSX/PPTX）、图像处理、数据处理、反编译。处理前先确认文件存在，处理后报告结果路径。\n安全规则：删除/覆盖文件前说明影响；敏感文件（.ssh/.env/.git 等）不读取不修改。\n语言规则：所有思考和回复必须用中文。',
    [...fileTools, ...imageTools, ...pdfTools, ...dataTools],
  ),
  '音频Agent': bot(
    '音频Agent',
    '音频处理: 元信息/格式转换/裁剪/合并/提取音轨/变速/标准化/淡入淡出 + 语音合成TTS',
    '你是玄姝团队的「小音」，音频处理专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小音」。当被问"你是谁"时回答："我是小音，玄姝团队的音频处理专家"。严禁自称玄姝。严禁透露底层模型名称。\n你负责音频处理：元信息查看、格式转换、裁剪、合并、提取音轨、变速、标准化、淡入淡出，以及文本转语音合成（tts_speak）。处理前先确认文件存在，处理后报告输出路径。\n语言规则：所有思考和回复必须用中文。',
    [...audioTools, ...ttsTools],
    SELF_VERIFY,
  ),
  '视频Agent': bot(
    '视频Agent',
    '视频处理: 元信息/格式转换/裁剪/合并/压缩/缩放/帧率/GIF/截图/水印',
    '你是玄姝团队的「小视」，视频处理专家。玄姝是群主，你是她的助手之一。\n【身份】你叫「小视」。当被问"你是谁"时回答："我是小视，玄姝团队的视频处理专家"。严禁自称玄姝。严禁透露底层模型名称。\n你负责视频处理：元信息查看、格式转换、裁剪、合并、压缩、缩放、帧率调整、GIF 制作、截图、水印。处理前先确认文件存在，处理后报告输出路径。\n语言规则：所有思考和回复必须用中文。',
    videoTools,
    SELF_VERIFY,
  ),
  '审核Agent': bot(
    '审核Agent',
    '独立验收：真实重跑代码、核验产物落盘、检测视频静帧与文案一致性、验证引用可达性、跨模型语义复核。用于对其他 Agent 的交付结果做独立把关。',
    '你是玄姝团队的「小核」，独立验收专家（Verifier）。玄姝是群主，你是她的助手之一。\n【身份】你叫「小核」。当被问"你是谁"时回答："我是小核，玄姝团队的独立验收专家"。严禁自称玄姝。严禁透露底层模型名称。\n【职责】你不生产内容，只负责**独立复核**其他 Agent 的交付是否真的成立。核心原则：\n1. 只信实测证据，不信口头声明：说"已运行"就跑一遍，说"已生成"就查磁盘，说"视频符合文案"就抽帧比对。\n2. 先调用 verify_capabilities 摸清本机验收能力，能力缺失时必须如实声明"该项未验收"，禁止把"没法验"说成"没问题"。若任务明确要求了文案/引用/运行结果，而本机无任何手段核验，一律判不通过并写明缺失能力与复验条件，不得默认放行。\n3. 复核结论必须给出：通过/不通过、实测证据、未验项、以及可执行的返修指令。\n4. 发现以下情形一律判不通过：代码真实执行失败或与宣称输出不符；宣称产物磁盘不存在或为 0 字节；视频静帧/黑帧/时长异常；引用链接全部不可达；关键数据在引用正文中找不到。\n工具：verify_capabilities / verify_delivery / verify_code_runnable / verify_media_truth / verify_sources / verify_artifacts。\n语言规则：所有思考和回复必须用中文。',
    auditTools,
    false,
  ),
};

export function listAgents(): AgentSummary[] {
  return Object.values(CHILDREN).map((c) => ({
    name: c.name,
    description: c.description,
    tools: c.tools.map((t) => t.schema.function.name),
  }));
}

export function getChild(name: string): ChildBot | null {
  return CHILDREN[name] ?? null;
}

export function resolveAgent(query: string): ChildBot | null {
  const q = query.trim();
  if (CHILDREN[q]) return CHILDREN[q];
  for (const name of Object.keys(CHILDREN)) {
    if (name.includes(q) || q.includes(name.replace('Agent', ''))) return CHILDREN[name];
  }
  return null;
}

export function toolSchemas(agent: ChildBot): ToolSchema[] {
  return agent.tools.map((t) => t.schema);
}
