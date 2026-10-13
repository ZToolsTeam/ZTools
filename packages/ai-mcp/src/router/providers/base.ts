import {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelProviderConfig
} from '../../types/ai.js';

export class ModelProviderError extends Error {
  public statusCode?: number;
  public providerId: string;
  public retryable: boolean;

  constructor(message: string, providerId: string, statusCode?: number, retryable: boolean = true) {
    super(`[${providerId}] ${message}`);
    this.name = 'ModelProviderError';
    this.providerId = providerId;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class ModelTimeoutError extends ModelProviderError {
  constructor(providerId: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`, providerId, 408, true);
    this.name = 'ModelTimeoutError';
  }
}

export class ModelRateLimitError extends ModelProviderError {
  constructor(providerId: string, message: string = 'Rate limit exceeded (429)') {
    super(message, providerId, 429, true);
    this.name = 'ModelRateLimitError';
  }
}

export class ModelAuthError extends ModelProviderError {
  constructor(providerId: string, message: string = 'Authentication failed (401/403)') {
    super(message, providerId, 401, false);
    this.name = 'ModelAuthError';
  }
}

export abstract class BaseProvider {
  public readonly config: ModelProviderConfig;

  constructor(config: ModelProviderConfig) {
    this.config = config;
  }

  public get id(): string {
    return this.config.id;
  }

  public get name(): string {
    return this.config.name;
  }

  public abstract chat(request: ChatRequest): Promise<ChatResponse>;

  public abstract chatStream(request: ChatRequest): AsyncGenerator<ChatStreamChunk>;

  protected getTimeout(requestTimeout?: number): number {
    return requestTimeout ?? this.config.timeoutMs ?? 60000;
  }

  protected createAbortSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer)
    };
  }
}
