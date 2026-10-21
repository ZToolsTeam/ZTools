import {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelProviderConfig,
  TokenUsage,
  ToolCall
} from '../../types/ai.js';
import { BaseProvider } from './base.js';
import { TokenTracker } from '../token-tracker.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessageItem {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponsePayload {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
    };
  };
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: {
    output_tokens?: number;
  };
}

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

  private formatRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const model = request.model || this.config.defaultModel || 'claude-3-5-sonnet-20241022';

    // 提取系统提示词
    let systemPrompt = request.system || '';
    const messages: AnthropicMessageItem[] = [];

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = systemPrompt ? `${systemPrompt}\n${msg.content}` : msg.content;
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const blocks: AnthropicContentBlock[] = [];
          if (msg.content) {
            blocks.push({ type: 'text', text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            let parsedInput: Record<string, unknown> = {};
            if (typeof tc.function?.arguments === 'string' && tc.function.arguments.trim()) {
              try {
                parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                parsedInput = {};
              }
            }
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parsedInput
            });
          }
          messages.push({
            role: 'assistant',
            content: blocks
          });
        } else {
          messages.push({
            role: 'assistant',
            content: msg.content
          });
        }
      } else if (msg.role === 'user') {
        messages.push({
          role: 'user',
          content: msg.content
        });
      } else if (msg.role === 'tool') {
        const toolResultBlock: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId || 'call_0',
          content: msg.content
        };
        const prev = messages[messages.length - 1];
        if (
          prev &&
          prev.role === 'user' &&
          Array.isArray(prev.content) &&
          prev.content.every(b => b.type === 'tool_result')
        ) {
          prev.content.push(toolResultBlock);
        } else {
          messages.push({
            role: 'user',
            content: [toolResultBlock]
          });
        }
      }
    }

    const body: Record<string, unknown> = {
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
    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;
    const payload = this.formatRequestBody(request, false);

    const { data, latencyMs } = await this.postJsonRequest<AnthropicResponsePayload>(
      url,
      this.getHeaders(),
      payload,
      timeoutMs
    );

    let textContent = '';
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          textContent += block.text;
        } else if (block.type === 'tool_use' && block.id && block.name) {
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
      model: data.model || String(payload.model),
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
  }

  public async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const timeoutMs = this.getTimeout(request.timeoutMs);
    const baseUrl = this.config.baseUrl!.replace(/\/+$/, '');
    const url = `${baseUrl}/messages`;
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
              const event = JSON.parse(jsonStr) as AnthropicStreamEvent;

              if (event.type === 'message_start' && event.message?.usage) {
                currentInputTokens = event.message.usage.input_tokens || 0;
              }

              if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                const block = event.content_block;
                const initialArgs =
                  block.input && typeof block.input === 'object' && Object.keys(block.input).length > 0
                    ? JSON.stringify(block.input)
                    : '';
                yield {
                  id: event.message?.id || `chunk-${Date.now()}`,
                  model: modelName,
                  provider: this.id,
                  delta: {
                    role: 'assistant',
                    toolCalls: [
                      {
                        index: typeof event.index === 'number' ? event.index : 0,
                        id: block.id,
                        type: 'function',
                        function: {
                          name: block.name,
                          arguments: initialArgs
                        }
                      }
                    ]
                  },
                  finishReason: null
                };
              }

              if (event.type === 'content_block_delta') {
                if (event.delta?.type === 'text_delta') {
                  yield {
                    id: event.message?.id || `chunk-${Date.now()}`,
                    model: modelName,
                    provider: this.id,
                    delta: {
                      role: 'assistant',
                      content: event.delta.text
                    },
                    finishReason: null
                  };
                } else if (event.delta?.type === 'input_json_delta') {
                  yield {
                    id: event.message?.id || `chunk-${Date.now()}`,
                    model: modelName,
                    provider: this.id,
                    delta: {
                      toolCalls: [
                        {
                          index: typeof event.index === 'number' ? event.index : 0,
                          function: {
                            arguments: event.delta.partial_json || ''
                          }
                        }
                      ]
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
                  model: modelName,
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
    } catch (err: unknown) {
      this.mapRequestError(err, timeoutMs);
    } finally {
      cleanup();
      reader.releaseLock();
    }
  }
}
