/**
 * src/vendors/glm.ts — 智谱 GLM 厂商调度
 * 官方：GLM-4.5/GLM-4.6 系列 128K~203K 上下文，OpenAI 兼容端点
 * （https://open.bigmodel.cn/api/paas/v4）。
 */
import { BaseVendor } from './base.js';

export class GlmVendor extends BaseVendor {
  vendor = 'glm';
  context_window = 200_000;
  max_output = 16_000;
  cjk_chars_per_token = 1.0;
  cache_mode = 'none';
}
