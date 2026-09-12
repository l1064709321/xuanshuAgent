import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** 单个日志文件体积上限（MB），超出即裁剪，可用 XS_LOG_MAX_MB 覆盖 */
const MAX_MB = Number(process.env.XS_LOG_MAX_MB ?? 2);
/** 裁剪后保留的尾部体积（KB），可用 XS_LOG_KEEP_KB 覆盖 */
const KEEP_KB = Number(process.env.XS_LOG_KEEP_KB ?? 256);
/** 巡检周期（ms） */
const INTERVAL_MS = Number(process.env.XS_LOG_CHECK_MS ?? 5 * 60 * 1000);

/**
 * 就地裁剪日志文件：超过 maxBytes 时只保留尾部 keepBytes（按整行对齐）。
 * 采用"重写同一 inode"而非改名轮转，因为服务进程由 nohup 以 O_APPEND 持有该 fd，
 * 改名后写入仍会落到被改名的旧文件上；就地裁剪可让后续 append 继续写到新文件末尾。
 */
export function trimLogFile(file: string, maxBytes: number, keepBytes: number): boolean {
  try {
    if (!existsSync(file)) return false;
    const size = statSync(file).size;
    if (size <= maxBytes) return false;
    const buf = readFileSync(file);
    const tail = buf.subarray(Math.max(0, buf.length - keepBytes));
    const nl = tail.indexOf(0x0a);
    const body = nl >= 0 ? tail.subarray(nl + 1) : tail;
    const stamp = `[log-cap] 日志超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB，已裁剪至尾部（${size} -> ${body.length} 字节）\n`;
    writeFileSync(file, Buffer.concat([Buffer.from(stamp, "utf8"), body]));
    return true;
  } catch {
    return false;
  }
}

/** 启动即裁剪一次，并每 5 分钟巡检，避免日志无限增长 */
export function startLogCap(): void {
  const files = [join(ROOT, "server_out.log"), join(ROOT, "server_err.log")];
  const maxBytes = Math.max(64 * 1024, MAX_MB * 1024 * 1024);
  const keepBytes = Math.max(32 * 1024, KEEP_KB * 1024);
  const run = (): void => {
    for (const f of files) trimLogFile(f, maxBytes, keepBytes);
  };
  run();
  const timer = setInterval(run, Math.max(30_000, INTERVAL_MS));
  timer.unref?.();
}
