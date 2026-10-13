import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, screen, type Session } from 'electron'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PluginOpenParams } from '../../contracts/method-params.js'
import type { PluginExitStatus } from '../services/event-service.js'
import type { SdkApiLane } from '../../contracts/sdk-api-lane.js'
import type { PluginManifest, PluginManifestRuntimeMetadata } from '../services/plugin-install-service.js'
import type { PluginStateProvider } from '../services/plugin-state-service.js'
import { secureWebPreferences } from './main-window.js'
import type { PluginSessionProvider } from './plugin-session-manager.js'
import type { WindowRegistry } from './window-registry.js'
import { ensureBoundsVisible } from './display-bounds.js'

const MAX_PLUGIN_WINDOWS = 16
const DEFAULT_WIDTH = 900
const DEFAULT_HEIGHT = 640
const MIN_WINDOW_WIDTH = 320
const MIN_WINDOW_HEIGHT = 240
const MAX_WINDOW_DIMENSION = 4096

export type PluginWindowState = 'creating' | 'ready' | 'suspended' | 'crashed' | 'closing' | 'destroyed'
type LifecycleOutStatus = 'hidden' | 'closed'

export interface PluginCrashDetails {
  reason: string
  exitCode: number
  timestamp: number
}

const DEFAULT_SUSPEND_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BACKGROUND_PLUGINS = 4

interface PendingLifecycleAck {
  record: PluginWindowRecord
  timer: NodeJS.Timeout
  completion: Promise<void>
  resolve: () => void
}

export interface PluginManifestProvider {
  withPluginManifest<T>(
    pluginId: string,
    action: (manifest: PluginManifest, runtimeMetadata?: PluginManifestRuntimeMetadata) => Promise<T>
  ): Promise<T>
}

export interface PluginWindowManagerOptions {
  registry: WindowRegistry
  manifests: PluginManifestProvider
  sessions?: PluginSessionProvider
  state?: PluginStateProvider
  events?: PluginWindowEventPublisher
  pluginRoot?: string
  isDarkMode?: () => boolean
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
  requestExit?: (owner: CallerIdentity, isKill: boolean) => Promise<PluginExitStatus>
  suspendTimeoutMs?: number
  maxActiveBackgroundPlugins?: number
  onPluginSuspend?: (pluginId: string, instanceId: string) => void
  onPluginResume?: (pluginId: string, instanceId: string) => void
  onPluginCrash?: (pluginId: string, instanceId: string, details: { reason: string; exitCode: number }) => void
}

export interface PluginWindowEventPublisher {
  publishHost(type: string, payload: unknown): { success: true; delivered: number }
  publishHostToOwner(
    type: string,
    payload: unknown,
    owner: CallerIdentity
  ): { success: true; delivered: number }
}

export interface PluginOpenResult {
  success: true
  pluginId: string
  instanceId: string
  pluginLoadStatus: 'running'
  windowInstanceStatus: 'created' | 'reused'
}

interface NormalizedWindowConfig {
  width: number
  height: number
  minWidth: number
  minHeight: number
  resizable: boolean
  minimizable: boolean
  maximizable: boolean
  closable: boolean
  singleInstance: boolean
}

interface PluginWindowRecord {
  pluginId: string
  instanceId: string
  window: BrowserWindow
  singleInstance: boolean
  state: PluginWindowState
  closePromise?: Promise<void>
  controls: {
    minimize: boolean
    maximize: boolean
    close: boolean
  }
  visible: boolean
  opened: boolean
  lifecycleOutSent: boolean
  lifecycleOutStatus: LifecycleOutStatus | undefined
  closePending: boolean
  forceDestroy: boolean
  outCompletions: Set<Promise<void>>
  closeCompletion: Promise<void> | undefined
  pendingOpenStatus: 'created' | 'reused' | undefined
  lastOpenStatus: 'created' | 'reused'
  lastWindowState: 'maximized' | 'normal' | 'minimized' | undefined
  startupPayload: Record<string, unknown> | undefined
  restoreMaximized: boolean
  persistTimer: NodeJS.Timeout | undefined
  enterRetryTimer: NodeJS.Timeout | undefined
  suspendTimer: NodeJS.Timeout | undefined
  backgroundTimestamp?: number | undefined
  crashDetails?: PluginCrashDetails | undefined
}

interface PersistedWindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalBoolean(
  value: unknown,
  label: string,
  fallback: boolean
): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, `${label} 必须是布尔值`)
  }
  return value
}

function optionalDimension(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > MAX_WINDOW_DIMENSION) {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, `${label} 超出有效范围`)
  }
  return value as number
}

