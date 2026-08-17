/**
 * src/core/coordinator.ts — 统一 LLM 调用调度器
 *
 * 对齐 Python core.py XuanShuCore._llm_call：
 * - 根据模型模态自动路由（多模态模型走专有端点，阶段4实现；此处先预留）
 * - 前缀缓存注入（vendors 层按厂商归一化路由）
 * - 多模型兜底链 + 失败冷却
 * - Token 预算追踪（阶段4强化）
 */
import { ModelPool, type LlmResponse, type Modality } from './modelPool.js';
import { injectCacheHints } from '../vendors/index.js';
import { getChild, type ChildBot, type ToolHandler, type ToolSchema } from './agents.js';

/** 工具循环最大轮数（对齐 Python 4 轮） */
const MAX_TOOL_ROUNDS = 4;

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

  /** 构建子 Agent 消息列表 — v6 前缀冻结（对齐 Python _build_child_msgs 骨架） */
  buildChildMessages(child: ChildBot, userInput: string, extraContext = ''): unknown[] {
    const frozen = [
      `${child.system_prompt}\n\n## 启动指令\n你的长期经验（MEMORY.md）已自动注入到下方的「Agent 自主记忆」章节，无需主动读取。只有当你想更新 MEMORY.md 时才用 memdir_write。\n如需查询记忆文件夹现有文件，可选调用 memdir_list/memdir_search。`,
    ];
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

  /** 子 Agent 派发：选择 Agent → 构建消息 → 调用 LLM → 执行 ReAct 工具循环（对齐 Python _run_child） */
  async dispatch(agentName: string, userInput: string, opts: { extraContext?: string; stream?: boolean } = {}): Promise<LlmResponse> {
    const child = getChild(agentName);
    if (!child) {
      return {
        choices: [{ message: { role: 'assistant', content: `未知 Agent: ${agentName}` } }],
        usage: { total_tokens: 0 },
        _model: 'none',
      };
    }
    const messages = this.buildChildMessages(child, userInput, opts.extraContext);
    const tools = child.tools.map((t) => t.schema);
    const thinkingLog: { round: number; tool: string; thought: string }[] = [];

    for (let loop = 0; loop < MAX_TOOL_ROUNDS; loop++) {
      const resp = await this.llmCall(child.name, messages, tools, [], ['观察:', '\n观察']);
      const msg = resp.choices[0]?.message ?? { role: 'assistant', content: '' };

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
        if (reply) {
          return {
            choices: [{ message: { role: 'assistant', content: reply } }],
            usage: resp.usage ?? {},
            _model: resp._model ?? '?',
            _tool_rounds: loop,
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
        };
      }

      // 记录思考
      const thought = String(msg.content ?? '');
      const toolNames = tcs.map((tc) => tc.function?.name ?? '?').join(', ');
      if (thought) thinkingLog.push({ round: loop + 1, tool: toolNames, thought });

      // 注入 assistant 消息（含 tool_calls）
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: tcs } as never);

      // 逐个执行工具
      const toolResults: { name: string; result: string }[] = [];
      const errors: string[] = [];
      for (const tc of tcs) {
        const r = await dispatchToolCall(child, tc, this.pool);
        toolResults.push(r);
        messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_${loop}_${toolResults.length}`, content: r.result } as never);
        if (r.result.includes('[工具调用错误]') || r.result.includes('[工具执行异常]')) {
          errors.push(`  ${r.name}: ${r.result.slice(0, 300)}`);
        }
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
    }

    return {
      choices: [{ message: { role: 'assistant', content: '[子Agent] 工具调用轮数超限' } }],
      usage: {},
      _model: '?',
      _tool_rounds: MAX_TOOL_ROUNDS,
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
