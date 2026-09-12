import { spawn, type ChildProcess } from "node:child_process";
import { resolve, sep } from "node:path";
import {
  readdirSync, readFileSync, writeFileSync, statSync, mkdirSync,
} from "node:fs";
import os from "node:os";
import type { FastifyPluginAsync } from "fastify";

/**
 * /api/vm — 真实 Linux 虚拟机模块
 * - 终端：基于 bash 子进程的持久会话（保持 cd/变量状态），轮询读写
 * - 执行：一次性命令执行（写代码/跑程序即真实 Linux 环境）
 * - 文件：工作区内的只读浏览与可写编辑（路径安全限制在项目根内）
 */
const VM_ROOT = resolve(process.cwd());
const MAX_READ = 1024 * 1024; // 1MB
/**
 * 项目工作区根：前端「文件」树与 VM 文件窗口的可见根。
 * 平台自身工程（src/ dist/ node_modules/ .git/ .data/ 等）不在其中，
 * 因此浏览器侧无法列出/预览平台源码，只能看到用户项目文件（含上传文件）。
 */
const WS_DIRNAME = "workspace_files";
const WS_ROOT = resolve(VM_ROOT, WS_DIRNAME);
try { mkdirSync(WS_ROOT, { recursive: true }); } catch { /* ignore */ }

interface VmSession {
  id: string;
  proc: ChildProcess;
  buf: string;
  lastActive: number;
  closed: boolean;
}

const sessions = new Map<string, VmSession>();

// ── 会话清理：空闲 15 分钟回收 ──
const SESSION_TTL = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) {
      try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

function drainBuf(s: VmSession): void {
  // 防止缓冲区无限增长，仅保留末尾 256KB
  if (s.buf.length > 256 * 1024) s.buf = s.buf.slice(-256 * 1024);
}

function createSession(): VmSession {
  const id = "vm_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const proc = spawn("bash", [], {
    cwd: VM_ROOT,
    env: { ...process.env, TERM: "xterm-256color", PS1: "\\u@vm:\\w\\$ " },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const s: VmSession = { id, proc, buf: "", lastActive: Date.now(), closed: false };
  proc.stdout?.on("data", (d: Buffer) => { s.buf += d.toString("utf8"); s.lastActive = Date.now(); drainBuf(s); });
  proc.stderr?.on("data", (d: Buffer) => { s.buf += d.toString("utf8"); s.lastActive = Date.now(); drainBuf(s); });
  proc.on("exit", () => { s.closed = true; sessions.delete(id); });
  sessions.set(id, s);
  return s;
}

function runCommand(cmd: string, cwd?: string, timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn("bash", ["-c", cmd], {
      cwd: resolve(cwd && cwd.trim() ? cwd : VM_ROOT),
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let so = "", se = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      res({ code, stdout: so, stderr: se });
    };
    p.stdout?.on("data", (d: Buffer) => { so += d.toString("utf8"); });
    p.stderr?.on("data", (d: Buffer) => { se += d.toString("utf8"); });
    p.on("close", (code) => finish(code ?? -1));
    p.on("error", (e) => finish(-1)); // stderr 已携带部分信息
    setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* ignore */ } finish(124); }, timeoutMs);
  });
}

// ── 路径安全：仅允许项目根内访问 ──
function safeResolve(p: string): string | null {
  const r = resolve(VM_ROOT, p || ".");
  if (r !== VM_ROOT && !r.startsWith(VM_ROOT + sep)) return null;
  return r;
}

// ── 路径安全：仅允许项目工作区内访问（浏览器侧文件浏览用） ──
function safeResolveWs(p: string): string | null {
  const raw = (p || "").trim();
  // 前端可能传来 "/" 或 "workspace_files" 作为根，统一归一到工作区根
  const rel = raw === "" || raw === "/" || raw === WS_DIRNAME || raw === WS_DIRNAME + "/" ? "." : raw;
  const r = resolve(WS_ROOT, rel);
  if (r !== WS_ROOT && !r.startsWith(WS_ROOT + sep)) return null;
  return r;
}

interface FsEntry { name: string; path: string; type: "file" | "dir"; size: number; }

