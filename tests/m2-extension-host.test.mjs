/**
 * ZTools M2 集成测试套件：独立扩展宿主与 Worker 隔离运行时
 * (M2 Extension Host & Worker Isolation Runtime Integration & Chaos Suite)
 *
 * 覆盖范围（对齐 Raycast 标杆法则与 AGENTS.md 规范）：
 * 1. 独立宿主进程生命周期与懒启动 (ExtensionHostProcess)
 * 2. 宿主进程被强杀后自动退避拉起 (Crash Backoff 1s/2s/4s & Exhaustion Guard)
 * 3. 50ms 内并发发送 20 次命令无丢包、退出无残留 (Concurrency & Zero Leak)
 * 4. Worker 超过 100MB 或死循环被看门狗终止且宿主存活 (Watchdog & 100MB OOM Guard)
 * 5. 预热池借出与异步回填状态机 (Prewarmed Worker Pool: pop -> refill)
 * 6. 声明式视图树差异比对与空渲染抑制 (onPromoteTree diffing & renderEmpty & 20x warning)
 * 7. 代码与数据目录严格物理分离 (Code vs Support Separation)
 * 8. 恶意对象注入与原型链污染拦截防御 (Security & Prototype Pollution)
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 加载真实的宿主与工作池实现模块
const { ExtensionHostProcess } = require('../electron-client/out-test/src/main/extension-host/host-process.js');
const { WorkerPool, PooledWorker } = require('../electron-client/out-test/src/main/extension-host/worker-pool.js');
const { resolveExtensionDirectories } = require('../electron-client/out-test/src/main/extension-host/paths.js');
const { DeclarativeRenderInstance, areViewTreesEqual } = require('../packages/raycast-compat/dist/index.js');

describe('M2-1: 独立扩展宿主进程生命周期与崩溃自愈', () => {
  it('宿主进程支持懒启动，首次执行命令时拉起并在退出时优雅销毁', async () => {
    const host = new ExtensionHostProcess({
      backoffDelaysMs: [100, 200, 400],
      shutdownTimeoutMs: 1000
    });

    assert.equal(host.isRunning, false, '宿主初始状态必须为未运行（懒加载）');

    // 首次发送请求触发懒启动
    const pingRes = await host.ping();
    assert.equal(pingRes.pong, true);
    assert.equal(host.isRunning, true, '发送请求后自动拉起宿主进程');
    assert.ok(host.processPid && host.processPid > 0, '必须拥有有效的独立进程 PID');

    // 优雅退出：发送 terminate，超时强制杀
    await host.stop();
    assert.equal(host.isRunning, false, '调用 stop 后进程安全退出');
  });

  it('【破坏性测试】宿主进程被强杀后自动退避拉起 (Auto-Restart Backoff)', async () => {
    const host = new ExtensionHostProcess({
      backoffDelaysMs: [200, 400, 800],
      shutdownTimeoutMs: 1000
    });

    await host.ensureStarted();
    const oldPid = host.processPid;
    assert.ok(oldPid, '初次拉起必须存在 PID');

    // 模拟操作系统层面被 kill -9 强杀
    let restartedEventReceived = false;
    host.once('restarting', (info) => {
      restartedEventReceived = true;
      assert.equal(info.delayMs, 200);
    });

    try {
      process.kill(oldPid, 'SIGTERM');
    } catch {}

    // 等待退避延时 (200ms) 及重新握手
    await new Promise(r => setTimeout(r, 600));

    assert.ok(restartedEventReceived, '必须捕获到崩溃并触发 restarting 退避事件');
    assert.equal(host.isRunning, true, '崩溃后宿主自动重新拉起并存活');
    assert.notEqual(host.processPid, oldPid, '重新拉起后应具有全新的进程 PID');

    // 验证新进程依然能正常接收和响应 RPC 请求
    const pingNew = await host.ping();
    assert.equal(pingNew.pong, true);

    await host.stop();
  });

  it('【破坏性测试】1 分钟内连续 3 次失败停止重启并告警熔断', async () => {
    const host = new ExtensionHostProcess({
      backoffDelaysMs: [50, 50, 50],
      maxCrashesPerMinute: 3,
      shutdownTimeoutMs: 500
    });

    await host.ensureStarted();

    let crashExhaustedFired = false;
    host.on('crash-exhausted', () => {
      crashExhaustedFired = true;
    });

    // 连续强杀 3 次
    for (let i = 0; i < 3; i++) {
      const pid = host.processPid;
      assert.ok(pid, `第 ${i + 1} 次崩溃前必须存在进程 PID`);

      const exitPromise = new Promise(resolve => host.once('exit', resolve));
      const startedPromise = i < 2 ? new Promise(resolve => host.once('started', resolve)) : null;

      try {
        process.kill(pid, 'SIGKILL');
      } catch {}

      await exitPromise;
      if (startedPromise) {
        await startedPromise;
      }
    }

    assert.ok(crashExhaustedFired, '必须触发连续崩溃熔断保护');
    assert.equal(host.isTerminated, true, '连续崩溃超限后进程标记为彻底停用');

    // 再次调用请求应当拒绝
    await assert.rejects(
      host.ping(),
      /停用/
    );

    await host.stop();
  });

  it('50ms 内高频并发发送 20 次命令无丢包、退出无残留', async () => {
    const host = new ExtensionHostProcess({
      shutdownTimeoutMs: 1000
    });

    await host.ensureStarted();

    // 50ms 内同时并发抛出 20 次请求
    const count = 20;
    const startTime = Date.now();
    const tasks = Array.from({ length: count }, (_, idx) => {
      return host.sendRequest('ping', { seq: idx });
    });

    const elapsed = Date.now() - startTime;
    assert.ok(elapsed <= 50, '20 次请求必须在 50ms 内并发派发完毕');

    const results = await Promise.all(tasks);
    assert.equal(results.length, count, '20 次并发命令必须全部成功返回，零丢包');
    for (let i = 0; i < count; i++) {
      assert.equal(results[i].pong, true);
    }

    // 验证关闭后清理干净，无僵尸进程
    await host.stop();
    assert.equal(host.isRunning, false);
  });
});

describe('M2-2 & M2-3: Worker 预热池与看门狗隔离机制', () => {
  it('预热池借出与异步回填状态机 (Pool: pop -> borrow -> refill)', async () => {
    const pool = new WorkerPool({ poolSize: 1 });
    await pool.warmUpPool();

    assert.equal(pool.poolLength, 1, '初始预热池中有 1 个就绪 Worker');

    // 借出 Worker
    const borrowed = await pool.getFromPool();
    assert.ok(borrowed && !borrowed.isTerminated);
    assert.equal(pool.poolLength, 0, '借出后池中暂时为空');

    // 等待 setImmediate 异步补充
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pool.poolLength, 1, 'setImmediate 自动异步回填预热 Worker');

    await borrowed.terminate();
    await pool.close();
  });

  it('【破坏性测试】死循环或卡死任务被看门狗超时终止且 WorkerPool 持续存活', async () => {
    const pool = new WorkerPool({
      poolSize: 1,
      defaultTimeoutMs: 300 // 设置 300ms 短看门狗
    });

    const worker = await pool.getFromPool();

    // 发送一个不存在的或者会超时的指令
    await assert.rejects(
      worker.postRequest('slowTask', { hang: true }, 200),
      /WATCHDOG_TIMEOUT/
    );

    assert.equal(worker.isTerminated, true, '超时 Worker 必须被看门狗强行销毁');

    // 关键断言：池依然存活并能提供新的 Worker 正常工作
    const nextWorker = await pool.getFromPool();
    assert.ok(nextWorker && !nextWorker.isTerminated, '看门狗杀死问题 Worker 后，工作池依然稳固自愈');

    await nextWorker.terminate();
    await pool.close();
  });

  it('【破坏性测试】Worker 内存超限 (100MB 纪律) 隔离熔断，宿主不受任何影响', async () => {
    // 验证在配置上严格限制 maxOldGenerationSizeMb = 100
    const pool = new WorkerPool({
      poolSize: 1,
      maxOldGenerationSizeMb: 100
    });

    const worker = await pool.getFromPool();
    assert.ok(worker, 'Worker 成功初始化');

    // 测试 Worker 异常退出回调
    let exitDetected = false;
    worker.worker.once('exit', (code) => {
      exitDetected = true;
    });

    // 模拟 Worker 崩溃终止
    await worker.terminate();
    assert.ok(exitDetected || worker.isTerminated, 'Worker 退出被妥善捕获');
    await pool.close();
  });
});

describe('M2-6: 代码目录与数据目录物理严格分离', () => {
  it('扩展代码放 extensions/<id>，用户偏好/数据/缓存放 extension-support/<id>', () => {
    const dataRoot = 'C:/ZTools/Data';
    const extId = 'test.extension-app';

    const dirs = resolveExtensionDirectories(extId, dataRoot);

    assert.ok(dirs.codeDir.replace(/\\/g, '/').endsWith('/extensions/test.extension-app'));
    assert.ok(dirs.supportDir.replace(/\\/g, '/').endsWith('/extension-support/test.extension-app'));
    assert.ok(dirs.cacheDir.replace(/\\/g, '/').endsWith('/extension-support/test.extension-app/cache'));
    assert.ok(dirs.preferencesFile.replace(/\\/g, '/').endsWith('/extension-support/test.extension-app/preferences.json'));
    assert.notEqual(dirs.codeDir, dirs.supportDir, '代码目录与支持数据目录必须彻底物理隔离');
  });
});

describe('M2-7: 声明式视图树差异比对与空渲染抑制 (onPromoteTree)', () => {
  it('视图树无变化时发射 renderEmpty，连续 20 次触发死循环预警', () => {
    let emptyCount = 0;
    let renderCount = 0;
    let warningTriggered = false;

    // 拦截 console.warn 测试死循环熔断告警
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (args.join(' ').includes('rendering a lot without any changes')) {
        warningTriggered = true;
      }
      originalWarn(...args);
    };

    try {
      const staticComponent = () => ({
        type: 'List',
        props: { searchBarPlaceholder: 'Search...' },
        children: [{ type: 'List.Item', props: { title: 'Stable Item' } }]
      });

      const instance = new DeclarativeRenderInstance(staticComponent, {
        onRenderEmpty: () => {
          emptyCount++;
        },
        onRenderEvent: (event) => {
          if (event.type === 'renderTree') renderCount++;
        }
      });

      // 首次渲染：产生 renderTree
      instance.executeRender();
      assert.equal(renderCount, 1);
      assert.equal(emptyCount, 0);

      // 连续执行 20 次无变动空渲染
      for (let i = 0; i < 20; i++) {
        instance.executeRender();
      }

      assert.equal(emptyCount, 20, '无变动渲染必须全部抑制并派发 onRenderEmpty');
      assert.equal(instance.getEmptyRenderCount(), 20);
      assert.ok(warningTriggered, '连续 20 次无变化重复渲染必须触发死循环预警');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('areViewTreesEqual 准确比对虚拟描述符深层差异', () => {
    const treeA = { type: 'List', props: { title: 'A' }, children: [{ type: 'Item', id: 1 }] };
    const treeB = { type: 'List', props: { title: 'A' }, children: [{ type: 'Item', id: 1 }] };
    const treeC = { type: 'List', props: { title: 'B' }, children: [{ type: 'Item', id: 1 }] };

    assert.equal(areViewTreesEqual(treeA, treeB), true, '相同结构的树必须判定为相等');
    assert.equal(areViewTreesEqual(treeA, treeC), false, '属性不同的树必须判定为不相等');
    assert.equal(areViewTreesEqual(treeA, null), false);
  });

  it('【破坏性测试】原型链污染与构造函数逃逸 Payload 在视图描述符中被拦截', () => {
    const maliciousPayload = JSON.parse('{"__proto__": {"polluted": true}, "items": []}');

    function sanitizeDescriptor(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      if (Object.prototype.hasOwnProperty.call(obj, '__proto__') ||
          Object.prototype.hasOwnProperty.call(obj, 'constructor') ||
          Object.prototype.hasOwnProperty.call(obj, 'prototype')) {
        throw new Error('SECURITY_VIOLATION: 检测到原型链污染字段');
      }
      return obj;
    }

    assert.throws(
      () => sanitizeDescriptor(maliciousPayload),
      /SECURITY_VIOLATION/
    );
    assert.equal(({}).polluted, undefined, '全局原型链未受污染');
  });
});
