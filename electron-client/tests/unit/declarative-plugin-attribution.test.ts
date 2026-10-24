import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { WebContents } from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../src/contracts/errors.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { authorizeIpcRequest } from '../../src/main/ipc/router.js'
import { requirePluginPermission, resolvePluginPrincipal } from '../../src/main/ipc/plugin-principal.js'
import type { CredentialProtection, CredentialProtectionStatus } from '../../src/main/services/credential-protection.js'
import { DatabaseService } from '../../src/main/services/database-service.js'
import {
  createBundledManifestReader,
  DeclarativePluginAttributionService
} from '../../src/main/services/declarative-plugin-attribution-service.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'
import { PluginStateService } from '../../src/main/services/plugin-state-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FakeWebContents extends EventEmitter {
  #destroyed = false
  readonly session = {}
  constructor(readonly id: number, private url = 'ztools://web/index.html') { super() }
  isDestroyed(): boolean { return this.#destroyed }
  getURL(): string { return this.url }
  send(): void {}
  destroy(): void {
    this.#destroyed = true
    this.emit('destroyed')
  }
  /** Electron 43 的 did-start-navigation：(details, url, isInPlace, isMainFrame, ...) */
  navigate(isInPlace: boolean, isMainFrame = true): void {
    this.emit('did-start-navigation', { isSameDocument: isInPlace, isMainFrame }, this.url, isInPlace, isMainFrame)
  }
}

class TestCredentialProtection implements CredentialProtection {
  readonly #key = randomBytes(32)
  statusValue: CredentialProtectionStatus = { status: 'available' }
  async status(): Promise<CredentialProtectionStatus> { return this.statusValue }
  async encrypt(plaintext: string): Promise<Buffer> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }
  async decrypt(ciphertext: Buffer): Promise<{ readonly plaintext: string; readonly shouldReEncrypt: boolean }> {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, ciphertext.subarray(0, 12))
    decipher.setAuthTag(ciphertext.subarray(12, 28))
    return {
      plaintext: Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8'),
      shouldReEncrypt: false
    }
  }
}

function silentLog() {
  const entries: Array<{ level: string; message: string }> = []
  const record = (level: string) => (message: unknown) => { entries.push({ level, message: String(message) }) }
  return { entries, log: { info: record('info'), warn: record('warn'), error: record('error') } }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function codeOf(code: string) {
  return (error: unknown) => error instanceof ZToolsError && error.code === code
}

async function writePlugin(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'dist', 'index.js'), 'exports.default = () => null\n')
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', entry: 'dist/index.js', targets: [CURRENT_TARGET], nativeComponents: [], ...manifest
  }))
}

const CURRENT_TARGET = {
  id: 'current', platform: process.platform === 'darwin' ? 'macos' : 'windows', runtime: 'electron', arch: process.arch
}

interface Harness {
  readonly dataRoot: string
  readonly webRoot: string
  readonly registry: WindowRegistry
  readonly state: PluginStateService
  readonly plugins: PluginInstallService
  readonly attribution: DeclarativePluginAttributionService
  readonly database: DatabaseService
  readonly logs: ReturnType<typeof silentLog>
  readonly main: FakeWebContents
  readonly mainCaller: CallerIdentity
  window(id: number, url?: string): { contents: FakeWebContents; caller: CallerIdentity }
  dispose(): Promise<void>
}

