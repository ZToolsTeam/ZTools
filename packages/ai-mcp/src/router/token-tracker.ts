import { TokenUsage, ModelMetrics } from '../types/ai.js';

export interface ProviderTokenStats {
  requests: number;
  tokens: TokenUsage;
  totalLatencyMs: number;
  averageLatencyMs: number;
}

export class TokenTracker {
  private stats: Map<string, ProviderTokenStats> = new Map();
  private totalRequests: number = 0;
  private successfulRequests: number = 0;
  private failedRequests: number = 0;
  private fallbackCount: number = 0;
  private totalLatencyMs: number = 0;
  private totalTokens: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };

  /**
   * 启发式分词与 Token 估算器 (跨中英文、代码混合)
   */
  public static estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    let tokens = 0;
    // 匹配 CJK 字符（汉字、日韩文字等）
    const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
    const cjkMatches = text.match(cjkRegex);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    // 移除 CJK 字符后处理非 CJK 文本
    const nonCjkText = text.replace(cjkRegex, ' ');
    // 按照空白与标点符号拆分英文单词/符号
    const words = nonCjkText.trim().split(/\s+/).filter(Boolean);

    // CJK 每个字符按 ~1.3 个 Token 估算
    tokens += Math.ceil(cjkCount * 1.3);

    // 英文按平均 ~1.3 token / word 估算，或每 4 个英文字符 ~1 token
    let nonCjkTokens = 0;
    for (const word of words) {
      nonCjkTokens += Math.max(1, Math.ceil(word.length / 3.8));
    }
    tokens += nonCjkTokens;

    return Math.max(1, tokens);
  }

  /**
   * 记录一次模型调用的 Token 用量
   */
  public recordUsage(
    providerId: string,
    usage: TokenUsage,
    latencyMs: number = 0,
    success: boolean = true
  ): void {
    this.totalRequests++;
    if (success) {
      this.successfulRequests++;
    } else {
      this.failedRequests++;
    }

    this.totalLatencyMs += latencyMs;
    this.totalTokens.promptTokens += usage.promptTokens;
    this.totalTokens.completionTokens += usage.completionTokens;
    this.totalTokens.reasoningTokens = (this.totalTokens.reasoningTokens || 0) + (usage.reasoningTokens || 0);
    this.totalTokens.totalTokens += usage.totalTokens;

    const current = this.stats.get(providerId) || {
      requests: 0,
      tokens: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      totalLatencyMs: 0,
      averageLatencyMs: 0
    };

    current.requests++;
    current.totalLatencyMs += latencyMs;
    current.averageLatencyMs = Math.round(current.totalLatencyMs / current.requests);
    current.tokens.promptTokens += usage.promptTokens;
    current.tokens.completionTokens += usage.completionTokens;
    current.tokens.reasoningTokens = (current.tokens.reasoningTokens || 0) + (usage.reasoningTokens || 0);
    current.tokens.totalTokens += usage.totalTokens;

    this.stats.set(providerId, current);
  }

  /**
   * 记录一次错误降级触发
   */
  public recordFallback(): void {
    this.fallbackCount++;
  }

  /**
   * 获取全局指标
   */
  public getMetrics(): ModelMetrics {
    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      fallbackCount: this.fallbackCount,
      totalTokens: { ...this.totalTokens },
      averageLatencyMs: this.totalRequests > 0 ? Math.round(this.totalLatencyMs / this.totalRequests) : 0
    };
  }

  /**
   * 获取指定 Provider 的用量统计
   */
  public getProviderStats(providerId: string): ProviderTokenStats | undefined {
    const stats = this.stats.get(providerId);
    if (!stats) return undefined;
    return {
      ...stats,
      tokens: { ...stats.tokens }
    };
  }

  /**
   * 获取所有 Provider 统计
   */
  public getAllStats(): Record<string, ProviderTokenStats> {
    const result: Record<string, ProviderTokenStats> = {};
    for (const [key, value] of this.stats.entries()) {
      result[key] = {
        ...value,
        tokens: { ...value.tokens }
      };
    }
    return result;
  }

  /**
   * 重置所有统计
   */
  public reset(): void {
    this.stats.clear();
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.fallbackCount = 0;
    this.totalLatencyMs = 0;
    this.totalTokens = {
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    };
  }
}
