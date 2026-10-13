import {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelProviderConfig,
  TokenUsage
} from '../../types/ai.js';
import {
  BaseProvider,
  ModelAuthError,
  ModelProviderError,
  ModelRateLimitError,
  ModelTimeoutError
} from './base.js';
import { TokenTracker } from '../token-tracker.js';

export class ClaudeProvider extends BaseProvider {
  constructor(config: ModelProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.anthropic.com/v1',
      defaultModel: config.defaultModel || 'claude-3-5-sonnet-20241022'
    });
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...this.config.headers
    };

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    return headers;
  }

  private formatRequestBody(request: ChatRequest, stream: boolean): any {
    const model = request.model || this.config.defaultModel || 'claude-3-5-sonnet-20241022';

    // 提取系统提示词
    let systemPrompt = request.system || '';
    const messages: Array<{ role: 'user' | 'assistant'; content: any }> = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${msg.content}` : msg.content;
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      } else if (msg.role === 'tool') {
        // Claude 工具返回格式：tool_result block
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId || 'call_0',
              content: msg.content
            }
          ]
        });
      }
    }

    const body: Record<string, any> = {
      model,
      messages,
      max_tokens: request.maxTokens || 4096,
      stream
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.stop) {
      body.stop_sequences = request.stop;
    }

    // 适配 Claude 工具格式
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        name: t.function.name,
        description: t.function.description || '',
        input_schema: t.function.parameters || { type: 'object', properties: {} }
      }));
    }

    return body;
  }

  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const timeoutMs = this.getTimeout(request.timeoutMs);
    const { signal, cleanup } = this.createAbortSignal(timeoutMs);
    const startTime = Date.now();

    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;
    const payload = this.formatRequestBody(request, false);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal
      });

      cleanup();
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = await response.json() as any;

      let textContent = '';
      const toolCalls: any[] = [];

      if (Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text') {
            textContent += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {})
              }
            });
          }
        }
      }

      const usage: TokenUsage = data.usage
        ? {
            promptTokens: data.usage.input_tokens || 0,
            completionTokens: data.usage.output_tokens || 0,
            totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
          }
        : {
            promptTokens: TokenTracker.estimateTokens(request.messages.map(m => m.content).join('\n')),
            completionTokens: TokenTracker.estimateTokens(textContent),
            totalTokens: 0
          };
      if (!data.usage) {
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }

      return {
        id: data.id || `resp-${Date.now()}`,
        model: data.model || payload.model,
        provider: this.id,
        message: {
          role: 'assistant',
          content: textContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined
        },
        finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : data.stop_reason || 'stop',
        usage,
        latencyMs
      };
    } catch (err: any) {
      cleanup();
      if (err.name === 'AbortError') {
        throw new ModelTimeoutError(this.id, timeoutMs);
      }
      if (err instanceof ModelProviderError) {
        throw err;
      }
      throw new ModelProviderError(err.message || String(err), this.id, undefined, true);
    }
  }

  public async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const timeoutMs = this.getTimeout(request.timeoutMs);
    const { signal, cleanup } = this.createAbortSignal(timeoutMs);

    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;
    const payload = this.formatRequestBody(request, true);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal
      });
    } catch (err: any) {
      cleanup();
      if (err.name === 'AbortError') {
        throw new ModelTimeoutError(this.id, timeoutMs);
      }
      throw new ModelProviderError(err.message || String(err), this.id, undefined, true);
    }

    if (!response.ok) {
      cleanup();
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      cleanup();
      throw new ModelProviderError('Response body is empty', this.id, response.status, false);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let currentInputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const event = JSON.parse(jsonStr);

              if (event.type === 'message_start' && event.message?.usage) {
                currentInputTokens = event.message.usage.input_tokens || 0;
              }

              if (event.type === 'content_block_delta') {
                if (event.delta?.type === 'text_delta') {
                  yield {
                    id: event.message?.id || `chunk-${Date.now()}`,
                    model: payload.model,
                    provider: this.id,
                    delta: {
                      role: 'assistant',
                      content: event.delta.text
                    },
                    finishReason: null
                  };
                }
              }

              if (event.type === 'message_delta') {
                const stopReason = event.delta?.stop_reason;
                const outputTokens = event.usage?.output_tokens || 0;

                yield {
                  id: `chunk-${Date.now()}`,
                  model: payload.model,
                  provider: this.id,
                  delta: {},
                  finishReason: stopReason === 'tool_use' ? 'tool_calls' : stopReason || 'stop',
                  usage: {
                    promptTokens: currentInputTokens,
                    completionTokens: outputTokens,
                    totalTokens: currentInputTokens + outputTokens
                  }
                };
              }
            } catch {
              // 忽略残缺行
            }
          }
        }
      }
    } finally {
      cleanup();
      reader.releaseLock();
    }
  }

  private async handleErrorResponse(response: Response): Promise<never> {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      errorText = response.statusText;
    }

    if (response.status === 401 || response.status === 403) {
      throw new ModelAuthError(this.id, `Authentication error (${response.status}): ${errorText}`);
    }
    if (response.status === 429) {
      throw new ModelRateLimitError(this.id, `Rate limit exceeded (429): ${errorText}`);
    }

    throw new ModelProviderError(
      `API error (${response.status}): ${errorText}`,
      this.id,
      response.status,
      response.status >= 500
    );
  }
}