export const vmRoutes: FastifyPluginAsync = async (app) => {
  // 系统信息
  app.get("/vm/info", async () => {
    const u = await runCommand("uname -a");
    const load = os.loadavg();
    const cpus = os.cpus().length;
    const memTotal = Math.round(os.totalmem() / 1024 / 1024);
    const memFree = Math.round(os.freemem() / 1024 / 1024);
    let disk = "n/a";
    try {
      const d = await runCommand("df -h / | tail -1");
      disk = d.stdout.trim().split(/\s+/).slice(1, 5).join(" / ");
    } catch { /* ignore */ }
    return {
      ok: true,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: Math.round(os.uptime()),
      loadavg: load.map((x) => +x.toFixed(2)),
      cpus,
      memTotal,
      memFree,
      disk,
      cwd: VM_ROOT,
      uname: u.stdout.trim() || u.stderr.trim(),
    };
  });

  // 实时系统监控（CPU/内存/磁盘/进程）
  app.get("/vm/stats", async () => {
    // CPU 使用率：两次采样 /proc/stat
    let cpuPct = 0;
    try {
      const readCpu = () => {
        const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total };
      };
      const a = readCpu();
      await new Promise((r) => setTimeout(r, 200));
      const b = readCpu();
      const dTotal = b.total - a.total;
      cpuPct = dTotal > 0 ? Math.round(((dTotal - (b.idle - a.idle)) / dTotal) * 100) : 0;
    } catch { /* ignore */ }

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

    let disk: { total: number; used: number; free: number; pct: number } | null = null;
    try {
      const d = await runCommand("df -k / | tail -1");
      const p = d.stdout.trim().split(/\s+/);
      if (p.length >= 4) {
        const total = parseInt(p[1], 10) || 0;
        const used = parseInt(p[2], 10) || 0;
        const free = parseInt(p[3], 10) || 0;
        disk = { total, used, free, pct: total > 0 ? Math.round((used / total) * 100) : 0 };
      }
    } catch { /* ignore */ }

    let procs: { pid: number; user: string; cpu: number; mem: number; rss: number; cmd: string }[] = [];
    try {
      const p = await runCommand("ps -eo pid,user,%cpu,%mem,rss,comm --sort=-%cpu | head -25", undefined, 5000);
      procs = p.stdout.split("\n").slice(1).map((l) => {
        const m = l.trim().split(/\s+/);
        if (m.length < 6) return null;
        return { pid: parseInt(m[0], 10) || 0, user: m[1], cpu: parseFloat(m[2]) || 0, mem: parseFloat(m[3]) || 0, rss: parseInt(m[4], 10) || 0, cmd: m.slice(5).join(" ") };
      }).filter((x): x is NonNullable<typeof x> => x !== null);
    } catch { /* ignore */ }

    return {
      ok: true,
      ts: Date.now(),
      cpu: { pct: cpuPct, cores: os.cpus().length, loadavg: os.loadavg().map((x) => +x.toFixed(2)) },
      mem: { total: Math.round(memTotal / 1024), used: Math.round(memUsed / 1024), free: Math.round(os.freemem() / 1024), pct: memPct },
      disk,
      procs,
    };
  });

  // 一次性命令执行
  app.post("/vm/exec", async (req, reply) => {
    const body = req.body as { cmd?: string; cwd?: string; timeout?: number };
    if (!body.cmd || !body.cmd.trim()) {
      return reply.code(400).send({ ok: false, error: "cmd 不能为空" });
    }
    const r = await runCommand(body.cmd, body.cwd, body.timeout || 30_000);
    return { ok: true, ...r };
  });

  // 创建持久终端会话
  app.post("/vm/session", async () => {
    const s = createSession();
    return { ok: true, id: s.id };
  });

  // 写入终端输入
  app.post("/vm/session/:id/write", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = sessions.get(id);
    if (!s || s.closed) return reply.code(404).send({ ok: false, error: "会话不存在或已关闭" });
    const body = req.body as { data?: string };
    if (body.data) {
      s.proc.stdin?.write(body.data);
      s.lastActive = Date.now();
    }
    return { ok: true };
  });

  // 读取终端输出（drain 缓冲）
  app.get("/vm/session/:id/read", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = sessions.get(id);
    if (!s || s.closed) return reply.code(404).send({ ok: false, error: "会话不存在或已关闭" });
    const data = s.buf;
    s.buf = "";
    s.lastActive = Date.now();
    return { ok: true, data, closed: s.closed };
  });

  // 销毁终端会话
  app.delete("/vm/session/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = sessions.get(id);
    if (!s) return { ok: true };
    try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
    sessions.delete(id);
    return { ok: true };
  });

  // 列出目录（项目工作区内：平台源码不可见）
  app.post("/vm/ls", async (req, reply) => {
    const body = req.body as { path?: string };
    const dir = safeResolveWs(body?.path || "");
    if (!dir) return reply.code(403).send({ ok: false, error: "路径超出项目工作区范围" });
    try {
      const entries: FsEntry[] = readdirSync(dir, { withFileTypes: true }).map((e): FsEntry => {
        const full = resolve(dir, e.name);
        const isDir = e.isDirectory();
        let size = 0;
        try { if (!isDir) size = statSync(full).size; } catch { /* ignore */ }
        return {
          name: e.name,
          path: full,
          type: isDir ? "dir" : "file",
          size,
        };
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      return { ok: true, path: dir, root: WS_ROOT, entries };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        return reply.code(404).send({ ok: false, error: "目录不存在（不在项目工作区内）" });
      }
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // 读取文件（项目根内，文本/二进制判断）
  app.post("/vm/read", async (req, reply) => {
    const body = req.body as { path?: string };
    if (!body.path) return reply.code(400).send({ ok: false, error: "path 不能为空" });
    const full = safeResolve(body.path);
    if (!full) return reply.code(403).send({ ok: false, error: "路径超出工作区范围" });
    try {
      const st = statSync(full);
      if (!st.isFile()) return reply.code(400).send({ ok: false, error: "不是文件" });
      if (st.size > MAX_READ) return reply.code(413).send({ ok: false, error: "文件超过 1MB，请用终端查看" });
      const buf = readFileSync(full);
      const binary = buf.includes(0);
      return {
        ok: true,
        path: full,
        size: st.size,
        binary,
        content: binary ? "" : buf.toString("utf8"),
      };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  // 写入文件（项目根内）
  app.post("/vm/write", async (req, reply) => {
    const body = req.body as { path?: string; content?: string };
    if (!body.path) return reply.code(400).send({ ok: false, error: "path 不能为空" });
    const full = safeResolve(body.path);
    if (!full) return reply.code(403).send({ ok: false, error: "路径超出工作区范围" });
    try {
      writeFileSync(full, body.content ?? "", "utf8");
      return { ok: true, path: full, size: Buffer.byteLength(body.content ?? "", "utf8") };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });
};
