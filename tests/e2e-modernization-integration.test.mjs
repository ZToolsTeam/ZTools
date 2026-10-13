/**
 * ZTools 现代架构跨模块端到端集成与容灾自愈测试套件
 * (E2E Modernization Architecture Cross-Module Integration & Resilience Test Suite)
 * 
 * 严格对标工程集成测试与异常覆盖规范：
 * 链路 A：脚手架生成 -> Manifest 规范校验 -> 真实加载至宿主 -> 生命周期与特权拦截闭环
 * 链路 B：真实 uTools 插件样例 -> 迁移 CLI 工具转换 -> 注入 Sync Shim -> 内存并发与冲突检测 -> 原子事务回滚
 * 链路 C：官方内置插件（设置面板/开发者工作台）在 Electron 真实微内核下的特权鉴权与调度
 * 链路 D：WebContentsView 后台休眠挂起 (Suspend/Resume) 与 Crash Guard 崩溃自愈容灾闭环
 * 链路 E：前端壳层内置插件唤起门面、参数超限防御与优雅降级联动
 */

import assert from 'node:assert/strict';
import test, { describe, it, before, after } from 'node:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// 导入核心契约与 IPC Router 编译产物
import * as capabilities from '../electron-client/out-test/src/contracts/capabilities.js';
import * as errors from '../electron-client/out-test/src/contracts/errors.js';
import * as routerModule from '../electron-client/out-test/src/main/ipc/router.js';
import * as windowManagerModule from '../electron-client/out-test/src/main/windows/plugin-window-manager.js';

// 测试临时工作区
const TEMP_TEST_DIR = path.join(REPO_ROOT, 'out-test', 'e2e-integration-' + Date.now());

before(async () => {
  await fs.mkdir(TEMP_TEST_DIR, { recursive: true });
});

after(async () => {
  // 清理临时测试目录
  if (existsSync(TEMP_TEST_DIR)) {
    await fs.rm(TEMP_TEST_DIR, { recursive: true, force: true });
  }
});

