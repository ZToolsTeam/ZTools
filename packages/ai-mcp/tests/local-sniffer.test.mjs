import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  sniffOllama,
  sniffLMStudio,
  sniffLocalProviders,
  createLocalProviderConfig,
  ModelRouter
} from '../dist/index.js';

describe('Local Inference Auto-Sniffing (Ollama & LM Studio)', () => {
  let mockOllamaServer;
  let mockLmStudioServer;
  let ollamaPort = 19434;
  let lmStudioPort = 19234;

  before(async () => {
    // 模拟 Ollama HTTP 服务
    mockOllamaServer = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: [
              { name: 'deepseek-r1:8b', size: 4920754802 },
              { name: 'qwen2.5-coder:7b', size: 4500000000 }
            ]
          })
        );
      } else if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.5.4' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // 模拟 LM Studio HTTP 服务
    mockLmStudioServer = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'meta-llama-3.1-8b-instruct' },
              { id: 'mistral-7b-instruct-v0.3' }
            ]
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise(r => mockOllamaServer.listen(ollamaPort, r));
    await new Promise(r => mockLmStudioServer.listen(lmStudioPort, r));
  });

  after(async () => {
    await new Promise(r => mockOllamaServer.close(r));
    await new Promise(r => mockLmStudioServer.close(r));
  });

  test('sniffOllama detects online status, version, and models', async () => {
    const result = await sniffOllama(`http://127.0.0.1:${ollamaPort}`, 2000);

    assert.equal(result.type, 'ollama');
    assert.equal(result.online, true);
    assert.equal(result.version, '0.5.4');
    assert.ok(result.latencyMs !== undefined && result.latencyMs >= 0);
    assert.deepEqual(result.models, ['deepseek-r1:8b', 'qwen2.5-coder:7b']);
  });

  test('sniffLMStudio detects online status and models', async () => {
    const result = await sniffLMStudio(`http://127.0.0.1:${lmStudioPort}`, 2000);

    assert.equal(result.type, 'lmstudio');
    assert.equal(result.online, true);
    assert.ok(result.latencyMs !== undefined && result.latencyMs >= 0);
    assert.deepEqual(result.models, ['meta-llama-3.1-8b-instruct', 'mistral-7b-instruct-v0.3']);
  });

  test('offline server gracefully returns online: false without throwing', async () => {
    // 探测一个未监听的端口
    const offlineResult = await sniffOllama('http://127.0.0.1:59999', 500);

    assert.equal(offlineResult.type, 'ollama');
    assert.equal(offlineResult.online, false);
    assert.equal(offlineResult.models.length, 0);
    assert.ok(offlineResult.error);
  });

  test('sniffLocalProviders concurrently checks both and converts to ProviderConfig', async () => {
    const sniffResult = await sniffLocalProviders({
      ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
      lmStudioUrl: `http://127.0.0.1:${lmStudioPort}`
    });

    assert.equal(sniffResult.ollama.online, true);
    assert.equal(sniffResult.lmStudio.online, true);
    assert.equal(sniffResult.allOnline.length, 2);

    const config = createLocalProviderConfig(sniffResult.ollama);
    assert.equal(config.id, 'local-ollama');
    assert.equal(config.type, 'ollama');
    assert.equal(config.baseUrl, `http://127.0.0.1:${ollamaPort}/v1`);
    assert.equal(config.defaultModel, 'deepseek-r1:8b');
  });

  test('ModelRouter.autoDetectLocalProviders registers detected local models', async () => {
    const router = new ModelRouter();

    const sniffRes = await router.autoDetectLocalProviders({
      ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
      lmStudioUrl: `http://127.0.0.1:${lmStudioPort}`
    });

    assert.equal(sniffRes.allOnline.length, 2);

    const registered = router.listProviders();
    const ids = registered.map(p => p.id);
    assert.ok(ids.includes('local-ollama'));
    assert.ok(ids.includes('local-lmstudio'));
  });
});
