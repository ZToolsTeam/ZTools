import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAiMcpLocale,
  stripAiMcpLocaleSuffix,
  matchAiMcpSupportedLocale,
  tAiMcp,
  AiMcpError,
  AI_MCP_MESSAGES,
  PromptTemplateManager,
  getPresetPromptTemplates,
  createSearchFilesTool,
  createReadClipboardTool,
  createWriteClipboardTool,
  createManageWindowTool,
  getZToolsSystemTools,
  SEARCH_FILES_TOOL,
  READ_CLIPBOARD_TOOL,
  WRITE_CLIPBOARD_TOOL,
  MANAGE_WINDOW_TOOL,
  ZTOOLS_SYSTEM_TOOLS,
  createZToolsSystemToolsServer,
  registerSystemToolsToHost,
  searchFiles,
  writeClipboard,
  manageWindow,
  McpHost,
  McpServer,
  McpToolRegistry,
  ToolValidationError,
  ModelRouter,
  ModelRouterError,
  ExtensionToolManager,
  serializeToolOutput,
  executeToolEntryPoint,
  InMemoryTransport
} from '../dist/index.js';

/**
 * 在回调期间临时覆盖 globalThis.__ztoolsLocale，并在结束后可靠恢复
 */
async function withGlobalLocale(locale, fn) {
  const prevExists = Object.prototype.hasOwnProperty.call(globalThis, '__ztoolsLocale');
  const prevValue = globalThis.__ztoolsLocale;
  if (locale === undefined) {
    delete globalThis.__ztoolsLocale;
  } else {
    globalThis.__ztoolsLocale = locale;
  }
  try {
    return await fn();
  } finally {
    if (prevExists) {
      globalThis.__ztoolsLocale = prevValue;
    } else {
      delete globalThis.__ztoolsLocale;
    }
  }
}

const CJK_REGEX = /[\u4e00-\u9fff]/;

