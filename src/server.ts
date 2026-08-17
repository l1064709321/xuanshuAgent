import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { logger } from "./core/logger.js";
import { healthRoutes } from "./routes/health.js";
import { pingRoutes } from "./routes/ping.js";
import { modelRoutes } from "./routes/models.js";
import { agentRoutes } from "./routes/agents.js";
import { chatRoutes } from "./routes/chat.js";

async function main() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });

  // 基础探针
  await app.register(healthRoutes);
  await app.register(pingRoutes);

  // 模型层
  await app.register(modelRoutes, { prefix: "/api" });

  // 多 Agent 调度层
  await app.register(agentRoutes, { prefix: "/api" });
  await app.register(chatRoutes, { prefix: "/api" });

  // 统一错误处理
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; name?: string; message?: string };
    logger.error({ err }, "unhandled error");
    reply.code(e.statusCode ?? 500).send({
      error: e.name ?? "InternalServerError",
      message: e.message ?? String(err),
    });
  });

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(`玄姝(TS) 已启动: http://${config.HOST}:${config.PORT}`);
}

main().catch((err) => {
  logger.fatal(err, "启动失败");
  process.exit(1);
});
