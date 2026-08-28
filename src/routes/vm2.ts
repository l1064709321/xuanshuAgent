// ========== VM2 路由：真虚拟机管理（QEMU 引擎 + Bash 降级） ==========
// 参考 VirtualBox/UTM 模式：创建(磁盘镜像) → 启动(QEMU 进程) → 控制台(VNC/截图) → 停止
import { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { detectVmEngine, type VmEngineInfo } from "../core/vmEngine.js";
import { createConnection } from "node:net";

const VMS_ROOT = join(homedir(), ".xuanshu-vms");
const ISO_DIR = join(VMS_ROOT, "iso");

interface VmMeta {
  name: string;
  memMb: number;
  diskGb: number;
  iso?: string;
  pid?: number;
  vncPort?: number;
  monitorSock?: string;
  engine: string;
  diskFormat: "qcow2" | "raw";
  created: string;
}

const running = new Map<string, { proc: ChildProcess; meta: VmMeta }>();

function vmDir(name: string): string { return join(VMS_ROOT, name); }
function metaPath(name: string): string { return join(vmDir(name), "meta.json"); }
function diskPath(name: string, fmt: "qcow2" | "raw" = "qcow2"): string { return join(vmDir(name), fmt === "qcow2" ? "disk.qcow2" : "disk.img"); }

function loadMeta(name: string): VmMeta | null {
  const p = metaPath(name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as VmMeta; } catch { return null; }
}
function saveMeta(meta: VmMeta): void {
  writeFileSync(metaPath(meta.name), JSON.stringify(meta, null, 2));
}

/** 发送命令到 QEMU monitor（unix socket） */
function qemuMonitorCmd(sockPath: string, cmd: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const c = createConnection(sockPath);
    let out = "";
    const timer = setTimeout(() => { c.destroy(); reject(new Error("monitor 超时")); }, timeoutMs);
    c.on("connect", () => c.write(cmd + "\n"));
    c.on("data", (d) => { out += d.toString(); });
    c.on("error", (e) => { clearTimeout(timer); reject(e); });
    c.on("close", () => { clearTimeout(timer); resolvePromise(out); });
  });
}

