import { pino } from "pino";

/** 玄姝统一日志器 */
export const logger = pino({
  level: process.env.XS_DEBUG === "true" ? "debug" : "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});
