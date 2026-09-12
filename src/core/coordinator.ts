/**
 * src/core/coordinator.ts — 统一 LLM 调用调度器
 *
 * 对齐 Python core.py XuanShuCore._llm_call：
 * - 根据模型模态自动路由（多模态模型走专有端点，阶段4实现；此处先预留）
 * - 前缀缓存注入（vendors 层按厂商归一化路由）
 * - 多模型兜底链 + 失败冷却
 * - Token 预算追踪（阶段4强化）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ModelPool, type LlmResponse, type Modality } from './modelPool.js';
import { injectCacheHints } from '../vendors/index.js';
import { getChild, type ChildBot, type ToolHandler, type ToolSchema } from './agents.js';
import { memFileName } from '../tools/memTools.js';
import { PROJECT_ROOT } from './sandbox.js';
import { verifyChildResult, formatVerdictForPrompt, formatVerdictBrief, type VerifyVerdict } from './verifier.js';
import { getLimits } from './limits.js';

/** Agent 记忆目录（与 memTools / API 层一致） */
const MEM_DIR = path.join(PROJECT_ROOT, '.memdir');
/** 注入上下文的记忆上限（字符），防上下文爆炸 */
const MEM_INJECT_LIMIT = 4000;

/** 工具循环轮数上限 / 无进展熔断阈值均改为运行时可配（见 core/limits.ts，默认 500 / 5，可由前端调整） */

/** 子 Agent 过程事件（think/tool/result 为执行过程，verify 为独立验收过程，need_continue 为触发暂停待续轮） */
export interface ProgressEvent {
  type: 'think' | 'tool' | 'result' | 'verify' | 'need_continue';
  agent: string;
  round?: number;
  thought?: string;
  tool?: string;
  args?: string;
  result?: string;
  stage?: string;
  detail?: string;
}
export type ProgressFn = (evt: ProgressEvent) => void;

/** 工具调用参数解析：兼容 JSON 字符串/对象，失败时返回 null */
function safeParseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // 兼容裸 JSON（模型偶尔输出无花括号的 key:value）
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
    return null;
  }
}

/** 工具名模糊匹配（精确 → 包含 → 前缀） */
function fuzzyMatchTool(raw: string, valid: string[]): string | null {
  if (valid.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  for (const v of valid) {
    if (v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase())) return v;
  }
  return null;
}

/** 分发单个工具调用：安全兜底，绝不抛异常 */
async function dispatchToolCall(child: ChildBot, tc: { id?: string; function?: { name?: string; arguments?: unknown } }, pool: ModelPool): Promise<{ name: string; result: string }> {
  const fnBlock = tc.function;
  const rawName = fnBlock?.name ?? '?';
  const callId = tc.id ?? `call_${Date.now()}`;
  const validNames = child.tools.map((t) => t.schema.function.name);

  // 参数解析
  const args = safeParseArgs(fnBlock?.arguments ?? '{}');
  if (!args) {
    return { name: rawName, result: `[工具调用错误] 参数JSON解析失败: ${String(fnBlock?.arguments ?? '').slice(0, 300)}\n请用合法的JSON重新调用工具。` };
  }

  // 工具名模糊匹配
  const matched = fuzzyMatchTool(rawName, validNames);
  if (!matched) {
    return { name: rawName, result: `[工具调用错误] 工具 '${rawName}' 不存在。\n可用工具: ${validNames.join(', ')}\n请选择正确的工具名称重新调用。` };
  }

  const tool: ToolHandler | undefined = child.tools.find((t) => t.schema.function.name === matched);
  if (!tool) return { name: matched, result: `[工具调用错误] 工具 '${matched}' 内部未找到` };

  try {
    const result = await tool.handler(args, { agent: child.name, pool });
    return { name: matched, result: String(result) };
  } catch (e) {
    return { name: matched, result: `[工具执行异常] ${(e as Error).message}` };
  }
}

