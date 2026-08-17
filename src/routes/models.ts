import type { FastifyPluginAsync } from "fastify";
import { BUILTIN_MODELS } from "../data/presets.js";

/** GET /models — 内置模型预设列表 */
export const modelRoutes: FastifyPluginAsync = async (app) => {
  app.get("/models", async () => {
    const models = Object.values(BUILTIN_MODELS);
    return {
      total: models.length,
      models,
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
