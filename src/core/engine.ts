/**
 * src/core/engine.ts — 全局引擎单例
 * 持有 ModelPool + Coordinator，供路由与后续阶段共享。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelPool } from './modelPool.js';
import { Coordinator, initCoordinator } from './coordinator.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '../..');

let _pool: ModelPool | null = null;
let _coord: Coordinator | null = null;

export function getPool(): ModelPool {
  if (!_pool) {
    const apiKey = process.env.XS_API_KEY ?? '';
    _pool = new ModelPool('agnes-2.0-flash', apiKey);
    // 启动时加载持久化每模型 Key（.data/keys.json）
    try {
      const keysFile = join(ROOT, '.data', 'keys.json');
      if (existsSync(keysFile)) {
        const store = JSON.parse(readFileSync(keysFile, 'utf-8')) as Record<string, string>;
        for (const [model, key] of Object.entries(store)) {
          if (key) _pool.setModelKey(model, key);
        }
      }
    } catch {
      // keys.json 缺失或损坏时忽略，保持默认空 Key
    }
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