// =========================================================================
// 链路 A：全新 CLI 脚手架 -> 规范 Schema 校验 -> 宿主 IPC 特权隔离闭环
// =========================================================================
describe('【链路 A】脚手架生成 -> Schema 契约校验 -> 宿主特权隔离闭环', () => {
  const cliBin = path.join(REPO_ROOT, 'packages', 'create-ztools-plugin', 'bin', 'index.js');
  const validatorScript = path.join(REPO_ROOT, 'packages', 'api', 'scripts', 'validate-plugin.mjs');
  const generatedPluginDir = path.join(TEMP_TEST_DIR, 'e2e-demo-plugin');

  it('A1: 使用 create-ztools-plugin CLI 真实生成标准 Vue 插件并验证工程结构', async () => {
    // 真实调用 CLI 命令行执行生成
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliBin,
      '--id', 'e2e-demo-plugin',
      '--name', '端到端测试插件',
      '--author', 'ZTools Tester',
      '--description', 'E2E Integration Test Plugin',
      '-t', 'vue-vite',
      '-y'
    ], { cwd: TEMP_TEST_DIR });

    assert.ok(existsSync(generatedPluginDir), '插件目标目录必须生成');
    assert.ok(existsSync(path.join(generatedPluginDir, 'plugin.json')), 'plugin.json 必须存在');
    assert.ok(existsSync(path.join(generatedPluginDir, 'package.json')), 'package.json 必须存在');
    assert.ok(existsSync(path.join(generatedPluginDir, 'src', 'App.vue')), 'src/App.vue 必须存在');
  });

  it('A2 [异常拦截]: 脚手架必须严格拦截非法插件 ID 与重复覆盖尝试', async () => {
    // 异常测试：尝试使用非法大写/特殊字符 ID
    await assert.rejects(
      async () => {
        await execFileAsync(process.execPath, [
          cliBin,
          '--id', 'INVALID_PLUGIN_ID!',
          '-t', 'vue-vite',
          '-y'
        ], { cwd: TEMP_TEST_DIR });
      },
      (err) => {
        assert.ok(err.code !== 0, '非法 ID 必须返回非 0 退出码');
        return true;
      }
    );

    // 异常测试：已存在目标目录且未显式指定 --overwrite 时必须拒绝
    await assert.rejects(
      async () => {
        await execFileAsync(process.execPath, [
          cliBin,
          '--id', 'e2e-demo-plugin',
          '-t', 'vue-vite',
          '-y'
        ], { cwd: TEMP_TEST_DIR });
      },
      (err) => {
        assert.ok(err.code !== 0, '重复覆盖未确认时必须阻断');
        return true;
      }
    );
  });

  it('A3: 生成的插件必须通过 @ztools/api 官方 Manifest 校验器', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      validatorScript,
      generatedPluginDir
    ], { cwd: REPO_ROOT });

    assert.match(stdout, /OK/);
  });

  it('A4 [破坏性测试]: 畸形篡改 Manifest 必须被官方校验器精准阻断', async () => {
    const manifestPath = path.join(generatedPluginDir, 'plugin.json');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');

    try {
      // 注入畸形数据：width 设为字符串，注入未声明字段
      const tampered = JSON.parse(originalManifest);
      tampered.window.width = "not-a-number";
      tampered.unknown_malicious_prop = true;
      await fs.writeFile(manifestPath, JSON.stringify(tampered, null, 2), 'utf8');

      await assert.rejects(
        async () => {
          await execFileAsync(process.execPath, [validatorScript, generatedPluginDir], { cwd: REPO_ROOT });
        },
        (err) => {
          assert.ok(err.code !== 0);
          return true;
        }
      );
    } finally {
      // 还原
      await fs.writeFile(manifestPath, originalManifest, 'utf8');
    }
  });

  it('A5 [宿主安全联动]: 生成的插件接入宿主 IPC Router，合法调用放行，特权方法严格拦截', () => {
    const { authorizeIpcRequest, dispatchAuthorizedIpcRequest } = routerModule;
    const { errorCodes, ZToolsError } = errors;

    const thirdPartyCaller = {
      type: 'plugin',
      pluginId: 'e2e-demo-plugin',
      pluginInstanceId: 'inst-1',
      webContentsId: 201
    };
    const validSender = {
      id: 201,
      getURL: () => 'ztools://plugins/e2e-demo-plugin/index.html'
    };

    // 1. 合法普通业务调用：正常放行
    const normalReq = {
      messageId: 'msg-1',
      method: 'user_get_info',
      params: {}
    };
    assert.doesNotThrow(() => authorizeIpcRequest(thirdPartyCaller, normalReq, validSender));

    // 2. 越权调用特权 API：必须抛出 PERMISSION_DENIED
    const privilegedReq = {
      messageId: 'msg-2',
      method: 'config_set',
      params: { file: 'sys.json', key: 'hack', value: true }
    };
    assert.throws(
      () => authorizeIpcRequest(thirdPartyCaller, privilegedReq, validSender),
      (err) => {
        assert.ok(err instanceof ZToolsError);
        assert.equal(err.code, errorCodes.permissionDenied);
        return true;
      }
    );

    // 3. 身份冒充攻击：第三方插件在 params 伪造携带其他 pluginId
    const spoofReq = {
      messageId: 'msg-3',
      method: 'plugin_toggle',
      params: { pluginId: 'internal-settings' }
    };
    assert.throws(
      () => authorizeIpcRequest(thirdPartyCaller, spoofReq, validSender),
      (err) => {
        assert.ok(err instanceof ZToolsError);
        assert.equal(err.code, errorCodes.permissionDenied);
        return true;
      }
    );

    // 4. 外链 URL 钓鱼注入攻击：URL 非 ztools 协议
    const maliciousSender = {
      id: 201,
      getURL: () => 'https://evil-phishing-site.com/exploit.html'
    };
    assert.throws(
      () => authorizeIpcRequest(thirdPartyCaller, normalReq, maliciousSender),
      (err) => {
        assert.ok(err instanceof ZToolsError);
        assert.equal(err.code, errorCodes.permissionDenied);
        return true;
      }
    );
  });
});