async function createHarness(options: { maxSessionsPerWindow?: number } = {}): Promise<Harness> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-attribution-'))
  const webRoot = path.join(dataRoot, 'web')
  await fs.mkdir(path.join(webRoot, 'bundled-plugins'), { recursive: true })
  await writePlugin(path.join(dataRoot, 'Plugins'), 'google-auth', { permissions: ['clipboard'] })
  await writePlugin(path.join(dataRoot, 'Plugins'), 'kill-process', { permissions: ['process', 'system'] })
  await writePlugin(path.join(dataRoot, 'Plugins'), 'weird-perms', { permissions: 'process' })
  await writePlugin(path.join(dataRoot, 'Plugins'), 'mismatch', {})
  await fs.writeFile(path.join(dataRoot, 'Plugins', 'mismatch', 'plugin.json'), JSON.stringify({
    id: 'other-id', name: 'x', version: '1.0.0', entry: 'dist/index.js', targets: [CURRENT_TARGET], nativeComponents: []
  }))
  // 内置插件：与已安装同 id 时取内置清单（与前端优先级一致）
  await writePlugin(path.join(webRoot, 'bundled-plugins'), 'json-format', { permissions: ['clipboard'] })
  await writePlugin(path.join(dataRoot, 'Plugins'), 'json-format', { permissions: ['process'] })
  await writePlugin(path.join(webRoot, 'bundled-plugins'), 'bundled-mismatch', {})
  await fs.writeFile(path.join(webRoot, 'bundled-plugins', 'bundled-mismatch', 'plugin.json'), JSON.stringify({ id: 'json-format' }))
  await writePlugin(path.join(webRoot, 'bundled-plugins'), 'bundled-broken', {})
  await fs.writeFile(path.join(webRoot, 'bundled-plugins', 'bundled-broken', 'plugin.json'), '{ not json')

  const state = new PluginStateService(dataRoot)
  const plugins = new PluginInstallService(dataRoot, { publish() {} } as never, { state })
  const registry = new WindowRegistry()
  const logs = silentLog()
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: createBundledManifestReader(webRoot),
    readInstalled: pluginId => plugins.withPluginManifest(pluginId, async manifest => manifest),
    isRevoked: pluginId => plugins.isRevoked(pluginId)
  }, { log: logs.log, ...(options.maxSessionsPerWindow ? { maxSessionsPerWindow: options.maxSessionsPerWindow } : {}) })
  const database = new DatabaseService(path.join(dataRoot, 'LevelDB'), new TestCredentialProtection())
  const window = (id: number, url?: string) => {
    const contents = new FakeWebContents(id, url)
    const caller = registry.registerMain(contents as unknown as WebContents)
    return { contents, caller }
  }
  const { contents: main, caller: mainCaller } = window(1)
  return {
    dataRoot, webRoot, registry, state, plugins, attribution, database, logs, main, mainCaller, window,
    async dispose() {
      attribution.stop()
      await database.stop()
      await plugins.stop()
      await fs.rm(dataRoot, { recursive: true, force: true })
    }
  }
}

/** 与 IpcRouter.#handleLegacy 相同的顺序：解析信封 → 登记身份 → 会话归属 → 鉴权 → 参数校验 */
function admit(h: Harness, sender: FakeWebContents, value: unknown): { caller: CallerIdentity; params: unknown } {
  const request = parseRequest(value)
  let caller = h.registry.get(sender.id)
  if (!caller) throw new ZToolsError(errorCodes.permissionDenied, '调用者未注册')
  caller = h.attribution.attributeCaller(caller, request)
  authorizeIpcRequest(caller, request, sender)
  validateMethodParams(request.method, request.params)
  return { caller, params: request.params }
}

let sequence = 0
function envelope(method: string, params: unknown, pluginSession?: string) {
  sequence += 1
  return { messageId: `test-${sequence}`, method, params, ...(pluginSession ? { pluginSession } : {}) }
}

