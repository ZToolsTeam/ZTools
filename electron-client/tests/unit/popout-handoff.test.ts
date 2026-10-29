import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BrowserWindow, WebContents } from 'electron'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { MAX_REQUEST_BYTES, parseRequest } from '../../src/contracts/ipc.js'
import {
  POPOUT_HANDOFF_MAX_PATHS,
  POPOUT_HANDOFF_MAX_STATE_BYTES,
  validateMethodParams,
  type PopoutHandoffParams
} from '../../src/contracts/method-params.js'
import { authorizeIpcRequest } from '../../src/main/ipc/router.js'
import {
  createBundledManifestReader,
  DeclarativePluginAttributionService
} from '../../src/main/services/declarative-plugin-attribution-service.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'
import { PluginStateService } from '../../src/main/services/plugin-state-service.js'
import { parsePopoutRoute, POPOUT_HANDOFF_TTL_MS, WindowService } from '../../src/main/services/window-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

/** 与 Electron 一致：对同一 webContents 发起新导航会让上一次 loadURL 以 ERR_ABORTED 失败 */
class FakeContents extends EventEmitter {
  #destroyed = false
  readonly session = {}
  constructor(readonly id: number) { super() }
  isDestroyed(): boolean { return this.#destroyed }
  getURL(): string { return 'ztools://web/index.html' }
  send(): void {}
  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.emit('destroyed')
  }
}

class FakePopoutWindow extends EventEmitter {
  #destroyed = false
  readonly webContents: FakeContents
  readonly loadedUrls: string[] = []
  failLoad = false
  deferLoads = false
  #pending: { resolve(): void; reject(error: Error): void; url: string } | undefined

  constructor(id: number) {
    super()
    this.webContents = new FakeContents(id)
  }

  isDestroyed(): boolean { return this.#destroyed }
  isMinimized(): boolean { return false }
  isMaximized(): boolean { return false }
  isFullScreen(): boolean { return false }
  restore(): void {}
  show(): void {}
  focus(): void {}
  getBounds() { return { x: 0, y: 0, width: 1140, height: 760 } }
  getNormalBounds() { return this.getBounds() }

  loadURL(url: string): Promise<void> {
    if (this.#pending) {
      const previous = this.#pending
      this.#pending = undefined
      previous.reject(Object.assign(new Error('ERR_ABORTED (-3) loading ' + previous.url), { code: 'ERR_ABORTED' }))
    }
    if (this.failLoad) return Promise.reject(new Error('Load failed'))
    if (!this.deferLoads) {
      this.loadedUrls.push(url)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.#pending = { url, resolve: () => { this.loadedUrls.push(url); resolve() }, reject }
    })
  }

  finishLoad(): void {
    const pending = this.#pending
    this.#pending = undefined
    pending?.resolve()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.emit('closed')
    this.webContents.destroy()
  }
}

const CURRENT_TARGET = {
  id: 'current', platform: process.platform === 'darwin' ? 'macos' : 'windows', runtime: 'electron', arch: process.arch
}

function codeOf(code: string) {
  return (error: unknown) => error instanceof ZToolsError && error.code === code
}
const denied = codeOf(errorCodes.permissionDenied)
const invalid = codeOf(errorCodes.invalidRequest)

async function writePlugin(root: string, id: string, permissions: string[]): Promise<void> {
  const dir = path.join(root, id)
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fs.writeFile(path.join(dir, 'dist', 'index.js'), 'exports.default = () => null\n')
  await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name: id, version: '1.0.0', entry: 'dist/index.js', targets: [CURRENT_TARGET], nativeComponents: [], permissions
  }))
}

let sequence = 0

interface Harness {
  root: string
  data: string
  registry: WindowRegistry
  files: FileSystemService
  windows: WindowService
  attribution: DeclarativePluginAttributionService
  created: FakePopoutWindow[]
  main: FakeContents
  mainCaller: CallerIdentity
  clock: { now: number }
  /** 下一个新建窗口的行为 */
  nextWindow: { failLoad?: boolean; deferLoads?: boolean }
  admit(sender: FakeContents, method: string, params: unknown, pluginSession?: string): CallerIdentity
  session(pluginId: string, caller: CallerIdentity): Promise<string>
  popoutCaller(index?: number): CallerIdentity
  dispose(): Promise<void>
}