describe('ai-mcp i18n support', () => {
  test('resolveAiMcpLocale resolves explicit locale, globalThis.__ztoolsLocale, and defaults to en-US', async () => {
    await withGlobalLocale(undefined, () => {
      assert.equal(resolveAiMcpLocale(), 'en-US');
      assert.equal(resolveAiMcpLocale(''), 'en-US');
      assert.equal(resolveAiMcpLocale('ja-JP'), 'en-US');
      assert.equal(resolveAiMcpLocale('zh'), 'zh-CN');
      assert.equal(resolveAiMcpLocale('zh-CN'), 'zh-CN');
      assert.equal(resolveAiMcpLocale('zh_HK'), 'zh-CN');
      assert.equal(resolveAiMcpLocale('zh-Hans'), 'zh-CN');
    });

    await withGlobalLocale('zh-CN', () => {
      assert.equal(resolveAiMcpLocale(), 'zh-CN');
      assert.equal(resolveAiMcpLocale('en-US'), 'en-US');
    });
  });

  test('all 5 preset prompt templates output complete bilingual fields and react to runtime locale', async () => {
    const presetNames = [
      'file_search_assistant',
      'code_reviewer',
      'summarizer',
      'tool_dispatch_planner',
      'json_extractor'
    ];
    const manager = new PromptTemplateManager();

    // 1. en-US 预设模板不含任何硬编码中文
    await withGlobalLocale(undefined, () => {
      const enPresets = getPresetPromptTemplates();
      assert.equal(enPresets.length, 5);
      for (const name of presetNames) {
        const tpl = manager.getTemplate(name);
        assert.ok(tpl, `missing preset ${name}`);
        assert.equal(CJK_REGEX.test(tpl.description || ''), false, `${name} en description contains CJK`);
        assert.equal(CJK_REGEX.test(tpl.systemPrompt || ''), false, `${name} en systemPrompt contains CJK`);
        assert.equal(CJK_REGEX.test(tpl.template), false, `${name} en template contains CJK`);
        if (tpl.defaultValues) {
          for (const val of Object.values(tpl.defaultValues)) {
            assert.equal(CJK_REGEX.test(val), false, `${name} en defaultValue contains CJK`);
          }
        }
      }

      const codeMsgs = manager.renderMessages('code_reviewer', {
        language: 'ts',
        code: 'const x = 1;'
      });
      assert.equal(codeMsgs[0].role, 'system');
      assert.ok(codeMsgs[0].content.includes('code review'));
      assert.ok(codeMsgs[1].content.includes('Untitled file'));
    });

    // 2. 运行时切换到 zh-CN，同一个 PromptTemplateManager 实例自动输出中文
    await withGlobalLocale('zh-CN', () => {
      for (const name of presetNames) {
        const tpl = manager.getTemplate(name);
        assert.ok(tpl);
        assert.equal(CJK_REGEX.test(tpl.description || ''), true, `${name} zh description missing CJK`);
        assert.equal(CJK_REGEX.test(tpl.systemPrompt || ''), true, `${name} zh systemPrompt missing CJK`);
        assert.equal(CJK_REGEX.test(tpl.template), true, `${name} zh template missing CJK`);
      }

      const zhSummary = manager.renderMessages('summarizer', { text: '测试文本' });
      assert.ok(zhSummary[0].content.includes('内容提炼与摘要助手'));
      assert.ok(zhSummary[1].content.includes('3 条核心要点'));

      // 显式参数 locale 覆盖全局 zh-CN
      const enOverride = manager.renderMessages('tool_dispatch_planner', {
        tools: 'search_files',
        goal: 'find config'
      }, 'en-US');
      assert.ok(enOverride[0].content.includes('intelligent system action planner'));
      assert.ok(enOverride[1].content.includes('User goal: find config'));
    });

    // 3. 实例级 locale 选项与自定义模板覆盖/卸载兼容
    const zhManager = new PromptTemplateManager({ locale: 'zh-CN' });
    await withGlobalLocale('en-US', () => {
      const tpl = zhManager.getTemplate('json_extractor');
      assert.ok(tpl?.systemPrompt?.includes('JSON 数据抽取器'));
      assert.equal(zhManager.unregisterTemplate('json_extractor'), true);
      assert.equal(zhManager.getTemplate('json_extractor'), undefined);
      assert.equal(zhManager.listTemplates().some(t => t.name === 'json_extractor'), false);
    });
  });

  test('all 4 built-in MCP system tools support bilingual descriptions and parameter schemas', async () => {
    // 静态导出保持向后兼容（默认 en-US）
    assert.equal(ZTOOLS_SYSTEM_TOOLS.length, 4);
    assert.equal(SEARCH_FILES_TOOL.name, 'search_files');
    assert.equal(READ_CLIPBOARD_TOOL.name, 'read_clipboard');
    assert.equal(WRITE_CLIPBOARD_TOOL.name, 'write_clipboard');
    assert.equal(MANAGE_WINDOW_TOOL.name, 'manage_window');

    const enTools = getZToolsSystemTools('en-US');
    const zhTools = getZToolsSystemTools('zh-CN');
    assert.equal(enTools.length, 4);
    assert.equal(zhTools.length, 4);

    // 递归校验所有 description 字段在 en-US 无中文、在 zh-CN 含中文
    const collectDescriptions = (obj, acc = []) => {
      if (!obj || typeof obj !== 'object') return acc;
      if (typeof obj.description === 'string') {
        acc.push(obj.description);
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
          collectDescriptions(value, acc);
        }
      }
      return acc;
    };

    const enDescs = collectDescriptions(enTools);
    const zhDescs = collectDescriptions(zhTools);
    assert.equal(enDescs.length, 17);
    assert.equal(zhDescs.length, 17);

    for (const desc of enDescs) {
      assert.equal(CJK_REGEX.test(desc), false, `en-US schema description should not contain CJK: ${desc}`);
    }
    for (const desc of zhDescs) {
      assert.equal(CJK_REGEX.test(desc), true, `zh-CN schema description should contain CJK: ${desc}`);
    }

    // 校验 4 个独立工厂函数遵循 globalThis.__ztoolsLocale
    await withGlobalLocale('zh-CN', () => {
      assert.ok(createSearchFilesTool().description.includes('快速检索'));
      assert.ok(createReadClipboardTool().description.includes('读取系统剪贴板'));
      assert.ok(createWriteClipboardTool().description.includes('写入系统剪贴板'));
      assert.ok(createManageWindowTool().description.includes('桌面客户端窗口形态'));
    });

    // 校验 createZToolsSystemToolsServer 和 registerSystemToolsToHost 透传/响应 locale
    const zhServer = createZToolsSystemToolsServer({ name: 'zh-sys', locale: 'zh-CN' });
    const zhRegistered = zhServer.registry.listTools();
    assert.ok(zhRegistered.every(t => CJK_REGEX.test(t.description || '')));

    const host = new McpHost({ name: 'i18n-test-host' });
    await withGlobalLocale('zh-CN', async () => {
      await registerSystemToolsToHost(host, 'en-sys', { locale: 'en-US' });
    });
    const hostTools = host.listTools();
    assert.equal(hostTools.length, 4);
    for (const tool of hostTools) {
      assert.equal(CJK_REGEX.test(tool.description || ''), false, `expected en-US tool description for ${tool.name}`);
    }
    await host.disconnectAll();
  });

  test('explicit locale overrides runtime default for AI/MCP errors, PromptTemplateManager, and system tools', async () => {
    // 校验 AI_MCP_MESSAGES 双语键集对齐
    assert.deepEqual(
      Object.keys(AI_MCP_MESSAGES['en-US']).sort(),
      Object.keys(AI_MCP_MESSAGES['zh-CN']).sort()
    );
    assert.equal(tAiMcp('prompt.emptyName', undefined, 'zh-CN'), '模板名称不能为空');
    assert.equal(tAiMcp('prompt.emptyName', undefined, 'en-US'), 'Template name cannot be empty');

    await withGlobalLocale('en-US', async () => {
      // PromptTemplateManager: 实例 locale 与调用级 locale 覆盖全局 en-US
      const zhManager = new PromptTemplateManager({ locale: 'zh-CN' });
      assert.equal(zhManager.getLocale(), 'zh-CN');
      assert.throws(() => zhManager.registerTemplate({ name: '   ', template: 'x', variables: [] }), /模板名称不能为空/);
      assert.throws(() => zhManager.render('missing_tpl', {}), /未找到 Prompt 模板 "missing_tpl"/);
      assert.throws(() => zhManager.render('summarizer', {}), /缺少必填变量 "text"/);
      // 调用级 locale 覆盖实例 zh-CN
      assert.throws(() => zhManager.render('missing_tpl', {}, 'en-US'), /Prompt template "missing_tpl" not found/);
      assert.throws(() => zhManager.renderMessages('missing_tpl', {}, 'en-US'), /Prompt template "missing_tpl" not found/);
      zhManager.setLocale('en-US');
      assert.equal(zhManager.getLocale(), 'en-US');
      assert.throws(() => zhManager.render('missing_tpl', {}), /Prompt template "missing_tpl" not found/);

      // 系统工具显式 locale 覆盖全局 en-US
      await assert.rejects(() => searchFiles({ query: '   ', locale: 'zh-CN' }), /搜索关键词不能为空/);
      await assert.rejects(() => searchFiles({ query: 'abc', directory: './__nonexistent_dir_i18n__' }, 'zh-CN'), /目录不存在/);
      await assert.rejects(() => writeClipboard({ text: null, locale: 'zh-CN' }), /剪贴板文本内容必须为字符串/);
      await assert.rejects(() => manageWindow({ action: 'invalid_action', locale: 'zh-CN' }), /不支持的窗口操作/);
    });

    await withGlobalLocale('zh-CN', async () => {
      // 全局 zh-CN 时，显式传 en-US 必须覆盖为英文
      await assert.rejects(() => searchFiles({ query: '', locale: 'en-US' }), /Search query cannot be empty/);
      await assert.rejects(() => writeClipboard({ text: 123 }, 'en-US'), /Clipboard text content must be a string/);
      await assert.rejects(() => manageWindow({ action: 'unknown' }, 'en-US'), /Unsupported window action/);
    });
  });

  test('resolveAiMcpLocale strips POSIX suffixes, skips system/third-party, and reads ZTOOLS_LOCALE', async () => {
    const prevEnv = process.env.ZTOOLS_LOCALE;
    delete process.env.ZTOOLS_LOCALE;
    try {
      assert.equal(stripAiMcpLocaleSuffix('zh_CN.UTF-8'), 'zh-CN');
      assert.equal(stripAiMcpLocaleSuffix('en_US@euro'), 'en-US');
      assert.equal(matchAiMcpSupportedLocale('system'), null);
      assert.equal(matchAiMcpSupportedLocale('ja-JP'), null);
      assert.equal(matchAiMcpSupportedLocale('fr-FR'), null);
      assert.equal(matchAiMcpSupportedLocale('zh_CN.UTF-8'), 'zh-CN');

      await withGlobalLocale(undefined, () => {
        assert.equal(resolveAiMcpLocale(['system', 'fr-FR', 'zh_CN.UTF-8']), 'zh-CN');
        assert.equal(resolveAiMcpLocale(['system', 'ja-JP']), 'en-US');
        assert.equal(resolveAiMcpLocale('en_US@euro'), 'en-US');
      });

      await withGlobalLocale('zh_CN.UTF-8', () => {
        // 显式传 'system' 时跳过并顺延到 globalThis.__ztoolsLocale
        assert.equal(resolveAiMcpLocale('system'), 'zh-CN');
        assert.equal(resolveAiMcpLocale('en_GB@euro'), 'en-US');
      });

      await withGlobalLocale(undefined, () => {
        process.env.ZTOOLS_LOCALE = 'zh_TW.UTF-8';
        assert.equal(resolveAiMcpLocale(), 'zh-CN');
        assert.equal(resolveAiMcpLocale('system'), 'zh-CN');
        assert.equal(resolveAiMcpLocale('en-US'), 'en-US');
      });
    } finally {
      if (prevEnv === undefined) delete process.env.ZTOOLS_LOCALE;
      else process.env.ZTOOLS_LOCALE = prevEnv;
    }
  });

  test('AiMcpError & bilingual errors across host, registry, server, model-router, and extension-tools', async () => {
    // 1. 校验全部词典键对齐且 en-US 无中文、zh-CN 无空值
    const enKeys = Object.keys(AI_MCP_MESSAGES['en-US']).sort();
    const zhKeys = Object.keys(AI_MCP_MESSAGES['zh-CN']).sort();
    assert.deepEqual(enKeys, zhKeys);
    assert.ok(enKeys.length >= 45, `Expected >= 45 AI/MCP message keys, got ${enKeys.length}`);
    for (const key of enKeys) {
      assert.equal(CJK_REGEX.test(AI_MCP_MESSAGES['en-US'][key]), false, `en-US key ${key} contains CJK`);
      assert.ok(AI_MCP_MESSAGES['zh-CN'][key].trim().length > 0, `zh-CN key ${key} is empty`);
    }

    // 2. AiMcpError 保持 instanceof Error 向下兼容且携带 code 与 params
    const sampleErr = new AiMcpError('mcp.host.serverNotConnected', { serverName: 'demo' }, 'zh-CN');
    assert.ok(sampleErr instanceof Error);
    assert.ok(sampleErr instanceof AiMcpError);
    assert.equal(sampleErr.code, 'mcp.host.serverNotConnected');
    assert.deepEqual(sampleErr.params, { serverName: 'demo' });
    assert.match(sampleErr.message, /未连接/);

    // 3. 验证 5 个模块在 en-US 与 zh-CN 下均正确抛出双语结构化错误
    for (const [locale, expected] of [
      ['en-US', {
        hostNotConn: /Server "ghost" not connected/,
        hostToolMissing: /was not found on any connected MCP server/,
        regEmpty: /Tool name cannot be empty/,
        regRequired: /Missing required parameter: "q"/,
        regNotFound: /Tool "nope" not found/,
        srvMethod: /Method "unknown\/op" is not supported/,
        routerNoId: /Provider config must have an id/,
        routerNoProv: /No AI provider registered or selected/,
        routerNotReg: /Provider "missing" is not registered/,
        extBigInt: /BigInt cannot be serialized to JSON/,
        extArgsArr: /must be an object, not an array/,
        extManifestId: /Invalid extension manifest: id is required/
      }],
      ['zh-CN', {
        hostNotConn: /MCP 服务 "ghost" 未连接/,
        hostToolMissing: /所有已连接的 MCP 服务中均未找到工具/,
        regEmpty: /工具名称不能为空/,
        regRequired: /缺少必填参数: "q"/,
        regNotFound: /未找到工具 "nope"/,
        srvMethod: /不支持的 MCP 方法 "unknown\/op"/,
        routerNoId: /模型服务商配置必须包含 id/,
        routerNoProv: /尚未注册或选择任何 AI 模型服务商/,
        routerNotReg: /模型服务商 "missing" 尚未注册/,
        extBigInt: /BigInt 无法序列化为 JSON/,
        extArgsArr: /不能为数组/,
        extManifestId: /缺少必填字段 id/
      }]
    ]) {
      await withGlobalLocale(locale, async () => {
        // host.ts
        const host = new McpHost();
        await assert.rejects(
          () => host.refreshServerTools('ghost'),
          (err) => err instanceof AiMcpError && err instanceof Error && err.code === 'mcp.host.serverNotConnected' && expected.hostNotConn.test(err.message)
        );
        await assert.rejects(
          () => host.callTool('missing_tool'),
          (err) => err instanceof AiMcpError && err.code === 'mcp.host.toolNotFoundAnyServer' && expected.hostToolMissing.test(err.message)
        );

        // registry.ts
        const registry = new McpToolRegistry();
        assert.throws(
          () => registry.registerTool({ name: '  ', description: '', inputSchema: { type: 'object', properties: {} } }, () => 'ok'),
          (err) => err instanceof AiMcpError && err.code === 'mcp.registry.emptyToolName' && expected.regEmpty.test(err.message)
        );
        assert.throws(
          () => registry.validateArgs({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, {}),
          (err) => err instanceof ToolValidationError && err.i18nCode === 'mcp.registry.missingRequiredParam' && expected.regRequired.test(err.message)
        );
        await assert.rejects(
          () => registry.executeTool('nope'),
          (err) => err instanceof AiMcpError && err.code === 'mcp.registry.toolNotFound' && expected.regNotFound.test(err.message)
        );

        // server.ts
        const server = new McpServer();
        const [clientT, serverT] = InMemoryTransport.createPair();
        await server.connect(serverT);
        const srvHost = new McpHost();
        await srvHost.connectServer('srv', clientT);
        await assert.rejects(
          () => srvHost.sendRequest('srv', 'unknown/op', {}),
          (err) => err instanceof AiMcpError && err.code === 'mcp.host.rpcError' && expected.srvMethod.test(err.message)
        );
        await srvHost.disconnectAll();

        // model-router.ts
        const router = new ModelRouter();
        assert.throws(
          () => router.registerProvider({ id: '', type: 'openai', apiKey: 'k', model: 'm' }),
          (err) => err instanceof AiMcpError && err.code === 'router.providerIdRequired' && expected.routerNoId.test(err.message)
        );
        assert.throws(
          () => router.setDefaultProvider('missing'),
          (err) => err instanceof AiMcpError && err.code === 'router.providerNotRegistered' && expected.routerNotReg.test(err.message)
        );
        await assert.rejects(
          () => router.chat({ messages: [{ role: 'user', content: 'hi' }] }),
          (err) => err instanceof AiMcpError && err.code === 'router.noProviderSelected' && expected.routerNoProv.test(err.message)
        );

        // extension-tools.ts
        const bigIntRes = serializeToolOutput(123n);
        assert.equal(bigIntRes.isError, true);
        assert.match(bigIntRes.content[0].text, expected.extBigInt);

        const arrArgsRes = await executeToolEntryPoint({ toolPath: 'nonexistent.js', args: [1, 2] });
        assert.equal(arrArgsRes.isError, true);
        assert.match(arrArgsRes.content[0].text, expected.extArgsArr);

        const extMgr = new ExtensionToolManager();
        await assert.rejects(
          () => extMgr.registerExtension({ id: '' }),
          (err) => err instanceof AiMcpError && err.code === 'extTools.manifestIdRequired' && expected.extManifestId.test(err.message)
        );
      });
    }
  });
});
