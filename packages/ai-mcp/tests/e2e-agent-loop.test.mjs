import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import {
  ModelRouter,
  McpHost,
  registerSystemToolsToHost,
  readClipboard
} from '../dist/index.js';

describe('End-to-End Autonomous Agent Loop (ModelRouter + MCP Host + System Tools)', () => {
  let tempDir;
  let mockServer;
  let serverPort = 19388;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-e2e-agent-'));
    const targetFile = path.join(tempDir, 'project-config.json');
    fs.writeFileSync(targetFile, JSON.stringify({ version: '3.0.0', author: 'ztools' }), 'utf-8');

    // 智能模拟大模型端点：根据对话历史决策执行 MCP 工具
    mockServer = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let bodyStr = '';
        req.on('data', chunk => (bodyStr += chunk));
        req.on('end', () => {
          const body = JSON.parse(bodyStr);
          const messages = body.messages || [];
          const lastMsg = messages[messages.length - 1];

          res.writeHead(200, { 'Content-Type': 'application/json' });

          const toolCallId = lastMsg.tool_call_id || lastMsg.toolCallId;

          // 第一步：用户提出需求，模型决定调用 search_files
          if (lastMsg.role === 'user') {
            res.end(
              JSON.stringify({
                id: 'agent-step-1',
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: '我将先为您检索目标配置文件。',
                      tool_calls: [
                        {
                          id: 'call_search_1',
                          type: 'function',
                          function: {
                            name: 'search_files',
                            arguments: JSON.stringify({
                              query: 'project-config.json',
                              directory: tempDir
                            })
                          }
                        }
                      ]
                    },
                    finish_reason: 'tool_calls'
                  }
                ],
                usage: { prompt_tokens: 60, completion_tokens: 30, total_tokens: 90 }
              })
            );
          }
          // 第二步：检索结果返回后，模型分析结果并调用 write_clipboard
          else if (lastMsg.role === 'tool' && toolCallId === 'call_search_1') {
            const toolResult = JSON.parse(lastMsg.content);
            const foundPath = toolResult.files[0]?.path || '';

            res.end(
              JSON.stringify({
                id: 'agent-step-2',
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: `已找到文件 ${foundPath}，现在将其写入剪贴板。`,
                      tool_calls: [
                        {
                          id: 'call_clip_2',
                          type: 'function',
                          function: {
                            name: 'write_clipboard',
                            arguments: JSON.stringify({
                              text: foundPath
                            })
                          }
                        }
                      ]
                    },
                    finish_reason: 'tool_calls'
                  }
                ],
                usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
              })
            );
          }
          // 第三步：剪贴板写入完成，模型给出最终结论
          else if (lastMsg.role === 'tool' && toolCallId === 'call_clip_2') {
            res.end(
              JSON.stringify({
                id: 'agent-step-3',
                model: 'deepseek-chat',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: '任务已顺利完成：已检索到 project-config.json 并将其绝对路径写入系统剪贴板。'
                    },
                    finish_reason: 'stop'
                  }
                ],
                usage: { prompt_tokens: 180, completion_tokens: 50, total_tokens: 230 }
              })
            );
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unrecognized step in mock agent' }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(r => mockServer.listen(serverPort, r));
  });

  after(async () => {
    await new Promise(r => mockServer.close(r));
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test('full agent loop: user request -> LLM tool call -> MCP execution -> result feedback -> final completion', async () => {
    // 1. 初始化 McpHost 并注册 ZTools 系统能力
    const host = new McpHost({ name: 'ztools-agent-runtime' });
    await registerSystemToolsToHost(host, 'ztools-system');

    // 2. 初始化大模型路由网关并配置 BYOK
    const router = new ModelRouter();
    router.registerProvider({
      id: 'agent-llm',
      name: 'Agent Reasoner LLM',
      type: 'deepseek',
      apiKey: 'sk-byok-key-agent',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'deepseek-chat'
    });

    // 3. 将 MCP Tools 转换为大模型 Tools 格式
    const mcpTools = host.listTools();
    const llmTools = mcpTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));

    // 4. 用户输入目标
    const messages = [
      {
        role: 'user',
        content: `请在目录 ${tempDir} 下检索 project-config.json 文件，并将该文件绝对路径直接保存至系统剪贴板。`
      }
    ];

    let loopCount = 0;
    let finalAnswer = '';

    // 5. 执行 Agent 决策与调度自循环
    while (loopCount++ < 5) {
      const response = await router.chat({
        provider: 'agent-llm',
        messages: messages,
        tools: llmTools
      });

      messages.push(response.message);

      // 检查是否有 Tool Calls
      if (response.message.toolCalls && response.message.toolCalls.length > 0) {
        for (const call of response.message.toolCalls) {
          const fnName = call.function.name;
          const fnArgs = JSON.parse(call.function.arguments);

          // 核心：由 ZTools McpHost 执行标准 MCP 调度
          const toolResult = await host.callTool(fnName, fnArgs);
          assert.equal(toolResult.isError, false);

          const resultText = toolResult.content[0].type === 'text' ? toolResult.content[0].text : '';

          messages.push({
            role: 'tool',
            name: fnName,
            content: resultText,
            toolCallId: call.id
          });
        }
      } else {
        // 完成闭环
        finalAnswer = response.message.content;
        break;
      }
    }

    assert.ok(finalAnswer.includes('任务已顺利完成'));

    // 6. 验证系统剪贴板实际状态
    const clipboard = await readClipboard();
    const expectedFilePath = path.join(tempDir, 'project-config.json');
    assert.equal(clipboard.content, expectedFilePath);

    // 7. 验证 TokenTracker 完整会话用量
    const metrics = router.getMetrics();
    assert.equal(metrics.totalRequests, 3);
    assert.equal(metrics.successfulRequests, 3);
    assert.equal(metrics.totalTokens.totalTokens, 480); // 90 + 160 + 230

    await host.disconnectAll();
  });
});
