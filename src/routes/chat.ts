import type { FastifyPluginAsync } from 'fastify';
import { getCoordinator } from '../core/engine.js';
import { getChild, resolveAgent } from '../core/agents.js';

interface ChatBody {
  agent?: string;
  messages?: { role: string; content: string }[];
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
      try {
        for await (const chunk of s.stream as AsyncIterable<{ choices?: { delta?: { content?: string | null } }[]; model?: string }>) {
          if (!chunk.choices || chunk.choices.length === 0) continue;
          const delta = chunk.choices[0].delta;
          if (delta?.content) {
            reply.raw.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta.content } }] })}\n\n`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      } finally {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      }
      return reply;
    }

    // 非流式
    const resp = await coord.llmCall(agent, messages, undefined, [], undefined, modelOverride);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: resp._model,
      choices: resp.choices,
      usage: resp.usage ?? {},
      _tried: resp._tried ?? [],
      _fallback_used: resp._fallback_used ?? false,
    };
  });
};