export function normalizePluginWindowConfig(manifest: PluginManifest): NormalizedWindowConfig {
  const raw = manifest.window
  if (raw !== undefined && !isRecord(raw)) {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, 'window 必须是对象')
  }
  const windowConfig = raw ?? {}
  const rawControls = windowConfig.controls
  if (rawControls !== undefined && !isRecord(rawControls)) {
    throw new ZToolsError(errorCodes.pluginPackageInvalid, 'window.controls 必须是对象')
  }
  const controls = rawControls ?? {}
  const configValue = (key: string): unknown => Object.hasOwn(manifest, key) ? manifest[key] : windowConfig[key]
  const configLabel = (key: string): string => manifest[key] !== undefined ? key : `window.${key}`
  const minWidth = optionalDimension(configValue('minWidth'), configLabel('minWidth'), MIN_WINDOW_WIDTH, MIN_WINDOW_WIDTH)
  const minHeight = optionalDimension(configValue('minHeight'), configLabel('minHeight'), MIN_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT)
  const width = Math.max(optionalDimension(configValue('width'), configLabel('width'), DEFAULT_WIDTH, MIN_WINDOW_WIDTH), minWidth)
  const height = Math.max(optionalDimension(configValue('height'), configLabel('height'), DEFAULT_HEIGHT, MIN_WINDOW_HEIGHT), minHeight)
  const resizable = optionalBoolean(configValue('resizable'), configLabel('resizable'), true)
  return {
    width,
    height,
    minWidth,
    minHeight,
    resizable,
    minimizable: optionalBoolean(controls.minimize, 'window.controls.minimize', true),
    maximizable: resizable && optionalBoolean(controls.maximize, 'window.controls.maximize', true),
    closable: optionalBoolean(controls.close, 'window.controls.close', true),
    singleInstance: optionalBoolean(configValue('singleInstance'), configLabel('singleInstance'), false)
  }
}

function pluginTitle(manifest: PluginManifest): string {
  const title = manifest.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128)
  return title || manifest.id
}

function pluginUrl(pluginId: string, entry: string): string {
  const encodedEntry = entry.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')
  return `ztools://plugins/${encodeURIComponent(pluginId)}/${encodedEntry}`
}

function isPluginUrl(value: string, pluginId: string): boolean {
  try {
    const url = new URL(value)
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    return url.protocol === 'ztools:' && url.hostname === 'plugins' && segments[0] === pluginId
  } catch {
    return false
  }
}

function startupPayloadScript(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(JSON.stringify(payload))
  return `(()=>{const payload=JSON.parse(${serialized});window.__ztools_plugin_startup_payload=payload;window.dispatchEvent(new CustomEvent('ztools:startup-payload',{detail:payload}));})()`
}