test('会话令牌把主窗口调用归属到主进程读到的插件清单，加密存储按插件分区，关闭后令牌作废', async () => {
  const h = await createHarness()
  try {
    const opened = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    assert.equal(opened.data.pluginId, 'google-auth')
    assert.deepEqual(opened.data.permissions, ['clipboard'])
    assert.match(opened.data.token, /^[A-Za-z0-9_-]{43}$/)
    assert.match(opened.data.sessionId, /^ds_[A-Za-z0-9_-]{16}$/)

    const set = admit(h, h.main, envelope('credential_v1_set', { key: 'accounts', value: 'secret-1' }, opened.data.token))
    assert.equal(set.caller.type, 'main', 'type 保持 main，现有 main 方法不受影响')
    assert.equal(set.caller.pluginId, undefined)
    assert.equal(set.caller.attributedPlugin?.pluginId, 'google-auth')
    assert.deepEqual(resolvePluginPrincipal(set.caller), { pluginId: 'google-auth', instanceId: opened.data.sessionId, kind: 'session' })
    await h.database.credentialV1Set(set.params as never, set.caller, signal())
    const get = admit(h, h.main, envelope('credential_v1_get', { key: 'accounts' }, opened.data.token))
    assert.deepEqual((await h.database.credentialV1Get(get.params as never, get.caller, signal())).data, {
      status: 'present', value: 'secret-1'
    })

    // 别的插件的会话读不到 google-auth 的密钥
    const other = await h.attribution.open(h.mainCaller, { pluginId: 'kill-process' })
    const otherGet = admit(h, h.main, envelope('credential_v1_get', { key: 'accounts' }, other.data.token))
    assert.deepEqual((await h.database.credentialV1Get(otherGet.params as never, otherGet.caller, signal())).data, { status: 'missing' })

    // 不带令牌（宿主身份）拿不到任何插件的加密数据
    const anonymous = admit(h, h.main, envelope('credential_v1_get', { key: 'accounts' }))
    assert.equal(anonymous.caller.attributedPlugin, undefined)
    await assert.rejects(h.database.credentialV1Get(anonymous.params as never, anonymous.caller, signal()),
      codeOf(errorCodes.pluginIdentityRequired))

    h.attribution.close(h.mainCaller, { sessionId: opened.data.sessionId })
    const closed = admit(h, h.main, envelope('credential_v1_get', { key: 'accounts' }, opened.data.token))
    assert.equal(closed.caller.attributedPlugin, undefined, '关闭后的令牌按未归属处理')
    await assert.rejects(h.database.credentialV1Get(closed.params as never, closed.caller, signal()),
      codeOf(errorCodes.pluginIdentityRequired))
    // 关闭幂等
    assert.deepEqual(h.attribution.close(h.mainCaller, { sessionId: opened.data.sessionId }), { success: true })
  } finally {
    await h.dispose()
  }
})

test('冒充：篡改令牌、跨窗口使用、插件窗口带令牌、畸形令牌都拿不到归属', async () => {
  const h = await createHarness()
  try {
    const opened = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    const token = opened.data.token
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    assert.equal(admit(h, h.main, envelope('credential_v1_status', {}, flipped)).caller.attributedPlugin, undefined)
    // 限频：同一窗口 60 秒内只 warn 一次
    admit(h, h.main, envelope('credential_v1_status', {}, flipped))
    assert.equal(h.logs.entries.filter(entry => entry.level === 'warn' && entry.message.includes('令牌已失效')).length, 1)

    const { contents: other } = h.window(2)
    assert.equal(admit(h, other, envelope('credential_v1_status', {}, token)).caller.attributedPlugin, undefined,
      'A 窗口的令牌在 B 窗口无效')

    const pluginWindow = new FakeWebContents(3, 'ztools://plugins/google-auth/index.html')
    h.registry.registerPlugin(pluginWindow as unknown as WebContents, 'google-auth', 'instance-1')
    assert.throws(() => admit(h, pluginWindow, envelope('credential_v1_status', {}, token)), codeOf(errorCodes.invalidRequest))

    for (const bad of ['short', `${token}x`, token.replace(/.$/, '='), 42, null]) {
      assert.throws(() => parseRequest({ ...envelope('credential_v1_status', {}), pluginSession: bad }),
        codeOf(errorCodes.invalidRequest))
    }
    // pluginSession 不会出现在 params 里：参数校验仍拒绝未知字段
    assert.throws(() => admit(h, h.main, envelope('credential_v1_status', { pluginSession: token })), codeOf(errorCodes.invalidRequest))
    // 归属会话不能再申请会话（防止嵌套冒充）
    const attributed = admit(h, h.main, envelope('declarative_session_open', { pluginId: 'kill-process' }, token)).caller
    await assert.rejects(h.attribution.open(attributed, { pluginId: 'kill-process' }), codeOf(errorCodes.permissionDenied))
    // 插件窗口不能申请会话（canCall 已拦截第三方插件窗口）
    assert.throws(() => admit(h, pluginWindow, envelope('declarative_session_open', { pluginId: 'google-auth' })),
      codeOf(errorCodes.permissionDenied))
  } finally {
    await h.dispose()
  }
})

