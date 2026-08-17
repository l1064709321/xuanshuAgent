/**
 * src/tools/codeTools.ts — 代码Agent 工具
 *
 *  - run_code：调用 Python 沙箱子进程（默认隔离模式，可选 venv/local）
 *  - git_log / git_status / git_revert：Git 版本操作
 * 安全：git_revert 为破坏性操作，自动 stash 当前改动并说明影响。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSandboxed, runInVenv, runLocal, formatSandboxResult, PROJECT_ROOT } from '../core/sandbox.js';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const exec = promisify(execFile);

async function git(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30000 });
    return (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim() || '(无输出)';
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `[git 失败] ${err.stderr || err.message || String(e)}`.trim();
  }
}

export const codeTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'run_code', description: '执行 Python 代码。默认沙箱隔离模式（无网络、禁写文件）；mode=venv 使用项目虚拟环境（有依赖）；mode=local 直接执行（信任代码时）。', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Python 代码' }, mode: { type: 'string', description: 'sandbox(默认)/venv/local' } }, required: ['code'] } } },
    handler: async (args: Record<string, unknown>) => {
      const code = String(args.code ?? '');
      const mode = String(args.mode ?? 'sandbox');
      if (!code) return '[run_code 失败] 缺少 code';
      try {
        if (mode === 'venv') {
          const res = await runInVenv(code);
          return formatSandboxResult(res, 'venv 执行');
        }
        if (mode === 'local') {
          const res = await runLocal(code);
          return formatSandboxResult(res, '本地执行');
        }
        const res = await runSandboxed(code);
        return formatSandboxResult(res, '沙箱执行');
      } catch (e) {
        return `[run_code 失败] ${(e as Error).message}`;
      }
    },
  },
  {
    schema: { type: 'function', function: { name: 'git_log', description: '查看最近 git 提交记录（默认15条）', parameters: { type: 'object', properties: { n: { type: 'integer', description: '显示条数，默认15' } } } } },
    handler: async (args: Record<string, unknown>) => {
      const n = Math.min(Number(args.n ?? 15) || 15, 100);
      return git(['log', `-${n}`, '--pretty=format:%h %ad %s', '--date=format:%m-%d %H:%M']);
    },
  },
  {
    schema: { type: 'function', function: { name: 'git_status', description: '查看 git 工作区状态', parameters: { type: 'object', properties: {} } } },
    handler: () => git(['status', '--short', '--branch']),
  },
  {
    schema: { type: 'function', function: { name: 'git_revert', description: '回滚到指定 commit。自动 stash 当前未提交改动。回滚后工作区代码会被替换，属破坏性操作，执行前确认。', parameters: { type: 'object', properties: { commit: { type: 'string', description: '目标 commit hash 或 HEAD~N' } } } } },
    handler: async (args: Record<string, unknown>) => {
      const commit = String(args.commit ?? '');
      if (!commit) return '[git_revert 失败] 缺少 commit';
      const stash = await git(['stash', 'push', '-u', '-m', `auto-stash-before-revert-${Date.now()}`]);
      if (!stash.includes('No local changes')) {
        // stash 成功，记录
      }
      const revert = await git(['reset', '--hard', commit]);
      return `[已回滚到 ${commit}]\n${revert}\n${stash.includes('No local changes') ? '(无未提交改动)' : '(未提交改动已 stash，可用 git stash pop 恢复)'}`;
    },
  },
];
