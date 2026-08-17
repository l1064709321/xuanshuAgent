import type { FastifyPluginAsync } from "fastify";

/** GET /health — 存活探针 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    ts: Date.now(),
  }));
};
