import { JsonRpcMessage } from '../../types/mcp.js';

export interface McpTransport {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
}
