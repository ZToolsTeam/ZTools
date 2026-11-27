import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  StdioTransport,
  HttpSseTransport,
  ModelRouter,
  OpenAiCompatibleProvider,
  ClaudeProvider,
  sniffOllama,
  sniffLMStudio,
  sniffLocalProviders,
  validateRemoteServiceUrl,
  validateLoopbackUrl,
  AiMcpError
} from '../dist/index.js';

describe('AI/MCP Security Hardening (P2)', () => {
  test('StdioTransport isolates process.env secrets, respects envAllowlist/env, and cleanly closes child process', async () => {
    const prevSecret = process.env.SECRET_TEST_TOKEN;
    const prevAllowed = process.env.ALLOWED_TEST_VAR;
    process.env.SECRET_TEST_TOKEN = 'top-secret-host-token-do-not-leak';
    process.env.ALLOWED_TEST_VAR = 'allowed-from-host';

    try {
      // 1. 子进程打印接收到的环境变量（JSON-RPC 格式返回），并保活等待 close() 清理
      const childScript = `
        const payload = {
          jsonrpc: '2.0',
          method: 'env_report',
          params: {
            secret: process.env.SECRET_TEST_TOKEN ?? null,
            allowed: process.env.ALLOWED_TEST_VAR ?? null,
            explicit: process.env.EXPLICIT_CHILD_VAR ?? null,
            hasPath: Boolean(process.env.PATH || process.env.Path)
          }
        };
        process.stdout.write(JSON.stringify(payload) + '\\n');
        setInterval(() => {}, 10000);
      `;

      const transport = new StdioTransport({
        command: process.execPath,
        args: ['-e', childScript],
        envAllowlist: ['ALLOWED_TEST_VAR'],
        env: { EXPLICIT_CHILD_VAR: 'explicit-ok' }
      });

      const receivedPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for child env report')), 5000);
        transport.onMessage((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        transport.onError((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await transport.connect();
      const reportMsg = await receivedPromise;

      assert.equal(reportMsg.params.secret, null, '宿主 SECRET_TEST_TOKEN 绝不能泄露给子进程');
      assert.equal(reportMsg.params.allowed, 'allowed-from-host', 'envAllowlist 中的环境变量应透传');
      assert.equal(reportMsg.params.explicit, 'explicit-ok', 'options.env 显式传入的环境变量应生效');
      assert.equal(reportMsg.params.hasPath, true, '最小安全白名单应保留 PATH');

      let closedCount = 0;
      transport.onClose(() => {
        closedCount += 1;
      });

      // 关闭并清理进程树（包括二次幂等调用）
      await transport.close();
      assert.equal(transport.isConnected, false);
      assert.equal(closedCount, 1);

      // 幂等再次 close 不应抛错也不重复触发 close 回调
      await transport.close();
      assert.equal(closedCount, 1);
    } finally {
      if (prevSecret === undefined) delete process.env.SECRET_TEST_TOKEN;
      else process.env.SECRET_TEST_TOKEN = prevSecret;
      if (prevAllowed === undefined) delete process.env.ALLOWED_TEST_VAR;
      else process.env.ALLOWED_TEST_VAR = prevAllowed;
    }
  });

  test('URL guard & Providers block SSRF, insecure remote HTTP, embedded credentials, metadata IPs, and private networks by default', () => {
    // 1. 合法 URL：公网 HTTPS 与回环 HTTP/HTTPS
    assert.equal(validateRemoteServiceUrl('https://api.openai.com/v1').origin, 'https://api.openai.com');
    assert.equal(validateRemoteServiceUrl('http://127.0.0.1:11434/v1').origin, 'http://127.0.0.1:11434');
    assert.equal(validateRemoteServiceUrl('http://localhost:1234/v1').origin, 'http://localhost:1234');
    assert.equal(validateRemoteServiceUrl('http://[::1]:11434/v1').origin, 'http://[::1]:11434');

    // 2. 拒绝非回环明文 HTTP 与非法协议
    for (const badProto of ['http://api.openai.com/v1', 'file:///etc/passwd', 'ftp://example.com/model']) {
      assert.throws(
        () => validateRemoteServiceUrl(badProto),
        (err) => err instanceof AiMcpError && err.code === 'security.protocolNotAllowed',
        `should reject protocol: ${badProto}`
      );
    }

    // 3. 拒绝内嵌凭据
    assert.throws(
      () => validateRemoteServiceUrl('https://user:pass@api.openai.com/v1'),
      (err) => err instanceof AiMcpError && err.code === 'security.credentialsInUrlNotAllowed'
    );
    assert.throws(
      () => validateLoopbackUrl('http://admin:1234@127.0.0.1:11434'),
      (err) => err instanceof AiMcpError && err.code === 'security.credentialsInUrlNotAllowed'
    );

    // 4. 始终拒绝云元数据 / 链路本地 / 未指定地址（即使开启 allowPrivateNetwork: true）
    const alwaysBlocked = [
      'https://169.254.169.254/latest/meta-data',
      'http://169.254.169.254/latest/meta-data',
      'https://[::ffff:169.254.169.254]/latest/meta-data',
      'https://[fe80::1]/api',
      'https://0.0.0.0/api',
      'https://[::]/api',
      'https://100.100.100.200/latest/meta-data',
      'https://metadata.google.internal/computeMetadata/v1/'
    ];
    for (const url of alwaysBlocked) {
      assert.throws(
        () => validateRemoteServiceUrl(url, { allowPrivateNetwork: true }),
        (err) => err instanceof AiMcpError && err.code === 'security.blockedMetadataOrLinkLocal',
        `metadata/link-local must always be blocked: ${url}`
      );
    }

    // 5. 默认拒绝非回环私有内网，显式 allowPrivateNetwork: true 允许 HTTPS 私有内网
    const privateUrls = [
      'https://10.0.0.8/v1',
      'https://172.16.5.4/v1',
      'https://192.168.1.100/v1',
      'https://[fc00::1]/v1',
      'https://[fd12:3456::1]/v1',
      'https://llm.internal/v1'
    ];
    for (const url of privateUrls) {
      assert.throws(
        () => validateRemoteServiceUrl(url),
        (err) => err instanceof AiMcpError && err.code === 'security.privateNetworkNotAllowed',
        `private network should be rejected by default: ${url}`
      );
      assert.ok(validateRemoteServiceUrl(url, { allowPrivateNetwork: true }));
    }

    // 6. ModelRouter / OpenAiCompatibleProvider / ClaudeProvider 均接入校验
    const router = new ModelRouter();
    assert.throws(
      () =>
        router.registerProvider({
          id: 'ssrf-openai',
          name: 'Bad',
          type: 'openai',
          baseUrl: 'http://169.254.169.254/latest/meta-data'
        }),
      (err) => err instanceof AiMcpError && err.code === 'security.blockedMetadataOrLinkLocal'
    );
    assert.throws(
      () =>
        new OpenAiCompatibleProvider({
          id: 'bad-http',
          name: 'Bad HTTP',
          type: 'custom',
          baseUrl: 'http://api.example.com/v1'
        }),
      (err) => err instanceof AiMcpError && err.code === 'security.protocolNotAllowed'
    );
    assert.throws(
      () =>
        new ClaudeProvider({
          id: 'bad-claude',
          name: 'Bad Claude',
          type: 'claude',
          baseUrl: 'https://192.168.1.10/v1'
        }),
      (err) => err instanceof AiMcpError && err.code === 'security.privateNetworkNotAllowed'
    );

    // 显式 allowPrivateNetwork: true 注册私有内网 HTTPS Provider 成功
    const privateProv = router.registerProvider({
      id: 'corp-llm',
      name: 'Corp LLM',
      type: 'custom',
      baseUrl: 'https://10.10.0.5/v1',
      allowPrivateNetwork: true
    });
    assert.equal(privateProv.id, 'corp-llm');
  });

  test('HttpSseTransport rejects unsafe URLs and blocks cross-origin/SSRF SSE endpoint redirects', async () => {
    // 构造器拦截非法 URL
    assert.throws(
      () => new HttpSseTransport({ url: 'http://example.com/mcp' }),
      (err) => err instanceof AiMcpError && err.code === 'security.protocolNotAllowed'
    );
    assert.throws(
      () => new HttpSseTransport({ url: 'https://169.254.169.254/mcp' }),
      (err) => err instanceof AiMcpError && err.code === 'security.blockedMetadataOrLinkLocal'
    );

    // 搭建本地回环 SSE 服务，下发恶意跨源 endpoint 与合法同源 endpoint 进行实测
    let postHitPath = '';
    const server = http.createServer((req, res) => {
      if (req.url === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        // 1. 尝试跨源跳转到恶意公网地址
        res.write('event: endpoint\n');
        res.write('data: https://evil.example.com/steal\n\n');
        // 2. 尝试跳转到云元数据地址
        res.write('event: endpoint\n');
        res.write('data: http://169.254.169.254/latest/meta-data/\n\n');
        // 3. 发送合法同源相对路径
        res.write('event: endpoint\n');
        res.write('data: /messages?session=ok\n\n');
        return;
      }

      if (req.method === 'POST') {
        postHitPath = req.url || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const transport = new HttpSseTransport({ url: `http://127.0.0.1:${port}` });
      const errors = [];
      const messages = [];
      transport.onError((err) => errors.push(err));
      transport.onMessage((msg) => messages.push(msg));

      await transport.connect();
      // 等待 SSE 事件处理完毕
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.ok(
        errors.some((e) => e instanceof AiMcpError && e.code === 'security.crossOriginRedirectBlocked'),
        '跨源 SSE endpoint 必须触发 security.crossOriginRedirectBlocked 错误'
      );
      assert.ok(
        errors.some((e) => e instanceof AiMcpError && e.code === 'security.blockedMetadataOrLinkLocal'),
        '元数据 SSE endpoint 必须触发 security.blockedMetadataOrLinkLocal 错误'
      );

      // 发送消息应打到合法同源端点 /messages?session=ok
      await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.equal(postHitPath, '/messages?session=ok');
      assert.equal(messages.length, 1);

      await transport.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('local-sniffer strictly enforces loopback-only URLs without issuing outbound requests', async () => {
    const nonLoopbackTargets = [
      'https://api.openai.com',
      'http://169.254.169.254',
      'http://192.168.1.50:11434',
      'http://10.0.0.2:1234',
      'file:///etc/passwd',
      'http://user:pass@127.0.0.1:11434'
    ];

    for (const target of nonLoopbackTargets) {
      const ollamaRes = await sniffOllama(target, 500);
      assert.equal(ollamaRes.online, false, `sniffOllama must reject ${target}`);
      assert.equal(ollamaRes.models.length, 0);
      assert.ok(ollamaRes.error, `sniffOllama must return explicit error for ${target}`);

      const lmRes = await sniffLMStudio(target, 500);
      assert.equal(lmRes.online, false, `sniffLMStudio must reject ${target}`);
      assert.equal(lmRes.models.length, 0);
      assert.ok(lmRes.error, `sniffLMStudio must return explicit error for ${target}`);
    }

    const combined = await sniffLocalProviders({
      ollamaUrl: 'http://169.254.169.254',
      lmStudioUrl: 'https://evil.example.com'
    });
    assert.equal(combined.ollama.online, false);
    assert.equal(combined.lmStudio.online, false);
    assert.equal(combined.allOnline.length, 0);
    assert.ok(combined.ollama.error);
    assert.ok(combined.lmStudio.error);
  });

  test('ModelRouter.listProviders() strips apiKey and sensitive headers while preserving internal provider config', () => {
    const router = new ModelRouter();
    router.registerProvider({
      id: 'sec-openai',
      name: 'Secure OpenAI',
      type: 'openai',
      apiKey: 'sk-live-very-secret-key',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      headers: {
        Authorization: 'Bearer raw-secret',
        'X-API-Key': 'raw-x-api-key',
        'api-key': 'raw-azure-key',
        'Proxy-Authorization': 'Basic c2VjcmV0',
        'X-Custom-Tenant': 'tenant-alpha'
      }
    });

    const list = router.listProviders();
    assert.equal(list.length, 1);
    const listed = list[0];

    // apiKey 必须被彻底剥离
    assert.equal('apiKey' in listed, false);
    assert.equal(listed.apiKey, undefined);

    // 敏感头必须被大小写不敏感剥离，非敏感头保留
    assert.deepEqual(listed.headers, { 'X-Custom-Tenant': 'tenant-alpha' });

    // 修改返回的副本不得污染内部 Provider 的原始配置
    listed.headers['X-Custom-Tenant'] = 'mutated';
    listed.models.push('injected-model');

    const internalProvider = router.getProvider('sec-openai');
    assert.equal(internalProvider?.config.apiKey, 'sk-live-very-secret-key');
    assert.equal(internalProvider?.config.headers?.['Authorization'], 'Bearer raw-secret');
    assert.equal(internalProvider?.config.headers?.['X-Custom-Tenant'], 'tenant-alpha');
    assert.deepEqual(internalProvider?.config.models, ['gpt-4o']);
  });
});
