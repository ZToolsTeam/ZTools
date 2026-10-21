import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { ModelRouter } from '../dist/index.js';

describe('ModelRouter (BYOK & Multi-Provider Gateway)', () => {
  let mockServer;
  let serverPort = 19188;

  before(async () => {
    mockServer = http.createServer((req, res) => {
      // 1. OpenAI / DeepSeek / SiliconFlow / Ollama /chat/completions
      if (req.url === '/v1/chat/completions') {
        let bodyStr = '';
        req.on('data', chunk => (bodyStr += chunk));
        req.on('end', () => {
          const body = JSON.parse(bodyStr);

          // 模拟失败测试
          if (body.model === 'fail-model') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }));
            return;
          }

          if (body.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });

            // DeepSeek-R1 思考流
            res.write(
              `data: ${JSON.stringify({
                id: 'cmpl-stream-1',
                choices: [{ delta: { role: 'assistant', reasoning_content: '思考中...' }, finish_reason: null }]
              })}\n\n`
            );

            // 正式回复流
            res.write(
              `data: ${JSON.stringify({
                id: 'cmpl-stream-1',
                choices: [{ delta: { content: '你好，我是' }, finish_reason: null }]
              })}\n\n`
            );

            res.write(
              `data: ${JSON.stringify({
                id: 'cmpl-stream-1',
                choices: [{ delta: { content: ' DeepSeek 大模型！' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
              })}\n\n`
            );

            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          // 非流式响应
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test-123',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '这是来自大模型的测试回复',
                    reasoning_content: '通过严密逻辑推导'
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 18,
                total_tokens: 30
              }
            })
          );
        });
      }
      // 2. Claude /v1/messages
      else if (req.url === '/v1/messages') {
        let bodyStr = '';
        req.on('data', chunk => (bodyStr += chunk));
        req.on('end', () => {
          const authKey = req.headers['x-api-key'];
          const anthropicVer = req.headers['anthropic-version'];

          assert.equal(anthropicVer, '2023-06-01');
          assert.equal(authKey, 'sk-claude-test-key');

          const body = JSON.parse(bodyStr);

          if (body.stream && body.model === 'claude-tool-stream') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            res.write(
              `data: ${JSON.stringify({
                type: 'content_block_start',
                content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' }
              })}\n\n`
            );
            res.write(
              `data: ${JSON.stringify({
                type: 'content_block_delta',
                delta: { type: 'input_json_delta', partial_json: '{"city":"Shanghai"}' }
              })}\n\n`
            );
            res.write(
              `data: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 12 }
              })}\n\n`
            );
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_test_claude_1',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [
                {
                  type: 'text',
                  text: 'Claude 已经收到您的指令。'
                }
              ],
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 20,
                output_tokens: 15
              }
            })
          );
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
  });

  test('BYOK provider registration and management', () => {
    const router = new ModelRouter();

    router.registerProvider({
      id: 'my-deepseek',
      name: 'DeepSeek BYOK',
      type: 'deepseek',
      apiKey: 'sk-deepseek-xxx',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'deepseek-chat'
    });

    router.registerProvider({
      id: 'my-claude',
      name: 'Claude BYOK',
      type: 'claude',
      apiKey: 'sk-claude-test-key',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'claude-3-5-sonnet'
    });

    assert.equal(router.getDefaultProviderId(), 'my-deepseek');
    const list = router.listProviders();
    assert.equal(list.length, 2);

    // 切换默认
    router.setDefaultProvider('my-claude');
    assert.equal(router.getDefaultProviderId(), 'my-claude');
  });

  test('chat with OpenAI/DeepSeek compatible endpoint works and tracks tokens', async () => {
    const router = new ModelRouter();
    router.registerProvider({
      id: 'test-openai',
      name: 'Mock OpenAI',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'gpt-4o'
    });

    const response = await router.chat({
      messages: [{ role: 'user', content: '测试问答' }]
    });

    assert.equal(response.provider, 'test-openai');
    assert.equal(response.message.content, '这是来自大模型的测试回复');
    assert.equal(response.finishReason, 'stop');
    assert.equal(response.usage?.totalTokens, 30);

    const metrics = router.getMetrics();
    assert.equal(metrics.totalRequests, 1);
    assert.equal(metrics.successfulRequests, 1);
    assert.equal(metrics.totalTokens.totalTokens, 30);
  });

  test('chat with Claude Messages API endpoint works correctly', async () => {
    const router = new ModelRouter();
    router.registerProvider({
      id: 'test-claude',
      name: 'Mock Claude',
      type: 'claude',
      apiKey: 'sk-claude-test-key',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'claude-3-5-sonnet'
    });

    const response = await router.chat({
      provider: 'test-claude',
      system: '请使用专业态度回答',
      messages: [{ role: 'user', content: '你好 Claude' }]
    });

    assert.equal(response.provider, 'test-claude');
    assert.equal(response.message.content, 'Claude 已经收到您的指令。');
    assert.equal(response.usage?.promptTokens, 20);
    assert.equal(response.usage?.completionTokens, 15);
    assert.equal(response.usage?.totalTokens, 35);
  });

  test('chatStream streams chunks and yields reasoning_content (DeepSeek-R1 style)', async () => {
    const router = new ModelRouter();
    router.registerProvider({
      id: 'test-stream',
      name: 'Mock Stream Provider',
      type: 'deepseek',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'deepseek-reasoner'
    });

    const chunks = [];
    for await (const chunk of router.chatStream({
      messages: [{ role: 'user', content: '进行复杂逻辑推理' }]
    })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.length >= 3);
    assert.equal(chunks[0].delta.reasoningContent, '思考中...');
    assert.equal(chunks[1].delta.content, '你好，我是');
    assert.equal(chunks[2].delta.content, ' DeepSeek 大模型！');
    assert.equal(chunks[2].finishReason, 'stop');
    assert.equal(chunks[2].usage?.totalTokens, 40);
  });

  test('automatic error fallback from primary to secondary provider', async () => {
    const router = new ModelRouter();

    // Provider 1 会报 500 错误
    router.registerProvider({
      id: 'failing-provider',
      name: 'Failing Provider',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'fail-model'
    });

    // Provider 2 是健康的备选
    router.registerProvider({
      id: 'healthy-backup',
      name: 'Healthy Backup',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'gpt-4o'
    });

    router.setDefaultProvider('failing-provider');
    router.setFallbackChain(['healthy-backup']);

    const response = await router.chat({
      messages: [{ role: 'user', content: '测试降级路由' }]
    });

    // 应该平滑降级到 healthy-backup 返回结果
    assert.equal(response.provider, 'healthy-backup');
    assert.equal(response.message.content, '这是来自大模型的测试回复');

    const metrics = router.getMetrics();
    assert.equal(metrics.fallbackCount, 1);
    assert.equal(metrics.successfulRequests, 1);
  });

  test('ClaudeProvider formats multi-turn toolCalls/tool_result and streams tool_use blocks', async () => {
    const router = new ModelRouter();
    router.registerProvider({
      id: 'claude-tools',
      name: 'Claude Tools',
      type: 'claude',
      apiKey: 'sk-claude-test-key',
      baseUrl: `http://127.0.0.1:${serverPort}/v1`,
      defaultModel: 'claude-tool-stream'
    });

    const chunks = [];
    for await (const chunk of router.chatStream({
      provider: 'claude-tools',
      messages: [
        { role: 'user', content: '查天气' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_00', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }]
        },
        { role: 'tool', toolCallId: 'toolu_00', content: 'Sunny 25C' }
      ]
    })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((c) => c.delta.toolCalls?.[0]?.function?.name === 'get_weather'));
    assert.ok(chunks.some((c) => c.delta.toolCalls?.[0]?.function?.arguments === '{"city":"Shanghai"}'));
    assert.ok(chunks.some((c) => c.finishReason === 'tool_calls'));
  });
});
