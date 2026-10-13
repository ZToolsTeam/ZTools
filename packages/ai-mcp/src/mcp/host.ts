import {
  JsonRpcMessage,
  JsonRpcResponse,
  McpClientCapabilities,
  McpImplementationInfo,
  McpInitializeParams,
  McpInitializeResult,
  McpTool,
  McpToolResult,
  MCP_PROTOCOL_VERSION
} from '../types/mcp.js';
import {
  createJsonRpcNotification,
  createJsonRpcRequest,
  isJsonRpcResponse
} from './protocol.js';
import { McpTransport } from './transport/transport.js';

export interface McpHostOptions {
  name?: string;
  version?: string;
  capabilities?: McpClientCapabilities;
  requestTimeoutMs?: number;
}

export interface ConnectedServerInfo {
  name: string;
  transport: McpTransport;
  serverInfo?: McpImplementationInfo;
  capabilities?: any;
  tools: Map<string, McpTool>;
}

export class McpHost {
  public readonly info: McpImplementationInfo;
  private capabilities: McpClientCapabilities;
  private requestTimeoutMs: number;
  private servers: Map<string, ConnectedServerInfo> = new Map();
  private pendingRequests: Map<
    string | number,
    { resolve: (val: any) => void; reject: (err: any) => void; timer: any }
  > = new Map();
  private nextRequestId: number = 1;

  constructor(options: McpHostOptions = {}) {
    this.info = {
      name: options.name || 'ztools-mcp-host',
      version: options.version || '1.0.0'
    };
    this.capabilities = {
      roots: { listChanged: true },
      ...options.capabilities
    };
    this.requestTimeoutMs = options.requestTimeoutMs || 30000;
  }

  /**
   * 连接并握手一个 MCP Server
   */
  public async connectServer(serverName: string, transport: McpTransport): Promise<ConnectedServerInfo> {
    if (this.servers.has(serverName)) {
      throw new Error(`Server with name "${serverName}" is already connected`);
    }

    const serverEntry: ConnectedServerInfo = {
      name: serverName,
      transport,
      tools: new Map()
    };
    this.servers.set(serverName, serverEntry);

    // 绑定 Transport 消息监听
    transport.onMessage((msg: JsonRpcMessage) => {
      this.handleServerMessage(serverName, msg);
    });

    transport.onClose(() => {
      this.servers.delete(serverName);
    });

    if (!transport.isConnected) {
      await transport.connect();
    }

    // 执行 initialize 握手
    const initParams: McpInitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: this.info,
      capabilities: this.capabilities
    };

    const initResult = (await this.sendRequest(serverName, 'initialize', initParams)) as McpInitializeResult;
    serverEntry.serverInfo = initResult.serverInfo;
    serverEntry.capabilities = initResult.capabilities;

    // 发送 notifications/initialized
    await transport.send(createJsonRpcNotification('notifications/initialized'));

    // 拉取初始工具列表
    await this.refreshServerTools(serverName);

    return serverEntry;
  }

  /**
   * 断开指定 Server
   */
  public async disconnectServer(serverName: string): Promise<boolean> {
    const entry = this.servers.get(serverName);
    if (!entry) return false;

    this.servers.delete(serverName);
    try {
      await entry.transport.close();
    } catch {}
    return true;
  }

  /**
   * 断开所有已连接的 MCP Server
   */
  public async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys());
    for (const name of names) {
      await this.disconnectServer(name);
    }
  }

  /**
   * 刷新指定 Server 暴露的工具列表
   */
  public async refreshServerTools(serverName: string): Promise<McpTool[]> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`Server "${serverName}" not connected`);
    }

    const res = await this.sendRequest(serverName, 'tools/list', {}) as { tools?: McpTool[] };
    const tools = res.tools || [];

    entry.tools.clear();
    for (const tool of tools) {
      entry.tools.set(tool.name, tool);
    }

    return tools;
  }

  /**
   * 列出所有已连接 Server 的全部工具
   */
  public listTools(serverName?: string): Array<McpTool & { serverName: string }> {
    if (serverName) {
      const entry = this.servers.get(serverName);
      if (!entry) return [];
      return Array.from(entry.tools.values()).map(t => ({ ...t, serverName }));
    }

    const result: Array<McpTool & { serverName: string }> = [];
    for (const [sName, entry] of this.servers.entries()) {
      for (const tool of entry.tools.values()) {
        result.push({ ...tool, serverName: sName });
      }
    }
    return result;
  }

  /**
   * 查找拥有指定工具的 Server
   */
  private findServerForTool(toolName: string, preferredServer?: string): ConnectedServerInfo {
    if (preferredServer) {
      const entry = this.servers.get(preferredServer);
      if (!entry) {
        throw new Error(`Server "${preferredServer}" is not connected`);
      }
      if (!entry.tools.has(toolName)) {
        throw new Error(`Tool "${toolName}" not found on server "${preferredServer}"`);
      }
      return entry;
    }

    for (const entry of this.servers.values()) {
      if (entry.tools.has(toolName)) {
        return entry;
      }
    }

    throw new Error(`Tool "${toolName}" was not found on any connected MCP server`);
  }

  /**
   * 调用 MCP 工具
   */
  public async callTool(
    toolName: string,
    args: Record<string, any> = {},
    serverName?: string
  ): Promise<McpToolResult> {
    const server = this.findServerForTool(toolName, serverName);
    const result = (await this.sendRequest(server.name, 'tools/call', {
      name: toolName,
      arguments: args
    })) as McpToolResult;

    return result;
  }

  /**
   * 向指定 Server 发送 JSON-RPC 请求
   */
  public async sendRequest(serverName: string, method: string, params?: Record<string, any>): Promise<any> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server "${serverName}" is not connected`);
    }

    const id = this.nextRequestId++;
    const req = createJsonRpcRequest(id, method, params);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP Request ${method} (id=${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      server.transport.send(req).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  private handleServerMessage(serverName: string, msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.reject(
          new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
        );
      } else {
        pending.resolve(msg.result);
      }
    } else if (msg.method === 'notifications/tools/list_changed') {
      // 收到工具列表变更通知，自动刷新缓存
      this.refreshServerTools(serverName).catch(() => {});
    }
  }
}
