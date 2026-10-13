/**
 * ZTools AI Native - 统一大模型路由与 BYOK 类型定义
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  provider?: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  system?: string;
  timeoutMs?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: string;
  message: ChatMessage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | string;
  usage?: TokenUsage;
  latencyMs?: number;
}

export interface StreamDelta {
  role?: string;
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface ChatStreamChunk {
  id: string;
  model: string;
  provider: string;
  delta: StreamDelta;
  finishReason?: string | null;
  usage?: TokenUsage;
}

export type ModelProviderType =
  | 'openai'
  | 'deepseek'
  | 'claude'
  | 'siliconflow'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export interface ModelProviderConfig {
  id: string;
  name: string;
  type: ModelProviderType;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface SniffedLocalProvider {
  type: 'ollama' | 'lmstudio';
  url: string;
  online: boolean;
  version?: string;
  latencyMs?: number;
  models: string[];
  error?: string;
}

export interface SniffOptions {
  ollamaUrl?: string;
  lmStudioUrl?: string;
  timeoutMs?: number;
}

export interface SniffResult {
  ollama: SniffedLocalProvider;
  lmStudio: SniffedLocalProvider;
  allOnline: SniffedLocalProvider[];
}

export interface PromptTemplate {
  name: string;
  description?: string;
  template: string;
  variables: string[];
  defaultValues?: Record<string, string>;
  systemPrompt?: string;
}

export interface ModelRouterOptions {
  defaultProvider?: string;
  fallbackProviders?: string[];
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ModelMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  fallbackCount: number;
  totalTokens: TokenUsage;
  averageLatencyMs: number;
}
