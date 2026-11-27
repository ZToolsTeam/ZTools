import { JsonRpcMessage } from '../../types/mcp.js';
import { McpTransport } from './transport.js';
import { validateRemoteServiceUrl } from '../../security/url-guard.js';
import { AiMcpError } from '../../i18n.js';

export interface HttpSseTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * 是否允许访问非回环私有内网地址（默认 false）
   */
  allowPrivateNetwork?: boolean;
}

export class HttpSseTransport implements McpTransport {
  private url: string;
  private postUrl: string;
  private readonly origin: string;
  private readonly allowPrivateNetwork: boolean;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private connected: boolean = false;
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private abortController?: AbortController;

  constructor(options: HttpSseTransportOptions) {
    this.allowPrivateNetwork = options.allowPrivateNetwork === true;
    const parsed = validateRemoteServiceUrl(options.url, {
      allowPrivateNetwork: this.allowPrivateNetwork
    });
    this.origin = parsed.origin;
    this.url = parsed.toString().replace(/\/+$/, '');
    this.postUrl = this.url;
    this.headers = options.headers ? { ...options.headers } : {};
    this.timeoutMs = options.timeoutMs || 30000;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<void> {
    // 连接前再次校验 URL 安全策略
    validateRemoteServiceUrl(this.url, {
      allowPrivateNetwork: this.allowPrivateNetwork
    });

    this.connected = true;
    this.abortController = new AbortController();

    // 启动后台 SSE 监听 (如果服务端提供 SSE 端点)
    this.startSseListener().catch((err: unknown) => {
      if (!this.connected) return;
      if (err instanceof AiMcpError) {
        this.emitError(err);
      }
    });
  }

  /**
   * 校验 SSE 服务端下发的 endpoint 地址：必须通过 URL 安全校验且与基准地址严格同源，严防跨源/SSRF 跳转
   */
  private applySseEndpoint(rawEndpoint: string): void {
    let resolved: URL;
    try {
      resolved = new URL(rawEndpoint, `${this.url}/`);
    } catch {
      this.emitError(new AiMcpError('security.invalidUrl', { url: rawEndpoint }));
      return;
    }

    try {
      validateRemoteServiceUrl(resolved.toString(), {
        allowPrivateNetwork: this.allowPrivateNetwork
      });
    } catch (err: unknown) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (resolved.origin !== this.origin) {
      this.emitError(
        new AiMcpError('security.crossOriginRedirectBlocked', {
          endpoint: resolved.toString(),
          origin: this.origin
        })
      );
      return;
    }

    this.postUrl = resolved.toString();
  }

  /**
   * 校验响应最终 URL（如存在 HTTP 重定向），防止跨源/SSRF 跳转
   */
  private assertResponseOrigin(responseUrl: string): void {
    if (!responseUrl) return;
    const parsed = validateRemoteServiceUrl(responseUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork
    });
    if (parsed.origin !== this.origin) {
      throw new AiMcpError('security.crossOriginRedirectBlocked', {
        endpoint: parsed.toString(),
        origin: this.origin
      });
    }
  }

  private async startSseListener(): Promise<void> {
    try {
      const sseUrl = `${this.url}/sse`;
      const res = await fetch(sseUrl, {
        headers: {
          Accept: 'text/event-stream',
          ...this.headers
        },
        signal: this.abortController?.signal
      });

      this.assertResponseOrigin(res.url);

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let currentEvent = '';

      try {
        while (this.connected) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const trimmed = rawLine.replace(/\r$/, '').trim();
            if (!trimmed) {
              currentEvent = '';
              continue;
            }
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim();
              continue;
            }
            if (trimmed.startsWith('data:')) {
              const payloadStr = trimmed.slice(5).trim();
              if (currentEvent === 'endpoint') {
                this.applySseEndpoint(payloadStr);
                continue;
              }
              try {
                const parsed = JSON.parse(payloadStr) as JsonRpcMessage;
                this.emitMessage(parsed);
              } catch (parseErr: unknown) {
                void parseErr;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: unknown) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      if (this.connected && errorObj.name !== 'AbortError') {
        this.emitError(errorObj);
      }
    }
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('HttpSseTransport is not connected');
    }

    // 发送前再次确认目标地址合法且同源
    const targetUrl = validateRemoteServiceUrl(this.postUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork
    });
    if (targetUrl.origin !== this.origin) {
      throw new AiMcpError('security.crossOriginRedirectBlocked', {
        endpoint: targetUrl.toString(),
        origin: this.origin
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });

      clearTimeout(timer);
      this.assertResponseOrigin(res.url);

      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }

      // 很多 MCP HTTP 服务在 POST 响应中直接返回结果
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json() as JsonRpcMessage;
        this.emitMessage(data);
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      const errorObj = err instanceof Error ? err : new Error(String(err));
      this.emitError(errorObj);
      throw errorObj;
    }
  }

  public async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (handlerErr: unknown) {
        void handlerErr;
      }
    }
  }

  public onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  public onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private emitMessage(msg: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch (err: unknown) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err);
      } catch (handlerErr: unknown) {
        void handlerErr;
      }
    }
  }
}
