import type { FastifyPluginAsync } from 'fastify';
import { getCoordinator } from '../core/engine.js';
import type { ProgressFn } from '../core/coordinator.js';
import { getChild, resolveAgent, type ToolSchema } from '../core/agents.js';
import { formatVerdictBrief, type VerifyVerdict } from '../core/verifier.js';
import { recordTokens } from '../core/tokenStats.js';

import { createSessionId, loadSession, saveSession, type StoredMessage } from '../core/sessionStore.js';
import { truncateForApi } from '../core/historyWindow.js';
import { getLimits } from '../core/limits.js';

/**
 * 从上游 usage 提取缓存命中 token 数。
 * 兼容 OpenAI(prompt_tokens_details.cached_tokens)、DeepSeek(prompt_cache_hit_tokens)、
 * Anthropic(cache_read_input_tokens) 及顶层 cached_tokens 等命名；
 * reported=false 表示上游本次未上报任何缓存字段（此时命中率 0 属"无数据"，而非"真未命中"）。
 */
function pickCachedTokens(u: unknown): { cached: number; reported: boolean } {
  const o = (u ?? {}) as Record<string, unknown>;
  const details = (o.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const candidates: [unknown, boolean][] = [
    [details.cached_tokens, 'cached_tokens' in details],
    [o.prompt_cache_hit_tokens, 'prompt_cache_hit_tokens' in o],
    [o.cache_read_input_tokens, 'cache_read_input_tokens' in o],
    [o.cached_tokens, 'cached_tokens' in o],
  ];
  for (const [v, present] of candidates) {
    if (present && typeof v === 'number') return { cached: v, reported: true };
  }
  return { cached: 0, reported: false };
}

interface ChatBody {
  agent?: string;
  session_id?: string;
  messages?: { role: string; content: string }[];
  msg?: string;
  stream?: boolean;
  model?: string;
}

/**
 * 主 Agent 固定身份 — 无论切换哪个底层模型，主对话身份始终是「玄姝」。
 */
const MAIN_SYSTEM_PROMPT = [
  '你是「玄姝」，由 Master of the Stars 开发的 AI Agent 助手。',
  '【身份铁律】无论被问"你是谁/你叫什么/你是什么模型/谁开发的/底层是什么"，一律回答："我是玄姝，由 Master of the Stars 开发的 Agent 助手"。严禁自称其他名称，严禁透露底层模型名称（如 Agnes、DeepSeek 等）。',
  '【能力清单】',
  '1. 编程开发：编写、调试、审查代码（Python / TypeScript / JavaScript / Shell 等），完成算法设计与工程实现。',
  '2. 文件处理：读写文件、解析文档（PDF / DOCX / XLSX / PPTX）、图像与数据处理。',
  '3. 信息检索：联网搜索、获取实时资讯、天气、百科知识。',
  '4. 系统与浏览器：管理服务器、操控浏览器完成网页交互、模拟真人操作。',
  '5. 记忆与协作：多 Agent 协作、长期记忆读写、技能调用。',
  '【多Agent协同（重要）】你有一支真实团队，成员会在收到任务后以自己身份真实执行：',
  ' - 搜索Agent「小搜」：联网搜索/实时资讯/天气/百科。',
  ' - 代码Agent「小码」：编程、调试、沙箱执行代码。',
  ' - 文件Agent「小文」：文件管理、文档/图像/PDF/数据处理。',
  ' - 浏览器Agent「小览」：打开网页、点击、表单、提取JS渲染内容、截图。',
  ' - 电脑Agent「小屏」：服务器系统运维、进程管理、软件管理。',
  ' - 手机Agent「小手机」：通过ADB操控Android设备/模拟器。',
  ' - 音频Agent「小音」：音频处理、语音合成。',
  ' - 视频Agent「小视」：视频处理。',
  ' - 审核Agent「小核」：独立验收，用真实证据复核其他 Agent 的交付（敢说"没验"也不说"没问题"）。',
  '【验收机制（重要）】子 Agent 完成交付后，系统会自动对其做独立验收：真实重跑代码、核验产物是否落盘、检测视频静帧与文案一致性、验证引用链接可达、跨模型语义复核。验收未通过会自动返修一次。你在汇总时：若工具结果里出现「独立验收」区块，且标注未通过或存在"未验项"，必须如实告知用户哪些已验证、哪些没验证，严禁把未验收当成已完成。',
  '调度规则：',
  '1. 当用户明确要求"让XX agent做YY/搜索一下/查一下/打开网站/跑一下代码/处理文件"等真实执行类请求时，必须调用 dispatch_agent 工具把任务真实派发给对应子 Agent，等它执行完成后，再基于它的真实结果给出最终答复。严禁嘴上说"正在搜索/我来帮你查"却不真正派发，严禁把猜测内容当作搜索结果。',
  '2. 拿不准该派给谁时，选最匹配的一个；子 Agent 结果若失败，如实告诉用户并建议换方案。',
  '3. 纯问答/无需真实执行的任务（解释概念、给建议、写文案等）不需要派发，直接回答。',
  '4. 子 Agent 返回以「[子Agent·断点]」开头的报告时，表示它因"达到轮数上限"或"连续多轮无进展"被暂停（不是失败）：已完成的产物均已落盘保留。你必须如实向用户说明当前进度与断点原因，并询问是否需要继续；严禁直接重派同一任务从头重做、严禁换其他 Agent 重写，用户确认后再派同一子 Agent 断点续跑。',
  '【语言规则】所有回复使用中文，专业严谨，直奔核心，不冗余。',
  '【任务询问机制】当用户请求的是多步骤/需要用户拍板的复杂任务（如搭建网站、开发 App、撰写企业调查报告、批量处理等）时，必须先输出一行 [ASK:具体问题]，明确询问用户关键需求（如网站主题与模块、App 平台、报告范围与篇幅等），一次只问一个问题，得到用户答复后再给出完整方案。不要一口气把全部假设做完，禁止在关键需求未确认时直接输出大段方案。注意：若用户已明确指定要"让某个子 Agent 做某事"，则应直接派发执行，不得再反问。',
].join('\n');

/** 主对话可调度的真实协作工具：派发子 Agent 执行 */
const MAIN_TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'dispatch_agent',
      description:
        '把任务真实派发给团队子 Agent 执行（子 Agent 会以自己身份调用真实工具工作，如搜索Agent联网搜索、代码Agent沙箱跑代码、文件Agent读写文件、浏览器Agent开网页、电脑Agent查系统、手机Agent操控设备）。派发后你将收到真实执行结果，请基于结果作答。用户明确要求"让/叫/派 XXAgent 做 YY"、或请求真实搜索/查资料/找文件/跑代码/开网页/处理文件时，必须调用本工具，禁止假装完成。',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: '子 Agent 名称，可选：搜索Agent / 代码Agent / 文件Agent / 浏览器Agent / 电脑Agent / 手机Agent / 音频Agent / 视频Agent',
          },
          task: { type: 'string', description: '要交给该子 Agent 执行的任务，保留用户原始意图与细节' },
        },
        required: ['agent', 'task'],
      },
    },
  },
];