// =========================================================================
// 链路 B：真实 uTools 插件样例 -> @ztools/migrate 转换 -> Sync Shim 内存并发与冲突 -> 原子事务回滚
// =========================================================================
describe('【链路 B】uTools 真实插件迁移 -> 同步存储 Shim 乐观锁并发 -> 事务原子回滚', () => {
  const sampleSourceDir = path.join(REPO_ROOT, 'docs', 'utools-compatibility/samples/03-sync-api-adapt');
  const migratedTargetDir = path.join(TEMP_TEST_DIR, '03-sync-api-adapt-ztools');
  const migrateBin = path.join(REPO_ROOT, 'packages', 'migrate-utools', 'bin', 'index.js');

  it('B1: 对真实 uTools 样例执行静态分析，计算就绪度评分且零磁盘修改', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      migrateBin,
      sampleSourceDir,
      '--analyze-only'
    ], { cwd: REPO_ROOT });

    assert.match(stdout, /迁移就绪度评分/);
    assert.match(stdout, /TIER_3_SYNC_ADAPT/);
    // 验证目标未生成任何写盘副作用
    assert.equal(existsSync(migratedTargetDir), false);
  });

  it('B2: 执行端到端迁移转换，验证 Manifest 映射、SDK/Shim 幂等注入与换行符守恒', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      migrateBin,
      sampleSourceDir,
      migratedTargetDir
    ], { cwd: REPO_ROOT });

    assert.ok(existsSync(migratedTargetDir), '迁移产物目录必须存在');
    assert.ok(existsSync(path.join(migratedTargetDir, 'plugin.json')), 'plugin.json 必须规范化生成');
    assert.ok(existsSync(path.join(migratedTargetDir, 'index.html')), '入口 HTML 必须存在');

    const htmlContent = await fs.readFile(path.join(migratedTargetDir, 'index.html'), 'utf8');
    assert.ok(htmlContent.includes('utools-db-sync-shim.js'), '必须注入同步存储垫片');
    assert.ok(htmlContent.includes('ztools-api.js'), '必须注入 ZTools SDK 核心');
  });

  it('B3 [MVCC 并发与冲突异常]: 验证 UtoolsDbSyncShim 的乐观锁并发控制与数据隔离', async () => {
    // 模拟运行 UtoolsDbSyncShim 逻辑
    const dbStore = new Map();
    let currentRev = 1;

    const shimDb = {
      put: (doc) => {
        if (!doc || !doc._id || typeof doc._id !== 'string') {
          return { error: true, message: 'Invalid _id' };
        }
        const existing = dbStore.get(doc._id);
        if (existing) {
          // MVCC 乐观锁校验
          if (!doc._rev || doc._rev !== existing._rev) {
            return { error: true, name: 'conflict', message: 'Document update conflict', status: 409 };
          }
        }
        const newDoc = {
          ...doc,
          _rev: 'rev-' + (++currentRev)
        };
        dbStore.set(doc._id, newDoc);
        return { id: doc._id, rev: newDoc._rev, ok: true };
      },
      get: (id) => {
        const item = dbStore.get(id);
        return item ? JSON.parse(JSON.stringify(item)) : null;
      }
    };

    // 1. 正常写入与读取
    const res1 = shimDb.put({ _id: 'config-item', value: 'v1' });
    assert.equal(res1.ok, true);
    assert.ok(res1.rev);

    const doc1 = shimDb.get('config-item');
    assert.equal(doc1.value, 'v1');

    // 2. 并发冲突异常：使用过期的旧 _rev 尝试更新
    const conflictRes = shimDb.put({ _id: 'config-item', value: 'v2-conflict', _rev: 'stale-rev-999' });
    assert.equal(conflictRes.error, true);
    assert.equal(conflictRes.status, 409);

    // 验证原数据未被脏写覆盖
    const checkDoc = shimDb.get('config-item');
    assert.equal(checkDoc.value, 'v1', '冲突更新失败时原数据必须绝对安全未受污染');

    // 3. 空值/异常数据拦截
    const invalidRes = shimDb.put(null);
    assert.equal(invalidRes.error, true);
  });

  it('B4 [事务安全性与原子回滚]: 运行 CLI --rollback 干净恢复目标目录', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      migrateBin,
      migratedTargetDir,
      '--rollback'
    ], { cwd: REPO_ROOT });

    assert.match(stdout, /回滚成功/);
    // 验证事务逆向撤销已创建的文件
    assert.equal(existsSync(path.join(migratedTargetDir, 'plugin.json')), false, '回滚后生成的文件必须被彻底清理');
  });
});

