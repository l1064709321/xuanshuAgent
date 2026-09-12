/**
 * src/core/limits.ts — 多轮执行限制（前端可调）
 *
 * 背景：子 Agent 工具循环原先硬编码 MAX_TOOL_ROUNDS=4，长产物任务（如生成完整游戏）
 * 会在第 4 轮被强行掐断，出现"文件写一半就失败"。
 *
 * 现在的语义：
 *  - maxRounds   单次任务最多执行轮数（默认 500）；达到上限不直接判失败，
 *                而是产出「断点报告」并暂停，由主 Agent 与用户对话确认是否续轮。
 *  - stallRounds 无进展熔断阈值（默认 5）；连续 N 轮工具观测结果无变化即暂停，
 *                避免模型空转烧 token（可前端调整）。
 *
 * 持久化：项目根 .data/exec_limits.json（JSON），不占系统目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './sandbox.js';

export interface ExecLimits {
  /** 单次任务最多执行轮数（达到则暂停 + 对话确认是否续轮） */
  maxRounds: number;
  /** 无进展熔断：连续 N 轮工具观测结果无变化则暂停请示 */
  stallRounds: number;
}

/** 出厂默认值：500 轮上限 / 5 轮无进展熔断 */
export const DEFAULT_LIMITS: ExecLimits = { maxRounds: 500, stallRounds: 5 };

/** 合法区间（防止前端填 0 或天文数字把服务打挂） */
export const LIMITS_RANGE = {
  maxRounds: { min: 1, max: 5000 },
  stallRounds: { min: 1, max: 200 },
} as const;

const DATA_DIR = path.join(PROJECT_ROOT, '.data');
const LIMITS_FILE = path.join(DATA_DIR, 'exec_limits.json');

let cache: ExecLimits | null = null;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 读取当前限制（带缓存；文件损坏/缺失均回退默认值） */
export function getLimits(): ExecLimits {
  if (cache) return cache;
  let raw: Partial<ExecLimits> = {};
  try {
    if (fs.existsSync(LIMITS_FILE)) {
      raw = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf-8')) as Partial<ExecLimits>;
    }
  } catch {
    raw = {};
  }
  cache = {
    maxRounds: clampInt(raw.maxRounds, LIMITS_RANGE.maxRounds.min, LIMITS_RANGE.maxRounds.max, DEFAULT_LIMITS.maxRounds),
    stallRounds: clampInt(raw.stallRounds, LIMITS_RANGE.stallRounds.min, LIMITS_RANGE.stallRounds.max, DEFAULT_LIMITS.stallRounds),
  };
  return cache;
}

/** 局部更新限制（只传要改的字段），返回落库后的完整值 */
export function setLimits(patch: Partial<ExecLimits>): ExecLimits {
  const cur = getLimits();
  const next: ExecLimits = {
    maxRounds: patch.maxRounds === undefined
      ? cur.maxRounds
      : clampInt(patch.maxRounds, LIMITS_RANGE.maxRounds.min, LIMITS_RANGE.maxRounds.max, DEFAULT_LIMITS.maxRounds),
    stallRounds: patch.stallRounds === undefined
      ? cur.stallRounds
      : clampInt(patch.stallRounds, LIMITS_RANGE.stallRounds.min, LIMITS_RANGE.stallRounds.max, DEFAULT_LIMITS.stallRounds),
  };
  cache = next;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LIMITS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    /* 落盘失败不阻断运行，本次进程内生效 */
  }
  return next;
}

/** 恢复默认值（前端"恢复默认"按钮） */
export function resetLimits(): ExecLimits {
  return setLimits({ ...DEFAULT_LIMITS });
}
