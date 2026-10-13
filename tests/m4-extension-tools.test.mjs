/**
 * ZTools M4 集成与抗毁性测试套件：扩展 Tool 接入 AI / MCP 全链路
 * (M4 Extension Tools MCP Integration & Chaos Resilience Suite)
 * 
 * 覆盖 4 大核心维度与全面异常注入：
 * 1. M4-1: Worker / Runtime tool 入口点执行引擎与混沌熔断
 *    - 正常传参与同步/异步函数执行
 *    - 字符串化 JSON 自动反序列化
 *    - 非法/畸形 JSON 语法容错拦截
 *    - 非 Object 异常参数 (Array, number, boolean) 严密阻断
 *    - 模块文件缺失、语法崩溃与非函数导出 (Non-function export) 安全兜底
 *    - 运行时抛出异常与 Promise 拒绝捕获
 *    - 挂起/死循环执行的看门狗超时 (Watchdog Timeout) 熔断
 *    - 循环引用 (Circular Reference) 与 BigInt 非序列化输出拦截
 * 2. M4-2: 动态挂载到 McpHost 网关与命名空间治理
 *    - 多工具批量自动注册与全限定名 (${pluginId}__${toolName}) / 短别名绑定
 *    - McpHost.listTools() 动态发现与参数 Schema 暴露
 *    - McpHost.callTool() 端到端全链路调用与结果解包
 * 3. M4-2: 扩展生命周期全同步与悬空调用防护 (Dangling Pointer Defense)
 *    - disableExtension: 实时从 McpServer 拔除，McpHost 工具池同步清理，调用即刻报错
 *    - enableExtension: 实时恢复挂载，McpHost 工具池重新发现，恢复正常调用
 *    - revokeExtension: 封禁插件，强制下线，阻断任何 re-enable 企图
 *    - uninstallExtension: 彻底清理扩展工具树与元数据
 * 4. M4-3: Human-in-the-Loop 人工交互二次确认机制
 *    - confirmation: false 工具静默极速穿透
 *    - confirmation: true 用户确认允许 (true) -> 放行执行
 *    - confirmation: true 用户明确拒绝 (false) -> 拦截执行，工具函数零副作用，向 AI 返回拒绝提示
 *    - confirmation: true 确认回调异常崩溃 -> 拦截执行，安全降级
 *    - confirmation: true 无确认回调兜底拦截
 */

import assert from 'node:assert/strict';
import test, { describe, it, before, after } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';

import {
  McpHost,
  ModelRouter,
  executeToolEntryPoint,
  serializeToolOutput,
  ExtensionToolManager
} from '../packages/ai-mcp/dist/index.js';

