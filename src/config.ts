/**
 * 玄姝配置 — TypeScript 版（对齐 Python config.py）
 */
export const config = {
  HOST: process.env.XS_HOST ?? "0.0.0.0",
  PORT: Number(process.env.XS_PORT ?? "8901"),
  DEBUG: (process.env.XS_DEBUG ?? "False").toLowerCase() === "true",
  RL_CHAT_PER_MIN: 30,
  RL_CHAT_BURST: 10,
  SMTP_HOST: process.env.SMTP_HOST ?? "",
  SMTP_PORT: Number(process.env.SMTP_PORT ?? "587"),
  SMTP_USER: process.env.SMTP_USER ?? "",
  SMTP_PASS: process.env.SMTP_PASS ?? "",
} as const;
