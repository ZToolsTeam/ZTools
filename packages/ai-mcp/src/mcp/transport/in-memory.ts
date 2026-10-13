import { JsonRpcMessage } from '../../types/mcp.js';
import { McpTransport } from './transport.js';

export class InMemoryTransport implements McpTransport {
  private peer?: InMemoryTransport;
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private connected: boolean = false;

  public get isConnected(): boolean {
    return this.connected;
  }

  /**
   * 创建一对相连的内存 Transport (Client & Server)
   */
  public static createPair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (!this.connected) {
      throw new Error('Transport is not connected');
    }
    if (!this.peer || !this.peer.connected) {
      throw new Error('Peer transport is not connected');
    }

    // 复制消息避免对象共享污染
    const cloned = JSON.parse(JSON.stringify(message)) as JsonRpcMessage;
    // 异步派发保证非重入
    queueMicrotask(() => {
      if (this.peer && this.peer.connected) {
        this.peer.receive(cloned);
      }
    });
  }

  public receive(message: JsonRpcMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (err: any) {
        this.emitError(err);
      }
    }
  }

  public async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
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

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err);
      } catch {}
    }
  }
}