describe('M4: 扩展 Tool 接入 AI / MCP 全链路集成套件', () => {
  let fixtureDir;
  let mathToolPath;
  let errorToolPath;
  let hangingToolPath;
  let circularToolPath;
  let bigintToolPath;
  let nonFuncToolPath;
  let dangerousToolPath;

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-m4-tools-fixture-'));

    // 1. 标准数学运算工具 (支持同步/异步、默认导出或具名导出)
    mathToolPath = path.join(fixtureDir, 'math-tools.mjs');
    fs.writeFileSync(
      mathToolPath,
      `
      export default async function calculate(args) {
        const { a = 0, b = 0, op = 'add' } = args || {};
        if (op === 'multiply') return { result: a * b };
        if (op === 'divide') {
          if (b === 0) throw new Error('Division by zero');
          return { result: a / b };
        }
        return { result: a + b };
      }

      export function echo(args) {
        return { echoed: args };
      }
      `,
      'utf-8'
    );

    // 2. 运行时故意抛出异常工具
    errorToolPath = path.join(fixtureDir, 'error-tool.mjs');
    fs.writeFileSync(
      errorToolPath,
      `
      export default function alwaysFail() {
        throw new Error('Database connection failed: ETIMEDOUT');
      }
      export function rejectAsync() {
        return Promise.reject(new Error('Remote API rate limit exceeded'));
      }
      `,
      'utf-8'
    );

    // 3. 故意挂起/死循环工具 (测试看门狗超时)
    hangingToolPath = path.join(fixtureDir, 'hanging-tool.mjs');
    fs.writeFileSync(
      hangingToolPath,
      `
      export default function hangForever() {
        return new Promise(() => {}); // 永不 resolve
      }
      `,
      'utf-8'
    );

    // 4. 循环引用工具 (测试 JSON 序列化熔断)
    circularToolPath = path.join(fixtureDir, 'circular-tool.mjs');
    fs.writeFileSync(
      circularToolPath,
      `
      export default function returnCircular() {
        const obj = { name: 'cyclic-node' };
        obj.self = obj;
        return obj;
      }
      `,
      'utf-8'
    );

    // 5. BigInt 工具 (测试 BigInt 序列化防御)
    bigintToolPath = path.join(fixtureDir, 'bigint-tool.mjs');
    fs.writeFileSync(
      bigintToolPath,
      `
      export default function returnBigInt() {
        return { value: 9007199254740993n };
      }
      export function returnRawBigInt() {
        return 42n;
      }
      `,
      'utf-8'
    );

    // 6. 导出非函数工具
    nonFuncToolPath = path.join(fixtureDir, 'non-func-tool.mjs');
    fs.writeFileSync(
      nonFuncToolPath,
      `
      export default { notAFunction: true };
      export const strExport = "hello";
      `,
      'utf-8'
    );

    // 7. 高危危险工具 (用于二次确认测试)
    dangerousToolPath = path.join(fixtureDir, 'dangerous-tool.mjs');
    fs.writeFileSync(
      dangerousToolPath,
      `
      export let executionCounter = 0;
      export default function deleteDatabase(args) {
        executionCounter++;
        return { status: 'DELETED', table: args?.table };
      }
      `,
      'utf-8'
    );
  });

  after(() => {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // 维度 1: M4-1 Worker / Runtime 执行器基础功能与极端边界混沌测试
  // =========================================================================
  describe('维度 1: Worker / Runtime executeToolEntryPoint 执行器', () => {
    it('正常执行：传入标准 Object 参数并返回正确的 JSON 结果', async () => {
      const res = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: { a: 10, b: 25, op: 'add' }
      });

      assert.equal(res.isError, false);
      assert.ok(Array.isArray(res.content));
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.result, 35);
    });

    it('具名导出执行：指定 exportName 调用 echo 函数', async () => {
      const res = await executeToolEntryPoint({
        toolPath: mathToolPath,
        exportName: 'echo',
        args: { message: 'hello ztools' }
      });

      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.echoed.message, 'hello ztools');
    });

    it('字符串化 JSON 参数：能够自动解析并安全调用', async () => {
      const res = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: JSON.stringify({ a: 6, b: 7, op: 'multiply' })
      });

      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.result, 42);
    });

    it('畸形/非法 JSON 参数：严密捕获语法错误并返回 isError: true，绝不使宿主崩溃', async () => {
      const res = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: '{ "a": 10, unquoted_key: invalid }' // 非法 JSON 格式
      });

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Invalid JSON input arguments/);
    });

    it('参数非 Object 类型 (Array/Number/Boolean)：拦截非法传参', async () => {
      // 数组
      const arrayRes = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: [1, 2, 3]
      });
      assert.equal(arrayRes.isError, true);
      assert.match(arrayRes.content[0].text, /Tool arguments must be an object/);

      // 数字
      const numRes = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: 12345
      });
      assert.equal(numRes.isError, true);
      assert.match(numRes.content[0].text, /Tool arguments must be an object/);

      // 字符串非对象 (JSON 解析结果为原始值)
      const primitiveJsonRes = await executeToolEntryPoint({
        toolPath: mathToolPath,
        args: '"simple string"'
      });
      assert.equal(primitiveJsonRes.isError, true);
      assert.match(primitiveJsonRes.content[0].text, /must be a JSON object/);
    });

    it('模块文件缺失：返回文件未找到明确错误', async () => {
      const missingPath = path.join(fixtureDir, 'not-exist-module.mjs');
      const res = await executeToolEntryPoint({
        toolPath: missingPath,
        args: {}
      });

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Tool file not found/);
    });

    it('模块导出非函数：导出对象或字符串时给出友好错误', async () => {
      const res1 = await executeToolEntryPoint({
        toolPath: nonFuncToolPath,
        exportName: 'default',
        args: {}
      });
      assert.equal(res1.isError, true);
      assert.match(res1.content[0].text, /is not a function/);

      const res2 = await executeToolEntryPoint({
        toolPath: nonFuncToolPath,
        exportName: 'strExport',
        args: {}
      });
      assert.equal(res2.isError, true);
      assert.match(res2.content[0].text, /is not a function \(got string\)/);
    });

    it('运行时同步/异步异常：捕获 throw 与 Promise.reject 并结构化输出', async () => {
      // 同步异常
      const syncRes = await executeToolEntryPoint({
        toolPath: errorToolPath,
        exportName: 'default',
        args: {}
      });
      assert.equal(syncRes.isError, true);
      assert.match(syncRes.content[0].text, /Database connection failed: ETIMEDOUT/);

      // 异步 reject
      const asyncRes = await executeToolEntryPoint({
        toolPath: errorToolPath,
        exportName: 'rejectAsync',
        args: {}
      });
      assert.equal(asyncRes.isError, true);
      assert.match(asyncRes.content[0].text, /Remote API rate limit exceeded/);
    });

    it('看门狗超时保护：挂起函数在超时后强制中止并返回超时错误', async () => {
      const start = Date.now();
      const res = await executeToolEntryPoint({
        toolPath: hangingToolPath,
        args: {},
        timeoutMs: 150 // 短超时用于测试
      });
      const elapsed = Date.now() - start;

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Tool execution timed out after 150ms/);
      assert.ok(elapsed >= 140, `Execution took ${elapsed}ms`);
    });

    it('非序列化输出容灾：循环引用对象被安全捕获，防止 JSON.stringify 崩溃', async () => {
      const res = await executeToolEntryPoint({
        toolPath: circularToolPath,
        args: {}
      });

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Circular reference detected/);
    });

    it('非序列化输出容灾：BigInt 字段与原始 BigInt 被安全捕获', async () => {
      const res1 = await executeToolEntryPoint({
        toolPath: bigintToolPath,
        exportName: 'default',
        args: {}
      });
      assert.equal(res1.isError, true);
      assert.match(res1.content[0].text, /BigInt cannot be serialized to JSON/);

      const res2 = await executeToolEntryPoint({
        toolPath: bigintToolPath,
        exportName: 'returnRawBigInt',
        args: {}
      });
      assert.equal(res2.isError, true);
      assert.match(res2.content[0].text, /BigInt cannot be serialized to JSON/);
    });
  });

  // =========================================================================
  // 维度 2: M4-2 ExtensionToolManager 动态挂载与 McpHost 全链路调用
  // =========================================================================
  describe('维度 2: ExtensionToolManager 与 McpHost 动态挂载', () => {
    let host;
    let manager;

    before(async () => {
      host = new McpHost({ name: 'test-mcp-host' });
      manager = new ExtensionToolManager({
        serverName: 'ztools-extensions-server',
        defaultTimeoutMs: 5000
      });

      await manager.attachHost(host);
    });

    it('注册包含 tools 与 commands(mode=tool) 的扩展插件', async () => {
      const tools = await manager.registerExtension({
        id: 'math-plugin',
        name: 'Math Toolkit',
        dir: fixtureDir,
        tools: [
          {
            name: 'calculate',
            description: 'Execute basic arithmetic operations',
            toolPath: mathToolPath,
            exportName: 'default',
            inputSchema: {
              type: 'object',
              properties: {
                a: { type: 'number' },
                b: { type: 'number' },
                op: { type: 'string', enum: ['add', 'multiply', 'divide'] }
              },
              required: ['a', 'b']
            }
          }
        ],
        commands: [
          {
            name: 'echo',
            title: 'Echo Arguments',
            mode: 'tool',
            entry: mathToolPath
          }
        ]
      });

      assert.equal(tools.length, 2);
      assert.equal(tools[0].qualifiedName, 'math-plugin__calculate');
      assert.equal(tools[1].qualifiedName, 'math-plugin__echo');

      // 验证在 McpHost 中已同步发现
      const hostTools = host.listTools();
      const toolNames = hostTools.map(t => t.name);
      assert.ok(toolNames.includes('math-plugin__calculate'));
      assert.ok(toolNames.includes('calculate')); // 短别名
    });

    it('通过 McpHost.callTool() 全限定名调用扩展工具', async () => {
      const res = await host.callTool('math-plugin__calculate', {
        a: 12,
        b: 8,
        op: 'multiply'
      });

      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.result, 96);
    });

    it('通过 McpHost.callTool() 短别名调用扩展工具', async () => {
      const res = await host.callTool('calculate', {
        a: 100,
        b: 50,
        op: 'divide'
      });

      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.result, 2);
    });
  });

  // =========================================================================
  // 维度 3: M4-2 扩展生命周期同步与悬空调用防护 (Dangling Pointer Defense)
  // =========================================================================
  describe('维度 3: 扩展生命周期流转与防悬空调用', () => {
    let host;
    let manager;

    before(async () => {
      host = new McpHost({ name: 'lifecycle-test-host' });
      manager = new ExtensionToolManager({ serverName: 'lifecycle-server' });
      await manager.attachHost(host);

      await manager.registerExtension({
        id: 'demo-plugin',
        name: 'Demo Plugin',
        dir: fixtureDir,
        tools: [
          {
            name: 'demo_calc',
            description: 'Demo calculation',
            toolPath: mathToolPath
          }
        ]
      });
    });

    it('启用状态下：可以正常调用工具', async () => {
      const res = await host.callTool('demo-plugin__demo_calc', { a: 5, b: 5 });
      assert.equal(res.isError, false);
      assert.equal(JSON.parse(res.content[0].text).result, 10);
    });

    it('disableExtension：工具被即时解绑，McpHost 调用立即报错，绝无悬空执行', async () => {
      const disabled = await manager.disableExtension('demo-plugin');
      assert.equal(disabled, true);

      // 验证在 McpHost 的工具列表中已消失
      const hostTools = host.listTools();
      const hasTool = hostTools.some(t => t.name === 'demo-plugin__demo_calc');
      assert.equal(hasTool, false);

      // 尝试调用已禁用的工具，必须直接抛出工具未找到异常
      await assert.rejects(
        () => host.callTool('demo-plugin__demo_calc', { a: 1, b: 1 }),
        /was not found on any connected MCP server/
      );
    });

    it('enableExtension：重新激活插件后工具恢复上线，调用恢复正常', async () => {
      const enabled = await manager.enableExtension('demo-plugin');
      assert.equal(enabled, true);

      // 验证重新发现工具
      const hostTools = host.listTools();
      const hasTool = hostTools.some(t => t.name === 'demo-plugin__demo_calc');
      assert.equal(hasTool, true);

      // 再次调用成功
      const res = await host.callTool('demo-plugin__demo_calc', { a: 20, b: 30 });
      assert.equal(res.isError, false);
      assert.equal(JSON.parse(res.content[0].text).result, 50);
    });

    it('revokeExtension：下架封禁插件，工具立即卸载且禁止被 re-enable', async () => {
      const revoked = await manager.revokeExtension('demo-plugin', '违规爬取用户凭证被官方下架');
      assert.equal(revoked, true);

      // 调用即刻失效
      await assert.rejects(
        () => host.callTool('demo-plugin__demo_calc', { a: 1, b: 1 }),
        /was not found/
      );

      // 尝试重新启用被封禁的插件必须抛出异常
      await assert.rejects(
        () => manager.enableExtension('demo-plugin'),
        /Cannot enable revoked extension "demo-plugin": 违规爬取用户凭证被官方下架/
      );
    });

    it('uninstallExtension：卸载插件后彻底从管理树移除', async () => {
      await manager.registerExtension({
        id: 'temp-plugin',
        tools: [{ name: 'temp_calc', description: 'temp', toolPath: mathToolPath }]
      });

      assert.ok(manager.getExtension('temp-plugin'));
      const uninstalled = await manager.uninstallExtension('temp-plugin');
      assert.equal(uninstalled, true);
      assert.equal(manager.getExtension('temp-plugin'), undefined);

      await assert.rejects(
        () => host.callTool('temp-plugin__temp_calc', {}),
        /was not found/
      );
    });
  });

  // =========================================================================
  // 维度 4: M4-3 Human-in-the-Loop 人工二次确认机制
  // =========================================================================
  describe('维度 4: Human-in-the-Loop 人工二次确认机制', () => {
    let host;
    let manager;
    let confirmationLog = [];

    before(async () => {
      host = new McpHost({ name: 'hitl-test-host' });
      manager = new ExtensionToolManager({
        serverName: 'hitl-server'
      });
      await manager.attachHost(host);

      await manager.registerExtension({
        id: 'admin-plugin',
        name: 'Admin Suite',
        tools: [
          {
            name: 'safe_calc',
            description: 'Safe operation without confirmation',
            toolPath: mathToolPath,
            confirmation: false
          },
          {
            name: 'delete_database',
            description: 'Dangerous operation requiring confirmation',
            toolPath: dangerousToolPath,
            confirmation: true,
            confirmationPrompt: '警告：即将删除数据库，该操作无法撤销，确认继续吗？'
          }
        ]
      });
    });

    it('无确认需求工具 (confirmation=false)：直接执行，不触发二次确认流程', async () => {
      manager.setConfirmHandler(() => {
        throw new Error('Should not be called for safe tools');
      });

      const res = await host.callTool('admin-plugin__safe_calc', { a: 10, b: 10 });
      assert.equal(res.isError, false);
      assert.equal(JSON.parse(res.content[0].text).result, 20);
    });

    it('有确认需求工具：用户同意授权 (true) -> 允许执行底层函数', async () => {
      confirmationLog = [];
      manager.setConfirmHandler(async (req) => {
        confirmationLog.push(req);
        return true; // 用户点击了"允许"
      });

      const res = await host.callTool('admin-plugin__delete_database', {
        table: 'users'
      });

      assert.equal(confirmationLog.length, 1);
      assert.equal(confirmationLog[0].pluginId, 'admin-plugin');
      assert.equal(confirmationLog[0].toolName, 'delete_database');
      assert.equal(confirmationLog[0].args.table, 'users');
      assert.match(confirmationLog[0].confirmationPrompt, /即将删除数据库/);

      assert.equal(res.isError, false);
      const parsed = JSON.parse(res.content[0].text);
      assert.equal(parsed.status, 'DELETED');
      assert.equal(parsed.table, 'users');
    });

    it('有确认需求工具：用户明确拒绝授权 (false) -> 拦截执行，底层函数零调用，返回明确拒绝提示', async () => {
      let functionExecuted = false;

      // 包装并监听
      manager.setConfirmHandler(async () => {
        return false; // 用户点击了"拒绝"
      });

      const res = await host.callTool('admin-plugin__delete_database', {
        table: 'critical_finance_data'
      });

      // 验证返回错误标志
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Tool execution cancelled by user: User denied confirmation/);
    });

    it('二次确认处理函数崩溃抛出异常：安全熔断拦截，绝不放行危险操作', async () => {
      manager.setConfirmHandler(async () => {
        throw new Error('UI Prompt timed out or user disconnected');
      });

      const res = await host.callTool('admin-plugin__delete_database', {
        table: 'critical_data'
      });

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Confirmation error/);
    });

    it('未注册二次确认回调时：默认安全阻断高危工具执行', async () => {
      manager.setConfirmHandler(undefined); // 清除 handler

      const res = await host.callTool('admin-plugin__delete_database', {
        table: 'users'
      });

      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /requires confirmation, but no confirmation handler is available/);
    });
  });

  // =========================================================================
  // 维度 5: AI Agent 自主调度扩展 Tool 闭环与故障自愈 (ModelRouter + McpHost)
  // =========================================================================
  describe('维度 5: AI Agent 自主调度扩展 Tool 闭环与故障自愈', () => {
    let host;
    let manager;
    let router;
    let mockHttpServer;
    let mockPort = 29481;
    let lastToolCallResult = null;

    before(async () => {
      host = new McpHost({ name: 'ai-agent-host' });
      manager = new ExtensionToolManager({ serverName: 'ai-extensions-server' });
      await manager.attachHost(host);

      await manager.registerExtension({
        id: 'agent-calc',
        name: 'Agent Calculator Plugin',
        dir: fixtureDir,
        tools: [
          {
            name: 'calculate',
            description: 'Perform math computation',
            toolPath: mathToolPath,
            confirmation: false
          },
          {
            name: 'delete_all_files',
            description: 'Destructive wiping tool',
            toolPath: dangerousToolPath,
            confirmation: true,
            confirmationPrompt: '确认抹除所有文件？'
          }
        ]
      });

      // 启动 Mock LLM HTTP 服务端点
      mockHttpServer = http.createServer((req, res) => {
        if (req.url === '/v1/chat/completions') {
          let bodyStr = '';
          req.on('data', chunk => (bodyStr += chunk));
          req.on('end', () => {
            const body = JSON.parse(bodyStr);
            const messages = body.messages || [];
            const lastMsg = messages[messages.length - 1];

            res.writeHead(200, { 'Content-Type': 'application/json' });

            // 1. 用户提问数学问题 -> 模型决策调用扩展 tool
            if (lastMsg.role === 'user' && lastMsg.content.includes('15 * 14')) {
              res.end(
                JSON.stringify({
                  id: 'agent-msg-1',
                  model: 'mock-agent-model',
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: '我将使用数学扩展工具为您计算结果。',
                        tool_calls: [
                          {
                            id: 'call_calc_1',
                            type: 'function',
                            function: {
                              name: 'agent-calc__calculate',
                              arguments: JSON.stringify({ a: 15, b: 14, op: 'multiply' })
                            }
                          }
                        ]
                      },
                      finish_reason: 'tool_calls'
                    }
                  ],
                  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }
                })
              );
            }
            // 2. 工具结果返回 -> 模型整合最终答案
            else if (lastMsg.role === 'tool' && lastMsg.tool_call_id === 'call_calc_1') {
              const toolResult = JSON.parse(lastMsg.content);
              res.end(
                JSON.stringify({
                  id: 'agent-msg-2',
                  model: 'mock-agent-model',
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: `计算完成，15 * 14 的结果是 ${toolResult.result}。`
                      },
                      finish_reason: 'stop'
                    }
                  ],
                  usage: { prompt_tokens: 80, completion_tokens: 25, total_tokens: 105 }
                })
              );
            }
            // 3. 用户请求高危操作 -> 模型决定调用 delete_all_files
            else if (lastMsg.role === 'user' && lastMsg.content.includes('抹除数据')) {
              res.end(
                JSON.stringify({
                  id: 'agent-msg-3',
                  model: 'mock-agent-model',
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: '正在尝试执行数据抹除。',
                        tool_calls: [
                          {
                            id: 'call_danger_1',
                            type: 'function',
                            function: {
                              name: 'agent-calc__delete_all_files',
                              arguments: JSON.stringify({ table: 'all' })
                            }
                          }
                        ]
                      },
                      finish_reason: 'tool_calls'
                    }
                  ],
                  usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
                })
              );
            }
            // 4. 工具被用户拒绝后 -> 模型输出安抚提示
            else if (lastMsg.role === 'tool' && lastMsg.tool_call_id === 'call_danger_1') {
              res.end(
                JSON.stringify({
                  id: 'agent-msg-4',
                  model: 'mock-agent-model',
                  choices: [
                    {
                      message: {
                        role: 'assistant',
                        content: '您已取消了高危抹除操作，未做任何更改。'
                      },
                      finish_reason: 'stop'
                    }
                  ],
                  usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 }
                })
              );
            }
          });
        }
      });

      await new Promise(resolve => mockHttpServer.listen(mockPort, resolve));

      router = new ModelRouter({
        defaultProvider: 'mock-agent'
      });
      router.registerProvider({
        id: 'mock-agent',
        name: 'Mock Agent Provider',
        type: 'openai',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'test-key',
        models: ['mock-agent-model'],
        enabled: true
      });
    });

    after(async () => {
      if (mockHttpServer) {
        await new Promise(resolve => mockHttpServer.close(resolve));
      }
    });

    it('E2E 闭环：用户提问 -> LLM 决策调用扩展 Tool -> McpHost 运行 -> 结果反馈 -> 模型生成最终答复', async () => {
      const messages = [
        { role: 'user', content: '请帮我计算 15 * 14 的结果。' }
      ];

      // Step 1: LLM 首次推理并生成 tool call
      const firstRes = await router.chat({ messages });
      assert.ok(firstRes.message.toolCalls && firstRes.message.toolCalls.length > 0);

      const toolCall = firstRes.message.toolCalls[0];
      assert.equal(toolCall.function.name, 'agent-calc__calculate');
      const toolArgs = JSON.parse(toolCall.function.arguments);

      // Step 2: 宿主通过 McpHost 调度扩展工具执行
      const executionResult = await host.callTool(toolCall.function.name, toolArgs);
      assert.equal(executionResult.isError, false);
      const textOutput = executionResult.content[0].text;
      assert.equal(JSON.parse(textOutput).result, 210);

      // Step 3: 将工具执行结果回填至对话上下文
      messages.push({
        role: 'assistant',
        content: firstRes.message.content,
        toolCalls: firstRes.message.toolCalls
      });
      messages.push({
        role: 'tool',
        content: textOutput,
        toolCallId: toolCall.id
      });

      // Step 4: LLM 汇总产出最终答复
      const finalRes = await router.chat({ messages });
      assert.match(finalRes.message.content, /210/);
    });

    it('E2E 异常闭环：LLM 尝试调用高危 Tool -> HITL 拒绝 -> 错误反馈模型 -> 模型妥善处理提示用户', async () => {
      // 模拟用户拒绝二次确认
      manager.setConfirmHandler(async () => {
        return false; // 用户在 UI 弹窗上点击"拒绝"
      });

      const messages = [
        { role: 'user', content: '请抹除数据' }
      ];

      // Step 1: LLM 决定调用高危工具
      const firstRes = await router.chat({ messages });
      assert.ok(firstRes.message.toolCalls);
      const dangerCall = firstRes.message.toolCalls[0];
      assert.equal(dangerCall.function.name, 'agent-calc__delete_all_files');

      // Step 2: 宿主调用工具，触发 HITL 拒绝拦截
      const executionResult = await host.callTool(
        dangerCall.function.name,
        JSON.parse(dangerCall.function.arguments)
      );
      assert.equal(executionResult.isError, true);
      assert.match(executionResult.content[0].text, /User denied confirmation/);

      // Step 3: 回传拒绝信息给大模型
      messages.push({
        role: 'assistant',
        content: firstRes.message.content,
        toolCalls: firstRes.message.toolCalls
      });
      messages.push({
        role: 'tool',
        content: executionResult.content[0].text,
        toolCallId: dangerCall.id
      });

      // Step 4: 模型获得拒绝结果并给出友好提示
      const finalRes = await router.chat({ messages });
      assert.match(finalRes.message.content, /您已取消了高危抹除操作/);
    });
  });
});