async function createHarness(): Promise<Harness> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-popout-handoff-')))
  const data = path.join(root, 'data')
  await fs.mkdir(data, { recursive: true })
  const webRoot = path.join(root, 'web')
  await fs.mkdir(path.join(webRoot, 'bundled-plugins'), { recursive: true })
  await writePlugin(path.join(root, 'Plugins'), 'batch-rename', ['fs'])
  await writePlugin(path.join(root, 'Plugins'), 'cleaner', ['fs'])
  const state = new PluginStateService(root)
  const plugins = new PluginInstallService(root, { publish() {} } as never, { state })
  const registry = new WindowRegistry()
  const quiet = { info() {}, warn() {}, error() {} }
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: createBundledManifestReader(webRoot),
    readInstalled: pluginId => plugins.withPluginManifest(pluginId, async manifest => manifest),
    isRevoked: pluginId => plugins.isRevoked(pluginId)
  }, { log: quiet })
  const clock = { now: Date.now() }
  const files = new FileSystemService(registry, path.join(root, 'cache'), () => clock.now)
  const created: FakePopoutWindow[] = []
  const nextWindow: Harness['nextWindow'] = {}
  let nextId = 100
  const windows = new WindowService(files, registry, undefined, () => {
    const win = new FakePopoutWindow(nextId++)
    win.failLoad = nextWindow.failLoad === true
    win.deferLoads = nextWindow.deferLoads === true
    created.push(win)
    return win as unknown as BrowserWindow
  })
  const main = new FakeContents(1)
  const mainCaller = registry.registerMain(main as unknown as WebContents)
  return {
    root, data, registry, files, windows, attribution, created, main, mainCaller, clock, nextWindow,
    admit(sender, method, params, pluginSession) {
      sequence += 1
      const request = parseRequest({
        messageId: `popout-${sequence}`, method, params, ...(pluginSession ? { pluginSession } : {})
      })
      let caller = registry.get(sender.id)
      if (!caller) throw new ZToolsError(errorCodes.permissionDenied, '调用者未注册')
      caller = attribution.attributeCaller(caller, request)
      authorizeIpcRequest(caller, request, sender as unknown as WebContents)
      validateMethodParams(request.method as never, request.params)
      return caller
    },
    async session(pluginId, caller) {
      return (await attribution.open(caller, { pluginId })).data.token
    },
    popoutCaller(index = created.length - 1) {
      const caller = registry.get(created[index]!.webContents.id)
      assert.ok(caller, '独立窗口已以宿主身份登记')
      return caller
    },
    async dispose() {
      windows.stop()
      attribution.stop()
      await files.stop()
      await plugins.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}

function handoffId(n: number | string = 1): string {
  return `handoff_${String(n).padStart(12, '0')}`
}

function popoutUrl(pluginId: string, id: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...extra, handoff: id }).toString()
  return `ztools://web/index.html#/popout/${encodeURIComponent(pluginId)}?${query}`
}

function handoff(pluginId: string, id: string, state: unknown, more: Partial<PopoutHandoffParams> = {}): PopoutHandoffParams {
  return { id, pluginId, state: JSON.stringify({ entries: state }), ...more }
}

async function touch(file: string, content = 'x'): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

async function canAccess(files: FileSystemService, value: string, caller: CallerIdentity, access: 'read' | 'write' | 'trash'): Promise<boolean> {
  try {
    await files.resolveAuthorizedPath(value, caller, access, false)
    return true
  } catch (error) {
    if (denied(error)) return false
    throw error
  }
}

