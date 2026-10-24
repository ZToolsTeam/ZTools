import {
  ChatRole,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelProviderConfig,
  StreamDelta,
  TokenUsage,
  ToolCall
} from '../../types/ai.js';
import {
  BaseProvider,
  ModelProviderError
} from './base.js';
import { TokenTracker } from '../token-tracker.js';

interface OpenAiResponsePayload {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: ChatRole;
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCall[];
    };
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: StreamDelta['toolCalls'];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

export class OpenAiCompatibleProvider extends BaseProvider {
  constructor(config: ModelProviderConfig) {
    const defaultBaseUrl = OpenAiCompatibleProvider.getDefaultBaseUrl(config);
    super({
      ...config,
      baseUrl: config.baseUrl || defaultBaseUrl,
      defaultModel: config.defaultModel || OpenAiCompatibleProvider.getDefaultModel(config)
    });
  }

  private static getDefaultBaseUrl(config: ModelProviderConfig): string {
    switch (config.type) {
      case 'deepseek':
        return 'https://api.deepseek.com';
      case 'siliconflow':
        return 'https://api.siliconflow.cn/v1';
      case 'ollama':
        return 'http://127.0.0.1:11434/v1';
      case 'lmstudio':
        return 'http://127.0.0.1:1234/v1';
      case 'openai':
      default:
        return 'https://api.openai.com/v1';
    }
  }

  private static getDefaultModel(config: ModelProviderConfig): string {
    switch (config.type) {
      case 'deepseek':
        return 'deepseek-chat';
      case 'siliconflow':
        return 'deepseek-ai/DeepSeek-V3';
      case 'ollama':
        return 'llama3:latest';
      case 'lmstudio':
        return 'default';
      case 'openai':
      default:
        return 'gpt-4o';
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  private formatRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const model = request.model || this.config.defaultModel || 'gpt-4o';
    const messages = [...request.messages];

    // 如果 request.system 单独指定且 messages 开头没有 system 消息，自动插入
    if (request.system && !messages.some(m => m.role === 'system')) {
      messages.unshift({
        role: 'system',
        content: request.system
      });
    }

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => {
        const item: Record<string, unknown> = {
          role: m.role,
          content: m.content
        };
        if (m.name) item.name = m.name;
        if (m.toolCalls) item.tool_calls = m.toolCalls;
        if (m.toolCallId) item.tool_call_id = m.toolCallId;
        return item;
      }),
      stream
    };

    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.stop) body.stop = request.stop;
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.toolChoice) body.tool_choice = request.toolChoice;

    return body;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const timeoutMs = this.getTimeout(request.timeoutMs);
    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const payload = this.formatRequestBody(request, false);

    const { data, status, latencyMs } = await this.postJsonRequest<OpenAiResponsePayload>(
      url,
      this.getHeaders(),
      payload,
      timeoutMs
    );

    const choice = data.choices?.[0];
    if (!choice) {
      throw new ModelProviderError('No choice returned from model provider', this.id, status, false);
    }

    const rawMsg = choice.message || {};

    const usage: TokenUsage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens || 0,
          completionTokens: data.usage.completion_tokens || 0,
          reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
          totalTokens: data.usage.total_tokens || 0
        }
      : {
          promptTokens: TokenTracker.estimateTokens(request.messages.map(m => m.content).join('\n')),
          completionTokens: TokenTracker.estimateTokens(rawMsg.content || ''),
          totalTokens: 0
        };
    if (!data.usage) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
    }

    return {
      id: data.id || `resp-${Date.now()}`,
      model: data.model || String(payload.model),
      provider: this.id,
      message: {
        role: rawMsg.role || 'assistant',
        content: rawMsg.content || '',
        toolCalls: rawMsg.tool_calls
      },
      finishReason: choice.finish_reason || 'stop',
      usage,
      latencyMs
    };
  }

  public async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const timeoutMs = this.getTimeout(request.timeoutMs);
    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const payload = this.formatRequestBody(request, true);
    const modelName = String(payload.model);

    const { reader, cleanup } = await this.openStreamResponse(
      url,
      this.getHeaders(),
      payload,
      timeoutMs
    );

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // 忽略心跳/空行

          if (trimmed === 'data: [DONE]') {
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const data = JSON.parse(jsonStr) as OpenAiResponsePayload;
              const choice = data.choices?.[0];
              if (!choice) continue;

              const delta = choice.delta || {};
              const chunk: ChatStreamChunk = {
                id: data.id || `chunk-${Date.now()}`,
                model: data.model || modelName,
                provider: this.id,
                delta: {
                  role: delta.role,
                  content: delta.content,
                  reasoningContent: delta.reasoning_content,
                  toolCalls: delta.tool_calls
                },
                finishReason: choice.finish_reason || null
              };

              if (data.usage) {
                chunk.usage = {
                  promptTokens: data.usage.prompt_tokens || 0,
                  completionTokens: data.usage.completion_tokens || 0,
                  reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens || 0,
                  totalTokens: data.usage.total_tokens || 0
                };
              }

              yield chunk;
            } catch {
              // 忽略单个残缺块解析错误
            }
          }
        }
      }
    } catch (err: unknown) {
      this.mapRequestError(err, timeoutMs);
    } finally {
      cleanup();
      reader.releaseLock();
    }
  }
}
