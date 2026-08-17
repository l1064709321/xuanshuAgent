import type { FastifyPluginAsync } from "fastify";

/** GET /ping — 延迟探针 */
export const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ping", async () => ({ pong: true, ts: Date.now() }));
};
