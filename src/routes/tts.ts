import type { FastifyPluginAsync } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TTS_SCRIPT = join(ROOT, 'src', 'scripts', 'tts_gen.py');

/**
 * POST /api/tts — 语音合成（edge-tts）
 * body: { text: string; speed?: number }
 * 返回: audio/mpeg 二进制
 */
export const ttsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/tts', async (req, reply) => {
    const body = (req.body ?? {}) as { text?: string; speed?: number };
    const text = (body.text || '').trim();
    if (!text) {
      return reply.code(400).send({ error: 'text 不能为空' });
    }
    const speed = typeof body.speed === 'number' && body.speed > 0 ? body.speed : 1.0;
    const out = join(tmpdir(), `xuanshu_tts_${Date.now()}_${randomBytes(4).toString('hex')}.mp3`);
    try {
      await execFileP('python3', [TTS_SCRIPT, '--text', text, '--out', out, '--speed', String(speed)], { timeout: 30000 });
      const buf = await readFile(out);
      return reply
        .header('Content-Type', 'audio/mpeg')
        .header('Cache-Control', 'no-store')
        .send(buf);
    } catch (e) {
      app.log.error(`TTS failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply.code(500).send({ error: 'TTS 合成失败: ' + (e instanceof Error ? e.message : String(e)) });
    }
  });
};
