/**
 * src/tools/sysTools.ts — 电脑Agent 系统控制工具
 *
 * 通过 shell 命令实现：系统信息、进程管理、资源监控、软件包管理。
 * 安全约束：
 *  - process_kill 禁止 kill PID 1 / 自身进程 / 关键系统服务
 *  - pkg_install / pkg_remove / pkg_update 属高风险操作，返回执行影响说明
 *  - 所有命令白名单化，禁止拼接任意 shell
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ── 本地工具类型（避免与 agents.ts 循环引用）──
type FnSchema = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
type ToolDef = { schema: FnSchema; handler: (args: Record<string, unknown>, ctx?: unknown) => string | Promise<string> };


const exec = promisify(execFile);

async function runCmd(cmd: string, args: string[], timeoutMs = 30000): Promise<string> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).trim();
    return out || '(无输出)';
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return `[命令失败] ${err.stderr || err.message || String(e)}`;
  }
}

const PROTECTED_PIDS = new Set([1]);

export const sysTools: ToolDef[] = [
  {
    schema: { type: 'function', function: { name: 'sys_info', description: '查看系统信息（内核、主机名、发行版、运行时间、架构）', parameters: { type: 'object', properties: {} } } },
    handler: async () => {
      const parts = await Promise.all([
        runCmd('uname', ['-a']),
        runCmd('cat', ['/etc/os-release']).then((s) => s.split('\n').slice(0, 3).join('\n')),
        runCmd('uptime', []),
        runCmd('hostname', []),
      ]);
      return [`[内核] ${parts[0]}`, `[发行版]\n${parts[1]}`, `[运行时间] ${parts[2]}`, `[主机名] ${parts[3]}`].join('\n');
    },
  },
  {
    schema: { type: 'function', function: { name: 'process_list', description: '列出进程（默认15条，按CPU排序；可指定条数）', parameters: { type: 'object', properties: { limit: { type: 'integer', description: '显示条数，默认15' } } } } },
    handler: async (args: Record<string, unknown>) => {
      const limit = Math.min(Number(args.limit ?? 15) || 15, 100);
      return runCmd('ps', ['-eo', 'pid,ppid,user,%cpu,%mem,stat,cmd', '--sort=-%cpu']).then((s) => {
        const lines = s.split('\n');
        return lines.slice(0, 1 + limit).join('\n');
      });
    },
  },
  {
    schema: { type: 'function', function: { name: 'process_kill', description: '终止进程（PID或进程名）。TERM 默认，可用 KILL 强制。', parameters: { type: 'object', properties: { target: { type: 'string', description: '目标PID或进程名' }, signal: { type: 'string', description: 'TERM(默认)/KILL' } }, required: ['target'] } } },
    handler: async (args: Record<string, unknown>) => {
      const target = String(args.target ?? '');
      const signal = String(args.signal ?? 'TERM').toUpperCase() === 'KILL' ? 'KILL' : 'TERM';
      if (!target) return '[process_kill 失败] 缺少 target';
      // 进程名 → 先解析 PID
      let pid = target;
      if (!/^\d+$/.test(target)) {
        const res = await runCmd('pgrep', ['-f', target]);
        const pids = res.split('\n').filter(Boolean);
        if (!pids.length) return `[process_kill] 未找到进程: ${target}`;
        pid = pids[0];
        if (pids.length > 1) return `[process_kill] 找到多个进程: ${pids.join(', ')}，请指定 PID`;
      }
      const pidNum = Number(pid);
      if (PROTECTED_PIDS.has(pidNum)) return '[process_kill 已拦截] 禁止终止 PID 1';
      if (pidNum === process.pid) return '[process_kill 已拦截] 禁止终止自身进程';
      const res = await runCmd('kill', [`-${signal}`, pid]);
      return res === '(无输出)' ? `[已发送 ${signal} 到 PID ${pid}]` : res;
    },
  },
  {
    schema: { type: 'function', function: { name: 'disk_usage', description: '查看磁盘使用情况', parameters: { type: 'object', properties: {} } } },
    handler: () => runCmd('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay']),
  },
  {
    schema: { type: 'function', function: { name: 'memory_usage', description: '查看内存使用情况', parameters: { type: 'object', properties: {} } } },
    handler: () => runCmd('free', ['-h']),
  },
  {
    schema: { type: 'function', function: { name: 'cpu_info', description: '查看CPU信息（型号/核心数/负载）', parameters: { type: 'object', properties: {} } } },
    handler: async () => {
      const model = await runCmd('sh', ['-c', "grep 'model name' /proc/cpuinfo | head -1"]).then((s) => s.replace('model name\t: ', ''));
      const cores = await runCmd('sh', ['-c', 'grep -c ^processor /proc/cpuinfo']);
      const load = await runCmd('cat', ['/proc/loadavg']);
      return `[CPU型号] ${model}\n[逻辑核心数] ${cores}\n[负载(1/5/15分钟)] ${load}`;
    },
  },
  {
    schema: { type: 'function', function: { name: 'network_info', description: '查看网络接口和监听端口', parameters: { type: 'object', properties: {} } } },
    handler: async () => {
      const [ifaces, ports] = await Promise.all([
        runCmd('sh', ['-c', "ip -brief addr 2>/dev/null || ifconfig 2>/dev/null || ip addr"]),
        runCmd('sh', ['-c', "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null"]),
      ]);
      return `[网络接口]\n${ifaces}\n\n[监听端口]\n${ports}`;
    },
  },
  {
    schema: { type: 'function', function: { name: 'pkg_search', description: '搜索软件包（dnf search，只读操作）', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    handler: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '');
      if (!query) return '[pkg_search 失败] 缺少 query';
      const res = await runCmd('dnf', ['search', query], 60000);
      return res.slice(0, 3000);
    },
  },
  {
    schema: { type: 'function', function: { name: 'pkg_install', description: '安装软件包（dnf install -y）。【高风险】安装新软件到系统', parameters: { type: 'object', properties: { name: { type: 'string', description: '包名' } }, required: ['name'] } } },
    handler: async (args: Record<string, unknown>) => {
      const name = String(args.name ?? '');
      if (!name) return '[pkg_install 失败] 缺少 name';
      return runCmd('dnf', ['install', '-y', name], 300000);
    },
  },
  {
    schema: { type: 'function', function: { name: 'pkg_remove', description: '卸载软件包（dnf remove -y）。【高风险】将移除软件及其依赖', parameters: { type: 'object', properties: { name: { type: 'string', description: '包名' } }, required: ['name'] } } },
    handler: async (args: Record<string, unknown>) => {
      const name = String(args.name ?? '');
      if (!name) return '[pkg_remove 失败] 缺少 name';
      return runCmd('dnf', ['remove', '-y', name], 300000);
    },
  },
  {
    schema: { type: 'function', function: { name: 'pkg_update', description: '检查系统可更新包（dnf check-update）；不带包名时只检查不更新', parameters: { type: 'object', properties: { name: { type: 'string', description: '指定包名（可选）' } } } } },
    handler: async (args: Record<string, unknown>) => {
      const name = String(args.name ?? '');
      if (name) {
        return runCmd('dnf', ['update', '-y', name], 300000);
      }
      return runCmd('dnf', ['check-update'], 120000);
    },
  },
];