export async function vm2Routes(app: FastifyInstance): Promise<void> {
  mkdirSync(VMS_ROOT, { recursive: true });
  mkdirSync(ISO_DIR, { recursive: true });

  // 引擎检测（跨平台：linux/win/mac 自动适配 KVM/WHPX/HVF/TCG）
  app.get("/vm2/engine", async () => detectVmEngine());

  // 已创建 VM 列表
  app.get("/vm2/list", async () => {
    const names = readdirSync(VMS_ROOT).filter((n) => existsSync(join(VMS_ROOT, n, "meta.json")));
    return names.map((n) => {
      const m = loadMeta(n);
      const proc = running.get(n);
      return { name: n, memMb: m?.memMb ?? 0, diskGb: m?.diskGb ?? 0, iso: m?.iso, engine: m?.engine ?? "bash", running: !!proc, pid: proc?.proc.pid ?? null, vncPort: m?.vncPort ?? null };
    });
  });

  // 可用 ISO 列表（放入 ~/.xuanshu-vms/iso/ 即可出现在创建向导）
  app.get("/vm2/iso", async () => {
    return readdirSync(ISO_DIR).filter((f) => /\.(iso|img|qcow2)$/i.test(f)).map((f) => ({ file: f, path: join(ISO_DIR, f) }));
  });

  // 创建 VM：分配目录 + qcow2 稀疏磁盘（按需增长，配额写多大都行）
  app.post<{ Body: { name: string; memMb?: number; diskGb?: number; iso?: string } }>("/vm2/create", async (req, reply) => {
    const { name, memMb = 2048, diskGb = 60, iso } = req.body || {};
    if (!name || !/^[\w-]{1,40}$/.test(name)) return reply.code(400).send({ ok: false, error: "VM 名称不合法" });
    if (memMb > 3072) return reply.code(400).send({ ok: false, error: "内存最多 3072MB" });
    if (diskGb > 120) return reply.code(400).send({ ok: false, error: "磁盘最大 120GB" });
    const dir = vmDir(name);
    if (existsSync(dir)) return reply.code(400).send({ ok: false, error: "VM 已存在" });
    mkdirSync(dir, { recursive: true });
    const eng = detectVmEngine();
    // 磁盘：优先 qemu-img 创建 qcow2 稀疏镜像；无 qemu-img 时退化为稀疏 raw 文件（QEMU 直接可用）
    let diskFormat: "qcow2" | "raw" = "qcow2";
    try {
      const qemuImg = eng.qemuPath ? eng.qemuPath.replace(/qemu-system/, "qemu-img") : null;
      if (qemuImg && existsSync(qemuImg)) {
        await new Promise<void>((res) => {
          const p = spawn(qemuImg, ["create", "-f", "qcow2", diskPath(name, "qcow2"), String(diskGb) + "G"], { stdio: ["ignore", "pipe", "pipe"] });
          p.on("error", () => res());
          p.on("exit", () => res());
        });
        if (!existsSync(diskPath(name, "qcow2"))) throw new Error("qemu-img 失败");
      } else {
        diskFormat = "raw";
        const img = diskPath(name, "raw");
        const size = diskGb * 1024 * 1024 * 1024;
        const fd = openSync(img, "w");
        ftruncateSync(fd, size);
        closeSync(fd);
      }
    } catch { /* 磁盘创建失败不阻断，运行时兜底 */ }
    const meta: VmMeta = { name, memMb, diskGb, iso, engine: eng.engine, diskFormat, created: new Date().toISOString() };
    saveMeta(meta);
    return { ok: true, meta, engine: eng };
  });

  // 启动 VM
  app.post<{ Body: { name: string } }>("/vm2/start", async (req, reply) => {
    const { name } = req.body || {};
    const meta = loadMeta(name || "");
    if (!meta) return reply.code(404).send({ ok: false, error: "VM 不存在" });
    if (running.has(name)) return { ok: true, already: true };
    const eng = detectVmEngine();
    if (eng.engine !== "qemu" || !eng.qemuPath) {
      return reply.code(400).send({ ok: false, error: "当前环境未检测到 QEMU，无法启动独立虚拟机。请安装 QEMU 或更换有 QEMU/KVM 的环境", engine: eng });
    }
    const vncPort = 5900 + 1 + Math.floor(Math.random() * 100);
    const sock = join(vmDir(name), "monitor.sock");
    const diskFmt = meta.diskFormat || "qcow2";
    const args = [
      "-name", name,
      "-m", String(meta.memMb),
      "-smp", "2",
      ...(eng.accel === "tcg" ? [] : ["-enable-kvm"]),
      "-accel", eng.accel,
      "-drive", `file=${diskPath(name, diskFmt)},format=${diskFmt},if=virtio`,
      ...(meta.iso ? ["-cdrom", join(ISO_DIR, meta.iso)] : []),
      "-boot", meta.iso ? "d" : "c",
      "-vnc", `127.0.0.1:${vncPort - 5900}`,
      "-monitor", `unix:${sock},server,nowait`,
      "-netdev", "user,id=n1", "-device", "virtio-net-pci,netdev=n1",
      "-display", "none",
    ];
    const proc = spawn(eng.qemuPath, args, { stdio: ["ignore", "ignore", "ignore"] });
    meta.pid = proc.pid;
    meta.vncPort = vncPort;
    meta.monitorSock = sock;
    meta.engine = eng.engine;
    saveMeta(meta);
    running.set(name, { proc, meta });
    proc.on("exit", () => { running.delete(name); meta.pid = undefined; saveMeta(meta); });
    return { ok: true, pid: proc.pid, vncPort, engine: eng };
  });

  // 停止 VM
  app.post<{ Body: { name: string } }>("/vm2/stop", async (req, reply) => {
    const { name } = req.body || {};
    const entry = running.get(name || "");
    if (entry) {
      try { entry.proc.kill("SIGTERM"); } catch { /* noop */ }
      setTimeout(() => { try { entry.proc.kill("SIGKILL"); } catch { /* noop */ } }, 3000);
      running.delete(name);
    }
    const meta = loadMeta(name || "");
    if (meta) { meta.pid = undefined; meta.vncPort = undefined; saveMeta(meta); }
    return { ok: true };
  });

  // 状态
  app.get<{ Querystring: { name?: string } }>("/vm2/status", async (req) => {
    const { name } = req.query;
    if (name) {
      const meta = loadMeta(name);
      if (!meta) return { ok: false, error: "VM 不存在" };
      const entry = running.get(name);
      return { ok: true, name, running: !!entry, pid: entry?.proc.pid ?? null, vncPort: meta.vncPort, engine: meta.engine, memMb: meta.memMb, diskGb: meta.diskGb };
    }
    return Array.from(running.entries()).map(([n, e]) => ({ name: n, pid: e.proc.pid, vncPort: e.meta.vncPort }));
  });

  // 截图（QEMU monitor screendump）
  app.get<{ Querystring: { name?: string } }>("/vm2/screenshot", async (req, reply) => {
    const { name } = req.query;
    const entry = running.get(name || "");
    if (!entry || !entry.meta.monitorSock) return reply.code(400).send({ ok: false, error: "VM 未运行" });
    const pngPath = join(vmDir(name || ""), "screen.png");
    try {
      await qemuMonitorCmd(entry.meta.monitorSock, `screendump ${pngPath}`);
      await new Promise((r) => setTimeout(r, 600));
      if (!existsSync(pngPath)) return { ok: false, error: "截图失败" };
      const buf = readFileSync(pngPath);
      return reply.type("image/png").send(buf);
    } catch (e) {
      return reply.code(500).send({ ok: false, error: String(e) });
    }
  });

  // 删除 VM
  app.post<{ Body: { name: string } }>("/vm2/delete", async (req, reply) => {
    const { name } = req.body || {};
    const entry = running.get(name || "");
    if (entry) { try { entry.proc.kill("SIGKILL"); } catch { /* noop */ } running.delete(name); }
    const dir = vmDir(name || "");
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); }
    return { ok: true };
  });
}