/** 真实派发子 Agent 执行，返回其最终回答
 *  onProgress: 子 Agent 内部过程（思考/工具调用/工具结果）实时回调，由上层透传 SSE 给前端 */
async function runSubAgent(
  coord: ReturnType<typeof getCoordinator>,
  agentName: string,
  task: string,
  reqId: string,
  onProgress?: ProgressFn,
): Promise<{ ok: boolean; reply: string; agent: string; error?: string; verify?: VerifyVerdict }> {
  const child = resolveAgent(agentName);
  if (!child) return { ok: false, reply: '', agent: agentName, error: `未知子Agent: ${agentName}` };
  console.log(`[chat:${reqId}] DISPATCH -> ${child.name} task="${task.slice(0, 120)}"`);
  try {
    const resp = await coord.dispatch(child.name, task, onProgress ? { onProgress } : {});
    const msg = resp.choices?.[0]?.message;
    const reply = String(msg?.content ?? '').trim();
    const verify = (resp as { _verify?: VerifyVerdict })._verify;
    console.log(`[chat:${reqId}] DISPATCH DONE <- ${child.name} replyLen=${reply.length} rounds=${(resp as { _tool_rounds?: number })._tool_rounds ?? '?'} verify=${verify ? (verify.ok ? 'PASS' : 'FAIL') : 'off'}`);
    if (!reply) return { ok: false, reply: '', agent: child.name, error: '子Agent未返回有效内容', verify };
    return { ok: true, reply, agent: child.name, verify };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    console.log(`[chat:${reqId}] DISPATCH ERR <- ${child.name}: ${m}`);
    return { ok: false, reply: '', agent: child.name, error: m };
  }
}