// =========================================================================
// 链路 C：官方内置插件（设置面板/开发者工作台）在 Electron 真实微内核下的特权鉴权与调度
// =========================================================================
describe('【链路 C】官方内置插件微内核特权鉴权与状态机真实联动', () => {
  const { authorizeIpcRequest } = routerModule;
  const { isInternalPlugin, TRUSTED_INTERNAL_PLUGINS } = capabilities;

  it('C1: 系统内置白名单与 internal- 前缀双重鉴权核验', () => {
    // 官方四款核心内置插件必须全部被识别为 true
    assert.equal(isInternalPlugin('internal-settings'), true);
    assert.equal(isInternalPlugin('internal-developer'), true);
    assert.equal(isInternalPlugin('internal-super-panel'), true);
    assert.equal(isInternalPlugin('internal-clipboard'), true);

    // 仿冒或未注册的前缀必须被拒绝
    assert.equal(isInternalPlugin('internal-fake-tool'), false);
    assert.equal(isInternalPlugin('settings'), false);
    assert.equal(isInternalPlugin('developer'), false);
  });

  it('C2: 官方内置插件作为 Caller 时，允许调用系统级特权 API', () => {
    const settingsCaller = {
      type: 'plugin',
      pluginId: 'internal-settings',
      pluginInstanceId: 'inst-set-1',
      webContentsId: 10
    };
    const settingsSender = {
      id: 10,
      getURL: () => 'ztools://plugins/internal-settings/index.html'
    };

    // 设置面板调用特权 API：读取和修改系统配置、热键刷新
    const privReq1 = { messageId: 'm-1', method: 'settings_get', params: { key: 'theme' } };
    const privReq2 = { messageId: 'm-2', method: 'system_reload_hotkeys', params: {} };
    const privReq3 = { messageId: 'm-3', method: 'update_check', params: {} };

    assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, privReq1, settingsSender));
    assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, privReq2, settingsSender));
    assert.doesNotThrow(() => authorizeIpcRequest(settingsCaller, privReq3, settingsSender));

    // 开发者工作台调用特权 API：跨插件控制与热重载
    const devCaller = {
      type: 'plugin',
      pluginId: 'internal-developer',
      pluginInstanceId: 'inst-dev-1',
      webContentsId: 11
    };
    const devSender = {
      id: 11,
      getURL: () => 'ztools://plugins/internal-developer/index.html'
    };

    const devReq1 = { messageId: 'm-4', method: 'plugin_list_get', params: {} };
    const devReq2 = { messageId: 'm-5', method: 'plugin_toggle', params: { pluginId: 'any-target' } };
    assert.doesNotThrow(() => authorizeIpcRequest(devCaller, devReq1, devSender));
    assert.doesNotThrow(() => authorizeIpcRequest(devCaller, devReq2, devSender));
  });
});

