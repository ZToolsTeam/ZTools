import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  isTrustedWindowsUiAccessLocation,
  ManagedSidecarProcess,
  resolveSidecarBinaryPath,
  SidecarManager
} from '../../src/main/services/sidecar-manager.js'

test('打包态仅从受控 resources/native 解析索引与 UIAccess 侧车，不回退 cwd 或 app.asar', () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-sidecar-resolve-')))
  const resourcesDir = path.join(tmpRoot, 'app-install', 'resources')
  const packagedNativeDir = path.join(resourcesDir, 'native')
  const fakeCwd = path.join(tmpRoot, 'untrusted-cwd')
  const fakeCwdBin = path.join(fakeCwd, 'out', 'native', 'win32-x64', 'bin')

  try {
    fs.mkdirSync(packagedNativeDir, { recursive: true })
    fs.mkdirSync(fakeCwdBin, { recursive: true })

    // 外部工作目录放同名文件，打包态绝不可命中
    fs.writeFileSync(path.join(fakeCwdBin, 'ztools-indexer.exe'), 'untrusted', 'utf8')
    assert.equal(
      resolveSidecarBinaryPath('ztools-indexer', {
        isPackaged: true,
        resourcesPath: resourcesDir,
        cwd: fakeCwd,
        platform: 'win32',
        env: {}
      }),
      null
    )

    // 在 resources/native 下放置受控普通文件后精确命中
    const expectedIndexer = path.join(packagedNativeDir, 'ztools-indexer.exe')
    const expectedUiaccess = path.join(packagedNativeDir, 'ztools-uiaccess.exe')
    const expectedUiaccessStd = path.join(packagedNativeDir, 'ztools-uiaccess-standard.exe')
    fs.writeFileSync(expectedIndexer, 'MZ', 'utf8')
    fs.writeFileSync(expectedUiaccess, 'MZ', 'utf8')
    fs.writeFileSync(expectedUiaccessStd, 'MZ', 'utf8')

    assert.equal(
      resolveSidecarBinaryPath('ztools-indexer', {
        isPackaged: true,
        resourcesPath: resourcesDir,
        cwd: fakeCwd,
        platform: 'win32',
        env: {}
      }),
      expectedIndexer
    )
    assert.equal(
      resolveSidecarBinaryPath('ztools-uiaccess', {
        resourcesPath: resourcesDir,
        defaultApp: false,
        cwd: fakeCwd,
        platform: 'win32',
        env: {}
      }),
      expectedUiaccess
    )
    assert.equal(
      resolveSidecarBinaryPath('ztools-uiaccess-standard', {
        resourcesPath: resourcesDir,
        defaultApp: false,
        cwd: fakeCwd,
        platform: 'win32',
        env: {}
      }),
      expectedUiaccessStd
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('开发态与环境变量覆盖按预期解析侧车路径，缺失时 SidecarManager 降级而非崩溃', async () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-sidecar-dev-')))
  const devAppRoot = path.join(tmpRoot, 'client')
  const devBinDir = path.join(devAppRoot, 'out', 'native', 'win32-x64', 'bin')
  const customOverride = path.join(tmpRoot, 'custom-indexer.exe')

  try {
    fs.mkdirSync(devBinDir, { recursive: true })
    const devIndexer = path.join(devBinDir, 'ztools-indexer.exe')
    fs.writeFileSync(devIndexer, 'MZ', 'utf8')
    fs.writeFileSync(customOverride, 'MZ', 'utf8')

    assert.equal(
      resolveSidecarBinaryPath('ztools-indexer', {
        resourcesPath: path.join(tmpRoot, 'electron-dist', 'resources'),
        defaultApp: true,
        appPath: devAppRoot,
        cwd: tmpRoot,
        platform: 'win32',
        env: {}
      }),
      devIndexer
    )

    assert.equal(
      resolveSidecarBinaryPath('ztools-indexer', {
        isPackaged: true,
        resourcesPath: path.join(tmpRoot, 'missing-resources'),
        platform: 'win32',
        env: { ZTOOLS_ZTOOLS_INDEXER_PATH: customOverride }
      }),
      customOverride
    )

    // 打包态缺失侧车二进制时优雅降级并保留诊断信息
    const manager = new SidecarManager({
      resolveContext: {
        isPackaged: true,
        resourcesPath: path.join(tmpRoot, 'empty-resources'),
        platform: 'win32',
        env: {}
      }
    })
    await manager.startAll()
    const status = manager.getStatus()
    assert.equal(status.indexer.state, 'degraded')
    assert.match(status.indexer.lastError ?? '', /Binary not found: ztools-indexer/)
    await manager.stop()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('主二进制缺失且回退二进制启动失败时收敛为 degraded 而不卡死 starting', async () => {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-sidecar-fallback-')))

  try {
    const proc = new ManagedSidecarProcess({
      name: 'fallback-failure',
      binaryName: 'ztools-missing-primary',
      fallbackBinaryName: 'ztools-broken-fallback',
      args: ['-e', 'process.exit(1)'],
      heartbeatIntervalMs: 60000,
      resolveContext: {
        isPackaged: true,
        resourcesPath: path.dirname(process.execPath),
        platform: process.platform,
        env: { ZTOOLS_ZTOOLS_BROKEN_FALLBACK_PATH: process.execPath }
      }
    })

    await proc.start()
    assert.equal(proc.state, 'degraded')
    assert.match(proc.lastError ?? '', /exited prematurely|code 1/)
    assert.equal(proc.pid, null)
    await proc.stop()
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('stop 等待 shutdown 期间若侧车进程已先退出清理 child，仍可安全收敛为 stopped', async () => {
  const proc = new ManagedSidecarProcess({
    name: 'graceful-shutdown-race',
    binaryName: 'ztools-real-node-sidecar',
    args: [
      '-e',
      [
        'const rl = require("readline").createInterface({ input: process.stdin });',
        'rl.on("line", (line) => {',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "shutdown") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }) + "\\n");',
        '    process.exit(0);',
        '  }',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n");',
        '});'
      ].join(' ')
    ],
    heartbeatIntervalMs: 60000,
    resolveContext: {
      isPackaged: true,
      resourcesPath: path.dirname(process.execPath),
      platform: process.platform,
      env: { ZTOOLS_ZTOOLS_REAL_NODE_SIDECAR_PATH: process.execPath }
    }
  })

  try {
    await proc.start()
    assert.equal(proc.state, 'running')
    const stopOutcome = await proc.stop()
    assert.equal(proc.state, 'stopped')
    assert.equal(proc.pid, null)
    assert.equal(proc.child, null)
    assert.equal(stopOutcome.forced, false)
    assert.ok(['rpc-shutdown', 'already-exited'].includes(stopOutcome.exitMethod))
  } finally {
    await proc.stop()
  }
})

test('主二进制启动失败后回退成功时清零 lastError 并标记降级态', async () => {
  const managerScript = [
    'const rl = require("readline").createInterface({ input: process.stdin });',
    'rl.on("line", (line) => {',
    '  const msg = JSON.parse(line);',
    '  if (msg.method === "shutdown") {',
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }) + "\\n");',
    '    process.exit(0);',
    '  }',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "ping" ? "pong" : {} }) + "\\n");',
    '});'
  ].join(' ')

  const proc = new ManagedSidecarProcess({
    name: 'fallback-success',
    binaryName: 'ztools-missing-primary',
    fallbackBinaryName: 'ztools-working-fallback',
    args: ['-e', managerScript],
    heartbeatIntervalMs: 60000,
    resolveContext: {
      isPackaged: true,
      resourcesPath: path.dirname(process.execPath),
      platform: process.platform,
      env: { ZTOOLS_ZTOOLS_WORKING_FALLBACK_PATH: process.execPath }
    }
  })

  try {
    await proc.start()
    assert.equal(proc.state, 'running')
    assert.equal(proc.lastError, null)
    assert.equal(proc.usingFallback, true)
    assert.equal(proc.activeBinary, 'ztools-working-fallback')
    assert.match(proc.fallbackReason ?? '', /Binary not found: ztools-missing-primary/)
  } finally {
    await proc.stop()
  }
})

