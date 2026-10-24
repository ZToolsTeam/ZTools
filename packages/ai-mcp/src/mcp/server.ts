import {
  JsonRpcMessage,
  JsonRpcRequest,
  McpErrorCode,
  McpImplementationInfo,
  McpInitializeParams,
  McpInitializeResult,
  McpServerCapabilities,
  McpTool,
  McpToolHandler,
  MCP_PROTOCOL_VERSION
} from '../types/mcp.js';
import {
  createJsonRpcError,
  createJsonRpcNotification,
  createJsonRpcResponse,
  isJsonRpcNotification,
  isJsonRpcRequest
} from './protocol.js';
import { McpToolRegistry } from './registry.js';
import { McpTransport } from './transport/transport.js';

export interface McpServerOptions {
  name?: string;
  version?: string;
  capabilities?: McpServerCapabilities;
}

export class McpServer {
  public readonly info: McpImplementationInfo;
  public readonly registry: McpToolRegistry;
  private capabilities: McpServerCapabilities;
  private transport?: McpTransport;
  private initialized: boolean = false;

  constructor(options: McpServerOptions = {}) {
    this.info = {
      name: options.name || 'ztools-mcp-server',
      version: options.version || '1.0.0'
    };
    this.capabilities = {
      tools: { listChanged: true },
      ...options.capabilities
    };
    this.registry = new McpToolRegistry();
  }

  public registerTool(tool: McpTool, handler: McpToolHandler): void {
    this.registry.registerTool(tool, handler);
  }

  public async connect(transport: McpTransport): Promise<void> {
    this.transport = transport;
    transport.onMessage(async (msg: JsonRpcMessage) => {
      await this.handleMessage(msg);
    });

    if (!transport.isConnected) {
      await transport.connect();
    }
  }

  public async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = undefined;
    }
    this.initialized = false;
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (isJsonRpcNotification(msg)) {
      if (msg.method === 'notifications/initialized') {
        this.initialized = true;
      }
      return;
    }

    if (!isJsonRpcRequest(msg)) {
      return;
    }

    const req = msg as JsonRpcRequest;
    try {
      const response = await this.dispatchRequest(req);
      if (this.transport && this.transport.isConnected) {
        await this.transport.send(response);
      }
    } catch (err: any) {
      if (this.transport && this.transport.isConnected) {
        await this.transport.send(
          createJsonRpcError(req.id, McpErrorCode.InternalError, err.message || String(err))
        );
      }
    }
  }

  private async dispatchRequest(req: JsonRpcRequest): Promise<any> {
    switch (req.method) {
      case 'initialize': {
        const params = req.params as McpInitializeParams;
        const result: McpInitializeResult = {
          protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: this.capabilities,
          serverInfo: this.info
        };
        return createJsonRpcResponse(req.id, result);
      }

      case 'ping': {
        return createJsonRpcResponse(req.id, {});
      }

      case 'tools/list': {
        const tools = this.registry.listTools();
        return createJsonRpcResponse(req.id, { tools });
      }

      case 'tools/call': {
        const { name, arguments: args } = req.params || {};
        if (!name || typeof name !== 'string') {
          return createJsonRpcError(req.id, McpErrorCode.InvalidParams, 'Tool name is required in params');
        }

        const tool = this.registry.getTool(name);
        if (!tool) {
          return createJsonRpcError(req.id, McpErrorCode.MethodNotFound, `Tool "${name}" not found on server`);
        }

        const result = await this.registry.executeTool(name, args || {});
        return createJsonRpcResponse(req.id, result);
      }

      default: {
        return createJsonRpcError(
          req.id,
          McpErrorCode.MethodNotFound,
          `Method "${req.method}" is not supported`
        );
      }
    }
  }

  public async notifyToolsChanged(): Promise<void> {
    if (this.transport && this.transport.isConnected && this.initialized) {
      await this.transport.send(
        createJsonRpcNotification('notifications/tools/list_changed')
      );
    }
  }
}
