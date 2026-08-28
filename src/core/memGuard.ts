/**
 * src/core/memGuard.ts — 记忆系统统一加固核心
 *
 * 供两条写入路径复用：
 * 1. HTTP API 层（src/routes/misc.ts  /api/memory/*）
 * 2. Agent 工具层（src/tools/memTools.ts  memdir_*）
 *
 * 保证正确性的机制：
 * - 扩展名白名单：只允许文本类文件，防止写入二进制/脚本
 * - 路径安全：防穿越、防绝对路径、防内部目录（.backup/.trash）
 * - 原子写入：先写 .tmp 再 rename，避免写一半崩溃留下半截文件
 * - 写前备份：目标已存在时先复制带时间戳备份，保留 MEM_BACKUP_KEEP 份
 * - 软删除：移入回收区，可恢复，不物理删除
 * - 大小上限：单文件读写均受限，防膨胀撑爆内存/磁盘
 */
import fs from 'node:fs';
import path from 'node:path';

export const MEM_ALLOWED_EXT = ['.md', '.txt', '.json', '.yaml', '.yml'];
export const MEM_MAX_READ = 5 * 1024 * 1024;
export const MEM_MAX_WRITE = 1 * 1024 * 1024;
export const MEM_BACKUP_KEEP = 5;

/** 校验记忆相对路径合法性：非空、非内部目录、非路径穿越、扩展名白名单 */
export function isValidMemRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\')) return false;
  const parts = rel.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) return false;
  const base = parts[0];
  if (base === '.backup' || base === '.trash') return false;
  const ext = path.extname(rel).toLowerCase();
  return MEM_ALLOWED_EXT.includes(ext);
}

/** 防路径穿越：目标必须位于 base 目录内 */
export function safeResolve(base: string, rel: string): string | null {
  const target = path.resolve(base, rel);
  if (!target.startsWith(path.resolve(base) + path.sep) && target !== path.resolve(base)) return null;
  return target;
}

/** 原子写入：先写临时文件再 rename，避免写一半崩溃留下半截文件 */
export function atomicWrite(file: string, content: string): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

/** 写前备份：目标已存在时先复制一份带时间戳的备份，超量清理最旧 */
export function backupBeforeWrite(target: string, memDir: string, backupDir: string): void {
  if (!fs.existsSync(target)) return;
  const rel = path.relative(memDir, target);
  const destDir = path.join(backupDir, path.dirname(rel));
  fs.mkdirSync(destDir, { recursive: true });
  const ts = Date.now();
  fs.copyFileSync(target, path.join(destDir, path.basename(rel) + '.' + ts + '.bak'));
  try {
    const baks = fs.readdirSync(destDir)
      .filter(f => f.startsWith(path.basename(rel) + '.') && f.endsWith('.bak'))
      .sort();
    for (const old of baks.slice(0, Math.max(0, baks.length - MEM_BACKUP_KEEP))) {
      fs.rmSync(path.join(destDir, old), { force: true });
    }
  } catch { /* 忽略 */ }
}

/** 软删除：移动到回收区（保留可恢复性），不物理删除 */
export function softDeleteToTrash(target: string, memDir: string, trashDir: string): string | null {
  if (!fs.existsSync(target)) return null;
  const rel = path.relative(memDir, target);
  const destDir = path.join(trashDir, path.dirname(rel));
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(rel) + '.' + Date.now() + '.trash');
  fs.renameSync(target, dest);
  return rel;
}
