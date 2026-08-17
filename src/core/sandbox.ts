/**
 * src/core/sandbox.ts — Python 沙箱子进程封装
 *
 * 迁移决策：保留 Python 沙箱（sandbox.py）作为子进程执行引擎。
 * 本模块通过 child_process 调用 python3，以 JSON 行协议通信：
 *   - runSandboxed(code, timeout, network)  → 默认隔离（无网络、禁写文件、seccomp+资源限制）
 *   - runInVenv(code, venvPath, timeout)     → 虚拟环境执行（有依赖）
 *   - runLocal(code, timeout)                → 当前环境直接执行
 *   - createVenv(packages)                   → 创建虚拟环境
 *   - envInfo()                              → 环境信息
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/core/sandbox.ts → 项目根（含 sandbox.py）
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  error: string | null;
}

/** 执行 Python 沙箱调用，返回 JSON 结果 */
function runPython(args: string[], timeoutMs: number): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'python3',
      ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(PROJECT_ROOT)})
from sandbox import run_sandboxed, run_in_venv, run_local, run_tool, create_venv, get_env_info
op = sys.argv[1]
if op == "sandboxed":
    code, timeout, network = sys.argv[2], int(sys.argv[3]), sys.argv[4] == "1"
    print(json.dumps(run_sandboxed(code, timeout=timeout, network=network), ensure_ascii=False))
elif op == "venv":
    code, timeout, venv = sys.argv[2], int(sys.argv[3]), sys.argv[4]
    print(json.dumps(run_in_venv(code, timeout=timeout, venv_path=venv or None), ensure_ascii=False))
elif op == "local":
    code, timeout = sys.argv[2], int(sys.argv[3])
    print(json.dumps(run_local(code, timeout=timeout), ensure_ascii=False))
elif op == "tool":
    code, timeout = sys.argv[2], int(sys.argv[3])
    print(json.dumps(run_tool(code, timeout=timeout), ensure_ascii=False))
elif op == "create_venv":
    pkgs = sys.argv[2].split("\\x1f") if sys.argv[2] else []
    print(json.dumps(create_venv(packages=pkgs), ensure_ascii=False))
elif op == "env_info":
    print(json.dumps(get_env_info(), ensure_ascii=False))
else:
    print(json.dumps({"error": "unknown op"}, ensure_ascii=False))
`].concat(args),
      { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: `沙箱进程启动失败: ${err.message}`, exit_code: -1, timed_out: false, error: err.message });
    });
    child.on('close', (code, signal) => {
      if (signal) {
        resolve({ stdout: '', stderr: `沙箱进程被终止(${signal})`, exit_code: -1, timed_out: true, error: 'timeout' });
        return;
      }
      try {
        const lastLine = stdout.trim().split('\n').pop() ?? '';
        const parsed = JSON.parse(lastLine) as SandboxResult & { ok?: boolean };
        resolve({
          stdout: parsed.stdout ?? '',
          stderr: parsed.stderr ?? '',
          exit_code: parsed.exit_code ?? code ?? -1,
          timed_out: parsed.timed_out ?? false,
          error: parsed.error ?? null,
        });
      } catch {
        resolve({ stdout: '', stderr: `沙箱输出解析失败: ${stdout.slice(0, 500)}`, exit_code: code ?? -1, timed_out: false, error: 'parse' });
      }
    });
  });
}

/** 隔离沙箱执行（无网络、禁写文件，seccomp+资源限制） */
export function runSandboxed(code: string, timeout = 30, network = false): Promise<SandboxResult> {
  return runPython(['sandboxed', code, String(timeout), network ? '1' : '0'], timeout * 1000 + 5000);
}

/** 虚拟环境执行（有依赖，不限制网络/文件） */
export function runInVenv(code: string, venvPath = '', timeout = 60): Promise<SandboxResult> {
  return runPython(['venv', code, String(timeout), venvPath], timeout * 1000 + 5000);
}

/** 本地执行（无隔离，信任代码时使用） */
export function runLocal(code: string, timeout = 60): Promise<SandboxResult> {
  return runPython(['local', code, String(timeout)], timeout * 1000 + 5000);
}

/** 受信工具层专用：执行项目自带工具模块（不注入 light guard） */
export function runTool(code: string, timeout = 60): Promise<SandboxResult> {
  return runPython(['tool', code, String(timeout)], timeout * 1000 + 5000);
}

export interface VenvResult {
  ok: boolean;
  path?: string;
  packages?: string[];
  error?: string;
}

/** 创建虚拟环境并安装依赖 */
export async function createVenv(packages: string[] = []): Promise<VenvResult> {
  const res = await runPython(['create_venv', packages.join('\x1f')], 130000);
  try {
    const lastLine = res.stdout.trim().split('\n').pop() ?? '';
    const parsed = JSON.parse(lastLine);
    return { ok: !!parsed.ok, path: parsed.path, packages: parsed.packages, error: parsed.error };
  } catch {
    return { ok: false, error: res.stderr || '解析失败' };
  }
}

export interface EnvInfo {
  python: string;
  sandbox_dir: string;
  has_venv: boolean;
  venv_path: string;
  platform: string;
  in_docker: boolean;
}

/** 获取 Python 沙箱环境信息 */
export async function envInfo(): Promise<EnvInfo> {
  const res = await runPython(['env_info'], 15000);
  try {
    const lastLine = res.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(lastLine) as EnvInfo;
  } catch {
    return { python: 'unknown', sandbox_dir: '', has_venv: false, venv_path: '', platform: process.platform, in_docker: false };
  }
}

/** 将沙箱结果格式化为 Agent 可读文本（对齐 Python _run_code 输出） */
export function formatSandboxResult(res: SandboxResult, label = '沙箱执行'): string {
  const parts = [`[${label}]`];
  if (res.stdout) parts.push(`[stdout]\n${res.stdout.slice(0, 2000)}`);
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.slice(0, 1000)}`);
  if (res.timed_out) parts.push('[警告] 代码执行超时');
  if (res.error && res.error !== 'timeout') parts.push(`[错误] ${res.error}`);
  parts.push(`[exit_code] ${res.exit_code}`);
  return parts.join('\n');
}
