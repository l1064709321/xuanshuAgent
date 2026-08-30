/**
 * deps.ts — 运行时环境依赖实时扫描
 * 检测后端服务运行所依赖的：进程、端口、公网隧道、系统命令、Python 包、关键路径。
 * GET /api/deps → 全量扫描结果（每次实时探测，不缓存）
 */
import type { FastifyInstance } from "fastify";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = 8901;
const TUNNEL_URL = "https://relation-dean-monitoring-print.trycloudflare.com";
const WORKDIR = "/home/marvis/Marvis/User/77A0318BB6CBFBF7DD7DE820DE597C1E/workspace/xuanshuAgent";

/** 运行 shell 命令并返回 stdout（失败返回 null），超时 5s */
function sh(cmd: string, args: string[], timeoutMs = 5000): string | null {
  const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout ?? "";
}

/** 命令是否可用：找 PATH 或 ~/.local/bin */
function findBin(cmd: string): string | null {
  const candidates = [cmd, join(process.env.HOME ?? "", ".local", "bin", cmd)];
  for (const c of candidates) {
    if (sh(c, ["--version"]) !== null || sh(c, ["-version"]) !== null) return c;
  }
  return null;
}

/** 端口是否有进程监听 */
function portListening(port: number): boolean {
  return sh("bash", ["-c", `ss -tln 2>/dev/null | grep -q ':${port} '`]) !== null;
}

/** 进程是否存在 */
function procExists(name: string): boolean {
  return sh("bash", ["-c", `pgrep -f '${name}' >/dev/null 2>&1`]) !== null;
}

/** HTTP 探测，返回耗时 ms 与状态码，失败返回 null */
async function httpProbe(url: string, timeoutMs = 4000): Promise<{ ok: boolean; ms: number; status: number } | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    const res = await fetch(url, { signal: ctrl.signal });
    const ms = Date.now() - t0;
    clearTimeout(timer);
    return { ok: res.ok, ms, status: res.status };
  } catch {
    return null;
  }
}

/** Python 包是否可导入，返回版本号 */
function pyPkg(pkg: string): { ok: boolean; version: string } {
  const out = sh("python3", ["-c", `import ${pkg}; print(getattr(${pkg}, '__version__', ''))`]);
  if (out === null) return { ok: false, version: "" };
  return { ok: true, version: out.trim() };
}

export async function depsRoutes(app: FastifyInstance) {
  app.get("/deps", async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const [localPing, tunnelPing] = await Promise.all([
      httpProbe(`${base}/ping`),
      httpProbe(`${TUNNEL_URL}/ping`, 6000),
    ]);

    const commands = ["node", "python3", "ffmpeg", "git", "cloudflared", "qemu-system-x86_64"].map((cmd) => {
      const bin = findBin(cmd);
      return { name: cmd, ok: bin !== null, path: bin };
    });

    const pyPkgs = ["pypdf", "edge_tts"].map((pkg) => ({ name: pkg, ...pyPkg(pkg) }));

    const paths = [
      WORKDIR,
      join(WORKDIR, "src", "scripts", "tts_gen.py"),
      join(WORKDIR, "sandbox.py"),
      join(WORKDIR, "pdf_tools.py"),
      join(WORKDIR, "tts_tools.py"),
      join(WORKDIR, "data_tools.py"),
      join(WORKDIR, ".github_token"),
    ].map((p) => ({ path: p, ok: existsSync(p) }));

    const serviceOk = localPing?.ok ?? false;
    const tunnelOk = tunnelPing?.ok ?? false;

    return {
      ts: Date.now(),
      summary: {
        overall: serviceOk && tunnelOk ? "ok" : "degraded",
        service: serviceOk,
        tunnel: tunnelOk,
        commands: `${commands.filter((c) => c.ok).length}/${commands.length}`,
        pyPkgs: `${pyPkgs.filter((p) => p.ok).length}/${pyPkgs.length}`,
        paths: `${paths.filter((p) => p.ok).length}/${paths.length}`,
      },
      service: {
        port: PORT,
        listening: portListening(PORT),
        ping: localPing,
      },
      tunnel: {
        process: procExists("cloudflared"),
        url: TUNNEL_URL,
        ping: tunnelPing,
      },
      commands,
      pyPkgs,
      paths,
      env: {
        home: process.env.HOME ?? "",
        node: process.version,
        arch: process.arch,
        platform: process.platform,
      },
    };
  });
}
