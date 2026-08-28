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
 * /api/chat — 统一对话入口（对齐 Python /api/chat）
 * - 不指定 agent 时走主对话（默认模型）
 * - 指定 agent 时派发到对应子 Agent
 * - 支持 stream SSE
 */
export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/chat', async (req, reply) => {
    const body = req.body as ChatBody;
    const coord = getCoordinator();

    const messages = Array.isArray(body.messages) ? body.messages : [];
    // 兼容前端 { msg } 短格式
    if (messages.length === 0 && body.msg) {
      messages.push({ role: 'user', content: body.msg });
    }
    if (messages.length === 0) {
      return reply.code(400).send({ error: 'messages 不能为空' });
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
      const s = await coord.llmStream(agent, messages, undefined, undefined, modelOverride);
      if (!s) {
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
      try {
        for await (const chunk of s.stream as AsyncIterable<{ choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }>) {
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