test('pluginId 非法 / 不存在 / 清单不一致 / 损坏 / 已下架 / 已禁用都不建立会话', async () => {
  const h = await createHarness()
  try {
    for (const pluginId of ['../google-auth', 'a/b', 'a..b', '.hidden', '', 'x'.repeat(200), 'google-auth.']) {
      await assert.rejects(h.attribution.open(h.mainCaller, { pluginId }), codeOf(errorCodes.invalidRequest), pluginId)
    }
    // 大小写先归一，返回清单里的 id
    assert.equal((await h.attribution.open(h.mainCaller, { pluginId: 'GOOGLE-AUTH' })).data.pluginId, 'google-auth')
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'not-installed' }), codeOf(errorCodes.pluginNotFound))
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'mismatch' }), codeOf(errorCodes.pluginPackageInvalid))
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'bundled-mismatch' }), codeOf(errorCodes.pluginPackageInvalid))
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'bundled-broken' }), codeOf(errorCodes.pluginPackageInvalid))

    // permissions 不是数组：按无权限处理并 warn
    const weird = await h.attribution.open(h.mainCaller, { pluginId: 'weird-perms' })
    assert.deepEqual(weird.data.permissions, [])
    assert.ok(h.logs.entries.some(entry => entry.level === 'warn' && entry.message.includes('permissions')))

    // 内置与已安装同 id：取内置清单（这里内置版没有 process 权限）
    const bundled = await h.attribution.open(h.mainCaller, { pluginId: 'json-format' })
    assert.deepEqual(bundled.data.permissions, ['clipboard'])
    assert.equal(h.attribution.snapshot().find(item => item.sessionId === bundled.data.sessionId)?.source, 'bundled')

    await h.state.setRevoked('google-auth', true, '测试下架')
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'google-auth' }), codeOf(errorCodes.permissionDenied))
    await h.state.setRevoked('json-format', true, '内置也能下架')
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'json-format' }), codeOf(errorCodes.permissionDenied))
    await h.state.toggleEnabled('kill-process', true)
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'kill-process' }), codeOf(errorCodes.pluginNotFound))
  } finally {
    await h.dispose()
  }
})

test('下架 / 更新 / 窗口销毁 / 页面刷新 / 渲染进程崩溃后旧令牌失效；同文档导航保留会话', async () => {
  const h = await createHarness()
  try {
    const first = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    const second = await h.attribution.open(h.mainCaller, { pluginId: 'kill-process' })
    assert.equal(h.attribution.revokePlugin('GOOGLE-AUTH'), 1)
    assert.equal(h.attribution.resolve(1, first.data.token), undefined)
    assert.equal(h.attribution.resolve(1, second.data.token)?.pluginId, 'kill-process')

    h.main.navigate(true)
    assert.equal(h.attribution.resolve(1, second.data.token)?.pluginId, 'kill-process', 'hash 路由切换不影响会话')
    h.main.navigate(false, false)
    assert.equal(h.attribution.resolve(1, second.data.token)?.pluginId, 'kill-process', '子框架导航不影响会话')
    h.main.navigate(false)
    assert.equal(h.attribution.snapshot().length, 0, '主框架刷新后旧上下文的会话全部删除')

    const third = await h.attribution.open(h.mainCaller, { pluginId: 'kill-process' })
    h.main.emit('render-process-gone', {}, { reason: 'crashed' })
    assert.equal(h.attribution.resolve(1, third.data.token), undefined)

    const { contents: popout, caller: popoutCaller } = h.window(5)
    const popoutSession = await h.attribution.open(popoutCaller, { pluginId: 'kill-process' })
    popout.destroy()
    assert.equal(h.attribution.resolve(5, popoutSession.data.token), undefined)
    assert.equal(h.attribution.snapshot().length, 0, '窗口销毁后无泄漏')
    assert.equal(popout.listenerCount('did-start-navigation'), 0, '窗口监听器成对清理')
  } finally {
    await h.dispose()
  }
})