test('契约：window_open 的 handoff 与 window_popout_handoff_take 参数逐项校验，整包保持在 1 MiB 普通上限内', () => {
  const ok = handoff('json-format', handoffId(), { text: 'a' })
  validateMethodParams('window_open', { url: popoutUrl('json-format', handoffId()), handoff: ok })
  validateMethodParams('window_open', { url: popoutUrl('json-format', handoffId()), handoff: { ...ok, featureCode: 'f', paths: ['/a'] } })
  validateMethodParams('window_open', { url: 'index.html#/popout/json-format' })

  const bad: Array<[string, unknown]> = [
    ['handoff 不是对象', 'x'],
    ['handoff 是数组', [ok]],
    ['未知字段', { ...ok, extra: 1 }],
    ['id 过短', { ...ok, id: 'short' }],
    ['id 含非法字符', { ...ok, id: 'handoff_00000000/../x' }],
    ['id 过长', { ...ok, id: 'a'.repeat(65) }],
    ['pluginId 穿越', { ...ok, pluginId: '../etc' }],
    ['pluginId 保留名', { ...ok, pluginId: 'con' }],
    ['featureCode 过长', { ...ok, featureCode: 'f'.repeat(129) }],
    ['state 非字符串', { ...ok, state: { entries: {} } }],
    ['state 字符数超限', { ...ok, state: 'a'.repeat(POPOUT_HANDOFF_MAX_STATE_BYTES + 1) }],
    // 字符数未超、UTF-8 字节数超限
    ['state 字节数超限', { ...ok, state: JSON.stringify({ t: '中'.repeat(90_000) }) }],
    ['paths 非数组', { ...ok, paths: '/a' }],
    ['paths 条数超限', { ...ok, paths: Array.from({ length: POPOUT_HANDOFF_MAX_PATHS + 1 }, (_, i) => `/p${i}`) }],
    ['路径过长', { ...ok, paths: ['/' + 'a'.repeat(4096)] }],
    ['路径含 NUL', { ...ok, paths: ['/a\0b'] }],
    ['空路径', { ...ok, paths: [''] }],
    ['路径非字符串', { ...ok, paths: [1] }],
    ['paths 合计超限', { ...ok, paths: Array.from({ length: 200 }, (_, i) => `/${i}/${'b'.repeat(3000)}`) }]
  ]
  for (const [label, value] of bad) {
    assert.throws(() => validateMethodParams('window_open', { url: popoutUrl('json-format', handoffId()), handoff: value }), invalid, label)
  }
  // window_redirect 不接受 handoff
  assert.throws(() => validateMethodParams('window_redirect', { url: 'index.html', handoff: ok }), invalid)

  validateMethodParams('window_popout_handoff_take', { handoffId: handoffId() })
  for (const params of [{}, { handoffId: 'x' }, { handoffId: handoffId(), extra: 1 }, { handoffId: 123 }]) {
    assert.throws(() => validateMethodParams('window_popout_handoff_take', params), invalid)
  }
  assert.equal(canCall('window_popout_handoff_take', { type: 'main', webContentsId: 1 }), true)
  assert.equal(canCall('window_popout_handoff_take', { type: 'plugin', webContentsId: 2, pluginId: 'x', pluginInstanceId: 'i' }), false)
  assert.equal(canCall('window_open', { type: 'plugin', webContentsId: 2, pluginId: 'x', pluginInstanceId: 'i' }), false)

  // 上限组合（state 256 KiB + paths 512 KiB）仍能通过信封的 1 MiB 校验
  const maxState = JSON.stringify({ entries: { t: 'a'.repeat(POPOUT_HANDOFF_MAX_STATE_BYTES - 32) } })
  const maxPaths = Array.from({ length: 128 }, (_, i) => `/${i}/${'c'.repeat(4000)}`)
  const params = { url: popoutUrl('json-format', handoffId()), handoff: { ...ok, state: maxState, paths: maxPaths } }
  validateMethodParams('window_open', params)
  const request = parseRequest({ messageId: 'max', method: 'window_open', params })
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < MAX_REQUEST_BYTES)
  // 超过 1 MiB 的请求在信封层就被拒绝
  assert.throws(() => parseRequest({
    messageId: 'huge', method: 'window_open', params: { url: 'x', handoff: { ...ok, state: 'a'.repeat(MAX_REQUEST_BYTES) } }
  }), invalid)
})

test('parsePopoutRoute：原样取出插件 ID 与 hash 查询参数，非插件路由返回 undefined', () => {
  const route = parsePopoutRoute('index.html#/popout/Json-Format?q=a&handoff=handoff_000000000001&feature=x')
  assert.equal(route?.pluginId, 'Json-Format')
  assert.equal(route?.query.get('handoff'), 'handoff_000000000001')
  assert.equal(route?.query.get('feature'), 'x')
  assert.equal(parsePopoutRoute('index.html#/settings?handoff=x'), undefined)
  assert.equal(parsePopoutRoute('index.html'), undefined)
  assert.throws(() => parsePopoutRoute('https://evil.example/#/popout/x'), denied)
})

