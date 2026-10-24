import {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelMetrics,
  ModelProviderConfig,
  ModelRouterOptions,
  SniffOptions,
  SniffResult
} from '../types/ai.js';
import { BaseProvider, ModelProviderError } from './providers/base.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import { ClaudeProvider } from './providers/claude.js';
import { TokenTracker } from './token-tracker.js';
import { PromptTemplateManager } from './prompt-manager.js';
import { sniffLocalProviders, createLocalProviderConfig } from './local-sniffer.js';

export class ModelRouterError extends Error {
  public failedAttempts: Array<{ providerId: string; error: string }>;

  constructor(message: string, failedAttempts: Array<{ providerId: string; error: string }> = []) {
    super(message);
    this.name = 'ModelRouterError';
    this.failedAttempts = failedAttempts;
  }
}

export class ModelRouter {
  private providers: Map<string, BaseProvider> = new Map();
  private defaultProviderId?: string;
  private fallbackChain: string[] = [];
  public readonly tokens: TokenTracker;
  public readonly prompts: PromptTemplateManager;

  constructor(options: ModelRouterOptions = {}) {
    this.tokens = new TokenTracker();
    this.prompts = new PromptTemplateManager();
    this.defaultProviderId = options.defaultProvider;
    this.fallbackChain = options.fallbackProviders ? [...options.fallbackProviders] : [];
  }

  /**
   * 注册大模型 Provider (BYOK)
   */
  public registerProvider(config: ModelProviderConfig): BaseProvider {
    if (!config.id) {
      throw new Error('Provider config must have an id');
    }

    let provider: BaseProvider;
    if (config.type === 'claude') {
      provider = new ClaudeProvider(config);
    } else {
      provider = new OpenAiCompatibleProvider(config);
    }

    this.providers.set(config.id, provider);

    // 如果未设置默认 Provider，首个注册的设为默认
    if (!this.defaultProviderId) {
      this.defaultProviderId = config.id;
    }

    return provider;
  }

  /**
   * 注销 Provider
   */
  public unregisterProvider(id: string): boolean {
    const deleted = this.providers.delete(id);
    if (this.defaultProviderId === id) {
      const first = this.providers.keys().next().value;
      this.defaultProviderId = first || undefined;
    }
    this.fallbackChain = this.fallbackChain.filter(pId => pId !== id);
    return deleted;
  }

  /**
   * 获取 Provider 实例
   */
  public getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * 列出所有已注册的 Provider 配置
   */
  public listProviders(): ModelProviderConfig[] {
    return Array.from(this.providers.values()).map(p => ({ ...p.config }));
  }

  /**
   * 设置默认 Provider
   */
  public setDefaultProvider(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Provider "${id}" is not registered`);
    }
    this.defaultProviderId = id;
  }

  /**
   * 获取当前默认 Provider ID
   */
  public getDefaultProviderId(): string | undefined {
    return this.defaultProviderId;
  }

  /**
   * 设置错误降级链 (Fallback Chain)
   */
  public setFallbackChain(providerIds: string[]): void {
    this.fallbackChain = [...providerIds];
  }

  /**
   * 获取当前错误降级链
   */
  public getFallbackChain(): string[] {
    return [...this.fallbackChain];
  }

  /**
   * 自动探测本地模型服务并自动注册
   */
  public async autoDetectLocalProviders(options?: SniffOptions): Promise<SniffResult> {
    const result = await sniffLocalProviders(options);

    for (const online of result.allOnline) {
      const config = createLocalProviderConfig(online);
      this.registerProvider(config);
    }

    return result;
  }

  /**
   * 解析候选 Provider 执行列表（主 Provider + 降级链）
   */
  private resolveProviderChain(requestedProviderId?: string): BaseProvider[] {
    const primaryId = requestedProviderId || this.defaultProviderId;
    if (!primaryId) {
      throw new Error('No AI provider registered or selected');
    }

    const primary = this.providers.get(primaryId);
    if (!primary) {
      throw new Error(`Primary provider "${primaryId}" not found`);
    }

    const chain: BaseProvider[] = [primary];

    for (const fallbackId of this.fallbackChain) {
      if (fallbackId !== primaryId && this.providers.has(fallbackId)) {
        chain.push(this.providers.get(fallbackId)!);
      }
    }

    return chain;
  }

  /**
   * 非流式对话：支持自动重试与错误降级
   */
  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const chain = this.resolveProviderChain(request.provider);
    const failedAttempts: Array<{ providerId: string; error: string }> = [];

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isFallback = i > 0;

      if (isFallback) {
        this.tokens.recordFallback();
      }

      const startTime = Date.now();
      try {
        const response = await provider.chat(request);

        // 记录 Token
        if (response.usage) {
          this.tokens.recordUsage(provider.id, response.usage, response.latencyMs || Date.now() - startTime, true);
        }

        return response;
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        failedAttempts.push({ providerId: provider.id, error: errorMsg });

        this.tokens.recordUsage(
          provider.id,
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs,
          false
        );

        // 如果不可重试且并非最后一个，是否跳过取决于策略；此处在 fallback 列表中继续尝试备选
        const canRetry = !(err instanceof ModelProviderError) || err.retryable || i < chain.length - 1;
        if (!canRetry) {
          throw err;
        }
      }
    }

    throw new ModelRouterError(
      `All providers in chain failed: ${failedAttempts.map(a => `${a.providerId} (${a.error})`).join('; ')}`,
      failedAttempts
    );
  }

  /**
   * 流式对话：支持首字节前错误降级
   */
  public async *chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const chain = this.resolveProviderChain(request.provider);
    const failedAttempts: Array<{ providerId: string; error: string }> = [];

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      const isFallback = i > 0;

      if (isFallback) {
        this.tokens.recordFallback();
      }

      let hasYielded = false;
      const startTime = Date.now();
      let lastUsage = undefined;

      try {
        const stream = provider.chatStream(request);

        for await (const chunk of stream) {
          hasYielded = true;
          if (chunk.usage) {
            lastUsage = chunk.usage;
          }
          yield chunk;
        }

        const latencyMs = Date.now() - startTime;
        if (lastUsage) {
          this.tokens.recordUsage(provider.id, lastUsage, latencyMs, true);
        }

        return;
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);
        failedAttempts.push({ providerId: provider.id, error: errorMsg });

        this.tokens.recordUsage(
          provider.id,
          { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs,
          false
        );

        // 如果已经输出过 Chunk，则无法静默降级（防止输出混乱拼接），直接向上抛出
        if (hasYielded) {
          throw err;
        }

        // 尚未输出 Chunk 时，继续尝试下一个降级 Provider
      }
    }

    throw new ModelRouterError(
      `All stream providers failed: ${failedAttempts.map(a => `${a.providerId} (${a.error})`).join('; ')}`,
      failedAttempts
    );
  }

  /**
   * 极简单行问答封装
   */
  public async quickChat(prompt: string, options: Partial<ChatRequest> = {}): Promise<string> {
    const res = await this.chat({
      ...options,
      messages: [{ role: 'user', content: prompt }]
    });
    return res.message.content;
  }

  /**
   * 获取聚合指标
   */
  public getMetrics(): ModelMetrics {
    return this.tokens.getMetrics();
  }
}