test('读清单途中窗口刷新或销毁：结果作废，不登记半个会话', async () => {
  const h = await createHarness()
  try {
    const opening = h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    h.main.navigate(false)
    await assert.rejects(opening, codeOf(errorCodes.callerDestroyed))
    const { contents, caller } = h.window(7)
    const opening2 = h.attribution.open(caller, { pluginId: 'google-auth' })
    contents.destroy()
    await assert.rejects(opening2, codeOf(errorCodes.callerDestroyed))
    assert.equal(h.attribution.snapshot().length, 0)
    h.attribution.stop()
    await assert.rejects(h.attribution.open(h.mainCaller, { pluginId: 'google-auth' }), codeOf(errorCodes.appStopping))
  } finally {
    await h.dispose()
  }
})

test('单窗口会话达到上限时淘汰最旧会话并报错日志，新会话仍可用；高频交替 open/close 不留残留', async () => {
  const h = await createHarness({ maxSessionsPerWindow: 32 })
  try {
    const sessions = []
    for (let index = 0; index < 33; index += 1) sessions.push(await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' }))
    assert.equal(h.attribution.snapshot().length, 32)
    assert.equal(h.attribution.resolve(1, sessions[0]!.data.token), undefined, '最旧会话被淘汰')
    assert.equal(h.attribution.resolve(1, sessions[32]!.data.token)?.pluginId, 'google-auth')
    assert.ok(h.logs.entries.some(entry => entry.level === 'error' && entry.message.includes('上限')))
    for (const session of sessions) h.attribution.close(h.mainCaller, { sessionId: session.data.sessionId })
    assert.equal(h.attribution.snapshot().length, 0)

    // 20ms 内 10 次 open/close 交替（并发）
    const started = Date.now()
    await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const opened = await h.attribution.open(h.mainCaller, { pluginId: index % 2 ? 'google-auth' : 'kill-process' })
      h.attribution.close(h.mainCaller, { sessionId: opened.data.sessionId })
    }))
    assert.ok(Date.now() - started < 2_000)
    assert.equal(h.attribution.snapshot().length, 0)
    // 只能关闭本窗口的会话
    const kept = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    const { caller: other } = h.window(9)
    h.attribution.close(other, { sessionId: kept.data.sessionId })
    assert.equal(h.attribution.resolve(1, kept.data.token)?.pluginId, 'google-auth')
  } finally {
    await h.dispose()
  }
})