test('交接：新窗口凭 URL 里的编号取走一次；错误编号、别的窗口、插件代码、插件窗口都拿不到', async () => {
  const h = await createHarness()
  try {
    const id = handoffId('a')
    const url = popoutUrl('json-format', id, { q: 'x' })
    const params = { url, handoff: handoff('json-format', id, { jsonText: '{"a":1}', indent: 2 }) }
    const caller = h.admit(h.main, 'window_open', params)
    const opened = await h.windows.open(params, caller)
    assert.equal(opened.windowInstanceStatus, 'created')
    assert.deepEqual(h.created[0]!.loadedUrls, [url])

    const popout = h.created[0]!.webContents
    // 编号不符：none，且不消耗真正的那一份
    assert.deepEqual(h.windows.takePopoutHandoff({ handoffId: handoffId('b') }, h.admit(popout, 'window_popout_handoff_take', { handoffId: handoffId('b') })), { success: true, status: 'none' })
    // 别的窗口（主窗口自己）冒充取：none
    assert.deepEqual(h.windows.takePopoutHandoff({ handoffId: id }, h.mainCaller), { success: true, status: 'none' })
    // 独立窗口里的插件代码（带会话令牌）代取：拒绝
    const token = await h.session('batch-rename', h.popoutCaller())
    const attributed = h.admit(popout, 'window_popout_handoff_take', { handoffId: id }, token)
    assert.equal(attributed.attributedPlugin?.pluginId, 'batch-rename')
    assert.throws(() => h.windows.takePopoutHandoff({ handoffId: id }, attributed), denied)
    // 旧式插件窗口：能力表就拒绝
    const pluginWindow = new FakeContents(7)
    h.registry.registerPlugin(pluginWindow as unknown as WebContents, 'json-format', 'inst-7')
    assert.throws(() => h.admit(pluginWindow, 'window_popout_handoff_take', { handoffId: id }))
    assert.throws(() => h.windows.takePopoutHandoff({ handoffId: id }, h.registry.get(7)!), denied)

    // 宿主界面按正确编号取走：一次成功，第二次 none
    const hostCaller = h.admit(popout, 'window_popout_handoff_take', { handoffId: id })
    const taken = h.windows.takePopoutHandoff({ handoffId: id }, hostCaller)
    assert.deepEqual(taken, {
      success: true, status: 'ok', pluginId: 'json-format', featureCode: '',
      state: JSON.stringify({ entries: { jsonText: '{"a":1}', indent: 2 } })
    })
    assert.deepEqual(h.windows.takePopoutHandoff({ handoffId: id }, hostCaller), { success: true, status: 'none' })
  } finally {
    await h.dispose()
  }
})

test('交接与 URL 交叉校验：插件 ID / 编号 / 功能码不一致、state 不是 JSON 对象、插件代码代为交接 → 拒绝且不建窗口', async () => {
  const h = await createHarness()
  try {
    const id = handoffId('m')
    const cases: Array<[string, { url: string; handoff: PopoutHandoffParams }]> = [
      ['插件 ID 不一致', { url: popoutUrl('json-format', id), handoff: handoff('crypto-tool', id, {}) }],
      ['插件 ID 大小写不一致', { url: popoutUrl('Json-Format', id), handoff: handoff('json-format', id, {}) }],
      ['编号不一致', { url: popoutUrl('json-format', handoffId('n')), handoff: handoff('json-format', id, {}) }],
      ['URL 缺编号', { url: 'index.html#/popout/json-format?q=1', handoff: handoff('json-format', id, {}) }],
      ['功能码不一致', { url: popoutUrl('json-format', id, { feature: 'a' }), handoff: handoff('json-format', id, {}, { featureCode: 'b' }) }],
      ['URL 有功能码但交接没有', { url: popoutUrl('json-format', id, { feature: 'a' }), handoff: handoff('json-format', id, {}) }],
      ['非插件路由', { url: `index.html#/settings?handoff=${id}`, handoff: handoff('json-format', id, {}) }],
      ['state 是数组', { url: popoutUrl('json-format', id), handoff: { ...handoff('json-format', id, {}), state: '[1]' } }],
      ['state 是 null', { url: popoutUrl('json-format', id), handoff: { ...handoff('json-format', id, {}), state: 'null' } }],
      ['state 不是 JSON', { url: popoutUrl('json-format', id), handoff: { ...handoff('json-format', id, {}), state: '{oops' } }]
    ]
    for (const [label, params] of cases) {
      const caller = h.admit(h.main, 'window_open', params)
      await assert.rejects(h.windows.open(params, caller), invalid, label)
    }
    assert.equal(h.created.length, 0, '校验失败时没有创建任何窗口')

    // 主窗口里带会话令牌的插件代码代为交接：拒绝
    const token = await h.session('batch-rename', h.mainCaller)
    const params = { url: popoutUrl('batch-rename', id), handoff: handoff('batch-rename', id, {}) }
    const attributed = h.admit(h.main, 'window_open', params, token)
    await assert.rejects(h.windows.open(params, attributed), denied)
    assert.equal(h.created.length, 0)
  } finally {
    await h.dispose()
  }
})

