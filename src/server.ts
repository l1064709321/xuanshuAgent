import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { config } from "./config.js";
import { logger } from "./core/logger.js";
import { healthRoutes } from "./routes/health.js";
import { pingRoutes } from "./routes/ping.js";
import { modelRoutes } from "./routes/models.js";
import { agentRoutes } from "./routes/agents.js";
import { chatRoutes } from "./routes/chat.js";
import { vmRoutes } from "./routes/vm.js";
import { vm2Routes } from "./routes/vm2.js";
import { miscRoutes } from "./routes/misc.js";
import { ttsRoutes } from "./routes/tts.js";
import { depsRoutes } from "./routes/deps.js";

async function main() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });

  // 静态前端（同源：页面与 API 共用 8901）
  await app.register(fastifyStatic, {
    root: resolve(import.meta.dirname, ".."),
    wildcard: false,
  });

  // 基础探针
  await app.register(healthRoutes);
  await app.register(pingRoutes);

  // 模型层
  await app.register(modelRoutes, { prefix: "/api" });

  // 多 Agent 调度层
  await app.register(agentRoutes, { prefix: "/api" });
  await app.register(chatRoutes, { prefix: "/api" });

  // Linux 虚拟机模块
  await app.register(vmRoutes, { prefix: "/api" });
  await app.register(vm2Routes, { prefix: "/api" });

  // 前端配套路由（Key/Token统计/记忆/技能/工作流/上传等）
  await app.register(miscRoutes, { prefix: "/api" });
  await app.register(ttsRoutes, { prefix: "/api" });
  await app.register(depsRoutes, { prefix: "/api" });

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