test('requirePluginPermission：未归属拒绝、会话按清单权限、bundled 不等于受信任、插件窗口现读清单', async () => {
  const h = await createHarness()
  try {
    await assert.rejects(requirePluginPermission(h.mainCaller, 'process', h.plugins), codeOf(errorCodes.pluginIdentityRequired))
    const kill = await h.attribution.open(h.mainCaller, { pluginId: 'kill-process' })
    const killCaller = h.attribution.attributeCaller(h.mainCaller, { pluginSession: kill.data.token, method: 'process_terminate_pid' })
    assert.equal((await requirePluginPermission(killCaller, 'process', h.plugins)).pluginId, 'kill-process')

    const auth = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    const authCaller = h.attribution.attributeCaller(h.mainCaller, { pluginSession: auth.data.token, method: 'process_terminate_pid' })
    await assert.rejects(requirePluginPermission(authCaller, 'process', h.plugins), (error) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.pluginPermissionRequired)
      assert.deepEqual(toPublicError(error).details, { permission: 'process' })
      return true
    })
    // 内置插件会话：同样按清单判定（内置版 json-format 没有 process 权限）
    const bundled = await h.attribution.open(h.mainCaller, { pluginId: 'json-format' })
    const bundledCaller = h.attribution.attributeCaller(h.mainCaller, { pluginSession: bundled.data.token, method: 'x' })
    await assert.rejects(requirePluginPermission(bundledCaller, 'process', h.plugins), codeOf(errorCodes.pluginPermissionRequired))

    const windowCaller: CallerIdentity = { type: 'plugin', webContentsId: 20, pluginId: 'kill-process', pluginInstanceId: 'i1' }
    assert.equal((await requirePluginPermission(windowCaller, 'process', h.plugins)).kind, 'window')
    await assert.rejects(requirePluginPermission({ ...windowCaller, pluginId: 'google-auth' }, 'process', h.plugins),
      codeOf(errorCodes.pluginPermissionRequired))
    await assert.rejects(requirePluginPermission({ type: 'plugin', webContentsId: 21 }, 'process', h.plugins),
      codeOf(errorCodes.pluginIdentityRequired))
    assert.equal((await requirePluginPermission({ type: 'plugin', webContentsId: 22, pluginId: 'internal-settings' }, 'process', h.plugins)).pluginId,
      'internal-settings')
    await h.state.setRevoked('kill-process', true, '下架')
    await assert.rejects(requirePluginPermission(windowCaller, 'process', h.plugins), codeOf(errorCodes.permissionDenied))
  } finally {
    await h.dispose()
  }
})

test('db_compact 与 credential ifAbsent：只给能证明身份的调用；压缩后已删明文不再留在库文件里', async () => {
  const h = await createHarness()
  try {
    const opened = await h.attribution.open(h.mainCaller, { pluginId: 'google-auth' })
    const caller = h.attribution.attributeCaller(h.mainCaller, { pluginSession: opened.data.token, method: 'db_compact' })
    const plaintext = 'JBSWY3DPEHPK3PXP-plaintext-totp-secret'
    // 旧版本插件写下的明文（LocalStorage 走未归属 db_put）
    await h.database.put({ plugin_id: 'google-auth', key: 'ls:google-auth.accounts.v1', value: JSON.stringify([{ secret: plaintext }]) },
      h.mainCaller, signal())
    // 迁移：ifAbsent 写入加密存储
    assert.equal((await h.database.credentialV1Set({ key: 'google-auth.accounts.v1', value: plaintext, ifAbsent: true }, caller, signal())).data, 'OK')
    // 另一个窗口并发迁移旧明文：已存在则不覆盖
    assert.equal((await h.database.credentialV1Set({ key: 'google-auth.accounts.v1', value: 'stale', ifAbsent: true }, caller, signal())).data, 'EXISTS')
    assert.deepEqual((await h.database.credentialV1Get({ key: 'google-auth.accounts.v1' }, caller, signal())).data,
      { status: 'present', value: plaintext })
    // 并发：两个 ifAbsent 同时写，只有一个成功
    const raced = await Promise.all([
      h.database.credentialV1Set({ key: 'race', value: 'a', ifAbsent: true }, caller, signal()),
      h.database.credentialV1Set({ key: 'race', value: 'b', ifAbsent: true }, caller, signal())
    ])
    assert.deepEqual(raced.map(item => item.data).sort(), ['EXISTS', 'OK'])

    await h.database.delete({ plugin_id: 'google-auth', key: 'ls:google-auth.accounts.v1' }, h.mainCaller, signal())
    await assert.rejects(h.database.compact({ plugin_id: 'google-auth' }, h.mainCaller, signal()), codeOf(errorCodes.pluginIdentityRequired))
    await assert.rejects(h.database.compact({ plugin_id: 'kill-process' }, caller, signal()), codeOf(errorCodes.permissionDenied))
    await assert.rejects(h.database.compact({ plugin_id: 'kill-process' },
      { type: 'plugin', webContentsId: 30, pluginId: 'google-auth', pluginInstanceId: 'x' }, signal()), codeOf(errorCodes.permissionDenied))
    assert.deepEqual((await h.database.compact({ plugin_id: 'google-auth' }, caller, signal())).data, { compacted: true, scheduled: false })
    // 60 秒内的重复压缩合并为一次延迟压缩，不报错
    assert.deepEqual((await h.database.compact({ plugin_id: 'google-auth' }, caller, signal())).data, { compacted: false, scheduled: true })

    const dbDir = path.join(h.dataRoot, 'LevelDB', 'google-auth')
    const files = (await fs.readdir(dbDir)).filter(name => /\.(log|ldb|sst)$/.test(name))
    for (const name of files) {
      const bytes = await fs.readFile(path.join(dbDir, name))
      assert.equal(bytes.includes(Buffer.from(plaintext)), false, `${name} 仍含已删除的明文`)
    }
  } finally {
    await h.dispose()
  }
})