test('超时与关闭：60 秒内未取走则丢弃；窗口关闭时清掉交接；stop 清空', async (t) => {
  const h = await createHarness()
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    const early = handoffId('early')
    const late = handoffId('late')
    await h.windows.open({ url: popoutUrl('json-format', early), handoff: handoff('json-format', early, { a: 1 }) }, h.mainCaller)
    await h.windows.open({ url: popoutUrl('crypto-tool', late), handoff: handoff('crypto-tool', late, { b: 1 }) }, h.mainCaller)
    t.mock.timers.tick(POPOUT_HANDOFF_TTL_MS - 1)
    assert.equal(h.windows.takePopoutHandoff({ handoffId: early }, h.popoutCaller(0)).status, 'ok', '期限内可以取走')
    t.mock.timers.tick(2)
    assert.equal(h.windows.takePopoutHandoff({ handoffId: late }, h.popoutCaller(1)).status, 'none', '过期后被丢弃')
    t.mock.timers.reset()

    // 关闭窗口：交接被清掉，同插件重新弹出的新窗口拿不到旧编号
    const id2 = handoffId('close')
    await h.windows.open({ url: popoutUrl('json-format', id2), handoff: handoff('json-format', id2, { a: 2 }) }, h.mainCaller)
    h.created[0]!.destroy()
    const id3 = handoffId('new')
    await h.windows.open({ url: popoutUrl('json-format', id3), handoff: handoff('json-format', id3, { a: 3 }) }, h.mainCaller)
    assert.equal(h.created.length, 3)
    const fresh = h.popoutCaller(2)
    assert.equal(h.windows.takePopoutHandoff({ handoffId: id2 }, fresh).status, 'none')
    // stop 之后不再交付
    h.windows.stop()
    assert.equal(h.windows.takePopoutHandoff({ handoffId: id3 }, fresh).status, 'none')
  } finally {
    await h.dispose()
  }
})

test('并发：20ms 内 10 次连续弹出同一插件，只保留最后一份；被打断的加载按取消处理且不销毁窗口', async () => {
  const h = await createHarness()
  try {
    const ids = Array.from({ length: 10 }, (_, i) => handoffId(`burst${i}`))
    const results = await Promise.allSettled(ids.map((id, i) =>
      h.windows.open({ url: popoutUrl('json-format', id), handoff: handoff('json-format', id, { n: i }) }, h.mainCaller)))
    assert.ok(results.every((r) => r.status === 'fulfilled'))
    assert.equal(h.created.length, 1, '同一插件只有一个独立窗口')
    const popoutCaller = h.popoutCaller()
    for (const id of ids.slice(0, -1)) {
      assert.equal(h.windows.takePopoutHandoff({ handoffId: id }, popoutCaller).status, 'none')
    }
    const last = h.windows.takePopoutHandoff({ handoffId: ids.at(-1)! }, popoutCaller)
    assert.equal(last.status, 'ok')
    assert.equal(last.status === 'ok' && JSON.parse(last.state).entries.n, 9)

    // 新建窗口的加载被下一次弹出（复用同一窗口）打断：第一次 CANCELLED，窗口保留给第二次
    h.nextWindow.deferLoads = true
    const a = handoffId('slowA')
    const b = handoffId('slowB')
    const first = h.windows.open({ url: popoutUrl('crypto-tool', a), handoff: handoff('crypto-tool', a, { k: 'a' }) }, h.mainCaller)
    await new Promise((resolve) => setImmediate(resolve))
    const second = h.windows.open({ url: popoutUrl('crypto-tool', b), handoff: handoff('crypto-tool', b, { k: 'b' }) }, h.mainCaller)
    await assert.rejects(first, codeOf(errorCodes.cancelled))
    const win = h.created[1]!
    assert.equal(win.isDestroyed(), false, '被取代的加载不销毁窗口')
    win.finishLoad()
    assert.equal((await second).windowInstanceStatus, 'reused')
    const caller = h.popoutCaller(1)
    assert.equal(h.windows.takePopoutHandoff({ handoffId: a }, caller).status, 'none')
    assert.equal(h.windows.takePopoutHandoff({ handoffId: b }, caller).status, 'ok')
  } finally {
    await h.dispose()
  }
})

