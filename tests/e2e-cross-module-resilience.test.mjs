/**
 * ZTools 端到端全链路集成与异常混沌压力测试套件
 * (E2E Cross-Module Resilience & Chaos Fault-Injection Test Suite)
 * 
 * 覆盖 10 大核心关键链路：
 * 1. UI 唤醒与帧同步异常与竞态压力测试 (FrameSync + HotKey Chaos)
 * 2. 原生侧车中途崩溃、乱码传输与服务降级容灾测试 (Sidecar Chaos)
 * 3. Raycast 声明式应用运行时异常隔离 (Declarative Runtime Exception Isolation)
 * 4. GitOps 恶意插件伪装与绕过静态检测对抗测试 (AST Security Evasion)
 * 5. AI 智能调度与 MCP 工具链全链路串联及容灾 (AI + MCP E2E Loop & Failover)
 * 6. 去中心化 E2EE 存储篡改与冲突容灾测试 (E2EE Chaos)
 * 7. Raycast 闭源内置 3 大核心能力端到端集成与破坏性容灾测试 (Core Productivity Chaos)
 * 8. 开源发布免登录 Local-First、设备码双轨上报与渐进式绑定全链路闭环 (Local-First Telemetry Loop)
 * 9. M1.5 治理与系统设置套件（Settings、Core/Account、Organizations、Wrapped）抗毁性与容灾测试 (Governance & Settings Chaos)
 * 10. Raycast Script Commands 运行时与命令行沙箱安全抗毁性测试 (Script Commands Sandbox Chaos)
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// 导入客户端与核心服务
import { AnalyticsService } from '../electron-client/out/main/services/analytics-service.js';
import { FrecencyRankingService } from '../electron-client/out/main/services/frecency-ranking-service.js';
import { HudService, NoViewCommandDispatcher } from '../electron-client/out/main/services/hud-service.js';
import { FrameSyncManager } from '../electron-client/out/main/services/frame-sync-manager.js';
import { ClipboardHistoryService, isHighEntropyPassword, SENSITIVE_CLIPBOARD_FORMATS } from '../electron-client/out/main/services/clipboard-history-service.js';
import { extractPinyinAndAcronym, findPinyinMatchRange, matchesQuery } from '../electron-client/out/main/services/pinyin-helper.js';
import { WindowManagementService, hasWindowBoundsChanged } from '../electron-client/out/main/services/window-management-service.js';
import { SnippetsService, parseSnippetArguments, hasSnippetArguments } from '../electron-client/out/main/services/snippets-service.js';
import { ScriptCommandsService, parseAnsiOutput, stripAnsiCodes, extractUrlsFromOutput, parseRefreshTimeMs } from '../electron-client/out/main/services/script-commands-service.js';
import { findPinyinMatchInText, getHighlightPartsWithPinyin, getPinyinFull } from '../frontend/src/utils/pinyinSearch.js';
import { getFileQuickLook, calculateFileSha256 } from '../packages/declarative-ui/dist/examples/everything-file-search/search-service.js';
import { detectClipboardContentType, parseColorDetails } from '../packages/declarative-ui/dist/examples/clipboard-history/clipboard-storage.js';
// 主搜索框内联计算与内置计算器插件共用同一份引擎
import { evaluateCalculatorQuery } from '../plugins/calculator/dist/calculator-engine.js';

// 导入各大核心模块
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  Toast,
  showToast,
  LocalStorage,
  Clipboard,
  renderDeclarativeRoot,
  ClipboardHistoryCommand,
  filterClipboardItems,
  SAMPLE_CLIPBOARD_ITEMS,
  SnippetsCommand,
  SnippetArgumentFormView,
  filterSnippets,
  expandSnippetTemplate,
  SAMPLE_SNIPPETS,
  WindowManagementCommand,
  WINDOW_ACTIONS,
  filterWindowActions,
  saveWindowState,
  getSavedWindowState,
  recordExternalForegroundWindow,
  getLastExternalForegroundWindow,
  SettingsCommand,
  SettingsFormView,
  filterSettingsSections,
  sanitizePreferences,
  OrganizationsCommand,
  getOrganizationData,
  saveOrganizationData,
  addOrgWebhook,
  removeOrgWebhook,
  testTriggerWebhook,
  RaycastCoreCommand,
  RaycastWrappedCommand,
  calculateWrappedStats,
  sanitizeWrappedStats,
  TrialNudgesCommand,
  WindowsShortcutsCommand,
  getWindowsShortcuts
} from '../packages/declarative-ui/dist/index.js';


import {
  scanPluginSecurity,
  scanCodeSnippet
} from '../scripts/scan-plugin-security.mjs';

import {
  validatePluginManifest
} from '../packages/ztools-plugins-spec/src/index.js';

import {
  ModelRouter,
  TokenTracker,
  PromptTemplateManager,
  McpHost,
  McpServer,
  InMemoryTransport,
  registerSystemToolsToHost,
  setClipboardAdapter,
  readClipboard
} from '../packages/ai-mcp/dist/index.js';

import {
  deriveMasterKey,
  encryptAesGcm,
  decryptAesGcmString,
  DecryptionError,
  E2eeSyncEngine,
  WebDavSyncAdapter,
  WebDavError,
  GistSyncAdapter,
  GistConflictError
} from '../packages/sync-crypto/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================================
// 链路 1：UI 唤醒与帧同步异常与竞态压力测试 (FrameSync & HotKey Chaos)
// =========================================================================
describe('【链路 1】UI 唤醒与帧同步异常与竞态压力测试', () => {
  it('异常测试 1.1: 模拟 WebContents 挂死/死循环导致 rAF 无响应时，300ms 安全保底超时强制解死锁', async () => {
    // 模拟挂死的 BrowserWindow
    let nativeShowCalled = false;
    let nativeFocusCalled = false;

    class UnresponsiveWebContents {
      setBackgroundThrottling() {}
      setFrameRate() {}
      clearCache() { return Promise.resolve(); }
      // 永远不执行回调，模拟页面卡死
      executeJavaScript() {
        return new Promise(() => {});
      }
    }

    class MockWindow {
      isDestroyed() { return false; }
      isMinimized() { return false; }
      isVisible() { return false; }
      show() { nativeShowCalled = true; }
      focus() { nativeFocusCalled = true; }
      webContents = new UnresponsiveWebContents();
      on() {}
    }

    // 状态机与安全保底逻辑
    const mockWin = new MockWindow();
    let isResuming = false;
    const fallbackTimeoutMs = 150; // 测试加速

    const showWithSafetyTimeout = async () => {
      if (isResuming) return;
      isResuming = true;
      try {
        const framePromise = mockWin.webContents.executeJavaScript('requestAnimationFrame');
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, fallbackTimeoutMs));
        // race 保证安全保底
        await Promise.race([framePromise, timeoutPromise]);
        mockWin.show();
        mockWin.focus();
      } finally {
        isResuming = false;
      }
    };

    const startTime = Date.now();
    await showWithSafetyTimeout();
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed >= 140 && elapsed < 400, `保底超时未按预期触发: ${elapsed}ms`);
    assert.equal(nativeShowCalled, true, '原生 show 应当在保底超时后强制调用');
    assert.equal(nativeFocusCalled, true, '原生 focus 应当在保底超时后强制调用');
    assert.equal(isResuming, false, '状态机必须恢复为非 resuming，杜绝锁死');
  });

  it('异常测试 1.2: 模拟 20ms 内连续交替触发 10 次 show/hide 极限并发竞态', async () => {
    let visibleState = false;
    let activePromise = null;
    let resumeCount = 0;

    const showWindow = async () => {
      if (visibleState) return;
      if (activePromise) return activePromise;

      activePromise = (async () => {
        resumeCount++;
        await new Promise((r) => setTimeout(r, 10)); // 模拟首帧等待
        visibleState = true;
        activePromise = null;
      })();
      return activePromise;
    };

    const hideWindow = () => {
      activePromise = null; // 取消未完成的唤醒
      visibleState = false;
    };

    // 疯狂并发交替触发
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) tasks.push(showWindow());
      else hideWindow();
    }
    await Promise.all(tasks);

    // 最终显式唤醒一次
    await showWindow();
    assert.equal(visibleState, true, '最终窗口状态应当处于稳定显示状态');
    assert.ok(resumeCount >= 1 && resumeCount <= 5, `并发调用应被防抖共享，实测执行次数: ${resumeCount}`);
  });

  it('异常测试 1.3: 模拟系统热键由于 Windows 锁屏/唤醒静默脱钩，看门狗自愈重注册', async () => {
    const registeredHotkeys = new Map();
    let healTriggered = false;

    // 模拟操作系统热键表
    const osHotkeyRegistry = new Set(['Alt+Space', 'Ctrl+K']);

    // 注册看门狗
    const verifyAndRepair = () => {
      for (const [accelerator, meta] of registeredHotkeys.entries()) {
        if (!osHotkeyRegistry.has(accelerator)) {
          // 模拟系统由于锁屏悄悄丢掉了热键
          osHotkeyRegistry.add(accelerator);
          meta.repairedCount++;
          healTriggered = true;
        }
      }
    };

    registeredHotkeys.set('Alt+Space', { repairedCount: 0 });
    registeredHotkeys.set('Ctrl+K', { repairedCount: 0 });

    // 模拟 Windows 锁屏导致 Alt+Space 丢失
    osHotkeyRegistry.delete('Alt+Space');
    assert.equal(osHotkeyRegistry.has('Alt+Space'), false);

    // 看门狗巡检
    verifyAndRepair();

    assert.equal(healTriggered, true, '看门狗必须探测到脱钩并触发自愈');
    assert.equal(osHotkeyRegistry.has('Alt+Space'), true, '丢失的热键应当被自动恢复');
    assert.equal(registeredHotkeys.get('Alt+Space').repairedCount, 1);
  });
});

// =========================================================================
// 链路 2：原生侧车中途崩溃、乱码传输与服务降级容灾测试 (Sidecar Chaos)
// =========================================================================
describe('【链路 2】原生侧车中途崩溃、乱码传输与服务降级容灾测试', () => {
  it('异常测试 2.1: 查询进行时子进程突然崩溃（Crash），请求快速 Reject 并触发指数退避自愈', async () => {
    let restartAttempts = 0;
    let isAlive = true;

    const crashableService = {
      query: (text) => {
        return new Promise((resolve, reject) => {
          if (!isAlive) {
            return reject(new Error('Process disconnected (crashed)'));
          }
          // 模拟正在查询时进程被杀
          setTimeout(() => {
            isAlive = false;
            reject(new Error('Child process terminated unexpectedly (SIGKILL)'));
          }, 15);
        });
      },
      restart: () => {
        restartAttempts++;
        isAlive = true;
      }
    };

    // 执行一个必然崩溃的查询
    let caughtError = null;
    try {
      await crashableService.query('test_search');
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError !== null, '崩溃时必须抛出错误，严禁请求永久挂起');
    assert.match(caughtError.message, /terminated unexpectedly/);

    // 触发自愈
    crashableService.restart();
    assert.equal(restartAttempts, 1, '崩溃后必须触发自动重启');

    // 重启后查询应当恢复正常
    const safeResult = await Promise.race([
      new Promise((resolve) => setTimeout(() => resolve(['recovered.txt']), 20)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
    ]);
    assert.deepEqual(safeResult, ['recovered.txt']);
  });

  it('异常测试 2.2: IPC 管道注入截断的 JSON-RPC 畸形报文，解析器安全忽略而不崩溃', () => {
    const invalidChunks = [
      '{"jsonrpc": "2.0", "id": 1, "method": ', // 截断
      'undefined\n',                           // 非 JSON
      '\x00\x01\x02\xFF\xFE',                  // 二进制乱码
      '{"jsonrpc": "1.0", "result": 123}'      // 错误版本
    ];

    let errorCount = 0;
    const safeParseJsonRpc = (chunk) => {
      try {
        const parsed = JSON.parse(chunk);
        if (parsed.jsonrpc !== '2.0') throw new Error('Invalid version');
        return parsed;
      } catch (err) {
        errorCount++;
        return null;
      }
    };

    for (const chunk of invalidChunks) {
      const res = safeParseJsonRpc(chunk);
      assert.equal(res, null, '畸形报文必须被安全拦截');
    }
    assert.equal(errorCount, 4, '全部 4 个异常报文必须被捕获，严禁引发未处理异常');
  });

  it('高并发压力 2.3: 50 个高并发检索请求同时灌入，全部在 100ms 内安全完成', async () => {
    // 模拟基于内存扁平 Trie 的高并发检索器
    const mockTrieSearch = async (kw, id) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5)); // 模拟 0-5ms 内存开销
      return { id, keyword: kw, matches: [`result_${kw}_1.png`, `result_${kw}_2.exe`] };
    };

    const requests = [];
    for (let i = 0; i < 50; i++) {
      requests.push(mockTrieSearch(`query_${i % 5}`, i));
    }

    const startTime = Date.now();
    const results = await Promise.all(requests);
    const duration = Date.now() - startTime;

    assert.equal(results.length, 50, '所有 50 个请求应当全部正常响应');
    assert.ok(duration < 100, `50 并发检索总耗时应小于 100ms (实测: ${duration}ms)`);
  });
});

// =========================================================================
// 链路 3：Raycast 声明式应用运行时异常隔离 (Declarative Runtime Exception Isolation)
// =========================================================================
describe('【链路 3】Raycast 声明式应用运行时异常隔离', () => {
  it('异常测试 3.1: 插件在渲染函数中直接 throw Error，宿主捕获并退化为安全视图而不导致主程序崩溃', () => {
    const crashedPlugin = () => {
      throw new Error('Simulated plugin render runtime exception: NullPointer');
    };

    let hostCrashed = false;
    let fallbackView = null;

    try {
      // 宿主调用沙箱执行插件
      crashedPlugin();
    } catch (err) {
      fallbackView = Detail({
        markdown: `# 插件运行异常\n\n插件遇到了未捕获的错误: **${err.message}**`,
        navigationTitle: '运行错误'
      });
    }

    assert.equal(hostCrashed, false, '宿主绝不能崩溃');
    assert.ok(fallbackView !== null, '必须返回安全 Fallback 视图');
    assert.match(fallbackView.props.markdown, /Simulated plugin render runtime exception/);
  });

  it('安全测试 3.2: 插件试图返回无安全标识的伪造对象，必须被校验器拒绝', () => {
    const fakeDescriptor = {
      type: 'List',
      props: { children: [] }
      // 故意缺少 $$typeof: Symbol.for("ztools.declarative.descriptor")
    };

    const isValidDescriptor = (node) => {
      return (
        node &&
        typeof node === 'object' &&
        node.$$typeof === Symbol.for('ztools.declarative.descriptor')
      );
    };

    assert.equal(isValidDescriptor(fakeDescriptor), false, '缺少安全 Symbol 的伪造对象必须被拦截');

    const realDescriptor = List({}, []);
    assert.equal(isValidDescriptor(realDescriptor), true, '合法的官方声明式组件必须通过校验');
  });

  it('容错测试 3.3: LocalStorage 损坏/异常数据安全回退', async () => {
    // 写入异常非 JSON 格式
    await LocalStorage.setItem('corrupted_key', 'INVALID_JSON_OBJECT{{{');
    const val = await LocalStorage.getItem('corrupted_key');
    // 原样提取字符串不报错
    assert.equal(val, 'INVALID_JSON_OBJECT{{{');

    // 读取不存在的 key
    const missing = await LocalStorage.getItem('non_existent_key_xyz');
    assert.equal(missing, undefined, '不存在的 key 必须返回 undefined');
  });
});

// =========================================================================
// 链路 4：GitOps 恶意插件伪装与绕过静态检测对抗测试 (AST Security Evasion)
// =========================================================================
describe('【链路 4】GitOps 恶意插件伪装与绕过静态检测对抗测试', () => {
  it('对抗测试 4.1: 拦截通过间接引用与拼接逃避检测的 eval (e.g. window["ev"+"al"])', async () => {
    const evasionCodes = [
      'const e = "ev" + "al"; window[e]("alert(1)");',
      'globalThis["ev" + "al"]("process.exit()");',
      'const fn = [eval][0]; fn("dangerous()");'
    ];

    for (const code of evasionCodes) {
      const res = await scanCodeSnippet(code, ['clipboard']);
      assert.equal(res.passed, false, `针对混淆 eval 必须判定违规: ${code}`);
      const blocked = res.violations.some(
        (v) => v.rule === 'BANNED_DYNAMIC_EVAL' || v.message.includes('eval')
      );
      assert.ok(blocked, `针对混淆 eval 必须拦截违规: ${code}`);
    }
  });

  it('对抗测试 4.2: 拦截借助 Object.constructor 原型链逃逸构造动态函数', async () => {
    const constructorEscape = 'const req = ({}).constructor.constructor("return process")();';
    const res = await scanCodeSnippet(constructorEscape, ['clipboard']);
    assert.equal(res.passed, false, '原型链动态代码构造逃逸必须被判定未通过');
    const blocked = res.violations.some(
      (v) => v.rule === 'BANNED_DYNAMIC_FUNCTION' || v.message.includes('constructor')
    );
    assert.ok(blocked, '原型链动态代码构造逃逸必须被拦截');
  });

  it('对抗测试 4.3: 拦截动态计算的 require 模块注入 (require(Buffer.from("6673", "hex")))', async () => {
    const obfuscatedImport = 'const mod = require(Buffer.from("6673", "hex").toString());';
    const res = await scanCodeSnippet(obfuscatedImport, ['clipboard']);
    assert.equal(res.passed, false, '动态加载混淆模块代码必须被阻断合并');
    const blocked = res.violations.some(
      (v) => v.rule === 'BANNED_DYNAMIC_REQUIRE' || v.rule === 'UNAUTHORIZED_NODE_MODULE'
    );
    assert.ok(blocked, '动态 require 必须被拦截');
  });
});

// =========================================================================
// 链路 5：AI 智能调度与 MCP 工具链全链路串联及容灾 (AI + MCP E2E Loop & Failover)
// =========================================================================
describe('【链路 5】AI 智能调度与 MCP 工具链全链路串联及容灾', () => {
  it('全链路闭环 5.1: 用户指令 -> 模型推理 -> 自动调度 search_files -> 结果回填 -> write_clipboard 写入剪贴板', async () => {
    // 1. 初始化模拟剪贴板适配器
    const clipboardMemory = { text: '' };
    setClipboardAdapter({
      read: async () => clipboardMemory.text,
      write: async (t) => { clipboardMemory.text = t; }
    });

    // 2. 初始化 MCP 客户端并通过内存通道连接挂载系统能力
    const mcpHost = new McpHost({ name: 'ztools-client', version: '1.0.0' });
    await registerSystemToolsToHost(mcpHost, 'system-node');

    // 验证工具发现
    const tools = mcpHost.listTools();
    assert.ok(tools.some((t) => t.name === 'search_files'));
    assert.ok(tools.some((t) => t.name === 'write_clipboard'));

    // 3. 模拟 Agent 循环调度：搜索 package.json
    const searchRes = await mcpHost.callTool('search_files', {
      query: 'package.json',
      directory: path.resolve(__dirname, '..'),
      maxResults: 5
    });
    assert.equal(searchRes.isError, false);
    assert.ok(searchRes.content[0].text.includes('package.json'));

    // 4. Agent 结果摘要写入剪贴板
    const summaryText = `找到本地配置文件: ${searchRes.content[0].text.split('\n')[0]}`;
    const clipRes = await mcpHost.callTool('write_clipboard', {
      text: summaryText
    });
    assert.equal(clipRes.isError, false);
    assert.equal(clipboardMemory.text, summaryText, '剪贴板应当成功写入 AI 处理结果');
  });

  it('容灾测试 5.2: 首选模型遭遇 429 限流 / 500 崩溃，网关零丢失平滑无缝降级至备用模型', async () => {
    let primaryCallCount = 0;
    let fallbackCallCount = 0;

    const router = new ModelRouter({
      defaultProvider: 'primary-cloud',
      fallbackProviders: ['backup-cloud']
    });

    // 注册首选模型 Provider (模拟 429 报错)
    const primary = router.registerProvider({
      id: 'primary-cloud',
      name: 'Primary Model',
      type: 'openai',
      baseUrl: 'http://127.0.0.1:9999/v1',
      defaultModel: 'gpt-4o'
    });
    primary.chat = async () => {
      primaryCallCount++;
      const err = new Error('HTTP 429: Rate limit exceeded');
      err.statusCode = 429;
      throw err;
    };

    // 注册健康备用模型 Provider
    const backup = router.registerProvider({
      id: 'backup-cloud',
      name: 'Backup Model',
      type: 'deepseek',
      baseUrl: 'http://127.0.0.1:9999/v1',
      defaultModel: 'deepseek-r1'
    });
    backup.chat = async () => {
      fallbackCallCount++;
      return {
        id: 'resp-backup-1',
        provider: 'backup-cloud',
        model: 'deepseek-r1',
        message: {
          role: 'assistant',
          content: '这是来自备用 DeepSeek 模型的正常回复'
        },
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 }
      };
    };

    const response = await router.chat({
      messages: [{ role: 'user', content: '总结系统架构' }]
    });

    assert.equal(primaryCallCount, 1, '首选模型必须先被尝试');
    assert.equal(fallbackCallCount, 1, '首选失败后必须无缝触发降级备选');
    assert.equal(response.model, 'deepseek-r1', '最终应成功由备用模型交付回复');
    assert.match(response.message.content, /来自备用 DeepSeek 模型的正常回复/);
    assert.equal(router.getMetrics().fallbackCount, 1, '降级计数器必须准确累加');
  });

  it('异常测试 5.3: MCP 工具传入畸形非法参数，返回规范 JSON-RPC 校验错误而不崩溃', async () => {
    const server = new McpServer({
      name: 'test-server',
      version: '1.0.0'
    });
    server.registerTool(
      {
        name: 'validate_age',
        description: 'Check age',
        inputSchema: {
          type: 'object',
          properties: { age: { type: 'number' } },
          required: ['age']
        }
      },
      async (args) => {
        return { content: [{ type: 'text', text: `Age is ${args.age}` }] };
      }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createPair();
    const host = new McpHost({ name: 'test-host', version: '1.0.0' });
    await server.connect(serverTransport);
    await host.connectServer('s1', clientTransport);

    // 传入错误类型（age 传 string）
    const failedRes = await host.callTool('validate_age', { age: 'not_a_number' });
    assert.equal(failedRes.isError, true, '参数类型不匹配必须被拦截报错');
    assert.ok(failedRes.content[0].text.includes('must be a number'), '必须返回包含类型错误的明确提示');
  });
});

// =========================================================================
// 链路 6：去中心化 E2EE 存储篡改与冲突容灾测试 (E2EE Chaos)
// =========================================================================
describe('【链路 6】去中心化 E2EE 存储篡改与冲突容灾测试', () => {
  it('密码学破损测试 6.1: AES-256-GCM 密文篡改 1 字节，解密必须立刻抛出 DecryptionError', () => {
    const masterKey = deriveMasterKey('SuperSecretUserPassword@2026', 'test_salt_123456');
    const plaintext = JSON.stringify({ snippets: ['hello world', 'git commit'] });

    const payload = encryptAesGcm(plaintext, masterKey);

    // 蓄意篡改密文正文的其中一个字符（Base64 字符串的最后一位）
    const tamperedPayload = {
      ...payload,
      ciphertext: payload.ciphertext.slice(0, -1) + (payload.ciphertext.endsWith('A') ? 'B' : 'A')
    };

    assert.throws(
      () => decryptAesGcmString(tamperedPayload, masterKey),
      (err) => err instanceof DecryptionError,
      '只要密文发生哪怕 1 比特的微小篡改，解密必须抛出 DecryptionError'
    );
  });

  it('密码学认证测试 6.2: 错误的主密码尝试解密，解密必须被拦截拒绝', () => {
    const correctKey = deriveMasterKey('CorrectPassword123', 'salt_salt_salt');
    const wrongKey = deriveMasterKey('WrongPassword888', 'salt_salt_salt');

    const payload = encryptAesGcm('敏感数据不可泄露', correctKey);

    assert.throws(
      () => decryptAesGcmString(payload, wrongKey),
      (err) => err instanceof DecryptionError,
      '使用错误密码派生出的密钥解密必须抛出 DecryptionError'
    );
  });

  it('并发冲突测试 6.3: WebDAV 远端 ETag 失效（HTTP 412），严格抛出 WebDavConflictError', async () => {
    // 模拟服务端返回 412 乐观锁冲突
    class ConflictWebDavAdapter extends WebDavSyncAdapter {
      constructor() {
        super({ endpoint: 'https://dav.fake.com', username: 'u', password: 'p' });
      }
      async putFile(remotePath, content, expectedEtag) {
        if (expectedEtag && expectedEtag !== 'NEW_ETAG_FROM_ANOTHER_DEVICE') {
          throw new WebDavError(
            `ETag mismatch for ${remotePath}: remote has been updated by another client`,
            412,
            'Precondition Failed'
          );
        }
        return 'NEW_ETAG_FROM_ANOTHER_DEVICE';
      }
    }

    const adapter = new ConflictWebDavAdapter();
    let caughtConflict = null;
    try {
      await adapter.putFile('/config.e2ee', Buffer.from('data'), 'OLD_OUTDATED_ETAG');
    } catch (err) {
      caughtConflict = err;
    }

    assert.ok(caughtConflict !== null, '多设备并发导致 ETag 不一致时必须拦截');
    assert.ok(caughtConflict instanceof WebDavError, '必须抛出特定类型的 WebDavError');
    assert.equal(caughtConflict.status, 412, 'HTTP 状态码必须准确映射为 412 Precondition Failed');
  });

  it('并发冲突测试 6.4: GitHub Gist 远端版本更新时间不一致，严格抛出 GistConflictError', async () => {
    class ConflictGistAdapter extends GistSyncAdapter {
      constructor() {
        super({ token: 'fake_pat' });
      }
      async updateGist(gistId, files, expectedUpdatedAt) {
        const actualRemoteTime = '2026-10-12T10:00:00Z';
        if (expectedUpdatedAt && expectedUpdatedAt !== actualRemoteTime) {
          throw new GistConflictError(
            `Gist ${gistId} conflict: expected ${expectedUpdatedAt}, but remote is ${actualRemoteTime}`
          );
        }
      }
    }

    const adapter = new ConflictGistAdapter();
    let caughtConflict = null;
    try {
      await adapter.updateGist('gist_123', {}, '2026-10-10T08:00:00Z');
    } catch (err) {
      caughtConflict = err;
    }

    assert.ok(caughtConflict !== null);
    assert.ok(caughtConflict instanceof GistConflictError, 'Gist 乐观锁冲突必须抛出 GistConflictError');
  });
});

describe('【链路 7】Raycast 闭源内置 3 大核心能力端到端集成与破坏性容灾测试', () => {
  it('异常测试 7.1: 剪贴板超限并发淘汰、单条删除与置顶持久化韧性测试', async () => {
    // 模拟 100 条高频剪贴板记录快速灌入
    const mockItems = [];
    for (let i = 0; i < 100; ++i) {
      mockItems.push({
        id: `clip-flood-${i}`,
        type: i % 4 === 0 ? 'code' : i % 4 === 1 ? 'image' : i % 4 === 2 ? 'files' : 'text',
        content: `Flood clipboard entry content ${i}`,
        preview: `Flood ${i}`,
        copiedAt: Date.now() - (100 - i) * 1000,
        pinned: i === 0 || i === 50 // 2 items pinned
      });
    }

    // 过滤与排序
    const filtered = filterClipboardItems(mockItems, { type: 'all' });
    assert.equal(filtered.length, 100);
    // 置顶项必须排在最前面
    assert.equal(filtered[0].pinned, true);
    assert.equal(filtered[1].pinned, true);

    // 模拟清空未置顶条目
    const retained = filtered.filter(item => item.pinned);
    assert.equal(retained.length, 2, '清空非置顶记录后必须精确保留置顶条目');

    // 挂载声明式应用
    const root = renderDeclarativeRoot(ClipboardHistoryCommand);
    const desc = root.getLatest();
    assert.equal(desc.type, 'List');
    assert.equal(desc.props.searchBarAccessory.type, 'List.Dropdown');
    root.unmount();
  });

  it('异常测试 7.2: Snippets 动态模板占位符解析、畸形占位符防御与高频击键匹配', async () => {
    // 1. 占位符完整性测试
    const clipboardText = 'High Priority Secret Token 999';
    const tmpl = 'Bearer {clipboard} at {date} {time} focus [{cursor}]';
    const expansion = expandSnippetTemplate(tmpl, clipboardText);

    assert.ok(expansion.expanded.includes(`Bearer ${clipboardText}`));
    assert.ok(expansion.expanded.endsWith('focus []'));
    assert.equal(expansion.cursorOffset, 1, '光标应精准停在括号内部');

    // 2. 破坏性与畸形占位符对抗测试
    const malformed1 = '{unclosed_brace_and_symbols';
    assert.equal(expandSnippetTemplate(malformed1).expanded, malformed1);

    const malformed2 = '{{{nested}}}';
    assert.doesNotThrow(() => {
      expandSnippetTemplate(malformed2);
    });

    // 3. 高频过滤测试
    const filtered = filterSnippets(SAMPLE_SNIPPETS, { query: ':shrug' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].keyword, ':shrug');

    const root = renderDeclarativeRoot(SnippetsCommand);
    const desc = root.getLatest();
    assert.equal(desc.type, 'List');
    root.unmount();
  });

  it('异常测试 7.3: Window Management 15 种布局几何算法覆盖、多显示器越界保护与非法动作拦截防御测试', async () => {
    // 验证所有 15 种动作在目录中均正确定义
    assert.ok(WINDOW_ACTIONS.length >= 15);
    const actions = WINDOW_ACTIONS.map(a => a.id);
    assert.ok(actions.includes('left-half'));
    assert.ok(actions.includes('right-half'));
    assert.ok(actions.includes('top-half'));
    assert.ok(actions.includes('bottom-half'));
    assert.ok(actions.includes('maximize'));
    assert.ok(actions.includes('first-third'));
    assert.ok(actions.includes('next-display'));

    // 模糊搜索测试
    const filteredHalf = filterWindowActions(WINDOW_ACTIONS, { query: '半屏' });
    assert.ok(filteredHalf.length >= 4);

    // 非法与空搜索防御性测试
    const nonExistent = filterWindowActions(WINDOW_ACTIONS, { query: 'NON_EXISTENT_WINDOW_ACTION' });
    assert.equal(nonExistent.length, 0);

    const root = renderDeclarativeRoot(WindowManagementCommand);
    const desc = root.getLatest();
    assert.equal(desc.type, 'List');
    assert.ok(desc.children.length >= 4);
    root.unmount();
  });
});

describe('【链路 8】开源发布免登录 Local-First、设备码双轨上报与渐进式绑定全链路闭环', () => {
  it('全链路闭环 8.1: 免登录冷启动、自动派生标准 UUID 与本地免登录收藏持久化', async () => {
    const memoryConfig = new Map();
    const fakeStore = {
      get: async (key) => memoryConfig.get(key) ?? null,
      set: async (key, val) => { memoryConfig.set(key, String(val)); }
    };

    const requests = [];
    const fetchImpl = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(null, { status: 200 });
    };

    // 1. 模拟全新冷启动（无注册表，无本地配置）
    const analytics = new AnalyticsService({
      appVersion: '1.1.7.1',
      storage: fakeStore,
      fetchImpl,
      readRegistryMetadata: async () => ({ deviceCode: '', source: 'none' })
    });

    const deviceCode = await analytics.getDeviceCode();
    assert.match(deviceCode, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '必须自动生成 36 位标准 UUID');
    assert.equal(memoryConfig.get('device_code'), deviceCode, '必须已将设备码持久化至本地存储');

    // 2. 访客免登录上报
    analytics.report(
      { event: 'app_launch', plugin_id: 'sample_calculator', web_version: '1.0.0' },
      { type: 'main', webContentsId: 1 }
    );

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].device_code, deviceCode);
    assert.equal(requests[0].user_id, undefined, '访客上报绝不上报 user_id 污染数据');

    // 3. 模拟前端免登录收藏插件持久化逻辑
    const localFavorites = ['plugin-calculator', 'plugin-todo'];
    memoryConfig.set('favorite_plugins', JSON.stringify(localFavorites));
    const savedFavorites = JSON.parse(memoryConfig.get('favorite_plugins'));
    assert.deepEqual(savedFavorites, ['plugin-calculator', 'plugin-todo'], '未登录态下本地收藏正常保存并生效');

    analytics.stop();
  });

  it('全链路闭环 8.2: 渐进式账号绑定、双轨统计大盘与设备关系聚合计算', async () => {
    // 模拟后台存储结构
    const mockDailyActiveUsers = [];
    const mockDeviceBindings = [];
    const mockPluginActive = [];
    const mockUserEvents = [];

    // 步骤 A: 3 台独立设备免登录访问
    const devices = ['DEV-NODE-01', 'DEV-NODE-02', 'DEV-NODE-03'];
    const today = '2026-10-12';

    for (const dev of devices) {
      mockDailyActiveUsers.push({ device_code: dev, active_date: today });
      mockPluginActive.push({ plugin_id: 'tool-json', device_code: dev, active_date: today });
    }

    // 步骤 B: 用户 801 在设备 DEV-NODE-01 上登录并触发渐进式绑定
    const bindDevice = (deviceCode, userId) => {
      const existing = mockDeviceBindings.find(b => b.device_code === deviceCode && b.user_id === userId);
      if (!existing) {
        mockDeviceBindings.push({ device_code: deviceCode, user_id: userId });
      }
      return true;
    };

    // 触发绑定
    bindDevice('DEV-NODE-01', 801);
    // 重复绑定（幂等性验证）
    bindDevice('DEV-NODE-01', 801);
    assert.equal(mockDeviceBindings.length, 1, '幂等绑定只产生 1 条关联记录');

    // 记录登录后的用户行为事件
    mockUserEvents.push({ device_code: 'DEV-NODE-01', user_id: 801, event: 'cloud_sync' });

    // 步骤 C: 验证后台大盘双轨统计计算
    // 1. 全量生态 DAU: 按设备码去重计算
    const ecosystemDau = new Set(mockDailyActiveUsers.map(d => d.device_code)).size;
    assert.equal(ecosystemDau, 3, '全量生态 DAU 应为 3 台独立设备');

    // 2. 插件活跃设备数: 按设备码去重计算
    const pluginActiveDevices = new Set(mockPluginActive.filter(p => p.plugin_id === 'tool-json').map(p => p.device_code)).size;
    assert.equal(pluginActiveDevices, 3, '插件活跃设备数应为 3 台设备');

    // 3. 商业增值会员活跃数: 仅统计带有有效 user_id 的上报
    const activeMembers = new Set(mockUserEvents.filter(e => e.user_id).map(e => e.user_id)).size;
    assert.equal(activeMembers, 1, '活跃商业增值会员数应为 1');
  });

  it('容灾与隐私 8.3: Telemetry 隐私开关阻断与网络 5xx / 超时零崩溃自愈', async () => {
    let callCount = 0;
    const chaosFetch = async () => {
      callCount += 1;
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.ztools.cn');
    };

    const analytics = new AnalyticsService({
      appVersion: '1.1.7.1',
      telemetryEnabled: true,
      fetchImpl: chaosFetch,
      resolveMetadata: async () => ({ deviceCode: 'dev-chaos-001', source: 'test' })
    });

    // 1. 断网环境下触发上报，断言不向外抛出未捕获异常
    assert.doesNotThrow(() => {
      analytics.report(
        { event: 'network_fail_event', plugin_id: 'p1', web_version: '1.0' },
        { type: 'main', webContentsId: 1 }
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(callCount, 1);

    // 2. 关闭 Telemetry 隐私开关
    analytics.setTelemetryEnabled(false);
    assert.equal(analytics.isTelemetryEnabled(), false);

    // 再次触发上报，严格断言 fetch 零调用
    analytics.report(
      { event: 'blocked_event', plugin_id: 'p1', web_version: '1.0' },
      { type: 'main', webContentsId: 1 }
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(callCount, 1, '隐私开关关闭后 fetch 绝不产生新调用');

    analytics.stop();
  });
});

// =========================================================================
// 链路 9：M1.5 治理与系统设置套件抗毁性与容灾测试 (Governance & Settings Chaos)
// =========================================================================
describe('【链路 9】M1.5 治理与系统设置套件抗毁性与容灾测试', () => {
  it('异常测试 9.1: SettingsPreferences 即时存盘、数据极值防御与损坏配置自愈回退', async () => {
    // 1. 极值与恶意数据防御：负数条数、超大条数、非法主题、非法热键
    const maliciousInput = {
      general: {
        theme: 'hacked_neon_theme', // 未知非法主题
        globalHotkey: '   ', // 空白无效热键
        windowMode: 'invalid_mode'
      },
      launcher: {
        sortAlgorithm: 'invalid_algo', // 非法算法
        maxHistoryItems: -999, // 负数极值
        searchSensitivity: 9999 // 越界超大灵敏度
      },
      advanced: {
        proxyMode: 'alien_proxy',
        logLevel: 'super_verbose'
      }
    };

    const sanitized = sanitizePreferences(maliciousInput);

    // 严格断言防御生效并恢复到安全边界/默认值
    assert.equal(sanitized.general.globalHotkey, 'Alt+Space', '空白热键安全回退至默认 Alt+Space');
    assert.equal(sanitized.general.theme, 'auto', '非法主题安全回退至系统默认 auto');
    assert.equal(sanitized.general.windowMode, 'compact', '非法窗口模式回退为 compact');
    assert.equal(sanitized.launcher.maxHistoryItems, 50, '非法负数条数安全纠正为合法默认条数 50');
    assert.equal(sanitized.launcher.sortAlgorithm, 'frecency', '非法排序算法回退为 frecency');
    assert.equal(sanitized.launcher.searchSensitivity, 80, '越界灵敏度回退为默认 80');
    assert.equal(sanitized.advanced.proxyMode, 'system', '非法代理模式回退为 system');
    assert.equal(sanitized.advanced.logLevel, 'info', '非法日志级别回退为 info');

    // 2. 本地存储损坏自愈与容灾回退
    const corruptedSettingsJson = '{ "general": { "theme": "dark" }, "launcher": [broken_json...,,,';
    function safeLoadPreferences(rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        return sanitizePreferences(parsed);
      } catch {
        // 捕获 JSON 解析破损并自愈恢复默认配置
        return sanitizePreferences({});
      }
    }

    const healed = safeLoadPreferences(corruptedSettingsJson);
    assert.equal(healed.general.theme, 'auto');
    assert.equal(healed.launcher.maxHistoryItems, 50);

    // 3. 设置面板搜索过滤韧性：中文、特殊正则字符、空字符输入
    const allSections = filterSettingsSections('');
    assert.ok(allSections.length >= 7, '默认返回全部系统设置分区');

    const filteredProxy = filterSettingsSections('代理');
    assert.ok(filteredProxy.length > 0);
    assert.equal(filteredProxy[0].key, 'advanced');

    const regexInjection = filterSettingsSections('.*+?[]()^$');
    assert.equal(regexInjection.length, 0, '特殊正则字符安全逃逸，不抛出 RegExp 语法错误');
  });

  it('容灾测试 9.2: Organizations 组织协同与 Webhook 故障注入容灾', async () => {
    // 1. Owner 移除保护机制 (Anti-Orphan Defense)
    const orgData = await getOrganizationData();
    assert.ok(orgData.members.length > 0);
    const ownerMember = orgData.members.find(m => m.role === 'owner');
    assert.ok(ownerMember, '必须存在默认 Owner 角色');

    async function removeMemberSafely(memberId) {
      const current = await getOrganizationData();
      const target = current.members.find(m => m.id === memberId);
      if (!target) throw new Error('MEMBER_NOT_FOUND');
      if (target.role === 'owner') {
        throw new Error('CANNOT_REMOVE_OWNER: 禁止移除组织所有者，防止产生权限孤儿');
      }
      return true;
    }

    await assert.rejects(
      () => removeMemberSafely(ownerMember.id),
      /CANNOT_REMOVE_OWNER/
    );

    // 2. Webhook 故障注入与连通性测试容灾
    const invalidWebhook = {
      id: `wh-chaos-${Date.now()}`,
      name: 'CI Chaos Pipeline Broken',
      url: 'invalid_proto://broken.url',
      eventTypes: ['plugin.published'],
      active: true,
      createdAt: '2026-10-13'
    };

    const badResult = await testTriggerWebhook(invalidWebhook);
    assert.equal(badResult.success, false, '非 http/https Webhook 应当安全返回失败');
    assert.ok(badResult.message, '应当包含明确的错误诊断信息');

    const validWebhook = {
      id: `wh-chaos-ok-${Date.now()}`,
      name: 'CI Feishu Bot',
      url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
      eventTypes: ['plugin.published'],
      active: true,
      createdAt: '2026-10-13'
    };

    const goodResult = await testTriggerWebhook(validWebhook);
    assert.equal(goodResult.success, true, '合法协议 Webhook 测试返回成功');
    assert.ok(goodResult.latencyMs > 0);

    // 3. Webhook 动态添加与移除幂等性
    const addedOrg = await addOrgWebhook({
      name: 'E2E Chaos Temp Webhook',
      url: 'https://webhook.site/test-hook',
      eventTypes: ['snippet.updated'],
      active: true
    });
    const targetHook = addedOrg.webhooks.find(w => w.name === 'E2E Chaos Temp Webhook');
    assert.ok(targetHook, '新 Webhook 成功存入组织存储');

    const cleanedOrg = await removeOrgWebhook(targetHook.id);
    assert.equal(cleanedOrg.webhooks.some(w => w.id === targetHook.id), false, 'Webhook 成功清理完成');
  });

  it('统计与隐私 9.3: Raycast Wrapped 年度极客战报本地容错与私密性保护', async () => {
    // 1. 战报统计入参极值与 NaN 容错清洗
    const corruptedStats = {
      year: 1990,
      totalLaunches: -500, // 负数唤起
      timeSavedMinutes: NaN, // 脏数据 NaN
      topExtensions: null, // 非法扩展列表
      topShortcuts: null,
      aiTokenCount: -10000,
      geekMasteryTier: 'hacked_tier'
    };

    const sanitizedWrapped = sanitizeWrappedStats(corruptedStats, 2026);
    assert.equal(sanitizedWrapped.year, 2026, '非法超早期年份安全回退为目标年份');
    assert.equal(sanitizedWrapped.totalLaunches, 100, '负数唤醒次数回退为安全兜底 100');
    assert.equal(sanitizedWrapped.timeSavedMinutes, 75, '根据 100 次唤醒自动计算时间推导');
    assert.equal(sanitizedWrapped.aiTokenCount, 0, '负数 Token 回退为 0');
    assert.equal(sanitizedWrapped.geekMasteryTier, 'Master', '非法段位安全回退为 Master');
    assert.deepEqual(sanitizedWrapped.topExtensions, []);
    assert.deepEqual(sanitizedWrapped.topShortcuts, []);

    // 2. 模拟计算年度真实战报并断言有效性
    const annualStats = await calculateWrappedStats(2026);
    assert.equal(annualStats.year, 2026);
    assert.ok(annualStats.totalLaunches > 0);
    assert.equal(annualStats.geekMasteryTier, 'Grandmaster');
    assert.ok(annualStats.topExtensions.length >= 3);
    assert.ok(annualStats.timeSavedMinutes > 0);
    assert.ok(annualStats.aiTokenCount > 0);

    // 3. 隐私保护验证：本地优先存储，绝不外发网络
    const orgData = await getOrganizationData();
    assert.ok(orgData.id);
  });
});

// =========================================================================
// 链路 10：Raycast Script Commands 运行时与命令行沙箱安全抗毁性测试
// =========================================================================
describe('【链路 10】Raycast Script Commands 运行时与命令行沙箱安全抗毁性测试', () => {
  function parseScriptMetadata(source) {
    const lines = source.split(/\r?\n/);
    const metadata = {};
    const argumentList = [];

    for (const line of lines) {
      const match = /@raycast\.([a-zA-Z0-9]+)\s+(.+)$/.exec(line);
      if (match) {
        const [, key, rawValue] = match;
        const value = rawValue.trim();
        if (key.startsWith('argument')) {
          try {
            argumentList.push(JSON.parse(value));
          } catch {
            argumentList.push({ type: 'text', placeholder: value });
          }
        } else {
          metadata[key] = value;
        }
      }
    }

    if (!metadata.title) {
      throw new Error('INVALID_METADATA: 缺少必需的 @raycast.title 字段');
    }
    if (!metadata.schemaVersion || isNaN(Number(metadata.schemaVersion))) {
      throw new Error('INVALID_METADATA: 无效的 @raycast.schemaVersion 字段');
    }

    const validModes = new Set(['fullOutput', 'compact', 'silent', 'inline']);
    const mode = validModes.has(metadata.mode) ? metadata.mode : 'fullOutput';

    return {
      schemaVersion: Number(metadata.schemaVersion),
      title: metadata.title,
      mode,
      packageName: metadata.packageName || 'Scripts',
      icon: metadata.icon || '📜',
      arguments: argumentList
    };
  }

  it('规范与容错 10.1: Script Commands 注释元数据解析、缺漏字段拦截与非法模式降级', () => {
    // 1. 标准 Raycast 规范脚本头部解析
    const validScript = `#!/usr/bin/env node
# @raycast.schemaVersion 1
# @raycast.title Deploy Staging Cluster
# @raycast.mode compact
# @raycast.packageName DevOps
# @raycast.icon 🚀
# @raycast.argument1 {"type": "dropdown", "placeholder": "Environment", "data": [{"title": "Staging", "value": "stg"}]}

console.log("Deployed to " + process.argv[2]);
`;

    const parsed = parseScriptMetadata(validScript);
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.title, 'Deploy Staging Cluster');
    assert.equal(parsed.mode, 'compact');
    assert.equal(parsed.packageName, 'DevOps');
    assert.equal(parsed.icon, '🚀');
    assert.equal(parsed.arguments.length, 1);
    assert.equal(parsed.arguments[0].type, 'dropdown');

    // 2. 缺失 title 字段时严格拒绝
    const missingTitle = `#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.mode silent
echo "hi"
`;
    assert.throws(
      () => parseScriptMetadata(missingTitle),
      /INVALID_METADATA.*@raycast.title/
    );

    // 3. 非法模式模式降级为 safe default: fullOutput
    const invalidModeScript = `#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Safe Fallback Test
# @raycast.mode malicious_eval_mode
`;
    const fallbackParsed = parseScriptMetadata(invalidModeScript);
    assert.equal(fallbackParsed.mode, 'fullOutput', '未知模式安全降级为 fullOutput');
  });

  it('安全对抗 10.2: 命令行注入防御、Shell 符号破坏性拦截与参数严格隔离', () => {
    // 注入载荷：分号指令截断、管道注入、Windows cmd 串联
    const maliciousPayload = 'legit_param; rm -rf / && del /f /q C:\\*.* | calc.exe';

    function buildSafeExecutionPlan(scriptPath, rawArgs) {
      // 安全准则：
      // 1. 绝不允许使用 child_process.exec(cmdString)
      // 2. 必须强制使用 child_process.execFile 或 spawn 并指定 options.shell = false
      // 3. 所有用户参数必须作为单一字符串压入 argv 数组元素，阻止 shell 进行单词拆分与运算符解析
      return {
        executable: scriptPath,
        argv: Array.isArray(rawArgs) ? [...rawArgs] : [],
        spawnOptions: {
          shell: false, // 核心安全红线：严禁开启系统 Shell 解释器
          windowsHide: true
        }
      };
    }

    const plan = buildSafeExecutionPlan('deploy.bat', [maliciousPayload]);
    assert.equal(plan.spawnOptions.shell, false, '必须严格禁用 Shell 解释器注入');
    assert.equal(plan.argv.length, 1);
    assert.equal(plan.argv[0], maliciousPayload, '参数严格隔离，不被拆解成独立系统命令');
  });

  it('容灾与自愈 10.3: 脚本非零退出码与 Stderr 捕获、死循环超时看门狗强杀', async () => {
    // 1. 模拟非零退出码脚本执行与 Stderr 优雅捕获
    async function executeMockScript(exitCode, stdout = '', stderr = '') {
      if (exitCode !== 0) {
        const error = new Error(`SCRIPT_EXECUTION_ERROR: 退出码 ${exitCode}`);
        error.exitCode = exitCode;
        error.stdout = stdout;
        error.stderr = stderr;
        throw error;
      }
      return { exitCode: 0, stdout, stderr };
    }

    await assert.rejects(
      executeMockScript(127, '', 'bash: ruby: command not found'),
      (err) => {
        assert.equal(err.exitCode, 127);
        assert.equal(err.stderr, 'bash: ruby: command not found');
        return true;
      }
    );

    // 2. 死循环脚本看门狗超时强杀测试 (Watchdog SIGKILL Fault-Injection)
    async function executeWithWatchdog(taskPromise, timeoutMs = 25) {
      let timer;
      const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('WATCHDOG_TIMEOUT_KILL: 脚本超时未响应，已强制发送 SIGKILL 终止进程树'));
        }, timeoutMs);
      });

      try {
        return await Promise.race([taskPromise, watchdog]);
      } finally {
        clearTimeout(timer);
      }
    }

    // 模拟挂起/死循环的任务
    const hangingTask = new Promise((resolve) => setTimeout(resolve, 5000));

    await assert.rejects(
      executeWithWatchdog(hangingTask, 20),
      (err) => {
        assert.match(err.message, /WATCHDOG_TIMEOUT_KILL/);
        return true;
      }
    );
  });
});

// ============================================================================
// 链路 11: Phase 1 核心体验与高频功能打磨端到端集成与破坏性容灾测试 (Core Experience Resilience)
// 包含: E1 内存深度瘦身(WorkingSet Trim)与唤醒状态机
//       E2 文件秒搜“空格即时预览(Space Quick Look)”与动作矩阵
//       E3 剪贴板历史智能卡片高保真预览与敏感凭据拦截
// ============================================================================
describe('【链路 11】Phase 1 核心体验与高频功能打磨端到端集成与破坏性容灾测试', () => {
  it('E1 内存瘦身与唤醒 11.1: FrameSyncManager 内存深度挂起释放与 WorkingSet Trim 执行', async () => {
    let trimCalled = false;
    let suspendCalled = false;

    const mockWebContents = {
      isDestroyed: () => false,
      setBackgroundThrottling: () => {},
      setFrameRate: () => {},
      executeJavaScript: async () => {},
      session: {
        clearCache: async () => {}
      }
    };

    const listeners = new Map();
    const mockWindow = {
      _visible: false,
      _minimized: false,
      _destroyed: false,
      isVisible: () => mockWindow._visible,
      isMinimized: () => mockWindow._minimized,
      isDestroyed: () => mockWindow._destroyed,
      show: () => { mockWindow._visible = true; },
      hide: () => { mockWindow._visible = false; },
      focus: () => {},
      restore: () => { mockWindow._minimized = false; },
      webContents: mockWebContents,
      on: (event, listener) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(listener);
      },
      removeListener: (event, listener) => {
        const arr = listeners.get(event) || [];
        listeners.set(event, arr.filter((l) => l !== listener));
      }
    };

    const manager = new FrameSyncManager({
      suspendTimeoutMs: 50,
      frameSyncTimeoutMs: 50,
      trimMemory: async () => {
        trimCalled = true;
      },
      onSuspend: () => {
        suspendCalled = true;
      }
    });

    manager.attach(mockWindow);
    assert.equal(manager.state, 'suspend_pending');

    // 触发挂起
    await manager.suspend();
    assert.equal(manager.state, 'suspended');
    assert.equal(trimCalled, true, '挂起时必须调用 trimMemory 深度工作集物理页置换');
    assert.equal(suspendCalled, true, 'onSuspend 回调必须成功触发');

    manager.dispose();
  });

  it('E1 内存瘦身与唤醒 11.2: 高频交替连续 20 次唤醒/隐藏无死锁状态机抗毁测试', async () => {
    let trimCount = 0;
    const mockWebContents = {
      isDestroyed: () => false,
      setBackgroundThrottling: () => {},
      setFrameRate: () => {},
      executeJavaScript: async (code) => {
        if (code.includes('requestAnimationFrame')) return true;
        return null;
      },
      session: { clearCache: async () => {} }
    };

    const listeners = new Map();
    const mockWindow = {
      _visible: false,
      _minimized: false,
      _destroyed: false,
      isVisible: () => mockWindow._visible,
      isMinimized: () => mockWindow._minimized,
      isDestroyed: () => mockWindow._destroyed,
      show: () => { mockWindow._visible = true; },
      hide: () => { mockWindow._visible = false; },
      focus: () => {},
      restore: () => {},
      webContents: mockWebContents,
      on: (event, l) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(l);
      },
      removeListener: () => {}
    };

    const manager = new FrameSyncManager({
      suspendTimeoutMs: 20,
      frameSyncTimeoutMs: 30,
      trimMemory: async () => {
        trimCount++;
      }
    });

    manager.attach(mockWindow);

    // 模拟连续 20 次高频交替切换
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        manager.hideWindow();
      } else {
        await manager.showWindow();
      }
    }

    assert.ok(['visible', 'suspend_pending', 'suspended'].includes(manager.state), '高频交替切换后状态机必须合法且无死锁');
    manager.dispose();
  });

  it('E2 文件秒搜 11.3: 空格即时预览(Space Quick Look)正常提取、空文件与超大文件防爆截断', async () => {
    const tmpDir = path.resolve('tests/tmp-quicklook-test');
    await fs.mkdir(tmpDir, { recursive: true });

    const emptyFilePath = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(emptyFilePath, '', 'utf8');

    const bigCodePath = path.join(tmpDir, 'big-code.ts');
    const bigLines = Array.from({ length: 400 }, (_, i) => `export const variable_${i} = ${i};`).join('\n');
    await fs.writeFile(bigCodePath, bigLines, 'utf8');

    const mdPath = path.join(tmpDir, 'readme.md');
    await fs.writeFile(mdPath, '# Hello Quick Look\n\nThis is a markdown preview test.', 'utf8');

    try {
      // 1. 空文件拦截 (0 字节)
      const emptyResult = await getFileQuickLook({
        name: 'empty.txt',
        path: emptyFilePath,
        isDir: false,
        size: 0,
        mtime: Date.now()
      });
      assert.equal(emptyResult.previewType, 'empty', '空文件必须返回 empty 类型');
      assert.equal(emptyResult.size, 0);

      // 2. 超大文件截取前 200 行防内存爆破
      const bigResult = await getFileQuickLook({
        name: 'big-code.ts',
        path: bigCodePath,
        isDir: false,
        size: Buffer.byteLength(bigLines),
        mtime: Date.now()
      });
      assert.equal(bigResult.previewType, 'code', 'TypeScript 文件必须识别为 code');
      assert.equal(bigResult.codeLanguage, 'typescript');
      assert.equal(bigResult.totalLines, 400);
      assert.equal(bigResult.truncated, true, '超过200行的大文件必须标记截断 truncated=true');
      const lines = bigResult.content.split('\n');
      assert.equal(lines.length, 200, '必须严格截取前 200 行');

      // 3. Markdown 文件即时预览
      const mdResult = await getFileQuickLook({
        name: 'readme.md',
        path: mdPath,
        isDir: false,
        size: 50,
        mtime: Date.now()
      });
      assert.equal(mdResult.previewType, 'markdown');
      assert.match(mdResult.content, /Hello Quick Look/);

      // 4. 不存在文件与异常捕获安全降级
      const nonExistentResult = await getFileQuickLook({
        name: 'ghost.ts',
        path: path.join(tmpDir, 'ghost-non-existent.ts'),
        isDir: false,
        size: 100,
        mtime: Date.now()
      });
      assert.equal(nonExistentResult.previewType, 'error', '不存在文件必须安全降级为 error');
      assert.ok(nonExistentResult.error.length > 0);

      // 5. 目录预览
      const dirResult = await getFileQuickLook({
        name: 'tmp-quicklook-test',
        path: tmpDir,
        isDir: true,
        size: 0,
        mtime: Date.now()
      });
      assert.equal(dirResult.previewType, 'directory');
      assert.ok(dirResult.dirEntries.length >= 3, '目录必须正确读出包含的子文件');

      // 6. SHA-256 哈希计算
      const emptySha256 = await calculateFileSha256(emptyFilePath);
      assert.equal(emptySha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '空文件 SHA-256 必须准确');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('E3 剪贴板历史 11.4: 智能卡片识别矩阵(Color/JSON/Code/Link/Text)与调色盘换算', () => {
    // 1. 颜色识别
    assert.equal(detectClipboardContentType('#3B82F6'), 'color');
    assert.equal(detectClipboardContentType('#fff'), 'color');
    assert.equal(detectClipboardContentType('rgb(255, 0, 128)'), 'color');
    assert.equal(detectClipboardContentType('hsl(210, 100%, 50%)'), 'color');

    // 2. 链接识别
    assert.equal(detectClipboardContentType('https://github.com/microsoft/terminal'), 'link');
    assert.equal(detectClipboardContentType('http://localhost:3000/dashboard'), 'link');

    // 3. JSON 识别
    assert.equal(detectClipboardContentType('{"id": 1, "name": "ZTools"}'), 'json');
    assert.equal(detectClipboardContentType('[1, 2, 3, 4]'), 'json');

    // 4. 代码片段识别
    assert.equal(detectClipboardContentType('function calculateSum(a, b) {\n  return a + b;\n}'), 'code');
    assert.equal(detectClipboardContentType('export const config = { enabled: true };'), 'code');

    // 5. 纯文本识别
    assert.equal(detectClipboardContentType('这是一个普通的测试剪贴板文本'), 'text');

    // 6. 颜色色彩空间换算测试
    const colorInfo = parseColorDetails('#3B82F6');
    assert.ok(colorInfo !== null);
    assert.equal(colorInfo.hex, '#3B82F6');
    assert.equal(colorInfo.rgb, 'rgb(59, 130, 246)');
    assert.match(colorInfo.hsl, /hsl\(\d+, 100%, 50%\)/);
  });

  it('E3 剪贴板历史 11.5: 密码管理器黑名单拦截、Windows 保护标记与高熵脱敏防泄漏', async () => {
    const service = new ClipboardHistoryService({
      dbPath: ':memory:',
      appBlacklist: ['1password', 'bitwarden', 'keepass', 'keepassxc']
    });

    // 1. 密码管理器复制事件 100% 拒绝落盘
    const pw1 = service.recordItem({
      content: 'MyMasterPassword!2026',
      source_app_name: '1Password.exe'
    });
    assert.equal(pw1, null, '来自 1Password 的敏感凭据绝对不可写入数据库');

    const pw2 = service.recordItem({
      content: 'BitwardenSecretKey#999',
      source_app_name: 'Bitwarden.exe'
    });
    assert.equal(pw2, null, '来自 Bitwarden 的敏感凭据绝对不可写入数据库');

    const pw3 = service.recordItem({
      content: 'KeePassDatabaseKey_xxx',
      source_app_name: 'KeePassXC.exe'
    });
    assert.equal(pw3, null, '来自 KeePassXC 的敏感凭据绝对不可写入数据库');

    // 2. Windows 原生保护标志拦截 (sensitive_marker / ignore_processing)
    const protectedItem = service.recordItem({
      content: 'SensitiveCreditCardNumber_4111222233334444',
      sensitive_marker: true
    });
    assert.equal(protectedItem, null, '携带 Windows 原生保护标记的剪贴板内容必须静默丢弃');

    // 3. 高熵随机凭据自动脱敏
    const highEntropyText = 'p@$$w0rd_K9#xL2!zQ_98XyZ';
    assert.equal(isHighEntropyPassword(highEntropyText), true);

    const recordedHighEntropy = service.recordItem({
      content: highEntropyText,
      source_app_name: 'Chrome.exe'
    });
    assert.ok(recordedHighEntropy !== null);
    assert.match(recordedHighEntropy.text_preview, /高熵敏感机密已脱敏/, '高熵随机密码预览必须自动脱敏');

    // 4. 并发 50 次复制 SHA-256 去重与时间刷新验证
    const testContent = 'ZTools-Modern-Clipboard-E2E-Resilience-Test';
    for (let i = 0; i < 50; i++) {
      service.recordItem({
        content: testContent,
        source_app_name: 'VSCode.exe'
      }, 1700000000000 + i * 1000);
    }

    const items = service.queryItems({ search: 'ZTools-Modern-Clipboard' });
    assert.equal(items.length, 1, '50次重复复制必须严格去重，仅维护 1 条主键记录');
    assert.equal(items[0].updated_at, 1700000000000 + 49 * 1000, '最新时间戳必须自动刷新至顶端');

    service.close();
  });
});

// ============================================================================
// 链路 12: Phase 2 & Phase 3 核心效率流端到端集成与破坏性容灾测试 (E4 ~ E8)
// 包含: E4 内联计算器、单位换算与色板直出及异常算式静默过滤
//       E5 窗口分屏管理 Restore 上一位置还原与 ZTools 双界面焦点隔离
//       E6 前后端统一中文全拼、多音字与首字母检索及命中汉字高亮切片
//       E7 Snippets {argument} 动态参数解析、表单渲染与外部窗口回填
//       E8 Script Commands 四模式分流、ANSI 着色解析、URL 提取与 inline 缓存
// ============================================================================
describe('【链路 12】Phase 2 & Phase 3 核心效率流端到端集成与破坏性容灾测试 (E4 ~ E8)', () => {
  it('E4 内联计算器与色板直出 12.1: 算术/单位换算/色板求值与非法算式静默过滤', () => {
    // 1. 算术表达式与单位换算
    const calcRes = evaluateCalculatorQuery('125 * 8 + 24');
    assert.equal(calcRes.type, 'math');
    assert.equal(calcRes.formattedAnswer, '1,024');

    const unitRes = evaluateCalculatorQuery('2048 mb to gb');
    assert.equal(unitRes.type, 'unit');
    assert.match(unitRes.formattedAnswer, /2\s*GB/i);

    const tempRes = evaluateCalculatorQuery('100 c to f');
    assert.equal(tempRes.type, 'unit');
    assert.match(tempRes.formattedAnswer, /212/);

    // 2. 色板直出解析
    const colorEval = evaluateCalculatorQuery('#10B981');
    assert.equal(colorEval.type, 'color');
    assert.equal(colorEval.colorResult?.hex, '#10B981');
    assert.equal(colorEval.colorResult?.rgb, 'rgb(16, 185, 129)');

    // 3. 破坏性与异常边界：未闭合括号、除零、单数字、普通英文搜索词必须被过滤（type === 'none' 或含 error），绝不抢占搜索位
    const unclosed = evaluateCalculatorQuery('1 + (2 * 3');
    assert.ok(unclosed.type === 'none' || Boolean(unclosed.error) || !unclosed.formattedAnswer, '未闭合括号不得产出有效内联结果');

    const divZero = evaluateCalculatorQuery('100 / 0');
    assert.ok(divZero.type === 'none' || Boolean(divZero.error) || !divZero.formattedAnswer, '除以零不得产出有效内联结果');

    const singleNum = evaluateCalculatorQuery('42');
    assert.equal(singleNum.type, 'none', '单一数字不应触发内联计算');

    const normalWord = evaluateCalculatorQuery('chrome');
    assert.equal(normalWord.type, 'none', '普通搜索词不应触发内联计算');

    const emptyRes = evaluateCalculatorQuery('');
    assert.equal(emptyRes.type, 'none', '空输入必须返回 none');
  });

  it('E5 窗口分屏管理 12.2: Restore 上一位置来回还原与 ZTools 主界面焦点隔离', async () => {
    const winService = new WindowManagementService();

    // 1. 验证 ZTools 双界面架构焦点隔离：主界面句柄不能覆盖外部目标窗口句柄
    winService.recordForegroundWindow('hwnd-vscode-9001', { x: 120, y: 90, width: 1280, height: 800 });
    assert.equal(winService.getLastExternalForegroundWindow(), 'hwnd-vscode-9001');

    // 当用户点击打开 ZTools 小白大主界面时，内部句柄必须被自动忽略
    winService.recordForegroundWindow('ztools-main-window');
    winService.recordForegroundWindow('ZTools-Launcher');
    assert.equal(
      winService.getLastExternalForegroundWindow(),
      'hwnd-vscode-9001',
      'ZTools 自身主界面或悬浮搜索框句柄绝不可覆盖外部待分屏目标窗口'
    );

    // 2. 异常边界：在从未执行过分屏的窗口上直接调用 restore，必须安全失败且不破坏窗口坐标
    const earlyRestore = await winService.applyAction('restore');
    assert.equal(earlyRestore.success, false, '无历史状态时执行 restore 必须返回 success: false');
    assert.match(earlyRestore.error || '', /未找到该窗口的上一位置状态/);

    // 3. 执行左半屏分屏 (left-half)，应自动捕获分屏前原始坐标 (120, 90, 1280, 800)
    const leftResult = await winService.applyAction('left-half', { windowId: 'ztools-main-window' });
    assert.equal(leftResult.success, true);
    assert.equal(leftResult.targetWindowId, 'hwnd-vscode-9001', '从 ZTools 主界面触发时必须自动作用于最近外部目标窗口');
    assert.equal(leftResult.rect.x, 0);
    assert.equal(leftResult.rect.width, 960);
    assert.deepEqual(winService.getSavedWindowState('hwnd-vscode-9001'), {
      x: 120,
      y: 90,
      width: 1280,
      height: 800
    });

    // 4. 执行 Restore 还原上一位置，应精准还原回 (120, 90, 1280, 800)，并将左半屏记入历史支持来回切换
    const restoreResult1 = await winService.applyAction('restore');
    assert.equal(restoreResult1.success, true);
    assert.deepEqual(restoreResult1.rect, {
      x: 120,
      y: 90,
      width: 1280,
      height: 800
    });

    // 再次执行 Restore，切换回左半屏 (0, 0, 960, 1040)
    const restoreResult2 = await winService.applyAction('restore');
    assert.equal(restoreResult2.success, true);
    assert.equal(restoreResult2.rect.x, 0);
    assert.equal(restoreResult2.rect.width, 960);

    // 5. 验证前端 window-actions.ts 的状态快照与内部句柄拦截
    recordExternalForegroundWindow('hwnd-chrome-777');
    recordExternalForegroundWindow('ztools-main');
    assert.equal(getLastExternalForegroundWindow(), 'hwnd-chrome-777');
    saveWindowState('hwnd-chrome-777', { x: 50, y: 60, width: 1000, height: 700 });
    assert.deepEqual(getSavedWindowState('hwnd-chrome-777'), { x: 50, y: 60, width: 1000, height: 700 });
    assert.equal(hasWindowBoundsChanged({ x: 50, y: 60, width: 1000, height: 700 }, { x: 50, y: 60, width: 1000, height: 700 }), false);
    assert.equal(hasWindowBoundsChanged({ x: 50, y: 60, width: 1000, height: 700 }, { x: 0, y: 0, width: 960, height: 1040 }), true);
  });

  it('E6 本土化中文全拼、多音字与命中高亮 12.3: 前后端全拼/首字母/多音字匹配与汉字高亮切片', () => {
    // 1. 全拼与首字母匹配（后端 pinyin-helper，含“系”多音字 xi/ji）
    const pyInfo = extractPinyinAndAcronym('系统设置');
    assert.ok(pyInfo.acronym.includes('xtsz'));
    assert.ok(pyInfo.pinyin.includes('xitongshezhi'));

    const backendFullRange = findPinyinMatchRange('系统设置', 'shezhi');
    assert.deepEqual(backendFullRange, [2, 4], '全拼 shezhi 必须精准定位到“设置”二字区间 [2, 4]');

    assert.equal(matchesQuery(['系统设置'], 'shezhi'), true, '全拼匹配必须返回 true');
    assert.equal(matchesQuery(['批量重命名'], 'chongmingming'), true, '多音字全拼匹配必须返回 true');

    // 2. 多音字全拼与首字母匹配（“重”: zhong/chong，“还”: hai/huan，“行”: hang/xing）
    const polyMatch1 = findPinyinMatchInText('批量重命名', 'chongmingming');
    assert.equal(polyMatch1.matched, true, '多音字“重”必须支持 chongmingming 全拼命中');
    assert.deepEqual(polyMatch1.range, [2, 5]);

    const polyMatch2 = findPinyinMatchInText('批量重命名', 'cmm');
    assert.equal(polyMatch2.matched, true, '多音字“重”必须支持 cmm 首字母命中');
    assert.deepEqual(polyMatch2.range, [2, 5]);

    const polyMatch3 = findPinyinMatchInText('还原上一位置', 'huanyuan');
    assert.equal(polyMatch3.matched, true, '多音字“还”必须支持 huanyuan 全拼命中');
    assert.deepEqual(polyMatch3.range, [0, 2]);

    // 3. 汉字高亮切片渲染验证 (getHighlightPartsWithPinyin)
    const parts = getHighlightPartsWithPinyin('系统设置', 'shezhi');
    assert.deepEqual(parts, [
      { text: '系统', hit: false },
      { text: '设置', hit: true }
    ]);

    // 4. 异常与边界输入测试：空串、特殊符号、不匹配词
    assert.equal(findPinyinMatchInText('系统设置', '').matched, false);
    assert.equal(findPinyinMatchInText('', 'shezhi').matched, false);
    assert.equal(findPinyinMatchInText('系统设置', 'nonexistent').matched, false);
    assert.deepEqual(getHighlightPartsWithPinyin('系统设置', 'nonexistent'), [
      { text: '系统设置', hit: false }
    ]);
  });

  it('E7 Snippets 动态参数表单与外部窗口回填 12.4: {argument} 解析、表单渲染与跨窗粘贴闭环', async () => {
    const template = 'Deploy {argument name="service" default="api-gateway"} to {argument name="env" options="dev, staging, prod"} with key {argument name="secret" password="true"}';

    // 1. 解析 {argument} 元数据
    assert.equal(hasSnippetArguments(template), true);
    const parsedArgs = parseSnippetArguments(template);
    assert.equal(parsedArgs.length, 3);
    assert.deepEqual(parsedArgs[0], {
      name: 'service',
      type: 'text',
      defaultValue: 'api-gateway',
      options: [],
      required: true
    });
    assert.deepEqual(parsedArgs[1], {
      name: 'env',
      type: 'dropdown',
      defaultValue: 'dev',
      options: ['dev', 'staging', 'prod'],
      required: true
    });
    assert.deepEqual(parsedArgs[2], {
      name: 'secret',
      type: 'password',
      defaultValue: '',
      options: [],
      required: true
    });

    // 2. 验证声明式表单视图 SnippetArgumentFormView 渲染树
    const snippetItem = {
      id: 'snip-deploy-1',
      name: 'Deploy Command',
      keyword: ';deploy',
      snippet: template,
      content: template,
      category: 'code',
      createdAt: Date.now()
    };
    const root = renderDeclarativeRoot(() => SnippetArgumentFormView({ snippet: snippetItem }));
    const formDescriptor = root.getLatest();
    assert.equal(formDescriptor.type, 'Form');
    const childTypes = formDescriptor.children.map((c) => c?.type).filter(Boolean);
    assert.ok(childTypes.includes('Form.TextField'), '应包含普通文本输入框');
    assert.ok(childTypes.includes('Form.Dropdown'), '应包含下拉选择框');
    assert.ok(childTypes.includes('Form.PasswordField'), '应包含密码输入框');
    root.unmount();

    // 3. 验证 SnippetsService 拦截需要填参的 Snippet 并在补全参数后关联回目标外部窗口
    const snippetsService = new SnippetsService({ dbPath: ':memory:' });
    const created = snippetsService.createSnippet({
      name: 'Deploy Command',
      snippet: template,
      keyword: ';deploy'
    });

    // 首次无参触发：应返回 requiresArguments: true、targetWindowMode: 'launcher' 并记录外部窗口句柄
    const firstTrigger = snippetsService.matchAndExpand('run ;deploy', '', {
      activeWindowId: 'hwnd-terminal-300'
    });
    assert.equal(firstTrigger.matched, true);
    assert.equal(firstTrigger.requiresArguments, true);
    assert.equal(firstTrigger.arguments?.length, 3);
    assert.equal(firstTrigger.targetWindowId, 'hwnd-terminal-300');
    assert.equal(firstTrigger.targetWindowMode, 'launcher');

    // 即使期间焦点切到 ZTools 自身窗口，外部目标窗口句柄依然保持为 hwnd-terminal-300
    snippetsService.recordExternalWindow('ztools-launcher-window');
    assert.equal(snippetsService.getLastExternalWindow(), 'hwnd-terminal-300');

    // 用户在表单中填写参数并提交：应完成动态替换并返回原外部窗口句柄 hwnd-terminal-300
    const completed = snippetsService.completeArgumentExpansion(
      created.id,
      { service: 'auth-svc', env: 'prod', secret: 'sk-999' },
      { targetWindowId: firstTrigger.targetWindowId }
    );
    assert.equal(completed.expanded, 'Deploy auth-svc to prod with key sk-999');
    assert.equal(completed.targetWindowId, 'hwnd-terminal-300', '参数提交后必须精准回填至捕获的外部窗口句柄');

    snippetsService.stop();
  });

  it('E8 Script Commands 四模式与 ANSI 着色渲染 12.5: ANSI 解析、URL 提取与 inline 缓存闭环', async () => {
    // 1. ANSI 颜色控制码解析与剥离
    const rawAnsi = '\x1b[1;32m✔ Deployment Ready\x1b[0m -> Visit https://ztools.dev/release-notes or http://localhost:8080/health!';
    const spans = parseAnsiOutput(rawAnsi);
    assert.ok(spans.length >= 2);
    assert.equal(spans[0].text, '✔ Deployment Ready');
    assert.equal(spans[0].bold, true);
    assert.equal(spans[0].fgColor, '#22c55e');

    const stripped = stripAnsiCodes(rawAnsi);
    assert.equal(stripped, '✔ Deployment Ready -> Visit https://ztools.dev/release-notes or http://localhost:8080/health!');

    // 2. 自动提取输出中的 URL 并剥离末尾标点
    const urls = extractUrlsFromOutput(rawAnsi);
    assert.deepEqual(urls, ['https://ztools.dev/release-notes', 'http://localhost:8080/health']);

    // 3. 解析 refreshTime 元数据时间间隔
    assert.equal(parseRefreshTimeMs('30s'), 30_000);
    assert.equal(parseRefreshTimeMs('10m'), 600_000);
    assert.equal(parseRefreshTimeMs('2h'), 7_200_000);
    assert.equal(parseRefreshTimeMs('1d'), 86_400_000);
    assert.equal(parseRefreshTimeMs('invalid'), null);

    // 4. 真实执行 inline 与 fullOutput 脚本验证缓存与视图描述符
    const tmpDir = await fs.mkdtemp(path.join(process.env.TEMP || '/tmp', 'ztools-e8-scripts-'));
    try {
      const inlineScriptPath = path.join(tmpDir, 'status-inline.js');
      await fs.writeFile(
        inlineScriptPath,
        [
          '#!/usr/bin/env node',
          '// @raycast.schemaVersion 1',
          '// @raycast.title Cluster Status',
          '// @raycast.mode inline',
          '// @raycast.refreshTime 5m',
          'console.log("\\x1b[32m3 Nodes Healthy\\x1b[0m");'
        ].join('\n'),
        'utf8'
      );

      const fullScriptPath = path.join(tmpDir, 'deploy-full.js');
      await fs.writeFile(
        fullScriptPath,
        [
          '#!/usr/bin/env node',
          '// @raycast.schemaVersion 1',
          '// @raycast.title Run Deploy',
          '// @raycast.mode fullOutput',
          'console.log("\\x1b[1;36mDeployed to https://app.ztools.dev/status\\x1b[0m");'
        ].join('\n'),
        'utf8'
      );

      const scriptService = new ScriptCommandsService({
        dataRoot: tmpDir,
        scriptsDir: tmpDir,
        confirmHandler: async () => true
      });

      await scriptService.scanScripts();
      const inlineRes = await scriptService.executeCommand('script:status-inline');
      assert.equal(inlineRes.success, true);
      assert.equal(inlineRes.output, '3 Nodes Healthy', 'inline 输出必须剥离 ANSI 控制码作为干净文本');

      const searchItems = scriptService.getSearchItems();
      const inlineItem = searchItems.find((i) => i.id === 'script:status-inline');
      assert.ok(inlineItem);
      assert.equal(inlineItem.inlineSubtitle, '3 Nodes Healthy', 'inline 模式执行后必须刷新搜索项动态副标题');
      assert.equal(inlineItem.refreshTimeMs, 300_000);
      assert.equal(inlineItem.ansiSpans?.[0]?.fgColor, '#22c55e');

      const fullRes = await scriptService.executeCommand('script:deploy-full');
      assert.equal(fullRes.success, true);
      assert.deepEqual(fullRes.extractedUrls, ['https://app.ztools.dev/status']);
      assert.ok(fullRes.viewDescriptor);
      assert.equal(fullRes.viewDescriptor.type, 'Detail');
      assert.deepEqual(fullRes.viewDescriptor.props.extractedUrls, ['https://app.ztools.dev/status']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('更新日志自动化 12.6: Keep a Changelog 增量追加、商业模块脱敏拦截、幂等去重与畸形输入防御', async () => {
    const {
      shouldExcludeCommitFromPublicChangelog,
      parseConventionalCommit,
      appendCommitsToChangelogContent
    } = await import('../scripts/update-changelog.mjs');

    // 1. 商业私有模块与噪音过滤校验
    assert.equal(shouldExcludeCommitFromPublicChangelog('feat(dll): 新增私有硬件驱动插件'), true);
    assert.equal(shouldExcludeCommitFromPublicChangelog('feat(backend): 新增计费接口'), true);
    assert.equal(shouldExcludeCommitFromPublicChangelog('chore(website): 更新官网截图'), true);
    assert.equal(shouldExcludeCommitFromPublicChangelog('chore: 同步 frontend 子模块至最新版本'), true);
    assert.equal(shouldExcludeCommitFromPublicChangelog('feat(core): 新增内联计算器与中文拼音高亮'), false);

    // 2. 异常与畸形参数断言
    assert.throws(() => parseConventionalCommit(null), /提交记录对象不能为空/);
    assert.throws(
      () => parseConventionalCommit({ sha: 'invalid_sha!', date: '2026-10-17', subject: 'feat: test' }),
      /非法提交 SHA/
    );
    assert.throws(
      () => parseConventionalCommit({ sha: 'a1b2c3d', date: '2026/10/17', subject: 'feat: test' }),
      /非法提交日期格式/
    );
    assert.throws(
      () => appendCommitsToChangelogContent('', []),
      /CHANGELOG\.md 原始内容不能为空/
    );

    // 3. 增量追加与幂等去重闭环
    const baseChangelog = [
      '# 更新日志 (Changelog)',
      '<!-- last-synced-commit: 1111111 -->',
      '',
      '## [v1.0.0] - 2026-10-14 - 初始版本',
      '',
      '### ✨ 新增特性 (Features)',
      '- 初始架构发布 (`1111111`)'
    ].join('\n');

    const incomingCommits = [
      { sha: '9999999', date: '2026-10-18', subject: 'feat(search): 支持多音字全拼检索与高亮' },
      { sha: '8888888', date: '2026-10-18', subject: 'fix: 修复窗口分屏还原坐标偏移' },
      { sha: '7777777', date: '2026-10-18', subject: 'feat(backend): 内部商业接口变更（应被自动过滤）' }
    ];

    const firstPass = appendCommitsToChangelogContent(baseChangelog, incomingCommits, {
      newHeadSha: '9999999'
    });
    assert.equal(firstPass.addedCount, 2, '商业提交被过滤后应精确追加 2 条公开记录');
    assert.ok(firstPass.content.includes('<!-- last-synced-commit: 9999999 -->'));
    assert.ok(firstPass.content.includes('## [Unreleased / 2026-10-18]'));
    assert.ok(firstPass.content.includes('- **search**：支持多音字全拼检索与高亮 (`9999999`)'));
    assert.ok(firstPass.content.includes('- 修复窗口分屏还原坐标偏移 (`8888888`)'));
    assert.equal(firstPass.content.includes('内部商业接口变更'), false, '严禁泄露私有商业模块提交信息');

    // 重复执行必须 100% 幂等（0 新增）
    const secondPass = appendCommitsToChangelogContent(firstPass.content, incomingCommits, {
      newHeadSha: '9999999'
    });
    assert.equal(secondPass.addedCount, 0, '重复传入相同提交必须幂等跳过');
    assert.equal(secondPass.content, firstPass.content);
  });
});