test('db_compact：明文早已落盘到最深层文件（重启后）再删除，压缩后同样不留旧值；延迟压缩在 stop 时清理', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-compact-'))
  let clock = 1_000_000
  const caller: CallerIdentity = { type: 'plugin', webContentsId: 40, pluginId: 'google-auth', pluginInstanceId: 'inst' }
  const plaintext = 'OLD-PLAINTEXT-SECRET-ON-DISK-0123456789'
  try {
    const first = new DatabaseService(path.join(root, 'LevelDB'), undefined, () => clock)
    for (let index = 0; index < 50; index += 1) {
      await first.put({ plugin_id: 'google-auth', key: `ls:filler-${index}`, value: 'x'.repeat(200) }, caller, signal())
    }
    await first.put({ plugin_id: 'google-auth', key: 'ls:accounts', value: plaintext }, caller, signal())
    await first.compact({ plugin_id: 'google-auth' }, caller, signal())
    await first.stop()

    const second = new DatabaseService(path.join(root, 'LevelDB'), undefined, () => clock)
    await second.delete({ plugin_id: 'google-auth', key: 'ls:accounts' }, caller, signal())
    clock += 61_000
    assert.deepEqual((await second.compact({ plugin_id: 'google-auth' }, caller, signal())).data, { compacted: true, scheduled: false })
    // 被合并的请求会排一个延迟压缩；stop 必须清掉定时器（否则测试进程不会退出）
    assert.equal((await second.compact({ plugin_id: 'google-auth' }, caller, signal())).data.scheduled, true)
    await second.stop()
    const dbDir = path.join(root, 'LevelDB', 'google-auth')
    for (const name of (await fs.readdir(dbDir)).filter(item => /\.(log|ldb|sst)$/.test(item))) {
      assert.equal((await fs.readFile(path.join(dbDir, name))).includes(Buffer.from(plaintext)), false, `${name} 仍含旧明文`)
    }
    // 其余数据完好
    const third = new DatabaseService(path.join(root, 'LevelDB'))
    assert.equal((await third.get({ plugin_id: 'google-auth', key: 'ls:filler-7' }, caller, signal())).data, 'x'.repeat(200))
    await assert.rejects(third.get({ plugin_id: 'google-auth', key: 'ls:accounts' }, caller, signal()), codeOf(errorCodes.databaseKeyNotFound))
    await third.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
