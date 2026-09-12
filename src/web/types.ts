// ========== 前端共享类型 ==========

export interface ModelItem {
  key: string;
  name: string;
  provider: string;
  model_id: string;
  base_url?: string;
  description?: string;
  has_key?: boolean;
  custom?: boolean;
}

export interface ChatResponse {
  ok?: boolean;
  reply?: string;
  agent?: string;
  dispatched_to?: string;
  session_id?: string;
  thinking?: ThinkingStep[];
  cmd?: boolean;
  model?: string;
  error?: string;
}

export interface ThinkingStep {
  round: number;
  tool?: string;
  thought?: string;
}

export interface MemoryEntry {
  rel: string;
  size: number;
}

export interface SkillItem {
  id: number | string;
  name: string;
  agent: string;
  content?: string;
}

export interface ToolInfo {
  available: boolean;
  path?: string;
  install_hint?: string;
}

export interface WorkflowNode {
  id: string;
  action: string;
  label: string;
  x: number;
  y: number;
  params: Record<string, string>;
}

export interface WFTrigger {
  type: string;
  keywords?: string[];
  mode?: string;
  prefix?: string;
  pattern?: string;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: WFTrigger;
  steps: { action: string; params: Record<string, string> }[];
  enabled: boolean;
}

export type WorkflowItem = Workflow;

export interface RestoredMsg {
  r: 'user' | 'agent' | 'system';
  a?: string;
  c: string;
  /** 思考链 HTML（agent-think-slot 内 details.thinking-chain），用于重新进入页面后恢复"思考过程"按钮与内容 */
  t?: string;
}

export interface TokenStats {
  ok?: boolean;
  hit_rate: string | number;
  total: { prompt_tokens: number; completion_tokens: number; calls: number };
  by_agent: Record<string, { prompt_tokens: number; cached_tokens: number; completion_tokens: number; calls: number }>;
  tokens_per_minute: number;
  budget?: { remaining: number; used: number; limit: number };
  timeline?: { ts: number; prompt: number; cached: number; completion: number }[];
}