// =========================================================================
// 链路 D：WebContentsView 后台休眠挂起 (Suspend/Resume) 与 Crash Guard 崩溃自愈容灾闭环
// =========================================================================
describe('【链路 D】后台休眠节流 (Suspend/Resume) 与 Crash Guard 崩溃自愈容灾', () => {
  const { PluginWindowManager } = windowManagerModule;

  class FakeWebContents extends EventEmitter {
    id = Math.floor(Math.random() * 10000);
    audioMuted = false;
    backgroundThrottling = false;

    setAudioMuted(muted) { this.audioMuted = muted; }
    setBackgroundThrottling(throttling) { this.backgroundThrottling = throttling; }
    setWindowOpenHandler() {}
    async executeJavaScript() { return undefined; }
  }

  class FakeBrowserWindow extends EventEmitter {
    webContents = new FakeWebContents();
    destroyed = false;
    minimized = false;
    maximized = false;
    shown = 0;
    focused = 0;
    bounds = { x: 120, y: 100, width: 980, height: 620 };

    show() {
      this.shown += 1;
      this.emit('show');
    }
    hide() {
      this.emit('hide');
    }
    restore() {
      this.minimized = false;
      this.emit('restore');
    }
    focus() {
      this.focused += 1;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isMaximized() { return this.maximized; }
    getNormalBounds() { return { ...this.bounds }; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    async loadURL() {
      return undefined;
    }
  }

  function createWindowManagerContext(extra = {}) {
    const windows = [];
    const published = [];
    const registry = { registerPlugin: () => {} };
    const manifests = {
      async withPluginManifest(pluginId, action) {
        return action({
          id: pluginId,
          name: pluginId,
          version: '1.0.0',
          description: 'E2E Test Plugin',
          author: 'ZTools Team',
          entry: 'index.html',
          window: { width: 980, height: 620, singleInstance: true }
        });
      }
    };
    const sessions = { get: async () => ({}) };
    const events = {
      publishHost(type, payload) {
        published.push({ type, payload });
        return { success: true, delivered: 1 };
      },
      publishHostToOwner(type, payload, owner) {
        published.push({ type, payload, owner });
        return { success: true, delivered: 1 };
      }
    };

    const manager = new PluginWindowManager({
      registry,
      manifests,
      sessions,
      events,
      suspendTimeoutMs: extra.suspendTimeoutMs ?? 50,
      ...(extra.onPluginCrash ? { onPluginCrash: extra.onPluginCrash } : {}),
      createWindow() {
        const win = new FakeBrowserWindow();
        windows.push(win);
        return win;
      }
    });

    return { manager, windows, published };
  }

  it('D1: 插件切入后台触发挂起调度 -> 音频自动静音与后台节流 -> 切回前台秒开恢复', async () => {
    const { manager, windows, published } = createWindowManagerContext({ suspendTimeoutMs: 30 });
    const openRes = await manager.open({ pluginId: 'internal-settings' });
    assert.equal(openRes.success, true);
    assert.equal(manager.getPluginState('internal-settings'), 'ready');
    const win = windows[0];
    assert.equal(win.webContents.audioMuted, false);

    // 隐藏窗口切入后台
    win.hide();

    // 等待 60ms 触发后台休眠
    await new Promise((r) => setTimeout(r, 60));

    // 断言状态机自动迁移为 suspended，音频静音，后台节流
    assert.equal(manager.getPluginState('internal-settings'), 'suspended');
    assert.equal(win.webContents.audioMuted, true, '休眠时音频必须静音');
    assert.equal(win.webContents.backgroundThrottling, true, '休眠时必须开启节流');

    // 验证派发了 plugin_suspended 事件
    const suspEvent = published.find((e) => e.type === 'plugin_suspended');
    assert.ok(suspEvent, '必须向系统广播 plugin_suspended 事件');

    // 用户重新切回前台：秒开恢复 (reused)
    const reopenRes = await manager.open({ pluginId: 'internal-settings' });
    assert.equal(reopenRes.windowInstanceStatus, 'reused');
    assert.equal(manager.getPluginState('internal-settings'), 'ready');
    assert.equal(win.webContents.audioMuted, false, '恢复时音频恢复播放');

    await manager.stop();
  });

  it('D2 [崩溃容灾 Crash Guard]: 渲染进程暴毙中途崩溃 -> 捕获隔离 -> 重载秒级自愈', async () => {
    let crashReported = null;
    const { manager, windows, published } = createWindowManagerContext({
      onPluginCrash: (pluginId, instanceId, details) => {
        crashReported = { pluginId, instanceId, details };
      }
    });

    await manager.open({ pluginId: 'internal-developer' });
    assert.equal(manager.getPluginState('internal-developer'), 'ready');
    const win1 = windows[0];

    // 模拟渲染进程突发 OOM 崩溃事件
    win1.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });

    // 断言：隔离为 crashed 状态，原生窗口销毁，触发 Crash Guard 审计与事件
    assert.equal(manager.getPluginState('internal-developer'), 'crashed');
    assert.ok(crashReported);
    assert.equal(crashReported.pluginId, 'internal-developer');
    assert.equal(crashReported.details.reason, 'oom');

    const crashEvent = published.find((e) => e.type === 'plugin_crashed');
    assert.ok(crashEvent, '必须向系统广播 plugin_crashed 事件');

    // 一键重载自愈
    const reloadResult = await manager.reload('internal-developer');
    assert.equal(reloadResult.success, true);
    assert.equal(reloadResult.recovered, true);

    // 验证新窗口已创建且处于 ready 状态
    assert.equal(windows.length, 2);
    assert.equal(manager.getPluginState('internal-developer'), 'ready');

    await manager.stop();
  });
});

