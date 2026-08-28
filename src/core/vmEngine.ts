// ========== VM 引擎检测层（跨平台） ==========
// 参考 QEMU/VirtualBox 的虚拟化引擎模式：
//   平台识别 → QEMU 二进制探测 → 加速器检测 → 降级链（QEMU → 容器 → Bash）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

export interface VmEngineInfo {
  engine: "qemu" | "bash" | "none";
  accel: "kvm" | "whpx" | "hvf" | "tcg" | "none";
  qemuPath: string | null;
  native: boolean;
  platform: NodeJS.Platform;
  detail: string;
}

const QEMU_NAMES: Record<NodeJS.Platform, string[]> = {
  linux: ["qemu-system-x86_64", "qemu-system-x86"],
  win32: ["qemu-system-x86_64.exe", "qemu-system-x86.exe"],
  darwin: ["qemu-system-x86_64", "qemu-system-x86"],
  // 其余平台不支持真虚拟机，直接走降级
  aix: [], android: [], freebsd: [], haiku: [], openbsd: [], sunos: [], cygwin: [], netbsd: [],
};

function which(cmd: string): string | null {
  try {
    if (platform() === "win32") {
      const out = execFileSync("where.exe", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return out.split(/\r?\n/)[0] || null;
    }
    const out = execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function probeQemu(): string | null {
  const names = QEMU_NAMES[platform()] || [];
  for (const n of names) {
    const p = which(n);
    if (p) return p;
  }
  // macOS 常见 Homebrew/手动安装路径兜底
  if (platform() === "darwin") {
    const candidates = ["/opt/homebrew/bin/qemu-system-x86_64", "/usr/local/bin/qemu-system-x86_64"];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return null;
}

function probeAccel(qemuPath: string): { accel: VmEngineInfo["accel"]; native: boolean; detail: string } {
  const plat = platform();
  try {
    if (plat === "linux") {
      // KVM 硬件加速
      if (existsSync("/dev/kvm")) return { accel: "kvm", native: true, detail: "KVM 硬件加速可用" };
      // 检查 qemu 是否支持 kvm（无 /dev/kvm 时仍可 tcg）
      return { accel: "tcg", native: false, detail: "无 /dev/kvm，使用 TCG 纯软件模拟" };
    }
    if (plat === "darwin") {
      // HVF: Hypervisor.framework（macOS 内置），尝试性探测
      try {
        const out = execFileSync(qemuPath, ["-accel", "hvf", "-machine", "help"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString();
        if (out.length >= 0) return { accel: "hvf", native: true, detail: "Hypervisor.framework 可用" };
      } catch {
        /* hvf 探测失败则降级 */
      }
      return { accel: "tcg", native: false, detail: "HVF 不可用，使用 TCG 纯软件模拟" };
    }
    if (plat === "win32") {
      // WHPX: Windows Hypervisor Platform
      try {
        const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
          "(Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State"], { timeout: 15000 }).toString().trim();
        if (out === "Enabled") return { accel: "whpx", native: true, detail: "WHPX 硬件加速可用" };
      } catch { /* 查询失败降级 */ }
      return { accel: "tcg", native: false, detail: "WHPX 未启用，使用 TCG 纯软件模拟" };
    }
    return { accel: "tcg", native: false, detail: "平台不支持硬件加速，使用 TCG" };
  } catch {
    return { accel: "tcg", native: false, detail: "加速器检测失败，使用 TCG" };
  }
}

export function detectVmEngine(): VmEngineInfo {
  const plat = platform();
  const qemuPath = probeQemu();
  if (!qemuPath) {
    // 降级：容器引擎（可选）→ Bash 引擎（内置）
    return {
      engine: "bash",
      accel: "none",
      qemuPath: null,
      native: false,
      platform: plat,
      detail: "未检测到 QEMU，降级为内置 Bash 引擎（真实 Linux 命令环境，非独立虚拟机）",
    };
  }
  const { accel, native, detail } = probeAccel(qemuPath);
  return {
    engine: "qemu",
    accel,
    qemuPath,
    native,
    platform: plat,
    detail: `QEMU 引擎: ${qemuPath}（${detail}）`,
  };
}

/** 根据引擎信息生成 QEMU 启动参数（加速部分，供 vm2 路由使用） */
export function qemuAccelArgs(info: VmEngineInfo): string[] {
  if (info.engine !== "qemu") return [];
  return ["-accel", info.accel];
}
