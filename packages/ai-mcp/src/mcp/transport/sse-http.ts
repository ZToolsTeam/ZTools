import { JsonRpcMessage } from '../../types/mcp.js';
import { McpTransport } from './transport.js';

export interface HttpSseTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpSseTransport implements McpTransport {
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private connected: boolean = false;
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private abortController?: AbortController;

  constructor(options: HttpSseTransportOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.headers = options.headers || {};
    this.timeoutMs = options.timeoutMs || 30000;
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<void> {
    this.connected = true;
    this.abortController = new AbortController();

    // 启动后台 SSE 监听 (如果服务端提供 SSE 端点)
    this.startSseListener().catch((err) => {
      // 如果仅支持纯 HTTP POST，静默降级
      if (!this.connected) return;
    });
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

      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (this.connected) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(trimmed.slice(6));
              this.emitMessage(parsed);
            } catch {}
          }
        }
      }
    } catch (err: any) {
      if (this.connected && err.name !== 'AbortError') {
        this.emitError(err);
      }
    }
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('HttpSseTransport is not connected');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.headers
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }

      // 很多 MCP HTTP 服务在 POST 响应中直接返回结果
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json() as JsonRpcMessage;
        this.emitMessage(data);
      }
    } catch (err: any) {
      clearTimeout(timer);
      this.emitError(err);
      throw err;
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
      } catch {}
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
      } catch (err: any) {
        this.emitError(err);
      }
    }
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err);
      } catch {}
    }
  }
}