test('Windows UIAccess 受信任路径判定与非受信任目录自动降级', async () => {
  const winEnv = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    SystemRoot: 'C:\\Windows'
  }
  assert.equal(
    isTrustedWindowsUiAccessLocation('C:\\Program Files\\ZTools\\resources\\native\\ztools-uiaccess.exe', winEnv),
    true
  )
  assert.equal(
    isTrustedWindowsUiAccessLocation('C:\\Program Files Evil\\ZTools\\ztools-uiaccess.exe', winEnv),
    false
  )
  assert.equal(
    isTrustedWindowsUiAccessLocation('E:\\中文测试\\ZTools\\resources\\native\\ztools-uiaccess.exe', winEnv),
    false
  )

  if (process.platform === 'win32') {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-uiaccess-untrusted-')))
    const nativeDir = path.join(tmpRoot, '中文路径测试', 'resources', 'native')
    try {
      fs.mkdirSync(nativeDir, { recursive: true })
      fs.writeFileSync(path.join(nativeDir, 'ztools-uiaccess.exe'), 'NOT-A-VALID-PE', 'utf8')
      const fallbackCopy = path.join(nativeDir, 'ztools-uiaccess-standard.exe')
      fs.copyFileSync(process.execPath, fallbackCopy)

      const fallbackServerScript = [
        'const rl = require("readline").createInterface({ input: process.stdin });',
        'rl.on("line", (line) => {',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "shutdown") {',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true }) + "\\n");',
        '    process.exit(0);',
        '  }',
        '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "ping" ? "pong" : {} }) + "\\n");',
        '});'
      ].join(' ')

      const proc = new ManagedSidecarProcess({
        name: 'ztools-uiaccess',
        binaryName: 'ztools-uiaccess',
        fallbackBinaryName: 'ztools-uiaccess-standard',
        args: ['-e', fallbackServerScript],
        heartbeatIntervalMs: 60000,
        resolveContext: {
          isPackaged: true,
          resourcesPath: path.dirname(nativeDir),
          platform: 'win32',
          env: winEnv
        }
      })

      await proc.start()
      assert.equal(proc.state, 'running')
      assert.equal(proc.lastError, null)
      assert.equal(proc.usingFallback, true)
      assert.equal(proc.activeBinary, 'ztools-uiaccess-standard')
      assert.match(proc.fallbackReason ?? '', /^untrusted-install-location:/)
      await proc.stop()
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }
})

test('start 阶段 100ms 握手尚未完成时调用 stop() 立即收敛且不挂起', async () => {
  const proc = new ManagedSidecarProcess({
    name: 'ztools-abort-during-handshake',
    binaryName: 'ztools-abort-during-handshake',
    args: ['-e', 'setInterval(() => {}, 1000)'],
    heartbeatIntervalMs: 60000,
    resolveContext: {
      isPackaged: true,
      resourcesPath: path.dirname(process.execPath),
      platform: process.platform,
      env: { ZTOOLS_ZTOOLS_ABORT_DURING_HANDSHAKE_PATH: process.execPath }
    }
  })

  const startedAt = Date.now()
  const startPromise = proc.start()
  // 在 100ms handshakeTimer 到期之前发起 stop()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const stopOutcome = await proc.stop()
  await startPromise

  assert.equal(proc.state, 'stopped')
  assert.equal(proc.child, null)
  assert.equal(proc.pid, null)
  assert.notEqual(stopOutcome.exitMethod, 'none')
  assert.ok(Date.now() - startedAt < 1500, '握手未完成时停机不应等满 1s RPC 超时')
})