/** 从 LLM 消息中提取 tool_calls（兼容原生 function calling 与文本解析） */
function extractToolCalls(msg: { content?: string; tool_calls?: unknown }): { id?: string; function?: { name?: string; arguments?: unknown } }[] | null {
  const tcs = msg.tool_calls;
  if (Array.isArray(tcs) && tcs.length) return tcs as never;
  // 文本解析：识别 ```json 或 {name:..., arguments:{...}} 块
  const content = msg.content ?? '';
  const m = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed.name || parsed.tool) {
        return [{ id: `call_text_${Date.now()}`, function: { name: parsed.name || parsed.tool, arguments: parsed.arguments ?? parsed.args ?? {} } }];
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** 剥离 ReAct 观察前缀 */
function stripObservationPrefix(text: string): string {
  return text
    .replace(/^\s*(观察|观测|Observation)[:：]\s*/i, '')
    .replace(/^\s*(观察|观测|Observation)[:：]\s*\n+/i, '')
    .trim();
}

/** 工具观测结果指纹：用于"无进展熔断"判断（连续 N 轮指纹一致 = 空转） */
function resultSignature(results: { name: string; result: string }[]): string {
  const s = results.map((r) => `${r.name}:${r.result.length}:${r.result.slice(0, 160)}`).join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${results.length}#${h}`;
}

/**
 * 触发暂停（轮数上限 / 无进展熔断）时产出的「断点报告」。
 * 关键：不写成"任务失败"，而是明确断点 + 给主 Agent 的续轮请示指令，
 * 让上层能带断点重派同一子 Agent 继续跑，而不是从头再做。
 */
function buildPauseReport(
  opts: {
    agent: string;
    reason: 'max_rounds' | 'stall';
    roundsUsed: number;
    maxRounds: number;
    stallRounds: number;
    lastTools: string;
  },
): string {
  const reasonLine = opts.reason === 'max_rounds'
    ? `已达单次执行轮数上限 ${opts.maxRounds} 轮，为防止无限占用而暂停等待确认`
    : `已连续 ${opts.stallRounds} 轮无进展（工具观测结果无变化），触发熔断暂停，避免空转烧 token`;
  return [
    `[子Agent·断点] 任务尚未完成，已在第 ${opts.roundsUsed} 轮暂停。`,
    '',
    `【停止原因】${reasonLine}`,
    `【执行进度】已执行 ${opts.roundsUsed} 轮工具调用，最后一轮涉及：${opts.lastTools || '（无）'}`,
    '【产物状态】已写入磁盘的产物全部保留，未完成部分待续，不需要重做已完成的步骤。',
    '',
    '【给主 Agent 的续轮请示指令（必须执行）】',
    '1. 立刻用自然语言向用户如实汇报：任务在第 ' + opts.roundsUsed + ' 轮暂停、原因、已完成到哪一步、还剩什么没做。',
    '2. 询问用户是否续轮继续执行，不要自行决定继续或放弃。',
    '3. 用户确认续轮后，重新派发同一个子 Agent（不要换 Agent、不要从头重写），并在任务描述开头注明「【续跑】本次是断点续跑」，要求它先检查磁盘上已有产物（列目录/读文件）再接着做。',
    '4. 用户拒绝或不再回复，则收尾总结已完成部分即可。',
  ].join('\n');
}

export interface ChatRequest {
  agent?: string;
  messages: { role: string; content: string | unknown }[];
  tools?: ToolSchema[];
  model_override?: string;
  stop?: string[];
  stream?: boolean;
}

export class Coordinator {
  pool: ModelPool;
  fallbackMode = false;

  constructor(pool: ModelPool, fallbackMode = false) {
    this.pool = pool;
    this.fallbackMode = fallbackMode;
  }

  /** 按厂商调度注入前缀缓存标记 */
  private injectCacheHints(messages: unknown[], modelKey: string): unknown[] {
    const entry = this.pool.allModels.get(modelKey);
    const provider = entry?.provider ?? '';
    return injectCacheHints(messages as never, provider, modelKey);
  }

  /** 提取最后一条用户消息文本 */
  private lastUserText(messages: { role: string; content: unknown }[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const c = messages[i].content;
        return typeof c === 'string' ? c : String(c ?? '');
      }
    }
    return '';
  }

  /** 统一 LLM 调用入口：根据模型模态自动路由 + fallback_mode 兜底。 */
  async llmCall(
    agent: string,
    messages: unknown[],
    tools?: ToolSchema[],
    extraFallbacks: string[] = [],
    stop?: string[],
    modelOverride = '',
  ): Promise<LlmResponse> {
    const key = modelOverride && this.pool.allModels.has(modelOverride) ? modelOverride : this.pool.getKey(agent);
    const modality: Modality = this.pool.classifyModel(key);

    // ── 多模态模型路由（阶段4实现专有端点，当前返回占位）──
    if (modality !== 'text') {
      return this.multimodalFallback(agent, modality, messages, modelOverride);
    }

    // 文本模型：标准 chat completions
    const msgs = this.injectCacheHints(messages, key);
    let resp: LlmResponse;
    if (this.fallbackMode) {
      resp = await this.pool.callLlmWithFallback(agent, msgs, tools as never, extraFallbacks, 5, modelOverride, stop);
    } else {
      resp = await this.pool.callLlm(agent, msgs, tools as never, modelOverride, stop);
    }
    return resp;
  }

  /** 流式调用（SSE）：返回可迭代流 + 模型名 */
  async llmStream(
    agent: string,
    messages: unknown[],
    tools?: ToolSchema[],
    stop?: string[],
    modelOverride = '',
  ): Promise<{ stream: AsyncIterable<unknown>; modelName: string } | null> {
    const key = modelOverride && this.pool.allModels.has(modelOverride) ? modelOverride : this.pool.getKey(agent);
    const modality = this.pool.classifyModel(key);
    if (modality !== 'text') return null; // 多模态暂不支持流式
    const msgs = this.injectCacheHints(messages, key);
    return this.pool.streamLlm(agent, msgs, tools as never, modelOverride, stop);
  }

  /** 多模态占位（阶段4实现） */
  private async multimodalFallback(agent: string, modality: Modality, messages: unknown[], modelOverride = ''): Promise<LlmResponse> {
    const text = this.lastUserText(messages as { role: string; content: unknown }[]);
    const modelName = this.pool.getModel(modelOverride || agent).name;
    return {
      choices: [{ message: { role: 'assistant', content: `[${modality} 生成] 阶段4实现专有端点。提示词: ${text.slice(0, 200)}` } }],
      usage: { total_tokens: 0 },
      _model: modelName,
      _multimodal: modality,
    };
  }

  /** 读取 Agent 专属记忆文件（自动注入上下文，无需 Agent 自觉调用） */
  private loadAgentMemory(agent: string): string {
    try {
      const fp = path.join(MEM_DIR, memFileName(agent));
      if (!fs.existsSync(fp)) return '';
      const content = fs.readFileSync(fp, 'utf8').trim();
      if (!content) return '';
      return content.length > MEM_INJECT_LIMIT ? content.slice(0, MEM_INJECT_LIMIT) + '\n...(截断)' : content;
    } catch {
      return '';
    }
  }

  /** 构建子 Agent 消息列表 — v6 前缀冻结（对齐 Python _build_child_msgs 骨架） */
  buildChildMessages(child: ChildBot, userInput: string, extraContext = ''): unknown[] {
    const memBlock = this.loadAgentMemory(child.name);
    const now = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const dateLine = `\n【当前日期】${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${week}（做时效性判断、搜索"今天/最新/近期"时必须使用此日期，禁止凭训练记忆猜测时间）`;
    const frozen = [
      `${child.system_prompt}${dateLine}\n\n## 启动指令\n你的长期经验已自动注入到下方的「Agent 自主记忆」章节，无需主动读取。只有当你想更新记忆时才用 memdir_write。\n如需查询记忆文件夹现有文件，可选调用 memdir_list/memdir_search。`,
    ];
    if (memBlock) {
      frozen.push('## Agent 自主记忆\n' + memBlock);
    } else {
      frozen.push('## Agent 自主记忆\n（暂无长期记忆。任务完成后若有值得沉淀的事实/偏好/经验，用 memdir_write 写入自己的记忆文件。）');
    }
    if (child.knowledge.length) {
      frozen.push('[知识库]\n' + child.knowledge.join('\n\n'));
    }
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: frozen.join('\n\n') },
    ];
    if (extraContext) {
      messages.push({ role: 'system', content: `[上下文]\n${extraContext}` });
    }
    messages.push({ role: 'user', content: userInput });
    return messages;
  }

  /**
   * 子 Agent 派发（对外主入口）：执行 + 独立验收 + 不合格返修。
   *  1) 跑一轮子 Agent（dispatchOnce）
   *  2) 开启 self_verify 的 Agent 交付后，由 verifier 用真实证据独立复核
   *  3) 未通过则把裁决作为返修指令回注，重跑一轮（默认最多返修 1 次）
   *
   *  开关：Agent 注册表的 self_verify / 调用方 opts.verify，环境变量 XS_VERIFY=0 可全局关闭。
   */
  async dispatch(
    agentName: string,
    userInput: string,
    opts: {
      extraContext?: string;
      stream?: boolean;
      onProgress?: ProgressFn;
      /** 覆盖 Agent 自身的 self_verify 设置 */
      verify?: boolean;
      /** 验收未通过时的最大返修轮数，默认 1 */
      maxRepair?: number;
    } = {},
  ): Promise<LlmResponse> {
    const child = getChild(agentName);
    if (!child) {
      return {
        choices: [{ message: { role: 'assistant', content: `未知 Agent: ${agentName}` } }],
        usage: { total_tokens: 0 },
        _model: 'none',
      };
    }

    const verifyEnabled = (opts.verify ?? child.self_verify) && process.env.XS_VERIFY !== '0';
    const maxRepair = verifyEnabled ? Math.max(0, opts.maxRepair ?? 1) : 0;
    let extra = opts.extraContext ?? '';
    let resp: LlmResponse | null = null;

    for (let attempt = 0; attempt <= maxRepair; attempt++) {
      resp = await this.dispatchOnce(child, userInput, { ...opts, extraContext: extra });
      // 断点暂停（轮数上限 / 无进展熔断）：不做验收返修，直接交回主 Agent 向用户请示续轮
      if ((resp as { _stop_reason?: string })._stop_reason) return resp;
      if (!verifyEnabled) return resp;

      const reply = String(resp.choices?.[0]?.message?.content ?? '');
      if (!reply.trim()) return resp;

      opts.onProgress?.({
        type: 'verify',
        agent: child.name,
        round: attempt + 1,
        stage: 'start',
        detail: `第 ${attempt + 1} 次交付开始独立验收（真实证据复核）`,
      });

      let verdict: VerifyVerdict;
      try {
        verdict = await verifyChildResult({
          agent: child.name,
          task: userInput,
          answer: reply,
          pool: this.pool,
          onProgress: opts.onProgress,
        });
      } catch (e) {
        // 验收环节自身故障绝不拖垮主流程，但必须如实标注"未验收"
        verdict = {
          ok: true,
          score: 0,
          modes: [],
          issues: [],
          evidence: [],
          degraded: [`验收引擎异常，本次交付未经验收：${(e as Error).message}`],
          retry_hint: '',
          duration_ms: 0,
          summary: '验收引擎异常，已跳过（未验收）',
        };
      }

      (resp as { _verify?: VerifyVerdict })._verify = verdict;
      opts.onProgress?.({
        type: 'verify',
        agent: child.name,
        round: attempt + 1,
        stage: 'done',
        detail: formatVerdictBrief(verdict),
      });

      if (verdict.ok || attempt >= maxRepair) return resp;

      // 返修：把实测证据与阻断问题回注，要求重做
      extra = [extra, formatVerdictForPrompt(verdict)].filter(Boolean).join('\n\n');
    }
    return resp as LlmResponse;
  }

  /** 子 Agent 单轮执行：选择 Agent → 构建消息 → 调用 LLM → 执行 ReAct 工具循环（对齐 Python _run_child）
   *  onProgress: 实时上报子 Agent 内部过程（思考/工具调用/工具结果），供上层 SSE 透传给前端 */
  private async dispatchOnce(
    child: ChildBot,
    userInput: string,
    opts: { extraContext?: string; stream?: boolean; onProgress?: ProgressFn } = {},
  ): Promise<LlmResponse> {
    const messages = this.buildChildMessages(child, userInput, opts.extraContext);
    const tools = child.tools.map((t) => t.schema);
    const thinkingLog: { round: number; tool: string; thought: string }[] = [];
    const progress = (evt: Omit<ProgressEvent, 'agent'>) => {
      opts.onProgress?.({ agent: child.name, ...evt });
    };

    // 轮数上限 / 无进展熔断阈值：运行时可配（默认 500 / 5，前端可调）
    const limits = getLimits();
    let stallStreak = 0;        // 连续无变化轮数
    let lastSig = '';           // 上一轮工具观测指纹
    let stopReason: 'max_rounds' | 'stall' | null = null;
    let roundsUsed = 0;
    let lastTools = '';

    for (let loop = 0; loop < limits.maxRounds; loop++) {
      roundsUsed = loop + 1;
      const resp = await this.llmCall(child.name, messages, tools, [], ['观察:', '\n观察']);
      const msg = resp.choices[0]?.message ?? { role: 'assistant', content: '' };
      const reasonText = String((msg as { reasoning_content?: unknown }).reasoning_content ?? '').trim();

      // 提取 tool_calls（原生 + 文本解析兜底）
      let tcs = extractToolCalls(msg);
      if (!tcs && msg.content) {
        // 文本解析后剥离 content 中的 tool_call 块，保留思考
        const m = String(msg.content).match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (m) msg.content = String(msg.content).replace(m[0], '').trim();
      }

      // 无工具调用：清洗后作为最终回答返回
      if (!tcs) {
        const reply = stripObservationPrefix(String(msg.content ?? ''));
        // 最后一步仍可能携带思考（无工具时）：作为 think 上报
        const lastThought = reasonText || (reply ? String(msg.content ?? '').slice(0, 500) : '');
        if (opts.onProgress && lastThought) {
          progress({ type: 'think', round: loop + 1, thought: lastThought.slice(0, 600) });
        }
        if (reply) {
          return {
            choices: [{ message: { role: 'assistant', content: reply } }],
            usage: resp.usage ?? {},
            _model: resp._model ?? '?',
            _tool_rounds: loop,
            _thinking_log: thinkingLog,
          };
        }
        // 空回复：注入强制指令重试一次
        if (loop === 0) {
          messages.push({ role: 'system', content: '[强制指令] 上一轮未输出有效内容。你必须调用工具获取信息，或给出具体分析结论。禁止只说"好的""明白"等空话。' });
          continue;
        }
        return {
          choices: [{ message: { role: 'assistant', content: '[子Agent] 未能生成有效回答' } }],
          usage: resp.usage ?? {},
          _model: resp._model ?? '?',
          _tool_rounds: loop,
          _thinking_log: thinkingLog,
        };
      }

      // 记录思考
      const thought = String(msg.content ?? '');
      const toolNames = tcs.map((tc) => tc.function?.name ?? '?').join(', ');
      const thoughtToLog = reasonText || thought;
      if (thoughtToLog) thinkingLog.push({ round: loop + 1, tool: toolNames, thought: thoughtToLog });
      if (opts.onProgress && thoughtToLog) {
        progress({ type: 'think', round: loop + 1, thought: thoughtToLog.slice(0, 800) });
      }
      for (const tc of tcs) {
        const fn = tc.function?.name ?? '?';
        const args = String(tc.function?.arguments ?? '').slice(0, 500);
        progress({ type: 'tool', round: loop + 1, tool: fn, args });
      }

      // 注入 assistant 消息（含 tool_calls）
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: tcs } as never);

      // 逐个执行工具
      const toolResults: { name: string; result: string }[] = [];
      const errors: string[] = [];
      for (const tc of tcs) {
        const r = await dispatchToolCall(child, tc, this.pool);
        toolResults.push(r);
        progress({ type: 'result', round: loop + 1, tool: r.name, result: r.result.slice(0, 400) });
        messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_${loop}_${toolResults.length}`, content: r.result } as never);
        if (r.result.includes('[工具调用错误]') || r.result.includes('[工具执行异常]')) {
          errors.push(`  ${r.name}: ${r.result.slice(0, 300)}`);
        }
      }

      // ── 无进展熔断：连续 N 轮工具观测结果完全一致 → 判定空转，暂停请示 ──
      lastTools = toolResults.map((r) => r.name).join(', ');
      const sig = resultSignature(toolResults);
      if (sig === lastSig) {
        stallStreak += 1;
      } else {
        stallStreak = 0;
        lastSig = sig;
      }
      if (stallStreak >= limits.stallRounds) {
        stopReason = 'stall';
        break;
      }

      // ReAct 观察区块 + 反幻觉约束（对齐 Python observe_block）
      const resultSummary = toolResults.map((r) => `  ${r.name} → ${r.result.slice(0, 200)}`).join('\n');
      let observeBlock: string;
      if (errors.length) {
        observeBlock = `【观察】\n以下工具返回结果：\n${resultSummary}\n\n⚠️ 部分工具调用失败：\n${errors.join('\n')}\n\n请思考失败原因，修正参数或换用其他工具，然后继续。不可重复完全相同的错误调用。`;
      } else if (loop >= 2) {
        observeBlock = `【观察】\n工具已返回结果：\n${resultSummary}\n\n已完成 ${loop + 1} 轮工具探索，信息足够。请直接给出最终回答，不要客套。\n⚠️ 幻觉禁令：回答中必须引用上述工具返回的具体数据。若某条结论无工具结果支撑，不要凭空编造。`;
        messages.push({ role: 'assistant', content: '' } as never); // 预填充防"好的"
      } else {
        observeBlock = `【观察】\n工具返回结果：\n${resultSummary}\n\n请判断：信息是否足够给出最终回答？足够则直接回答；不足则继续调工具。\n⚠️ 幻觉禁令：只能基于上述工具返回的实际数据作答，不得编造不存在的信息。`;
      }
      messages.push({ role: 'system', content: observeBlock } as never);

      // ── 轮数上限：不直接判失败，转为断点暂停，由主 Agent 与用户确认是否续轮 ──
      if (loop + 1 >= limits.maxRounds) {
        stopReason = 'max_rounds';
        break;
      }
    }

    // 触发暂停（轮数上限 / 无进展熔断）：产出断点报告，交给主 Agent 向用户请示续轮
    if (stopReason) {
      const detail = stopReason === 'max_rounds'
        ? `达到单次执行轮数上限 ${limits.maxRounds} 轮，已暂停待用户确认续轮`
        : `连续 ${limits.stallRounds} 轮无进展（观测结果无变化），已熔断暂停`;
      progress({ type: 'need_continue', round: roundsUsed, stage: stopReason, detail });
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: buildPauseReport({
              agent: child.name,
              reason: stopReason,
              roundsUsed,
              maxRounds: limits.maxRounds,
              stallRounds: limits.stallRounds,
              lastTools,
            }),
          },
        }],
        usage: {},
        _model: '?',
        _tool_rounds: roundsUsed,
        _stop_reason: stopReason,
        _thinking_log: thinkingLog,
      };
    }

    // 理论不可达（for 必以 break 结束）；保底兜底，不再使用固定 4 轮文案
    return {
      choices: [{ message: { role: 'assistant', content: buildPauseReport({
        agent: child.name,
        reason: 'max_rounds',
        roundsUsed,
        maxRounds: limits.maxRounds,
        stallRounds: limits.stallRounds,
        lastTools,
      }) } }],
      usage: {},
      _model: '?',
      _tool_rounds: roundsUsed,
      _stop_reason: 'max_rounds' as const,
      _thinking_log: thinkingLog,
    };
  }
}

/** 全局单例（server 启动时初始化） */
let _coordinator: Coordinator | null = null;

export function initCoordinator(pool: ModelPool, fallbackMode = false): Coordinator {
  _coordinator = new Coordinator(pool, fallbackMode);
  return _coordinator;
}

export function getCoordinator(): Coordinator {
  if (!_coordinator) throw new Error('Coordinator 未初始化');
  return _coordinator;
}