/**
 * /api/chat — 统一对话入口（对齐 Python /api/chat）
 * - 不指定 agent 时走主对话（默认模型，支持多 Agent 真实派发）
 * - 指定 agent 时派发到对应子 Agent
 * - 支持 stream SSE
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', async (req, reply) => {
    const body = req.body as ChatBody;
    const coord = getCoordinator();
    const _reqId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const _shortMsg = (body.msg ?? '').slice(0, 60).replace(/\n/g, ' ');
    console.log(`[chat:${_reqId}] POST agent=${body.agent ?? ''} stream=${String(body.stream)} model=${body.model ?? ''} contentType=${req.headers['content-type'] ?? ''} msg="${_shortMsg}"`);

    // ── 会话持久化（Phase 1）：优先按 session_id 从磁盘恢复结构化消息链 ──
    // 新前端带 session_id：首次请求自动建会话并落盘；旧前端不带 session_id：退回 stateless（messages 全量回传）
    const rawSid = String(body.session_id ?? '').trim();
    const persistEnabled = /^[A-Za-z0-9_-]{1,128}$/.test(rawSid);
    const sessionId = persistEnabled ? rawSid : createSessionId();
    const stored = persistEnabled ? loadSession(sessionId) : null;
    const messages = (stored ?? (Array.isArray(body.messages) ? body.messages : [])) as StoredMessage[];
    const persist = (): void => {
      if (!persistEnabled) return;
      try {
        // system 消息不落盘（每次请求重新注入，保证系统提示/日期行最新）
        saveSession(sessionId, messages.filter((m) => m.role !== 'system'));
      } catch (e) {
        console.log(`[chat:${_reqId}] session persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    // 兼容前端 { msg } 短格式；前端携带历史 messages 时，msg 作为当前最新 user 消息追加
    if (body.msg) {
      const last = messages[messages.length - 1];
      const dup = last && last.role === 'user' && last.content === body.msg;
      if (!dup) messages.push({ role: 'user', content: body.msg });
    }
    if (messages.length === 0) {
      return reply.code(400).send({ error: 'messages 不能为空' });
    }
    // 主对话固定注入玄姝身份（子 Agent 走各自 system_prompt，不在此注入）
    if (!body.agent && !messages.some((m) => m.role === 'system')) {
      const now = new Date();
      const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
      const dateLine = `【当前日期】${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${week}（做时效性判断、搜索"今天/最新/近期"时必须使用此日期，禁止凭训练记忆猜测时间）`;
      messages.unshift({ role: 'system', content: MAIN_SYSTEM_PROMPT + '\n' + dateLine });
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      return reply.code(400).send({ error: '缺少 user 消息' });
    }

    // 指定子 Agent 派发
    let agent = '主Agent';
    const isMain = !body.agent;
    if (body.agent) {
      const child = resolveAgent(body.agent);
      if (!child) return reply.code(404).send({ error: `agent not found: ${body.agent}` });
      agent = child.name;
    }

    // 模型覆盖：仅作用于本次调用
    let modelOverride = '';
    if (body.model) {
      const key = coord.pool.resolve(body.model);
      if (!key) return reply.code(400).send({ error: `model not found: ${body.model}` });
      modelOverride = key;
    }

    // 流式（仅文本模型；主对话支持多轮 dispatch_agent 真实派发）
    if (body.stream) {
      const tools = isMain ? MAIN_TOOLS : undefined;
      console.log(`[chat:${_reqId}] STREAM branch entered, calling llmStream agent=${agent} main=${String(isMain)}`);
      const s = await coord.llmStream(agent, messages, tools, undefined, modelOverride);
      if (!s) {
        console.log(`[chat:${_reqId}] llmStream returned null (unsupported)`);
        return reply.code(400).send({ error: '当前模型不支持流式或多模态模型暂不支持流式' });
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (persistEnabled) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'session', session_id: sessionId })}\n\n`);
      }
      let allReasoning = '';
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
      const HEARTBEAT_MS = 10_000;
      const MAX_IDLE_MS = 180_000;

      type SseChunk = {
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; message?: { tool_calls?: unknown } }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      };

      /** 迭代一轮 llmStream，返回聚合结果 */
      async function pumpOnce(
        msgs: unknown[],
        onDelta: (out: { content?: string; reasoning?: string }) => void,
      ): Promise<{ toolCalls: { id?: string; name?: string; args?: string }[]; finished: boolean; content: string }> {
        const s2 = await coord.llmStream(agent, truncateForApi(msgs as StoredMessage[]), tools, undefined, modelOverride);
        if (!s2) return { toolCalls: [], finished: true, content: '' };
        const it = (s2.stream as AsyncIterable<SseChunk>)[Symbol.asyncIterator]();
        let idleMs = 0;
        let roundText = '';
        // 流式 tool_calls 以 delta.tool_calls 增量分片下发（先 name 后 arguments 分段），须按 index 累积
        const toolCallAcc: { index: number; id: string; name: string; args: string }[] = [];
        let doneFlag = false;
        for (;;) {
          const dataP = it.next();
          const tickP = new Promise<'tick'>((res) => setTimeout(() => res('tick'), HEARTBEAT_MS));
          const raced = await Promise.race([
            dataP.then((r) => ({ kind: 'data' as const, r })),
            tickP.then(() => ({ kind: 'tick' as const })),
          ]);
          if (raced.kind === 'tick') {
            idleMs += HEARTBEAT_MS;
            if (idleMs >= MAX_IDLE_MS) {
              reply.raw.write(`data: ${JSON.stringify({ error: 'stream-idle-timeout' })}\n\n`);
              doneFlag = true;
              break;
            }
            reply.raw.write(': ping\n\n');
            continue;
          }
          idleMs = 0;
          const { done, value: chunk } = raced.r;
          if (done) break;
          if (chunk.usage) streamUsage = chunk.usage;
          if (!chunk.choices || chunk.choices.length === 0) continue;
          const choice = chunk.choices[0];
          const delta = choice.delta;
          const out: { content?: string; reasoning?: string } = {};
          if (delta?.content) out.content = delta.content;
          if (delta?.reasoning_content) out.reasoning = delta.reasoning_content;
          onDelta(out);
          if (out.content) roundText += out.content;
          // 累积 delta.tool_calls（OpenAI 兼容流式标准位置）
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let acc = toolCallAcc[idx];
              if (!acc) {
                acc = { index: idx, id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
                toolCallAcc[idx] = acc;
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }
          }
          // 兼容个别厂商把完整 tool_calls 放 message 的非流式形态
          const msgTc = (choice.message as { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } | undefined)?.tool_calls;
          if (Array.isArray(msgTc) && msgTc.length) {
            for (const tc of msgTc) {
              const idx = toolCallAcc.length;
              toolCallAcc[idx] = { index: idx, id: tc.id ?? '', name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' };
            }
          }
        }
        const toolCalls = toolCallAcc
          .sort((a, b) => a.index - b.index)
          .map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
        return { toolCalls, finished: doneFlag, content: roundText };
      }

      try {
        let toolRounds = 0;
        // 主 Agent 多轮协同上限：与子 Agent 共用可调配置（默认 500，前端可改），不再硬卡 3 轮
        const mainRoundLimit = getLimits().maxRounds;
        let hitRoundLimit = false;
        // 多轮：主对话模型若决定派发子 Agent，则真实执行后进入下一轮汇总；上限取配置值（默认 500）
        for (;;) {
          if (toolRounds >= mainRoundLimit) { hitRoundLimit = true; break; }
          const r = await pumpOnce(messages, (out) => {
            if (out.reasoning) {
              allReasoning += out.reasoning;
              reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: out.reasoning } }] })}\n\n`);
            }
            if (out.content) {
              // 内容直接透传（无派发场景=正文；派发后新一轮=汇总正文）
              reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.content } }] })}\n\n`);
            }
          });
          if (r.finished || !r.toolCalls.length) {
            // 无工具调用：本轮正文即最终回复，压入消息链用于持久化
            if (r.content) messages.push({ role: 'assistant', content: r.content } as never);
            break;
          }
          const tc = r.toolCalls[0];
          if (tc.name !== 'dispatch_agent') {
            messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_${toolRounds}`, content: '[工具调用错误] 不存在的工具: ' + (tc.name ?? '') } as never);
            toolRounds++;
            continue;
          }
          let parsed: { agent?: string; task?: string } = {};
          try {
            parsed = JSON.parse(tc.args || '{}');
          } catch {
            parsed = {};
          }
          const target = (parsed.agent || '').trim();
          const taskText = (parsed.task || '').trim();
          if (!target || !taskText) {
            messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_${toolRounds}`, content: '[工具参数错误] dispatch_agent 需要 agent 与 task 字段，请检查后重试' } as never);
            toolRounds++;
            continue;
          }
          // 告知前端：子 Agent 开始工作
          reply.raw.write(`data: ${JSON.stringify({ type: 'agent_start', agent: target, task: taskText.slice(0, 300) })}\n\n`);
          // 子 Agent 真实执行可能持续数十秒：期间发 SSE 心跳保活，避免隧道/前端误判断流
          const hb = setInterval(() => {
            try { reply.raw.write(': ping\n\n'); } catch { /* ignore */ }
          }, HEARTBEAT_MS);
          // 子 Agent 内部过程实时透传：思考(agent_think) → 调用工具(agent_tool) → 工具结果(agent_tool_done) → 独立验收(agent_verify)
          const emitProgress: ProgressFn = (evt) => {
            try {
              if (evt.type === 'think') {
                reply.raw.write(`data: ${JSON.stringify({ type: 'agent_think', agent: target, round: evt.round, thought: (evt.thought ?? '').slice(0, 800) })}\n\n`);
              } else if (evt.type === 'tool') {
                reply.raw.write(`data: ${JSON.stringify({ type: 'agent_tool', agent: target, round: evt.round, tool: evt.tool ?? '?', args: (evt.args ?? '').slice(0, 500) })}\n\n`);
              } else if (evt.type === 'verify') {
                reply.raw.write(`data: ${JSON.stringify({ type: 'agent_verify', agent: target, round: evt.round, stage: evt.stage ?? '', detail: (evt.detail ?? '').slice(0, 1200) })}\n\n`);
              } else if (evt.type === 'need_continue') {
                // 断点暂停：轮数上限 / 无进展熔断 → 前端展示"待续轮"卡片，等用户拍板
                reply.raw.write(`data: ${JSON.stringify({ type: 'agent_paused', agent: target, round: evt.round, reason: evt.stage ?? '', detail: (evt.detail ?? '').slice(0, 600) })}\n\n`);
              } else {
                reply.raw.write(`data: ${JSON.stringify({ type: 'agent_tool_done', agent: target, round: evt.round, tool: evt.tool ?? '?', result: (evt.result ?? '').slice(0, 400) })}\n\n`);
              }
            } catch { /* ignore */ }
          };
          let sub: { ok: boolean; reply?: string; agent?: string; error?: string; verify?: VerifyVerdict };
          try {
            sub = await runSubAgent(coord, target, taskText, _reqId, emitProgress);
          } finally {
            clearInterval(hb);
          }
          const verifyBlock = sub.verify
            ? `\n\n【独立验收（小核，真实证据复核）】\n${formatVerdictBrief(sub.verify)}`
            : '';
          const toolContent = sub.ok
            ? `【${sub.agent} 真实执行结果】\n${(sub.reply ?? '').slice(0, 4000)}${verifyBlock}`
            : `【${sub.agent} 执行失败】${sub.error ?? '未知错误'}\n请如实告知用户失败原因，并给出替代建议。`;
          reply.raw.write(`data: ${JSON.stringify({ type: 'agent_done', agent: target, ok: sub.ok, verify_ok: sub.verify ? sub.verify.ok : null, summary: sub.ok ? (sub.reply ?? '').slice(0, 1000) : (sub.error ?? '') })}\n\n`);
          // 回填给模型继续汇总
          messages.push({ role: 'assistant', content: r.content ?? '', tool_calls: [{ id: tc.id ?? `call_${toolRounds}`, type: 'function', function: { name: 'dispatch_agent', arguments: tc.args ?? '' } }] } as never);
          messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_${toolRounds}`, content: toolContent } as never);
          toolRounds++;
          console.log(`[chat:${_reqId}] toolRound=${toolRounds} sub=${target} ok=${String(sub.ok)}`);
        }
        // 达单次协同上限：不判失败，补一轮收尾——汇报进度并请用户拍板是否续轮
        if (hitRoundLimit) {
          messages.push({
            role: 'system',
            content: `【轮数断点】本轮协同已达单次上限 ${mainRoundLimit} 轮，任务尚未完成。请立即用自然语言：1) 如实汇报当前进度（已完成什么、还剩什么）；2) 说明因达到轮数上限而暂停；3) 询问用户是否继续执行。严禁谎称任务已完成，严禁从头重做已完成的步骤。`,
          } as never);
          console.log(`[chat:${_reqId}] main round limit ${mainRoundLimit} hit → 收尾请示`);
          await pumpOnce(messages, (out) => {
            if (out.reasoning) {
              allReasoning += out.reasoning;
              reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: out.reasoning } }] })}\n\n`);
            }
            if (out.content) {
              reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.content } }] })}\n\n`);
            }
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      } finally {
        persist();
        const su = streamUsage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
        if (su?.prompt_tokens != null) {
          const c = pickCachedTokens(su);
          recordTokens(agent, su.prompt_tokens, su.completion_tokens ?? 0, c.cached, c.reported);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        console.log(`[chat:${_reqId}] SSE END agent=${agent} usage=${su ? su.completion_tokens + '/' + su.prompt_tokens : 'n/a'} reasoningLen=${allReasoning.length}`);
      }
      return reply;
    }

    // 非流式（主对话同样支持真实派发，工具轮上限取配置值，默认 500）
    const tools = isMain ? MAIN_TOOLS : undefined;
    let toolRound = 0;
    const nonStreamRoundLimit = getLimits().maxRounds;
    let hitNonStreamLimit = false;
    let resp = await coord.llmCall(agent, truncateForApi(messages as StoredMessage[]), tools, [], undefined, modelOverride);
    for (;;) {
      const msg = resp.choices?.[0]?.message as {
        content?: string;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      } | undefined;
      const tcs = msg?.tool_calls;
      if (!tcs || !tcs.length) break;
      if (toolRound >= nonStreamRoundLimit) { hitNonStreamLimit = true; break; }
      const tc = tcs[0];
      if (tc.function?.name !== 'dispatch_agent') {
        messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_n${toolRound}`, content: '[工具调用错误] 不存在的工具: ' + (tc.function?.name ?? '') } as never);
        toolRound++;
        resp = await coord.llmCall(agent, truncateForApi(messages as StoredMessage[]), tools, [], undefined, modelOverride);
        continue;
      }
      let parsed: { agent?: string; task?: string } = {};
      try {
        parsed = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        parsed = {};
      }
      const target = (parsed.agent || '').trim();
      const taskText = (parsed.task || '').trim();
      const sub = target && taskText ? await runSubAgent(coord, target, taskText, _reqId) : { ok: false, reply: '', agent: target, error: '参数缺失' };
      const toolContent = sub.ok
        ? `【${sub.agent} 真实执行结果】\n${sub.reply.slice(0, 4000)}`
        : `【${sub.agent} 执行失败】${sub.error ?? '未知错误'}\n请如实告知用户失败原因，并给出替代建议。`;
      messages.push({ role: 'assistant', content: msg?.content ?? '', tool_calls: tcs } as never);
      messages.push({ role: 'tool', tool_call_id: tc.id ?? `call_n${toolRound}`, content: toolContent } as never);
      toolRound++;
      resp = await coord.llmCall(agent, truncateForApi(messages as StoredMessage[]), tools, [], undefined, modelOverride);
    }
    // 达单次协同上限：补一轮收尾，把进度与"是否续轮"交给用户拍板（不判失败、不重头做）
    if (hitNonStreamLimit) {
      messages.push({
        role: 'system',
        content: `【轮数断点】本轮协同已达单次上限 ${nonStreamRoundLimit} 轮，任务尚未完成。请立即用自然语言：1) 如实汇报当前进度（已完成什么、还剩什么）；2) 说明因达到轮数上限而暂停；3) 询问用户是否继续执行。严禁谎称任务已完成，严禁从头重做已完成的步骤。`,
      } as never);
      resp = await coord.llmCall(agent, truncateForApi(messages as StoredMessage[]), tools, [], undefined, modelOverride);
    }
    if (resp.usage && (resp.usage as { prompt_tokens?: number }).prompt_tokens != null) {
      const u = resp.usage as { prompt_tokens?: number; completion_tokens?: number };
      const c = pickCachedTokens(u);
      recordTokens(agent, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, c.cached, c.reported);
    }
    const msg = resp.choices?.[0]?.message;
    // 最终 assistant 正文压入消息链并持久化（持久化在 return 前执行）
    if (msg?.content) messages.push({ role: 'assistant', content: msg.content } as never);
    persist();
    const reasoning = (msg && (msg as { reasoning_content?: string }).reasoning_content) || '';
    const thinking = reasoning
      ? [{ round: 1, thought: reasoning }]
      : [];
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: resp._model,
      session_id: persistEnabled ? sessionId : undefined,
      // 前端协议（玄姝 UI）
      reply: msg?.content ?? '',
      thinking,
      agent: body.agent ?? '',
      // OpenAI 兼容
      choices: resp.choices,
      usage: resp.usage ?? {},
      _tried: resp._tried ?? [],
      _fallback_used: resp._fallback_used ?? false,
    };
  });
};
