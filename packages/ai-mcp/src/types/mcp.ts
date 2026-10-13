/**
 * ZTools 原生 MCP (Model Context Protocol) 核心协议类型定义
 * 遵循 Anthropic MCP 标准规范
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export enum McpErrorCode {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
  InternalError = -32603,
  ToolError = -32000,
  ConnectionClosed = -32001,
  Timeout = -32002
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: JsonRpcErrorObject;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface McpImplementationInfo {
  name: string;
  version: string;
}

export interface McpClientCapabilities {
  experimental?: Record<string, any>;
  roots?: {
    listChanged?: boolean;
  };
  sampling?: Record<string, any>;
}

export interface McpServerCapabilities {
  experimental?: Record<string, any>;
  logging?: Record<string, any>;
  prompts?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
  };
}

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities: McpClientCapabilities;
  clientInfo: McpImplementationInfo;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: McpImplementationInfo;
}

export interface McpToolInputSchema {
  type: 'object';
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: any;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpToolInputSchema;
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export type McpToolContent = McpTextContent | McpImageContent | McpResourceContent;

export interface McpToolResult {
  content: McpToolContent[];
  isError?: boolean;
}

export type McpToolHandler = (
  args: Record<string, any>,
  extra?: { signal?: AbortSignal; hostInfo?: McpImplementationInfo }
) => Promise<McpToolResult | string | Record<string, any>> | McpToolResult | string | Record<string, any>;

export interface RegisteredTool extends McpTool {
  handler: McpToolHandler;
}
