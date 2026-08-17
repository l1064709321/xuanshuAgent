/**
 * src/core/engine.ts — 全局引擎单例
 * 持有 ModelPool + Coordinator，供路由与后续阶段共享。
 */
import { ModelPool } from './modelPool.js';
import { Coordinator, initCoordinator } from './coordinator.js';

let _pool: ModelPool | null = null;
let _coord: Coordinator | null = null;

export function getPool(): ModelPool {
  if (!_pool) {
    const apiKey = process.env.XS_API_KEY ?? '';
    _pool = new ModelPool('nemotron-super', apiKey);
  }
  return _pool;
}

export function getCoordinator(): Coordinator {
  if (!_coord) {
    _coord = initCoordinator(getPool(), process.env.XS_FALLBACK === '1');
  }
  return _coord;
}

export function resetEngine(): void {
  _pool = null;
  _coord = null;
}
