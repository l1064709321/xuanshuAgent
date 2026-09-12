/**
 * src/core/modelPool.ts — 模型池
 *
 * 对齐 Python models.py ModelPool：内置 177+ 预设 + 用户自定义，
 * 支持每模型独立 API Key、Agent 绑定、多模型兜底链、失败冷却、模态分类。
 */
import OpenAI from 'openai';
import { BUILTIN_MODELS, type ModelPreset } from '../data/presets.js';

export type Modality = 'text' | 'image' | 'video' | 'tts' | 'stt' | 'music' | 'live';

export interface ModelEntry extends ModelPreset {}

export interface LlmResponse {
  choices: { message: { role: string; content: string; tool_calls?: unknown } }[];
  usage: Record<string, number | Record<string, number> | undefined>;
  _model: string;
  _tried?: [string, string][];
  _fallback_used?: boolean;
  _multimodal?: Modality;
  _audio_b64?: string;
  _audio_format?: string;
  _tool_rounds?: number;
  _thinking_log?: { round: number; tool: string; thought: string }[];
  /** 断点暂停标记：'max_rounds' 达轮数上限 / 'stall' 无进展熔断（有值表示未完成、待续轮） */
  _stop_reason?: 'max_rounds' | 'stall';
}

// ── 模态分类常量（对齐 Python）──
const IMAGE_KEYS = ['gpt-image', 'flux-', 'ideogram-', 'stable-image-', 'sf-qwen-image',
  'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
const VIDEO_KEYS = ['sora-', 'veo-', 'luma-', 'kling-', 'jimeng-', 'hailuo-',
  'seedance-', 'pika-', 'runway-', 'gemini-omni-', 'sf-qwen3-omni'];
const TTS_KEYS = ['tts-1', 'eleven-', 'minimax-speech-',
  'gemini-3.1-flash-tts', 'gemini-2.5-pro-tts', 'gemini-2.5-flash-tts'];
const STT_KEYS = ['whisper-'];
const MUSIC_KEYS = ['lyria-', 'minimax-music-', 'stable-audio-'];
const LIVE_KEYS = ['gemini-3.1-flash-live', 'gemini-2.5-flash-live'];

const MODALITY_HINT: [string, Modality][] = [
  ['图像', 'image'], ['image', 'image'], ['photo', 'image'], ['画', 'image'],
  ['视频', 'video'], ['video', 'video'], ['clip', 'video'],
  ['语音合成', 'tts'], ['tts', 'tts'], ['speech', 'tts'], ['语音', 'tts'],
  ['语音识别', 'stt'], ['stt', 'stt'], ['transcription', 'stt'],
  ['音乐', 'music'], ['music', 'music'], ['audio', 'music'],
  ['live', 'live'],
];

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class ModelPool {
  default_key: string;
  private _apiKey: string;
  private _clients = new Map<string, OpenAI>();
  private _bindings = new Map<string, string>();       // agent → model key
  private _custom = new Map<string, ModelEntry>();     // 用户自定义模型
  private _perModelKeys = new Map<string, string>();   // model key → api_key
  private _fallbackChain: string[] = [];               // 多模型兜底链
  private _cooldown = new Map<string, number>();       // model key → 失败时间戳
  private _cooldownSeconds = 60.0;                     // 1分钟冷却

  constructor(defaultKey = 'nemotron-super', apiKey = '') {
    this.default_key = defaultKey;
    this._apiKey = apiKey;
  }

  get apiKey(): string { return this._apiKey; }
  set apiKey(value: string) {
    if (this._apiKey !== value) this._clients.clear(); // key 变了，清空旧缓存
    this._apiKey = value;
  }

  // ── 每模型独立 API Key ──
  setModelKey(modelKey: string, apiKey: string): void {
    this._perModelKeys.set(modelKey, apiKey);
    const entry = this.allModels.get(modelKey);
    if (entry) this._clients.delete(entry.baseUrl);
  }

  removeModelKey(modelKey: string): void {
    this._perModelKeys.delete(modelKey);
    const entry = this.allModels.get(modelKey);
    if (entry) this._clients.delete(entry.baseUrl);
  }

  modelHasKey(modelKey: string): boolean {
    const k = this._perModelKeys.get(modelKey);
    return Boolean(k);
  }

  getModelKey(modelKey: string): string {
    return this._perModelKeys.get(modelKey) ?? this._apiKey;
  }

  get perModelKeys(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [k, v] of this._perModelKeys) out[k] = Boolean(v);
    return out;
  }

  // ── 模型合并 ──
  get allModels(): Map<string, ModelEntry> {
    const merged = new Map<string, ModelEntry>();
    for (const [k, v] of Object.entries(BUILTIN_MODELS)) merged.set(k, v);
    for (const [k, v] of this._custom) merged.set(k, v);
    return merged;
  }

  addCustom(name: string, modelId: string, baseUrl: string, provider = '自定义'): ModelEntry {
    const key = `_custom_${name.toLowerCase().replace(/\s+/g, '-')}`;
    const entry: ModelEntry = {
      key, name, modelId, baseUrl, provider,
      description: '用户自定义', aliases: [], custom: true,
    };
    this._custom.set(key, entry);
    return entry;
  }

  removeCustom(key: string): void {
    if (this._custom.size <= 1) throw new Error('至少保留一个自定义模型，请先添加新的再删除');
    this._custom.delete(key);
    if (this.default_key === key) {
      this.default_key = this._custom.keys().next().value as string;
    }
  }

  // ── Agent 绑定 ──
  bind(agent: string, key: string): void {
    if (!this.allModels.has(key)) throw new Error(`未知模型: ${key}`);
    this._bindings.set(agent, key);
  }

  unbind(agent: string): void {
    this._bindings.delete(agent);
  }

  getKey(agent: string): string {
    return this._bindings.get(agent) ?? this.default_key;
  }

  getModel(agent: string): ModelEntry {
    return this.allModels.get(this.getKey(agent))!;
  }

  setDefault(key: string): void {
    if (!this.allModels.has(key)) throw new Error(`未知模型: ${key}`);
    this.default_key = key;
  }

  /** 模型查询：key / model_id / aliases / 名称模糊匹配 */
  resolve(query: string): string | null {
    const q = query.toLowerCase().trim();
    const models = this.allModels;
    if (models.has(q)) return q;
    for (const [k, v] of models) if (q === v.modelId.toLowerCase()) return k;
    for (const [k, v] of models) {
      if (v.aliases.includes(q)) return k;
      if (k.toLowerCase().includes(q) || v.name.toLowerCase().includes(q)) return k;
    }
    return null;
  }

  // ── 模态分类（对齐 Python classify_model）──
  classifyModel(key: string): Modality {
    const model = this.allModels.get(key);
    if (!model) return 'text';
    const desc = model.description.toLowerCase();
    const starts = (list: string[]) => list.some((p) => key.startsWith(p));
    if (starts(IMAGE_KEYS)) return 'image';
    if (starts(VIDEO_KEYS)) return 'video';
    if (starts(TTS_KEYS)) return 'tts';
    if (starts(STT_KEYS)) return 'stt';
    if (starts(MUSIC_KEYS)) return 'music';
    if (starts(LIVE_KEYS)) return 'live';
    for (const [kw, modality] of MODALITY_HINT) {
      if (desc.includes(kw)) return modality;
    }
    return 'text';
  }

  // ── OpenAI 客户端缓存 ──
  private _getClient(baseUrl: string, modelKey = ''): OpenAI | null {
    if (!baseUrl) return null;
    const apiKey = modelKey ? this.getModelKey(modelKey) : this.apiKey;
    const cacheKey = `${baseUrl}::${modelKey}`;
    if (!this._clients.has(cacheKey)) {
      try {
        this._clients.set(cacheKey, new OpenAI({ apiKey, baseURL: baseUrl }));
      } catch {
        return null;
      }
    }
    return this._clients.get(cacheKey)!;
  }

  // ── 多模型兜底 ──
  setFallbackChain(keys: string[]): void {
    for (const k of keys) {
      if (!this.allModels.has(k)) throw new Error(`未知模型: ${k}`);
    }
    this._fallbackChain = [...keys];
  }

  clearCooldown(modelKey = ''): void {
    if (modelKey) this._cooldown.delete(modelKey);
    else this._cooldown.clear();
  }

  callLlm(agent: string, messages: unknown[], tools?: ToolDef[], modelOverride = '', stop?: string[]): Promise<LlmResponse> {
    return this.callLlmWithFallback(agent, messages, tools, [], 0, modelOverride, stop);
  }

  /**
   * 多模型兜底调用：依次尝试主模型和备用模型，直至成功。
   * 返回结果中额外字段：
   *   _model: 最终使用的模型名称
   *   _tried: 尝试过的模型列表 [(key, ok/err), ...]
   *   _fallback_used: 是否使用了备用模型
   */
  async callLlmWithFallback(
    agent: string,
    messages: unknown[],
    tools?: ToolDef[],
    fallbackModels: string[] = [],
    maxFallbacks = 5,
    modelOverride = '',
    stop?: string[],
  ): Promise<LlmResponse> {
    const tried: [string, string][] = [];
    const primaryKey = modelOverride && this.allModels.has(modelOverride)
      ? modelOverride : this.getKey(agent);

    const candidates = [primaryKey, ...fallbackModels, ...this._fallbackChain];
    const seen = new Set<string>();
    const ordered: string[] = [];
    const now = Date.now();
    for (const k of candidates) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (k !== primaryKey && this._cooldown.has(k)) {
        const ts = this._cooldown.get(k)!;
        if (now - ts < this._cooldownSeconds * 1000) {
          tried.push([k, '冷却中']);
          continue;
        }
        this._cooldown.delete(k); // 冷却到期
      }
      ordered.push(k);
      if (ordered.length >= maxFallbacks + 1) break;
    }

    let lastError = '';
    for (let i = 0; i < ordered.length; i++) {
      const key = ordered[i];
      const model = this.allModels.get(key)!;
      const client = this._getClient(model.baseUrl, key);
      if (!client) {
        tried.push([key, '无API连接']);
        continue;
      }

      const params: Record<string, unknown> = {
        model: model.modelId,
        messages: messages.slice(-20) as never,
        max_tokens: 4096,
      };
      if (tools) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }
      if (stop) params.stop = stop;
      // NVIDIA MiniMax 必须走 streaming，否则超时或空返回
      if (key.startsWith('nv-minimax')) params.stream = true;

      try {
        let d: Record<string, unknown>;
        if (params.stream) {
          // streaming 聚合（async 迭代）
          const stream = client.chat.completions.create(params as never) as unknown as AsyncIterable<{
            choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string | null; function?: { name?: string; arguments?: string } }[] } }[];
            model?: string;
          }>;
          let fullContent = '';
          const toolCallsData = new Map<number, { id: string; function: { name: string; arguments: string } }>();
          let finalModel = '';
          for await (const chunk of stream) {
            if (!chunk.choices || chunk.choices.length === 0) continue;
            const delta = chunk.choices[0].delta;
            if (delta?.content) fullContent += delta.content;
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!toolCallsData.has(idx)) {
                  toolCallsData.set(idx, { id: tc.id ?? `call_${idx}`, function: { name: '', arguments: '' } });
                }
                const item = toolCallsData.get(idx)!;
                if (tc.id) item.id = tc.id;
                if (tc.function?.name) item.function.name += tc.function.name;
                if (tc.function?.arguments) item.function.arguments += tc.function.arguments;
              }
            }
            if (chunk.model) finalModel = chunk.model;
          }
          const tcList = toolCallsData.size
            ? [...toolCallsData.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)
            : null;
          d = {
            id: '', choices: [{ message: { role: 'assistant', content: fullContent } }],
            created: 0, model: finalModel, object: 'chat.completion',
            usage: {}, system_fingerprint: null, moderation: null, service_tier: null,
          };
          if (tcList) (d['choices'] as { message: { tool_calls?: unknown } }[])[0].message.tool_calls = tcList;
        } else {
          const resp = await client.chat.completions.create(params as never);
          d = resp as unknown as Record<string, unknown>;
        }
        d['_model'] = model.name;
        d['_tried'] = tried;
        d['_fallback_used'] = i > 0;
        return d as unknown as LlmResponse;
      } catch (e) {
        const errMsg = String(e).slice(0, 80);
        tried.push([key, errMsg]);
        this._cooldown.set(key, now);
        lastError = errMsg;
        continue;
      }
    }

    return {
      choices: [{
        message: {
          role: 'assistant',
          content: `[多模型全部失败] 已尝试: ${tried.map(([k]) => k).join(' → ')}。最后错误: ${lastError}`,
        },
      }],
      usage: { total_tokens: 0 },
      _model: 'fallback-exhausted',
      _tried: tried,
      _fallback_used: true,
    };
  }

  /** 流式调用（聚合返回 async iterable，供 SSE 转发） */
  async streamLlm(
    agent: string,
    messages: unknown[],
    tools?: ToolDef[],
    modelOverride = '',
    stop?: string[],
  ): Promise<{ stream: AsyncIterable<unknown>; modelName: string; client: OpenAI } | null> {
    const primaryKey = modelOverride && this.allModels.has(modelOverride)
      ? modelOverride : this.getKey(agent);
    const model = this.allModels.get(primaryKey);
    if (!model) return null;
    const client = this._getClient(model.baseUrl, primaryKey);
    if (!client) return null;
    const params: Record<string, unknown> = {
      model: model.modelId,
      messages: messages.slice(-20) as never,
      max_tokens: 4096,
      stream: true,
    };
    if (tools) {
      params.tools = tools;
      params.tool_choice = 'auto';
    }
    if (stop) params.stop = stop;
    const stream = await client.chat.completions.create(params as never) as unknown as AsyncIterable<unknown>;
    return { stream, modelName: model.name, client };
  }

  // ── 展示 ──
  status(): string {
    return `模型池: ${this.allModels.size} 个模型 | 默认: ${this.default_key} | 全局Key: ${this._apiKey ? '已配置' : '未配置'}`;
  }

  toList(): { key: string; name: string; model_id: string; base_url: string; provider: string; description: string; custom: boolean; has_key: boolean }[] {
    const result = [];
    for (const [k, v] of this.allModels) {
      result.push({
        key: k, name: v.name, model_id: v.modelId,
        base_url: v.baseUrl, provider: v.provider,
        description: v.description, custom: v.custom,
        has_key: this.modelHasKey(k),
      });
    }
    return result;
  }

  providers(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const v of this.allModels.values()) {
      if (!seen.has(v.provider)) {
        seen.add(v.provider);
        result.push(v.provider);
      }
    }
    return result;
  }
}
