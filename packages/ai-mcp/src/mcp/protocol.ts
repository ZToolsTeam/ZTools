import {
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpErrorCode
} from '../types/mcp.js';

export function createJsonRpcRequest(
  id: string | number,
  method: string,
  params?: Record<string, any>
): JsonRpcRequest {
  const req: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method
  };
  if (params !== undefined) {
    req.params = params;
  }
  return req;
}

export function createJsonRpcNotification(
  method: string,
  params?: Record<string, any>
): JsonRpcNotification {
  const notif: JsonRpcNotification = {
    jsonrpc: '2.0',
    method
  };
  if (params !== undefined) {
    notif.params = params;
  }
  return notif;
}

export function createJsonRpcResponse(
  id: string | number,
  result: any
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: result !== undefined ? result : null
  };
}

export function createJsonRpcError(
  id: string | number | null,
  code: McpErrorCode | number,
  message: string,
  data?: any
): JsonRpcResponse {
  const errorObj: JsonRpcErrorObject = {
    code,
    message
  };
  if (data !== undefined) {
    errorObj.data = data;
  }
  return {
    jsonrpc: '2.0',
    id: id !== null ? id : 0,
    error: errorObj
  };
}

export function isJsonRpcRequest(msg: any): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    msg.jsonrpc === '2.0' &&
    'id' in msg &&
    typeof msg.method === 'string'
  );
}

export function isJsonRpcNotification(msg: any): msg is JsonRpcNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    msg.jsonrpc === '2.0' &&
    !('id' in msg) &&
    typeof msg.method === 'string'
  );
}

export function isJsonRpcResponse(msg: any): msg is JsonRpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    msg.jsonrpc === '2.0' &&
    'id' in msg &&
    ('result' in msg || 'error' in msg)
  );
}
