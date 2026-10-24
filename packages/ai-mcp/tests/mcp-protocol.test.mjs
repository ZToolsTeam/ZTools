import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  McpHost,
  McpServer,
  InMemoryTransport,
  createJsonRpcRequest,
  createJsonRpcResponse,
  createJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification
} from '../dist/index.js';

describe('Native MCP (Model Context Protocol) Protocol Stack', () => {
  test('JSON-RPC 2.0 protocol helpers work accurately', () => {
    const req = createJsonRpcRequest(1, 'tools/list', {});
    assert.ok(isJsonRpcRequest(req));
    assert.equal(isJsonRpcResponse(req), false);

    const resp = createJsonRpcResponse(1, { tools: [] });
    assert.ok(isJsonRpcResponse(resp));
    assert.equal(resp.result.tools.length, 0);

    const errResp = createJsonRpcError(2, -32601, 'Method not found');
    assert.ok(isJsonRpcResponse(errResp));
    assert.equal(errResp.error?.code, -32601);
  });

  test('InMemoryTransport pairs send and receive asynchronously without data contamination', async () => {
    const [client, server] = InMemoryTransport.createPair();
    await client.connect();
    await server.connect();

    assert.equal(client.isConnected, true);
    assert.equal(server.isConnected, true);

    const receivedByServer = [];
    server.onMessage(msg => receivedByServer.push(msg));

    await client.send(createJsonRpcRequest('req-1', 'ping'));

    await new Promise(r => setTimeout(r, 20));
    assert.equal(receivedByServer.length, 1);
    assert.equal(receivedByServer[0].id, 'req-1');

    await client.close();
    await server.close();
  });

  test('McpHost and McpServer perform handshake and tool discovery', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createPair();

    const server = new McpServer({
      name: 'test-mcp-server',
      version: '1.2.3'
    });

    server.registerTool(
      {
        name: 'echo_text',
        description: 'Echoes back given text with a prefix',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            repeat: { type: 'integer' }
          },
          required: ['text']
        }
      },
      (args) => {
        const repeat = args.repeat || 1;
        return Array(repeat).fill(args.text).join(' ');
      }
    );

    await server.connect(serverTransport);

    const host = new McpHost({
      name: 'ztools-test-host',
      version: '2.0.0'
    });

    const conn = await host.connectServer('my-server', clientTransport);
    assert.equal(conn.serverInfo?.name, 'test-mcp-server');
    assert.equal(conn.serverInfo?.version, '1.2.3');

    // 工具发现验证
    const tools = host.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo_text');
    assert.equal(tools[0].serverName, 'my-server');

    // 工具正常执行验证
    const result = await host.callTool('echo_text', { text: 'Hello MCP', repeat: 2 });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Hello MCP Hello MCP');

    // 工具参数校验失败验证（缺少必填字段 text）
    const failedResult = await host.callTool('echo_text', { repeat: 3 });
    assert.equal(failedResult.isError, true);
    assert.ok(failedResult.content[0].text.includes('Missing required parameter: "text"'));

    // 动态新增工具并发送 notification
    server.registerTool(
      {
        name: 'calculate_sum',
        description: 'Calculates sum of two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['a', 'b']
        }
      },
      args => ({ result: args.a + args.b })
    );

    await server.notifyToolsChanged();
    await new Promise(r => setTimeout(r, 30));

    // 自动刷新后的工具列表验证
    const updatedTools = host.listTools();
    assert.equal(updatedTools.length, 2);
    const names = updatedTools.map(t => t.name);
    assert.ok(names.includes('calculate_sum'));

    const sumResult = await host.callTool('calculate_sum', { a: 15, b: 27 });
    assert.equal(sumResult.isError, false);
    const parsed = JSON.parse(sumResult.content[0].text);
    assert.equal(parsed.result, 42);

    await host.disconnectAll();
  });

  test('McpHost rejects pending requests immediately when server disconnects', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createPair();
    const server = new McpServer({ name: 'slow-server', version: '1.0.0' });
    server.registerTool(
      {
        name: 'slow_task',
        description: 'Task that hangs until disconnect',
        inputSchema: { type: 'object', properties: {} }
      },
      () => new Promise(() => {})
    );

    await server.connect(serverTransport);
    const host = new McpHost({ name: 'test-host', version: '1.0.0' });
    await host.connectServer('slow-srv', clientTransport);

    const callPromise = host.callTool('slow_task', {});
    await new Promise((r) => setTimeout(r, 20));
    await host.disconnectServer('slow-srv');
    await server.close();

    await assert.rejects(callPromise, /MCP Server "slow-srv" disconnected/);
  });
});
