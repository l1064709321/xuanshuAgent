import type { FastifyPluginAsync } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getPythonCmd } from '../core/sandbox.js';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TTS_SCRIPT = join(ROOT, 'src', 'scripts', 'tts_gen.py');
const TTS_TMP_PREFIX = 'xuanshu_tts_';
/** 临时音频保留上限：超过这个数量或超过 1 小时的残留一律清掉 */
const TTS_TMP_MAX_FILES = 20;
const TTS_TMP_MAX_AGE_MS = 60 * 60 * 1000;

/** 清理历史残留的合成音频（进程被杀等异常情况下留下的） */
async function sweepTtsTmp(): Promise<void> {
  try {
    const dir = tmpdir();
    const names = (await readdir(dir)).filter(n => n.startsWith(TTS_TMP_PREFIX) && n.endsWith('.mp3'));
    if (!names.length) return;
    const entries: { name: string; mtime: number }[] = [];
    for (const name of names) {
      try {
        const s = await stat(join(dir, name));
        entries.push({ name, mtime: s.mtimeMs });
      } catch { /* 已被删除则忽略 */ }
    }
    const now = Date.now();
    entries
      .sort((a, b) => b.mtime - a.mtime)
      .forEach((e, i) => {
        if (i >= TTS_TMP_MAX_FILES || now - e.mtime > TTS_TMP_MAX_AGE_MS) {
          void unlink(join(dir, e.name)).catch(() => { /* 忽略 */ });
        }
      });
  } catch { /* 清理失败不影响主流程 */ }
}

/**
 * POST /api/tts — 语音合成（edge-tts）
 * body: { text: string; speed?: number }
 * 返回: audio/mpeg 二进制
 */
export const ttsRoutes: FastifyPluginAsync = async (app) => {
  // 启动即清理历史残留音频
  void sweepTtsTmp();
  app.post('/tts', async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string; speed?: number };
    const text = (body.text || '').trim();
    if (!text) {
      return reply.code(400).send({ error: 'text 不能为空' });
    }
    const speed = typeof body.speed === 'number' && body.speed > 0 ? body.speed : 1.0;
    const out = join(tmpdir(), `xuanshu_tts_${Date.now()}_${randomBytes(4).toString('hex')}.mp3`);
    // 顺手清理历史残留，避免临时音频无限堆积
    void sweepTtsTmp();
    try {
      await execFileP(getPythonCmd(), [TTS_SCRIPT, '--text', text, '--out', out, '--speed', String(speed)], { timeout: 30000 });
      const buf = await readFile(out);
      return reply
        .header('Content-Type', 'audio/mpeg')
        .header('Cache-Control', 'no-store')
        .send(buf);
    } catch (e) {
      app.log.error(`TTS failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply.code(500).send({ error: 'TTS 合成失败: ' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      // 音频只用于本次回传，读完即删（成功/失败都删）
      await unlink(out).catch(() => { /* 不存在则忽略 */ });
    }
  });
};
