import type { FastifyPluginAsync } from 'fastify';
import { getCoordinator } from '../core/engine.js';
import { getChild, resolveAgent } from '../core/agents.js';
import { recordTokens } from '../core/tokenStats.js';

interface ChatBody {
  agent?: string;
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
  '【语言规则】所有回复使用中文，专业严谨，直奔核心，不冗余。',
  '【任务询问机制】当用户请求的是多步骤/需要用户拍板的复杂任务（如搭建网站、开发 App、撰写企业调查报告、批量处理等）时，必须先输出一行 [ASK:具体问题]，明确询问用户关键需求（如网站主题与模块、App 平台、报告范围与篇幅等），一次只问一个问题，得到用户答复后再给出完整方案。不要一口气把全部假设做完，禁止在关键需求未确认时直接输出大段方案。',
].join('\n');

/**
 * /api/chat — 统一对话入口（对齐 Python /api/chat）
 * - 不指定 agent 时走主对话（默认模型）
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

    const messages = Array.isArray(body.messages) ? body.messages : [];
    // 兼容前端 { msg } 短格式
    if (messages.length === 0 && body.msg) {
      messages.push({ role: 'user', content: body.msg });
    }
    if (messages.length === 0) {
      return reply.code(400).send({ error: 'messages 不能为空' });
    }
    // 主对话固定注入玄姝身份（子 Agent 走各自 system_prompt，不在此注入）
    if (!body.agent && !messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: MAIN_SYSTEM_PROMPT });
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      return reply.code(400).send({ error: '缺少 user 消息' });
    }

    // 指定子 Agent 派发
    let agent = '主Agent';
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

    // 流式（仅文本模型）
    if (body.stream) {
      console.log(`[chat:${_reqId}] STREAM branch entered, calling llmStream agent=${agent}`);
      const s = await coord.llmStream(agent, messages, undefined, undefined, modelOverride);
      if (!s) {
        console.log(`[chat:${_reqId}] llmStream returned null (unsupported)`);
        return reply.code(400).send({ error: '当前模型不支持流式或多模态模型暂不支持流式' });
      }
      // 流式时若有 modelOverride 且与默认不同，先临时切换（流式仅用于测试直连）
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
      const HEARTBEAT_MS = 10_000;
      const MAX_IDLE_MS = 120_000;
      try {
        // 手动迭代 + 空闲心跳：模型在 reasoning→content 之间可能长时间无数据，
        // 需周期性写 SSE 注释行保活（防隧道/移动网络掐断），超过空闲上限则终止。
        const it = (s.stream as AsyncIterable<{ choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }>)[Symbol.asyncIterator]();
        let idleMs = 0;
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
          const delta = chunk.choices[0].delta;
          const outDelta: { content?: string; reasoning_content?: string } = {};
          if (delta?.content) outDelta.content = delta.content;
          if (delta?.reasoning_content) outDelta.reasoning_content = delta.reasoning_content;
          if (Object.keys(outDelta).length > 0) {
            reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: outDelta }] })}\n\n`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      } finally {
        if (streamUsage?.prompt_tokens != null) {
          recordTokens(agent, streamUsage.prompt_tokens, streamUsage.completion_tokens ?? 0, streamUsage.prompt_tokens_details?.cached_tokens ?? 0);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        console.log(`[chat:${_reqId}] SSE END agent=${agent} usage=${streamUsage ? streamUsage.completion_tokens + '/' + streamUsage.prompt_tokens : 'n/a'}`);
      }
      return reply;
    }

    // 非流式
    const resp = await coord.llmCall(agent, messages, undefined, [], undefined, modelOverride);
    if (resp.usage && (resp.usage as { prompt_tokens?: number }).prompt_tokens != null) {
      const u = resp.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      recordTokens(agent, u.prompt_tokens ?? 0, u.completion_tokens ?? 0, u.prompt_tokens_details?.cached_tokens ?? 0);
    }
    const msg = resp.choices?.[0]?.message;
    const reasoning = (msg && (msg as { reasoning_content?: string }).reasoning_content) || '';
    const thinking = reasoning
      ? [{ round: 1, thought: reasoning }]
      : [];
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: resp._model,
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
