import type { FastifyPluginAsync } from 'fastify';
import { getCoordinator } from '../core/engine.js';
import { verifyChildResult, verifySelfCheck, formatVerdictBrief, resetCapabilities } from '../core/verifier.js';

/**
 * 验收（Verifier）对外接口
 *  - GET  /api/verify/capabilities  本机验收能力自检
 *  - POST /api/verify/check         对一段交付内容做独立验收（不派发、只复核）
 *  - POST /api/verify/reset-caps    清空能力缓存（安装 ffmpeg/tesseract 后无需重启）
 */
export const verifyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/verify/capabilities', async () => {
    const coord = getCoordinator();
    const text = await verifySelfCheck(coord.pool);
    return { ok: true, text };
  });

  app.post('/verify/reset-caps', async () => {
    resetCapabilities();
    return { ok: true };
  });

  app.post('/verify/check', async (req) => {
    const body = req.body as { agent?: string; task?: string; answer?: string; llm_review?: boolean };
    const agent = String(body.agent ?? '未指定Agent');
    const task = String(body.task ?? '');
    const answer = String(body.answer ?? '');
    if (!answer.trim()) return { ok: false, error: 'answer 不能为空' };
    const coord = getCoordinator();
    const verdict = await verifyChildResult({
      agent,
      task,
      answer,
      pool: coord.pool,
      llmReview: body.llm_review !== false,
    });
    return { ok: true, verdict, brief: formatVerdictBrief(verdict) };
  });
};
