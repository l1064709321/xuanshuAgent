import type { FastifyPluginAsync } from "fastify";
import { getPool } from "../core/engine.js";
import { BUILTIN_MODELS } from "../data/presets.js";

/** GET /models — 模型预设列表（含每模型 has_key 状态） */
export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.get("/models", async () => {
    const models = getPool().toList();
    const providers = [...new Set(models.map(m => m.provider).filter(Boolean))] as string[];
    return {
      total: models.length,
      models,
      providers,
    };
  });

  app.get("/models/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const model = BUILTIN_MODELS[key];
    if (!model) {
      return reply.code(404).send({ error: `model not found: ${key}` });
    }
    return model;
  });
};