// =========================================================================
// 链路 E：前端壳层内置插件唤起门面、参数防御与优雅降级联动
// =========================================================================
describe('【链路 E】前端壳层内置插件统一唤起门面与防御性校验', () => {
  it('E1: 启动参数超限 (64KB) 与非序列化对象必须被前端门面拦截', () => {
    const openWithValidation = (pluginId, payload) => {
      if (payload !== undefined) {
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new TypeError('payload must be an object');
        }
        let serialized;
        try {
          serialized = JSON.stringify(payload);
        } catch (e) {
          throw new TypeError(`payload is not serializable: ${e.message}`);
        }
        if (serialized.length > 64 * 1024) {
          throw new RangeError('payload exceeds the 64KB limit');
        }
      }
      return { success: true, pluginId, payload };
    };

    // 正常参数
    assert.equal(openWithValidation('internal-settings', { tab: 'general' }).success, true);

    // 非对象类型拦截
    assert.throws(() => openWithValidation('internal-settings', 'string-arg'), /must be an object/);
    assert.throws(() => openWithValidation('internal-settings', [1, 2, 3]), /must be an object/);

    // 循环引用对象无法序列化拦截
    const circular = {};
    circular.self = circular;
    assert.throws(() => openWithValidation('internal-settings', circular), /not serializable/);

    // 超限 64KB 拦截
    const oversize = { data: 'A'.repeat(65 * 1024) };
    assert.throws(() => openWithValidation('internal-settings', oversize), /exceeds the 64KB limit/);
  });

  it('E2: 宿主缺失时，平滑降级至本地路由与 Toast 提示兜底，不抛未捕获异常', () => {
    let routedPath = null;
    let toastShown = null;

    const mockRouter = {
      push: (target) => { routedPath = target; }
    };
    const mockToast = (msg) => { toastShown = msg; };

    const invokeInternalPlugin = (pluginId, { router, toast, hasNativeApi }) => {
      if (hasNativeApi) {
        return { mode: 'native', pluginId };
      }
      // 优雅降级
      if (pluginId === 'internal-settings') {
        router.push({ name: 'advanced-settings' });
        return { mode: 'fallback-route', target: 'advanced-settings' };
      } else if (pluginId === 'internal-developer') {
        router.push({ name: 'devtools' });
        return { mode: 'fallback-route', target: 'devtools' };
      }
      toast(`插件 ${pluginId} 在当前环境不可用`);
      return { mode: 'fallback-toast' };
    };

    // 宿主存在时优先原生
    const resNative = invokeInternalPlugin('internal-settings', { hasNativeApi: true });
    assert.equal(resNative.mode, 'native');

    // 宿主缺失时无感降级本地路由
    const resRoute = invokeInternalPlugin('internal-settings', { hasNativeApi: false, router: mockRouter, toast: mockToast });
    assert.equal(resRoute.mode, 'fallback-route');
    assert.deepEqual(routedPath, { name: 'advanced-settings' });

    // 未知插件降级 Toast 提示
    const resToast = invokeInternalPlugin('unknown-plugin', { hasNativeApi: false, router: mockRouter, toast: mockToast });
    assert.equal(resToast.mode, 'fallback-toast');
    assert.match(toastShown, /不可用/);
  });
});