function runtimeIdentityScript(
  pluginId: string,
  instanceId: string,
  config: NormalizedWindowConfig,
  darkMode: boolean
): string {
  const identity = JSON.stringify({ pluginId, instanceId })
  const controls = JSON.stringify({
    minimize: config.minimizable,
    maximize: config.maximizable,
    close: config.closable
  })
  return `(()=>{const identity=${identity};window.__ztools_plugin_id=identity.pluginId;window.__ztools_plugin_instance_id=identity.instanceId;window.__ztools_window_controls=${controls};window.__ztools_is_dark_mode=${darkMode ? 'true' : 'false'};window.dispatchEvent(new CustomEvent('ztools:window-controls-config',{detail:window.__ztools_window_controls}));})()`
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function pluginIconPath(pluginRoot: string | undefined, manifest: PluginManifest): string | undefined {
  if (!pluginRoot || typeof manifest.icon !== 'string' || manifest.icon.trim() === '') return undefined
  const pluginDirectory = path.resolve(pluginRoot, manifest.id)
  const candidate = path.resolve(pluginDirectory, manifest.icon)
  if (!isWithin(pluginDirectory, candidate) || candidate === pluginDirectory) return undefined
  try {
    const realPluginDirectory = fs.realpathSync(pluginDirectory)
    const realCandidate = fs.realpathSync(candidate)
    if (!isWithin(realPluginDirectory, realCandidate) || !fs.lstatSync(realCandidate).isFile()) return undefined
    return realCandidate
  } catch {
    return undefined
  }
}

export class PluginWindowManager {
  readonly #records = new Map<string, Map<string, PluginWindowRecord>>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #pendingLifecycleAcks = new Map<string, PendingLifecycleAck>()
  readonly #createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
  #reservedWindows = 0
  #stopping = false
  #stopPromise: Promise<void> | undefined
  readonly #pendingStateWrites = new Set<Promise<void>>()
  #screenListenerAttached = false

  #onDisplayMetricsChanged = (): void => {
    if (this.#stopping || typeof screen?.getAllDisplays !== 'function' || typeof screen?.getPrimaryDisplay !== 'function') return
    const allDisplays = screen.getAllDisplays()
    const fallback = screen.getPrimaryDisplay()
    for (const recordMap of this.#records.values()) {
      for (const record of recordMap.values()) {
        const win = record.window
        if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen() || !win.isVisible()) {
          continue
        }
        const currentBounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
        const safeBounds = ensureBoundsVisible(currentBounds, allDisplays, fallback, 10000)
        if (
          safeBounds.x !== currentBounds.x ||
          safeBounds.y !== currentBounds.y ||
          safeBounds.width !== currentBounds.width ||
          safeBounds.height !== currentBounds.height
        ) {
          win.setBounds(safeBounds)
        }
      }
    }
  }

  #attachScreenListeners(): void {
    if (this.#screenListenerAttached || typeof screen?.on !== 'function') return
    screen.on('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.on('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = true
  }

  #detachScreenListeners(): void {
    if (!this.#screenListenerAttached || typeof screen?.removeListener !== 'function') return
    screen.removeListener('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.removeListener('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = false
  }

  constructor(private readonly options: PluginWindowManagerOptions) {
    this.#createWindow = options.createWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
    this.#attachScreenListeners()
  }

  open(params: PluginOpenParams): Promise<PluginOpenResult> {
    const key = params.pluginId.toLowerCase()
    return this.#serialize(key, () => this.#openSerialized(params))
  }

  closePlugin(pluginId: string, instanceId?: string): Promise<{ success: true; closed: number }> {
    const key = pluginId.toLowerCase()
    return this.#serialize(key, async () => {
      const pluginRecords = this.#records.get(key)
      const matchingRecord = instanceId === undefined
        ? undefined
        : pluginRecords?.get(instanceId.toLowerCase())
      const records = instanceId === undefined
        ? [...(pluginRecords?.values() ?? [])]
        : matchingRecord ? [matchingRecord] : []
      await Promise.all(records.map(record => this.#closeRecord(record, false)))
      return { success: true, closed: records.length }
    })
  }

  close(
    pluginId: string,
    instanceId?: string
  ): Promise<{ success: true; closed: number }> {
    const key = pluginId.toLowerCase()
    return this.#serialize(key, async () => {
      const records = [...(this.#records.get(key)?.values() ?? [])]
        .filter((record) => !instanceId || record.instanceId === instanceId)
      await Promise.all(records.map((record) => this.#requestGracefulClose(record)))
      return { success: true, closed: records.length }
    })
  }

  acknowledgeLifecycle(lifecycleId: string, caller: CallerIdentity): { success: true } {
    const pending = this.#pendingLifecycleAcks.get(lifecycleId)
    if (!pending) return { success: true }
    const record = pending.record
    if (
      caller.type !== 'plugin' ||
      caller.webContentsId !== record.window.webContents.id ||
      caller.pluginId?.toLowerCase() !== record.pluginId.toLowerCase() ||
      caller.pluginInstanceId !== record.instanceId
    ) {
      throw new ZToolsError(errorCodes.permissionDenied, '生命周期确认不属于当前插件窗口')
    }
    this.#resolveLifecycleAck(lifecycleId)
    return { success: true }
  }

  suspend(pluginId: string, instanceId?: string): boolean {
    const key = pluginId.toLowerCase()
    const records = this.#records.get(key)
    if (!records) return false
    let suspendedAny = false
    for (const record of records.values()) {
      if (!instanceId || record.instanceId === instanceId) {
        if (record.state === 'ready' && !record.visible) {
          this.#suspendRecord(record)
          suspendedAny = true
        }
      }
    }
    return suspendedAny
  }

  resume(pluginId: string, instanceId?: string): boolean {
    const key = pluginId.toLowerCase()
    const records = this.#records.get(key)
    if (!records) return false
    let resumedAny = false
    for (const record of records.values()) {
      if (!instanceId || record.instanceId === instanceId) {
        if (record.state === 'suspended') {
          this.#resumeRecord(record)
          resumedAny = true
        }
      }
    }
    return resumedAny
  }

  async reload(pluginId: string, instanceId?: string): Promise<{ success: boolean; recovered: boolean }> {
    const key = pluginId.toLowerCase()
    return this.#serialize(key, async () => {
      const records = this.#records.get(key)
      if (!records || records.size === 0) return { success: false, recovered: false }
      const target = instanceId
        ? records.get(instanceId)
        : [...records.values()][0]
      if (!target) return { success: false, recovered: false }

      const wasCrashed = target.state === 'crashed'
      const previousInstanceId = target.instanceId
      const payload = target.startupPayload
      this.#destroyRecord(target)

      await this.#openSerialized({ pluginId, ...(payload ? { payload } : {}) })
      if (wasCrashed) {
        this.#publishHost('plugin_recovered', {
          pluginId,
          previousInstanceId
        })
      }
      return { success: true, recovered: wasCrashed }
    })
  }

  getPluginState(pluginId: string, instanceId?: string): PluginWindowState | undefined {
    const key = pluginId.toLowerCase()
    const records = this.#records.get(key)
    if (!records) return undefined
    if (instanceId) return records.get(instanceId)?.state
    return [...records.values()][0]?.state
  }

  getCrashDetails(pluginId: string, instanceId?: string): PluginCrashDetails | undefined {
    const key = pluginId.toLowerCase()
    const records = this.#records.get(key)
    if (!records) return undefined
    if (instanceId) return records.get(instanceId)?.crashDetails
    return [...records.values()][0]?.crashDetails
  }

  stop(): Promise<void> {
    this.#detachScreenListeners()
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#stopPromise = (async () => {
      const existing = [...this.#records.values()].flatMap(records => [...records.values()])
      for (const record of existing) {
        this.#cancelSuspendTimer(record)
      }
      await Promise.all(existing.map(record => this.#closeRecord(record, true)))
      await Promise.allSettled([...this.#queues.values()])
      const remaining = [...this.#records.values()].flatMap(records => [...records.values()])
      await Promise.all(remaining.map(record => this.#closeRecord(record, true)))
      this.#records.clear()
      await Promise.allSettled([...this.#pendingStateWrites])
    })()
    return this.#stopPromise
  }

  #serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const operation = previous.then(action, action)
    const tail = operation.then(() => undefined, () => undefined)
    this.#queues.set(key, tail)
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key)
    })
    return operation
  }

  async #openSerialized(params: PluginOpenParams): Promise<PluginOpenResult> {
    this.#requireRunning()
    return this.options.manifests.withPluginManifest(params.pluginId, async (manifest, runtimeMetadata) => {
      if (this.options.state && !(await this.options.state.isEnabled(manifest.id, manifest.enabled !== false))) {
        throw new ZToolsError(errorCodes.pluginNotFound, '插件已禁用')
      }
      const crashed = this.#findCrashed(params.pluginId)
      const previousCrashedId = crashed?.instanceId
      if (crashed) {
        this.#destroyRecord(crashed)
      }
      const reusable = this.#findReusable(params.pluginId)
      if (reusable) return this.#reuseAndMarkUsed(reusable, params.payload)
      if (this.#windowCount() + this.#reservedWindows >= MAX_PLUGIN_WINDOWS) {
        throw new ZToolsError(errorCodes.pluginBusy, '插件窗口数量已达上限')
      }
      this.#reservedWindows += 1
      let reserved = true
      try {
        this.#requireRunning()
        if (!manifest.entry) {
          throw new ZToolsError(errorCodes.notSupported, '插件不包含可显示页面')
        }
        const config = normalizePluginWindowConfig(manifest)
        const secondReusable = this.#findReusable(params.pluginId)
        if (secondReusable) return this.#reuseAndMarkUsed(secondReusable, params.payload)
        this.#reservedWindows -= 1
        reserved = false
        const result = await this.#create(manifest, config, runtimeMetadata?.sdkApiLane ?? 1, params.payload)
        await this.#markUsed(manifest.id)
        if (previousCrashedId) {
          this.#publishHost('plugin_recovered', {
            pluginId: manifest.id,
            instanceId: result.instanceId,
            previousInstanceId: previousCrashedId
          })
        }
        return result
      } finally {
        if (reserved) this.#reservedWindows -= 1
      }
    })
  }

  async #create(
    manifest: PluginManifest,
    config: NormalizedWindowConfig,
    sdkApiLane: SdkApiLane,
    payload?: Record<string, unknown>
  ): Promise<PluginOpenResult> {
    const instanceId = randomUUID()
    const pluginSession: Session | undefined = await this.options.sessions?.get(manifest.id)
    const icon = pluginIconPath(this.options.pluginRoot, manifest)
    const persisted = await this.#readPersistedWindowState(manifest, config)
    let initialWidth = persisted?.width ?? config.width
    let initialHeight = persisted?.height ?? config.height
    let initialX = persisted?.x
    let initialY = persisted?.y

    if (initialX !== undefined && initialY !== undefined && typeof screen?.getAllDisplays === 'function' && typeof screen?.getPrimaryDisplay === 'function') {
      const allDisplays = screen.getAllDisplays()
      const fallback = screen.getPrimaryDisplay()
      const safeBounds = ensureBoundsVisible(
        { x: initialX, y: initialY, width: initialWidth, height: initialHeight },
        allDisplays,
        fallback,
        10000
      )
      initialX = safeBounds.x
      initialY = safeBounds.y
      initialWidth = safeBounds.width
      initialHeight = safeBounds.height
    }

    const window = this.#createWindow({
      title: pluginTitle(manifest),
      width: initialWidth,
      height: initialHeight,
      ...(initialX !== undefined && initialY !== undefined
        ? { x: initialX, y: initialY }
        : {}),
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      resizable: config.resizable,
      minimizable: config.minimizable,
      maximizable: config.maximizable,
      closable: config.closable,
      ...(icon ? { icon } : {}),
      show: false,
      autoHideMenuBar: true,
      backgroundColor: this.options.isDarkMode?.() === true ? '#141414' : '#ffffff',
      webPreferences: {
        ...secureWebPreferences(),
        ...(pluginSession ? { session: pluginSession } : {})
      }
    })
    const record: PluginWindowRecord = {
      pluginId: manifest.id,
      instanceId,
      window,
      singleInstance: config.singleInstance,
      state: 'creating',
      controls: {
        minimize: config.minimizable,
        maximize: config.maximizable,
        close: config.closable
      },
      visible: false,
      opened: false,
      lifecycleOutSent: false,
      lifecycleOutStatus: undefined,
      closePending: false,
      forceDestroy: false,
      outCompletions: new Set(),
      closeCompletion: undefined,
      pendingOpenStatus: undefined,
      lastOpenStatus: 'created',
      lastWindowState: undefined,
      startupPayload: undefined,
      restoreMaximized: persisted?.maximized === true && config.maximizable,
      persistTimer: undefined,
      enterRetryTimer: undefined,
      suspendTimer: undefined,
      backgroundTimestamp: undefined,
      crashDetails: undefined
    }
    this.#addRecord(record)
    try {
      this.options.registry.registerPlugin(window.webContents, manifest.id, instanceId, sdkApiLane)
      window.webContents.on('will-navigate', (event, url) => {
        if (!isPluginUrl(url, manifest.id)) event.preventDefault()
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-attach-webview', (event) => event.preventDefault())
      window.webContents.on('render-process-gone', (_event, details) => {
        if (record.state === 'closing' || record.state === 'destroyed' || record.forceDestroy) {
          return
        }
        this.#handleCrash(record, details)
      })
      window.on('show', () => this.#handleShow(record))
      window.on('hide', () => this.#handleHide(record))
      window.on('close', (event) => this.#handleClose(record, event))
      window.on('maximize', () => this.#publishWindowState(record, 'maximized'))
      window.on('unmaximize', () => this.#publishWindowState(record, 'normal'))
      window.on('minimize', () => this.#publishWindowState(record, 'minimized'))
      window.on('restore', () => this.#publishWindowState(record, 'normal'))
      window.on('resize', () => this.#saveWindowState(record))
      window.on('move', () => this.#saveWindowState(record))
      window.once('closed', () => this.#removeRecord(record))
      const url = pluginUrl(manifest.id, manifest.entry)
      console.info(`插件窗口开始加载: pluginId=${manifest.id}, instanceId=${instanceId}, url=${url}`)
      await window.loadURL(url)
      this.#requireRunning()
      if (window.isDestroyed()) {
        throw new ZToolsError(errorCodes.callerDestroyed, '插件窗口在加载期间被关闭')
      }
      record.state = 'ready'
      record.opened = true
      await window.webContents.executeJavaScript(
        runtimeIdentityScript(
          manifest.id,
          instanceId,
          config,
          this.options.isDarkMode?.() ?? false
        )
      )
      if (payload) await this.#deliverPayload(record, payload)
      record.pendingOpenStatus = 'created'
      if (record.restoreMaximized && !window.isMaximized()) window.maximize()
      window.show()
      this.#announcePendingOpen(record)
      window.focus()
      this.#publishHost('plugin_opened', {
        pluginId: record.pluginId,
        instanceId: record.instanceId,
        status: 'entered',
        windowInstanceStatus: 'created'
      })
      console.info(`插件窗口已显示: pluginId=${manifest.id}, instanceId=${instanceId}`)
      return {
        success: true,
        pluginId: manifest.id,
        instanceId,
        pluginLoadStatus: 'running',
        windowInstanceStatus: 'created'
      }
    } catch (error) {
      console.error(`插件窗口启动失败: pluginId=${manifest.id}, instanceId=${instanceId}`, error)
      this.#destroyRecord(record)
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.pluginPackageInvalid, '插件页面加载失败')
    }
  }

  async #reuse(
    record: PluginWindowRecord,
    payload?: Record<string, unknown>
  ): Promise<PluginOpenResult> {
    this.#cancelSuspendTimer(record)
    if (record.state === 'suspended') {
      this.#resumeRecord(record)
    }
    const window = record.window
    if (window.isDestroyed()) {
      this.#removeRecord(record)
      throw new ZToolsError(errorCodes.callerDestroyed, '插件窗口已销毁')
    }
    if (payload) await this.#deliverPayload(record, payload)
    if (window.isMinimized()) window.restore()
    record.pendingOpenStatus = 'reused'
    window.show()
    this.#announcePendingOpen(record)
    window.focus()
    this.#publishHost('plugin_opened', {
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      status: 'entered',
      windowInstanceStatus: 'reused'
    })
    console.info(`复用插件窗口: pluginId=${record.pluginId}, instanceId=${record.instanceId}`)
    return {
      success: true,
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      pluginLoadStatus: 'running',
      windowInstanceStatus: 'reused'
    }
  }

  async #reuseAndMarkUsed(
    record: PluginWindowRecord,
    payload?: Record<string, unknown>
  ): Promise<PluginOpenResult> {
    const result = await this.#reuse(record, payload)
    await this.#markUsed(record.pluginId)
    return result
  }

  async #markUsed(pluginId: string): Promise<void> {
    await this.options.state?.markUsed(pluginId).catch((error: unknown) => {
      console.warn(`插件使用统计保存失败: pluginId=${pluginId}`, error)
    })
  }

  async #deliverPayload(
    record: PluginWindowRecord,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (record.window.isDestroyed()) {
      throw new ZToolsError(errorCodes.callerDestroyed, '插件窗口已销毁')
    }
    await record.window.webContents.executeJavaScript(startupPayloadScript(payload))
    record.startupPayload = payload
  }

  #findReusable(pluginId: string): PluginWindowRecord | undefined {
    const records = this.#records.get(pluginId.toLowerCase())
    if (!records) return undefined
    for (const record of records.values()) {
      if (
        record.singleInstance &&
        (record.state === 'ready' || record.state === 'suspended') &&
        !record.window.isDestroyed()
      ) return record
    }
    return undefined
  }

  #findCrashed(pluginId: string): PluginWindowRecord | undefined {
    const records = this.#records.get(pluginId.toLowerCase())
    if (!records) return undefined
    for (const record of records.values()) {
      if (record.state === 'crashed') return record
    }
    return undefined
  }

  #windowCount(): number {
    let count = 0
    for (const records of this.#records.values()) count += records.size
    return count
  }

  #addRecord(record: PluginWindowRecord): void {
    const key = record.pluginId.toLowerCase()
    const records = this.#records.get(key) ?? new Map<string, PluginWindowRecord>()
    records.set(record.instanceId, record)
    this.#records.set(key, records)
  }

  #removeRecord(record: PluginWindowRecord): void {
    if (record.state === 'destroyed') return
    const wasOpened = record.opened
    this.#cancelSuspendTimer(record)
    if (record.persistTimer) clearTimeout(record.persistTimer)
    if (record.enterRetryTimer) clearTimeout(record.enterRetryTimer)
    this.#resolveLifecycleAcks(record)
    if (record.state !== 'crashed') {
      record.state = 'destroyed'
      const key = record.pluginId.toLowerCase()
      const records = this.#records.get(key)
      records?.delete(record.instanceId)
      if (records?.size === 0) {
        this.#records.delete(key)
        try {
          this.options.sessions?.release?.(record.pluginId)
        } catch (err) {
          console.warn(`释放插件 Session 引用失败: ${record.pluginId}`, err)
        }
      }
    }
    if (wasOpened) {
      this.#publishHost('plugin_closed', {
        pluginId: record.pluginId,
        instanceId: record.instanceId
      })
    }
    console.info(`插件窗口已关闭: pluginId=${record.pluginId}, instanceId=${record.instanceId}`)
  }

  #closeRecord(record: PluginWindowRecord, isKill: boolean): Promise<void> {
    if (record.closePromise) return record.closePromise
    if (record.state === 'destroyed') return Promise.resolve()
    this.#cancelSuspendTimer(record)
    if ((record.state !== 'ready' && record.state !== 'suspended') || !this.options.requestExit) {
      this.#destroyRecord(record)
      return Promise.resolve()
    }
    this.#saveWindowState(record, true)
    record.state = 'closing'
    const owner: CallerIdentity = { type: 'plugin', webContentsId: record.window.webContents.id,
      pluginId: record.pluginId, pluginInstanceId: record.instanceId }
    record.closePromise = (async () => {
      let timer: NodeJS.Timeout | undefined
      let onClosed: (() => void) | undefined
      try {
        const timeout = new Promise<PluginExitStatus>(resolve => {
          timer = setTimeout(() => resolve('TIMEOUT'), 2000)
        })
        const gone = new Promise<PluginExitStatus>(resolve => {
          onClosed = () => resolve('OWNER_GONE')
          record.window.once('closed', onClosed)
        })
        const completion = Promise.resolve().then(() => this.options.requestExit!(owner, isKill))
        const status = await Promise.race([completion, timeout, gone])
        if (status !== 'COMPLETED' && status !== 'NO_SUBSCRIBERS') {
          console.warn('插件退出回调未完成', { pluginId: record.pluginId, instanceId: record.instanceId, status })
        }
      } catch {
        console.warn('插件退出回调失败', { pluginId: record.pluginId, instanceId: record.instanceId })
      } finally {
        if (timer) clearTimeout(timer)
        if (onClosed) record.window.removeListener('closed', onClosed)
        this.#destroyRecord(record)
      }
    })()
    return record.closePromise
  }

  #destroyRecord(record: PluginWindowRecord): void {
    if (record.state === 'destroyed') return
    this.#cancelSuspendTimer(record)
    this.#saveWindowState(record, true)
    record.forceDestroy = true
    this.#resolveLifecycleAcks(record)
    record.lifecycleOutStatus = undefined
    record.lifecycleOutSent = false
    if (!record.closePromise) void this.#emitOut(record, true, 'closed')
    record.state = 'closing'
    if (!record.window.isDestroyed()) record.window.destroy()
    this.#removeRecord(record)
    const key = record.pluginId.toLowerCase()
    const records = this.#records.get(key)
    records?.delete(record.instanceId)
    if (records?.size === 0) {
      this.#records.delete(key)
      try {
        this.options.sessions?.release?.(record.pluginId)
      } catch (err) {
        console.warn(`释放插件 Session 引用失败: ${record.pluginId}`, err)
      }
    }
    record.state = 'destroyed'
  }

  #requestGracefulClose(record: PluginWindowRecord): Promise<void> {
    return this.#closeRecord(record, this.#stopping)
  }

  #handleShow(record: PluginWindowRecord): void {
    this.#cancelSuspendTimer(record)
    if (record.state === 'suspended') {
      this.#resumeRecord(record)
    }
    if (record.state !== 'ready') return
    if (record.pendingOpenStatus) {
      this.#announcePendingOpen(record)
      return
    }
    if (!record.visible) this.#emitEnter(record, 'reused')
  }

  #handleHide(record: PluginWindowRecord): void {
    if (record.state !== 'ready' && record.state !== 'suspended') return
    record.visible = false
    record.backgroundTimestamp = Date.now()
    void this.#emitOut(record, false, 'hidden')
    this.#scheduleSuspend(record)
    this.#enforceBackgroundLimit()
  }

  #scheduleSuspend(record: PluginWindowRecord): void {
    this.#cancelSuspendTimer(record)
    const timeout = this.options.suspendTimeoutMs ?? DEFAULT_SUSPEND_TIMEOUT_MS
    if (timeout <= 0) {
      this.#suspendRecord(record)
      return
    }
    record.suspendTimer = setTimeout(() => {
      record.suspendTimer = undefined
      this.#suspendRecord(record)
    }, timeout)
  }

  #cancelSuspendTimer(record: PluginWindowRecord): void {
    if (record.suspendTimer) {
      clearTimeout(record.suspendTimer)
      record.suspendTimer = undefined
    }
  }

  #enforceBackgroundLimit(): void {
    const maxBackground = this.options.maxActiveBackgroundPlugins ?? DEFAULT_MAX_BACKGROUND_PLUGINS
    const backgroundReadyRecords: PluginWindowRecord[] = []
    for (const records of this.#records.values()) {
      for (const record of records.values()) {
        if (!record.visible && record.state === 'ready') {
          backgroundReadyRecords.push(record)
        }
      }
    }
    if (backgroundReadyRecords.length > maxBackground) {
      backgroundReadyRecords.sort((a, b) => (a.backgroundTimestamp ?? 0) - (b.backgroundTimestamp ?? 0))
      const excess = backgroundReadyRecords.length - maxBackground
      for (let i = 0; i < excess; i++) {
        const candidate = backgroundReadyRecords[i]
        if (candidate) {
          this.#suspendRecord(candidate)
        }
      }
    }
  }

  #suspendRecord(record: PluginWindowRecord): void {
    if (record.state !== 'ready' || record.visible || record.window.isDestroyed()) return
    this.#cancelSuspendTimer(record)
    record.state = 'suspended'

    const webContents = record.window.webContents as unknown as {
      setAudioMuted?: (muted: boolean) => void
      setBackgroundThrottling?: (throttling: boolean) => void
    }
    if (typeof webContents.setAudioMuted === 'function') {
      webContents.setAudioMuted(true)
    }
    if (typeof webContents.setBackgroundThrottling === 'function') {
      webContents.setBackgroundThrottling(true)
    }

    this.#publishToOwner('plugin_suspend', {
      pluginId: record.pluginId,
      instanceId: record.instanceId
    }, record)
    this.#publishHost('plugin_suspended', {
      pluginId: record.pluginId,
      instanceId: record.instanceId
    })
    this.options.onPluginSuspend?.(record.pluginId, record.instanceId)
    console.info(`插件实例已休眠挂起: pluginId=${record.pluginId}, instanceId=${record.instanceId}`)
  }

  #resumeRecord(record: PluginWindowRecord): void {
    this.#cancelSuspendTimer(record)
    if (record.state === 'suspended') {
      record.state = 'ready'
      const webContents = record.window.webContents as unknown as {
        setAudioMuted?: (muted: boolean) => void
        setBackgroundThrottling?: (throttling: boolean) => void
      }
      if (typeof webContents.setAudioMuted === 'function') {
        webContents.setAudioMuted(false)
      }
      this.#publishToOwner('plugin_resume', {
        pluginId: record.pluginId,
        instanceId: record.instanceId
      }, record)
      this.#publishHost('plugin_resumed', {
        pluginId: record.pluginId,
        instanceId: record.instanceId
      })
      this.options.onPluginResume?.(record.pluginId, record.instanceId)
      console.info(`插件实例已从休眠恢复: pluginId=${record.pluginId}, instanceId=${record.instanceId}`)
    }
  }

  #handleCrash(
    record: PluginWindowRecord,
    details: { reason: string; exitCode: number }
  ): void {
    console.error(
      `插件渲染进程崩溃: pluginId=${record.pluginId}, instanceId=${record.instanceId}, reason=${details.reason}, exitCode=${details.exitCode}`
    )
    this.#cancelSuspendTimer(record)
    if (record.persistTimer) {
      clearTimeout(record.persistTimer)
      record.persistTimer = undefined
    }
    if (record.enterRetryTimer) {
      clearTimeout(record.enterRetryTimer)
      record.enterRetryTimer = undefined
    }
    this.#resolveLifecycleAcks(record)

    record.state = 'crashed'
    record.visible = false
    record.crashDetails = {
      reason: details.reason,
      exitCode: details.exitCode,
      timestamp: Date.now()
    }

    this.#publishHost('plugin_crashed', {
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      reason: details.reason,
      exitCode: details.exitCode
    })
    this.options.onPluginCrash?.(record.pluginId, record.instanceId, details)
    if (!record.window.isDestroyed()) {
      record.window.destroy()
    }
  }

  #handleClose(record: PluginWindowRecord, event: unknown): void {
    if (record.state === 'destroyed' || record.forceDestroy) return
    if (record.closePending) {
      if (isRecord(event) && typeof event.preventDefault === 'function') event.preventDefault()
      return
    }
    if (isRecord(event) && typeof event.preventDefault === 'function') event.preventDefault()
    void this.#requestGracefulClose(record)
  }

  #announcePendingOpen(record: PluginWindowRecord): void {
    const status = record.pendingOpenStatus
    if (!status) return
    record.pendingOpenStatus = undefined
    this.#emitEnter(record, status)
  }

  #emitEnter(record: PluginWindowRecord, status: 'created' | 'reused'): void {
    if (record.state !== 'ready') return
    record.visible = true
    record.lifecycleOutSent = false
    record.lifecycleOutStatus = undefined
    record.lastOpenStatus = status
    if (record.enterRetryTimer) clearTimeout(record.enterRetryTimer)
    record.enterRetryTimer = undefined
    this.#sendEnter(record, status, 0)
  }

  #sendEnter(record: PluginWindowRecord, status: 'created' | 'reused', attempt: number): void {
    if (record.state !== 'ready' || !record.visible || record.lifecycleOutSent) return
    const delivered = this.#publishToOwner('plugin_enter', {
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      code: 'main',
      type: 'window',
      isKill: false,
      windowInstanceStatus: status,
      ...(record.startupPayload ? { payload: record.startupPayload } : {})
    }, record)
    if (delivered > 0 || attempt >= 10) return
    record.enterRetryTimer = setTimeout(() => {
      record.enterRetryTimer = undefined
      this.#sendEnter(record, status, attempt + 1)
    }, 50)
  }

  async #emitOut(
    record: PluginWindowRecord,
    isKill: boolean,
    status: LifecycleOutStatus
  ): Promise<void> {
    if (!record.opened || record.lifecycleOutStatus === status) {
      await this.#waitForLifecycleAcks(record)
      return
    }
    record.lifecycleOutSent = true
    record.lifecycleOutStatus = status
    record.visible = false
    if (record.enterRetryTimer) clearTimeout(record.enterRetryTimer)
    record.enterRetryTimer = undefined
    if (!this.options.requestExit) return
    const completion = Promise.resolve().then(() => this.options.requestExit!({
      type: 'plugin', webContentsId: record.window.webContents.id,
      pluginId: record.pluginId, pluginInstanceId: record.instanceId
    }, isKill)).then(() => undefined)
    record.outCompletions.add(completion)
    try { await completion } catch {
      console.warn('插件隐藏回调失败', { pluginId: record.pluginId, instanceId: record.instanceId })
    } finally { record.outCompletions.delete(completion) }
  }

  async #waitForLifecycleAcks(record: PluginWindowRecord): Promise<void> {
    while (record.outCompletions.size > 0) {
      await Promise.all([...record.outCompletions])
    }
  }

  #resolveLifecycleAck(lifecycleId: string): void {
    const pending = this.#pendingLifecycleAcks.get(lifecycleId)
    if (!pending) return
    this.#pendingLifecycleAcks.delete(lifecycleId)
    clearTimeout(pending.timer)
    pending.resolve()
  }

  #resolveLifecycleAcks(record: PluginWindowRecord): void {
    for (const [lifecycleId, pending] of this.#pendingLifecycleAcks) {
      if (pending.record === record) this.#resolveLifecycleAck(lifecycleId)
    }
  }

  #publishWindowState(record: PluginWindowRecord, state: 'maximized' | 'normal' | 'minimized'): void {
    if (!record.opened || record.state !== 'ready') return
    this.#saveWindowState(record)
    if (record.lastWindowState === state) return
    record.lastWindowState = state
    this.#publishToOwner('plugin_window_state_changed', {
      pluginId: record.pluginId,
      instanceId: record.instanceId,
      state
    }, record)
  }

  #publishHost(type: string, payload: unknown): void {
    try {
      this.options.events?.publishHost(type, payload)
    } catch (error) {
      console.warn(`发布 ${type} 事件失败:`, error)
    }
  }

  #publishToOwner(type: string, payload: unknown, record: PluginWindowRecord): number {
    try {
      return this.options.events?.publishHostToOwner(type, payload, {
        type: 'plugin',
        webContentsId: record.window.webContents.id,
        pluginId: record.pluginId,
        pluginInstanceId: record.instanceId
      }).delivered ?? 0
    } catch (error) {
      console.warn(`发布 ${type} 事件失败:`, error)
      return 0
    }
  }

  async #readPersistedWindowState(
    manifest: PluginManifest,
    config: NormalizedWindowConfig
  ): Promise<PersistedWindowState | undefined> {
    if (!this.options.state || !config.singleInstance) return undefined
    try {
      const all = await this.options.state.readAll()
      const key = Object.keys(all).find((item) => item.toLowerCase() === manifest.id.toLowerCase())
      const pluginState = key ? all[key] : undefined
      if (!isRecord(pluginState) || !isRecord(pluginState.window)) return undefined
      const windowState = pluginState.window
      const candidate = isRecord(windowState.default) ? windowState.default : windowState
      if (!Number.isInteger(candidate.width) || !Number.isInteger(candidate.height)) return undefined
      const width = Math.max(config.minWidth, Math.min(MAX_WINDOW_DIMENSION, candidate.width as number))
      const height = Math.max(config.minHeight, Math.min(MAX_WINDOW_DIMENSION, candidate.height as number))
      const x = Number.isInteger(candidate.x) && (candidate.x as number) >= -32_768 && (candidate.x as number) <= 32_768
        ? candidate.x as number
        : undefined
      const y = Number.isInteger(candidate.y) && (candidate.y as number) >= -32_768 && (candidate.y as number) <= 32_768
        ? candidate.y as number
        : undefined
      const position = x !== undefined && y !== undefined && this.#positionIsVisible(x, y, width, height)
        ? { x, y }
        : {}
      return {
        width,
        height,
        ...position,
        maximized: candidate.maximized === true
      }
    } catch (error) {
      console.warn(`插件窗口状态读取失败: pluginId=${manifest.id}`, error)
      return undefined
    }
  }

  #positionIsVisible(x: number, y: number, width: number, height: number): boolean {
    try {
      return screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return x < area.x + area.width && x + width > area.x &&
          y < area.y + area.height && y + height > area.y
      })
    } catch {
      return false
    }
  }

  #saveWindowState(record: PluginWindowRecord, immediate = false): void {
    if (!this.options.state || !record.singleInstance || record.state === 'destroyed') return
    if (record.persistTimer) {
      clearTimeout(record.persistTimer)
      record.persistTimer = undefined
    }
    const save = (): void => {
      if (!this.options.state || record.window.isDestroyed()) return
      const bounds = record.window.getNormalBounds()
      // 状态写入可能排队到窗口销毁之后，必须在入队前读取窗口属性。
      const maximized = record.window.isMaximized()
      const write = this.options.state.update(record.pluginId, (state) => {
        const existing = isRecord(state.window) ? { ...state.window } : {}
        existing.default = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized
        }
        state.window = existing
      }).catch((error: unknown) => {
        console.warn(`插件窗口状态保存失败: pluginId=${record.pluginId}`, error)
      })
      this.#pendingStateWrites.add(write)
      void write.finally(() => this.#pendingStateWrites.delete(write))
    }
    if (record.window.isDestroyed()) return
    if (immediate) {
      save()
      return
    }
    record.persistTimer = setTimeout(() => {
      record.persistTimer = undefined
      save()
    }, 250)
  }

  #requireRunning(): void {
    if (this.#stopping) {
      throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    }
  }
}