test('路径授权转交：不超过源窗口（只读→只读、递归祖先→以子目录为根、无授权→dropped），过期时间沿用源授权', async () => {
  const h = await createHarness()
  try {
    const readOnly = await touch(path.join(h.data, 'readonly.txt'))
    const project = path.join(h.data, 'project')
    const sub = path.join(project, 'sub')
    const inSub = await touch(path.join(sub, 'a.txt'))
    const nested = await touch(path.join(sub, 'deep', 'b.txt'))
    const inProject = await touch(path.join(project, 'top.txt'))
    const fileInFolder = await touch(path.join(project, 'single.txt'))
    const sibling = await touch(path.join(project, 'sibling.txt'))
    const ungranted = await touch(path.join(h.data, 'secret.txt'))
    const outside = await touch(path.join(h.root, 'outside', 'target.txt'))
    await fs.symlink(path.dirname(outside), path.join(sub, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')

    await h.files.grantOpenPath(readOnly, h.mainCaller)
    await h.files.grantFolder(project, h.mainCaller)

    const target = new FakeContents(50)
    const targetCaller = h.registry.registerMain(target as unknown as WebContents)
    const transfer = await h.files.transferGrants(h.mainCaller, 50, [
      readOnly, sub, fileInFolder, ungranted, path.join(sub, 'escape', 'target.txt'),
      'relative/x', '', '/missing/nowhere.txt', 42 as unknown as string, readOnly
    ])
    assert.deepEqual({ transferred: transfer.transferred, dropped: transfer.dropped }, { transferred: 3, dropped: 6 })

    assert.equal(await canAccess(h.files, readOnly, targetCaller, 'read'), true)
    assert.equal(await canAccess(h.files, readOnly, targetCaller, 'write'), false, '只读授权转交后仍只读')
    assert.equal(await canAccess(h.files, inSub, targetCaller, 'write'), true, '以子目录为根递归')
    assert.equal(await canAccess(h.files, nested, targetCaller, 'read'), true)
    assert.equal(await canAccess(h.files, inProject, targetCaller, 'read'), false, '子目录之外的祖先范围不转交')
    assert.equal(await canAccess(h.files, project, targetCaller, 'read'), false)
    assert.equal(await canAccess(h.files, fileInFolder, targetCaller, 'write'), true, '文件只转交精确路径')
    assert.equal(await canAccess(h.files, sibling, targetCaller, 'read'), false)
    assert.equal(await canAccess(h.files, ungranted, targetCaller, 'read'), false)
    assert.equal(await canAccess(h.files, outside, targetCaller, 'read'), false, '经符号链接逃出源授权范围的路径不转交')

    // 源窗口的授权过期后，转交来的授权一并过期（不比源授权活得久）
    h.clock.now += 60 * 60 * 1000 + 1
    assert.equal(await canAccess(h.files, inSub, targetCaller, 'read'), false)
    assert.equal(await canAccess(h.files, readOnly, targetCaller, 'read'), false)
  } finally {
    await h.dispose()
  }
})

test('路径授权转交：结果授权原样复制（含回收站与归属插件）；revoke 只撤销本次新增；身份与窗口状态异常一律拒绝', async () => {
  const h = await createHarness()
  try {
    const junk = await touch(path.join(h.data, 'scan', 'junk.tmp'))
    const plain = await touch(path.join(h.data, 'scan', 'plain.log'))
    const own = await touch(path.join(h.data, 'own.txt'))
    // 主窗口里 cleaner（有 fs）扫描得到带回收站的结果授权；plain 是宿主界面搜索得到的只读结果
    const token = await h.session('cleaner', h.mainCaller)
    const cleanerMain = h.attribution.attributeCaller(h.mainCaller, parseRequest({ messageId: 'scan', method: 'system_search_files', params: {}, pluginSession: token }))
    await h.files.grantResultPaths(cleanerMain, [{ path: junk, isDir: false }], 'dir-scan')
    await h.files.grantResultPaths(h.mainCaller, [{ path: plain, isDir: false }], 'search')
    assert.equal(await canAccess(h.files, junk, cleanerMain, 'trash'), true)

    const target = new FakeContents(60)
    const targetCaller = h.registry.registerMain(target as unknown as WebContents)
    await h.files.grantOpenPath(own, targetCaller)
    await h.files.grantOpenPath(own, h.mainCaller)
    // 弹出的是别的插件：cleaner 扫出的结果不跟着走（宿主自身的结果与普通授权照常转交）
    const unrelated = await h.files.transferGrants(h.mainCaller, 60, [junk, plain, own], 'viewer')
    assert.equal(unrelated.transferred, 2)
    assert.equal(await canAccess(h.files, junk, targetCaller, 'read'), false)
    unrelated.revoke()
    const transfer = await h.files.transferGrants(h.mainCaller, 60, [junk, plain, own], 'cleaner')
    assert.equal(transfer.transferred, 3)

    const cleanerToken = await h.session('cleaner', targetCaller)
    const cleanerTarget = h.attribution.attributeCaller(targetCaller, parseRequest({ messageId: 't', method: 'shell_trash_item', params: {}, pluginSession: cleanerToken }))
    assert.equal(await canAccess(h.files, junk, cleanerTarget, 'trash'), true, '同一插件在新窗口可回收转交来的扫描结果')
    assert.equal(await canAccess(h.files, junk, targetCaller, 'trash'), false, '宿主身份不能借用插件的回收站权限')
    assert.equal(await canAccess(h.files, plain, targetCaller, 'read'), true)
    assert.equal(await canAccess(h.files, plain, cleanerTarget, 'trash'), false, '只读结果转交后仍不能回收')

    transfer.revoke()
    assert.equal(await canAccess(h.files, junk, targetCaller, 'read'), false, 'revoke 撤销转交的结果授权')
    assert.equal(await canAccess(h.files, plain, targetCaller, 'read'), false)
    assert.equal(await canAccess(h.files, own, targetCaller, 'read'), true, '目标窗口自己原有的授权不受影响')
    assert.equal(await canAccess(h.files, junk, cleanerMain, 'trash'), true, '源窗口授权不受影响')

    // 身份异常
    const plugin = new FakeContents(70)
    h.registry.registerPlugin(plugin as unknown as WebContents, 'cleaner', 'inst-70')
    const pluginCaller = h.registry.get(70)!
    await assert.rejects(h.files.transferGrants(pluginCaller, 60, [junk]), denied, '插件窗口不能作为源')
    await assert.rejects(h.files.transferGrants(h.mainCaller, 70, [junk]), denied, '不能转交给插件窗口')
    await assert.rejects(h.files.transferGrants(h.mainCaller, 1, [junk]), denied, '不能转交给自己')
    await assert.rejects(h.files.transferGrants(h.mainCaller, 999, [junk]), denied, '目标未登记')
    target.destroy()
    await assert.rejects(h.files.transferGrants(h.mainCaller, 60, [junk]), denied, '目标已关闭')

    // 超过 2000 条：多出的计入 dropped；转交中目标关闭：整体失败且不留授权
    const many = Array.from({ length: 2005 }, (_, i) => path.join(h.data, 'none', `${i}.txt`))
    const target2 = new FakeContents(61)
    h.registry.registerMain(target2 as unknown as WebContents)
    const overflow = await h.files.transferGrants(h.mainCaller, 61, many)
    assert.deepEqual({ transferred: overflow.transferred, dropped: overflow.dropped }, { transferred: 0, dropped: 2005 })
    const pending = h.files.transferGrants(h.mainCaller, 61, [junk, plain, ...many.slice(0, 50)])
    target2.destroy()
    await assert.rejects(pending, denied)
  } finally {
    await h.dispose()
  }
})

test('集成：window_open 带 handoff 转交授权；新窗口加载失败 → 交接与已转交授权都撤销（新建窗口销毁、复用窗口保留）', async () => {
  const h = await createHarness()
  try {
    const folder = path.join(h.data, 'rename-me')
    const file = await touch(path.join(folder, 'a.txt'))
    const other = await touch(path.join(h.data, 'other.txt'))
    await h.files.grantFolder(folder, h.mainCaller)

    // 新建窗口加载失败
    h.nextWindow.failLoad = true
    const failId = handoffId('fail')
    const failParams = { url: popoutUrl('batch-rename', failId), handoff: handoff('batch-rename', failId, { customDir: folder }, { paths: [folder] }) }
    await assert.rejects(h.windows.open(failParams, h.admit(h.main, 'window_open', failParams)), /Load failed/u)
    assert.equal(h.created[0]!.isDestroyed(), true)
    assert.equal(h.registry.get(h.created[0]!.webContents.id), undefined)
    h.nextWindow.failLoad = false

    // 成功：新窗口拿到目录的递归读写授权、拿不到未转交的路径
    const okId = handoffId('ok')
    const okParams = { url: popoutUrl('batch-rename', okId), handoff: handoff('batch-rename', okId, { customDir: folder }, { paths: [folder, other] }) }
    await h.windows.open(okParams, h.admit(h.main, 'window_open', okParams))
    const win = h.created[1]!
    const popoutCaller = h.popoutCaller(1)
    assert.equal(await canAccess(h.files, file, popoutCaller, 'write'), true)
    assert.equal(await canAccess(h.files, other, popoutCaller, 'read'), false)
    const taken = h.windows.takePopoutHandoff({ handoffId: okId }, popoutCaller)
    assert.equal(taken.status === 'ok' && JSON.parse(taken.state).entries.customDir, folder)

    // 复用窗口时加载失败：本次交接与新转交的授权撤销，之前已有的授权与窗口保留
    const extra = path.join(h.data, 'extra')
    const extraFile = await touch(path.join(extra, 'x.txt'))
    await h.files.grantFolder(extra, h.mainCaller)
    win.failLoad = true
    const reuseId = handoffId('reuse')
    const reuseParams = { url: popoutUrl('batch-rename', reuseId), handoff: handoff('batch-rename', reuseId, {}, { paths: [extra, folder] }) }
    await assert.rejects(h.windows.open(reuseParams, h.mainCaller), /Load failed/u)
    assert.equal(win.isDestroyed(), false)
    assert.equal(h.windows.takePopoutHandoff({ handoffId: reuseId }, popoutCaller).status, 'none')
    assert.equal(await canAccess(h.files, extraFile, popoutCaller, 'read'), false, '本次转交被撤销')
    assert.equal(await canAccess(h.files, file, popoutCaller, 'write'), true, '上一次转交的授权保留')

    // 转交本身失败（源窗口在弹出途中关闭）不阻止弹出：状态照常交接，只是没有授权
    win.failLoad = false
    const closing = new FakeContents(80)
    const closingCaller = h.registry.registerMain(closing as unknown as WebContents)
    await h.files.grantFolder(extra, closingCaller)
    closing.destroy()
    const noGrantId = handoffId('nogrant')
    const noGrantParams = { url: popoutUrl('batch-rename', noGrantId), handoff: handoff('batch-rename', noGrantId, { customDir: extra }, { paths: [extra] }) }
    assert.equal((await h.windows.open(noGrantParams, closingCaller)).windowInstanceStatus, 'reused')
    assert.equal(h.windows.takePopoutHandoff({ handoffId: noGrantId }, popoutCaller).status, 'ok')
    assert.equal(await canAccess(h.files, extraFile, popoutCaller, 'read'), false)
  } finally {
    await h.dispose()
  }
})
