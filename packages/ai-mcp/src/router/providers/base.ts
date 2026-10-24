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

  protected mapRequestError(err: unknown, timeoutMs: number): never {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ModelTimeoutError(this.id, timeoutMs);
    }
    if (err instanceof ModelProviderError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ModelProviderError(msg, this.id, undefined, true);
  }

  protected async postJsonRequest<T>(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
    timeoutMs: number
  ): Promise<{ data: T; status: number; latencyMs: number }> {
    const { signal, cleanup } = this.createAbortSignal(timeoutMs);
    const startTime = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal
      });

      cleanup();
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = (await response.json()) as T;
      return { data, status: response.status, latencyMs };
    } catch (err: unknown) {
      cleanup();
      this.mapRequestError(err, timeoutMs);
    }
  }

  protected async openStreamResponse(
    url: string,
    headers: Record<string, string>,
    payload: unknown,
    timeoutMs: number
  ): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>;
    cleanup: () => void;
  }> {
    const { signal, cleanup } = this.createAbortSignal(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal
      });
    } catch (err: unknown) {
      cleanup();
      this.mapRequestError(err, timeoutMs);
    }

    if (!response.ok) {
      cleanup();
      await this.handleErrorResponse(response);
    }

    if (!response.body) {
      cleanup();
      throw new ModelProviderError('Response body is empty', this.id, response.status, false);
    }

    return {
      reader: response.body.getReader(),
      cleanup
    };
  }

  protected async handleErrorResponse(response: Response): Promise<never> {
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
