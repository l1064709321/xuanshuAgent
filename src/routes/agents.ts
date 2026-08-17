import type { FastifyPluginAsync } from 'fastify';
import { listAgents, resolveAgent } from '../core/agents.js';
import { getPool } from '../core/engine.js';

/** /api/agents — 子 Agent 管理 */
export const agentRoutes: FastifyPluginAsync = async (app) => {
  /** GET /agents — 子 Agent 列表 */
  app.get('/agents', async () => {
    const pool = getPool();
    return {
      total: listAgents().length,
      agents: listAgents().map((a) => ({
        ...a,
        model: pool.getKey(a.name),
        model_name: pool.getModel(a.name).name,
      })),
    };
  });

  /** GET /agents/:name — 单个 Agent 详情（含工具 schema） */
  app.get('/agents/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const child = resolveAgent(name);
    if (!child) return reply.code(404).send({ error: `agent not found: ${name}` });
    const pool = getPool();
    return {
      name: child.name,
      description: child.description,
      system_prompt: child.system_prompt,
      tools: child.tools.map((t) => t.schema.function.name),
      tool_schemas: child.tools.map((t) => t.schema),
      model: pool.getKey(child.name),
      model_name: pool.getModel(child.name).name,
      knowledge: child.knowledge,
    };
  });

  /** POST /agents/:name/bind — Agent 绑定模型 */
  app.post('/agents/:name/bind', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as { model?: string };
    const child = resolveAgent(name);
    if (!child) return reply.code(404).send({ error: `agent not found: ${name}` });
    const pool = getPool();
    const key = body.model ? pool.resolve(body.model) : null;
    if (!key) return reply.code(400).send({ error: `model not found: ${body.model ?? ''}` });
    pool.bind(child.name, key);
    return { ok: true, agent: child.name, model: key };
  });

  /** POST /agents/:name/unbind — 解除绑定，回退默认模型 */
  app.post('/agents/:name/unbind', async (req, reply) => {
    const { name } = req.params as { name: string };
    const child = resolveAgent(name);
    if (!child) return reply.code(404).send({ error: `agent not found: ${name}` });
    getPool().unbind(child.name);
    return { ok: true, agent: child.name };
  });
};
