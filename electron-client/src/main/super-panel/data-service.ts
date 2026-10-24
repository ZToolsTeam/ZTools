import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ConfigService } from '../services/config-service.js'
import { JsonFileStore, type JsonObject } from '../services/json-file-store.js'
import { inspectMacApplicationBundle, type MacApplicationBundle } from '../platform/macos/local-application.js'
import { PluginStateService, type PluginStateProvider } from '../services/plugin-state-service.js'
import type { SystemToolsListResult, SystemToolsProvider, SystemToolTarget } from '../services/system-tools-service.js'
import { decodeSuperPanelConfig } from './config.js'

const LOCAL_APPS_FILE = 'local_apps.json'
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const LOCAL_APP_ID_PATTERN = /^localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64})$/i
const MAC_LOCAL_APP_ID_PATTERN = /^localapp:mac:[A-F0-9]{64}$/i
const MAX_LOCAL_APP_PATH_LENGTH = 32 * 1024

interface LocalAppBase {
  id: string
  name: string
  arguments: string
  useCount: number
  lastUsedAt: string
}

interface WindowsLocalApp extends LocalAppBase {
  type: 'windows-exe'
  exePath: string
  workingDir: string
  iconPath: string
}

interface MacLocalApp extends LocalAppBase {
  type: 'mac-app-bundle'
  appPath: string
  bundleIdentifier: string
}

type LocalApp = WindowsLocalApp | MacLocalApp

interface SuperPanelDataServiceOptions {
  platform?: NodeJS.Platform
  inspectMacApplicationBundle?: (selectedPath: string, signal?: AbortSignal) => Promise<MacApplicationBundle>
}
const SYSTEM_TOOL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, maximum = 4096): string {
  return typeof value === 'string' && value.length <= maximum ? value : ''
}

function pluginKeywords(manifest: Record<string, unknown>): string[] {
  const values = Array.isArray(manifest.keywords)
    ? manifest.keywords
    : typeof manifest.keyword === 'string'
      ? manifest.keyword.split(/\s+/)
      : []
  return values.filter((item): item is string =>
    typeof item === 'string' && item.trim().length > 0 && item.length <= 128
  ).slice(0, 100)
}

function localAppId(executable: string): string {
  const source = `${executable.trim().replaceAll('/', '\\').toLowerCase()}|`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `localapp:${hash.toString(16).toUpperCase().padStart(8, '0')}`
}

function macLocalAppId(appPath: string): string {
  const digest = createHash('sha256').update(`mac-app-bundle\0${appPath}`, 'utf8').digest('hex').toUpperCase()
  return `localapp:mac:${digest}`
}

function pluginState(document: JsonObject, pluginId: string): Record<string, unknown> {
  const value = document[pluginId]
  return isRecord(value) ? value : {}
}

export interface SuperPanelItem {
  id: string
  type: 'plugin' | 'local' | 'system_tool'
  name: string
  description: string
  iconUrl: string
  keywords: string[]
  pinned: boolean
  recent: boolean
  common: boolean
  target?: string
}

export interface SuperPanelData {
  success: true
  items: SuperPanelItem[]
  shortcuts: Array<{ prefix: string; pluginId: string }>
  defaultTab: 'history' | 'pinned' | 'local' | 'system_tools' | 'all'
}

interface PluginProvider {
  (): Promise<{ success: true; data: Record<string, unknown>[] }>
}

interface OpenPathAdapter {
  (fullPath: string): Promise<string>
}

interface LaunchProcessAdapter {
  (fullPath: string, args: readonly string[], workingDir: string): Promise<string>
}

interface FileIconAdapter {
  (fullPath: string): Promise<string>
}

interface PanelItemEntry {
  item: SuperPanelItem
  useCount: number
  lastUsedAt: string
  lastUsedTimestamp: number | null
  sourceOrder: number
}

function usageCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0
}

function usageTimestamp(value: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function iconDataUrl(value: string): string {
  return value.length <= 512 * 1024 &&
    /^data:image\/(?:bmp|gif|jpeg|png|webp|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : ''
}

function compareRecentUsage(left: PanelItemEntry, right: PanelItemEntry): number {
  if (left.lastUsedTimestamp !== right.lastUsedTimestamp) {
    if (left.lastUsedTimestamp === null) return 1
    if (right.lastUsedTimestamp === null) return -1
    return right.lastUsedTimestamp - left.lastUsedTimestamp
  }
  return left.sourceOrder - right.sourceOrder
}

function compareLocalUsage(left: PanelItemEntry, right: PanelItemEntry): number {
  if (left.useCount !== right.useCount) return right.useCount - left.useCount
  const timestampOrder = right.lastUsedAt.localeCompare(left.lastUsedAt, undefined, { sensitivity: 'base' })
  if (timestampOrder !== 0) return timestampOrder
  const nameOrder = left.item.name.localeCompare(right.item.name, undefined, { sensitivity: 'base' })
  return nameOrder || left.sourceOrder - right.sourceOrder
}

function parseWindowsArguments(value: string): string[] | null {
  if (value.includes('\0')) return null
  const output: string[] = []
  let current = ''
  let started = false
  let quoted = false
  let index = 0
  while (index < value.length) {
    const character = value[index]
    if ((character === ' ' || character === '\t') && !quoted) {
      if (started) {
        output.push(current)
        current = ''
        started = false
      }
      index += 1
      continue
    }
    started = true
    if (character === '\\') {
      let slashCount = 0
      while (value[index + slashCount] === '\\') slashCount += 1
      if (value[index + slashCount] === '"') {
        current += '\\'.repeat(Math.floor(slashCount / 2))
        index += slashCount
        if (slashCount % 2 === 1) {
          current += '"'
          index += 1
        } else if (quoted && value[index + 1] === '"') {
          current += '"'
          index += 2
        } else {
          quoted = !quoted
          index += 1
        }
      } else {
        current += '\\'.repeat(slashCount)
        index += slashCount
      }
      continue
    }
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"'
        index += 2
      } else {
        quoted = !quoted
        index += 1
      }
      continue
    }
    current += character
    index += 1
  }
  if (started) output.push(current)
  return output
}

function launchLocalProcess(
  fullPath: string,
  args: readonly string[],
  workingDir: string
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (message: string) => {
      if (settled) return
      settled = true
      resolve(message)
    }
    try {
      const child = spawn(fullPath, [...args], {
        cwd: workingDir,
        detached: true,
        shell: false,
        stdio: 'ignore'
      })
      child.once('error', (error) => finish(error instanceof Error ? error.message : '启动失败'))
      child.once('spawn', () => {
        child.unref()
        finish('')
      })
    } catch (error) {
      finish(error instanceof Error ? error.message : '启动失败')
    }
  })
}

export class SuperPanelDataService {
  readonly #store: JsonFileStore
  readonly #platform: NodeJS.Platform
  readonly #inspectMacApplicationBundle: (selectedPath: string, signal?: AbortSignal) => Promise<MacApplicationBundle>
  readonly #lifetimeController = new AbortController()
  #stopped = false

  constructor(
    dataRoot: string,
    private readonly config: Pick<ConfigService, 'get' | 'set'>,
    private readonly getPlugins: PluginProvider,
    private readonly openPath: OpenPathAdapter,
    optionsOrState: SuperPanelDataServiceOptions | PluginStateProvider = {},
    private readonly launchProcess: LaunchProcessAdapter = launchLocalProcess,
    private readonly getFileIcon?: FileIconAdapter,
    private readonly systemTools?: SystemToolsProvider
  ) {
    this.#store = new JsonFileStore(dataRoot, new Set([LOCAL_APPS_FILE]))
    const options = 'readAll' in optionsOrState ? {} : optionsOrState
    this.#pluginState = 'readAll' in optionsOrState ? optionsOrState : new PluginStateService(dataRoot)
    this.#platform = options.platform ?? process.platform
    this.#inspectMacApplicationBundle = options.inspectMacApplicationBundle ?? inspectMacApplicationBundle

  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#lifetimeController.abort()
  }

  readonly #pluginState: PluginStateProvider

  async getData(): Promise<SuperPanelData> {
    const [configuration, state, localDocument, pluginResult, systemTools] = await Promise.all([
      this.#readConfiguration(),
      this.#pluginState.readAll(),
      this.#store.read(LOCAL_APPS_FILE),
      this.getPlugins(),
      this.#readSystemTools()
    ])
    const pinnedLocalApps = new Set(configuration.pinnedLocalApps)
    const pluginItems: PanelItemEntry[] = []
    for (const manifest of pluginResult.data.slice(0, 1000)) {
      const id = stringValue(manifest.id, 128)
      const name = stringValue(manifest.name, 256)
      if (!PLUGIN_ID_PATTERN.test(id) || !name) continue
      const currentState = pluginState(state, id)
      const enabled = typeof currentState.enabled === 'boolean'
        ? currentState.enabled
        : manifest.enabled !== false
      if (!enabled) continue
      const pinned = currentState.pinned === true
      const lastUsedAt = stringValue(currentState.last_used_at, 128)
      const recent = lastUsedAt !== ''
      const iconUrl = stringValue(currentState.icon_url, 32 * 1024)
      pluginItems.push({
        item: {
          id,
          type: 'plugin',
          name,
          description: stringValue(manifest.description, 2048),
          iconUrl,
          keywords: pluginKeywords(manifest),
          pinned,
          recent,
          common: pinned || recent
        },
        useCount: usageCount(currentState.use_count),
        lastUsedAt,
        lastUsedTimestamp: usageTimestamp(lastUsedAt),
        sourceOrder: pluginItems.length
      })
    }
    const localItems: PanelItemEntry[] = await Promise.all(this.#readLocalApps(localDocument).map(async (app, sourceOrder) => {
      const pinned = pinnedLocalApps.has(app.id)
      const recent = app.useCount > 0
      return {
        item: {
          id: app.id,
          type: 'local',
          name: app.name,
          description: app.type === 'mac-app-bundle' ? app.appPath : app.exePath,
          iconUrl: app.type === 'windows-exe' ? await this.#readLocalIcon(app) : '',
          keywords: [],
          pinned,
          recent,
          common: pinned || recent
        },
        useCount: app.useCount,
        lastUsedAt: app.lastUsedAt,
        lastUsedTimestamp: usageTimestamp(app.lastUsedAt),
        sourceOrder
      }
    }))
    localItems.sort(compareLocalUsage)
    const recentLimit = configuration.maxRecentCount
    const orderedPlugins = [
      ...pluginItems.filter(({ item }) => item.pinned),
      ...pluginItems
        .filter(({ item, lastUsedTimestamp }) => !item.pinned && lastUsedTimestamp !== null)
        .sort(compareRecentUsage)
        .slice(0, recentLimit),
      ...pluginItems.filter(({ item, lastUsedTimestamp }) => !item.pinned && lastUsedTimestamp === null)
    ].map(({ item }) => item)
    return {
      success: true,
      items: [...orderedPlugins, ...localItems.map(({ item }) => item), ...systemTools],
      shortcuts: configuration.shortcuts,
      defaultTab: configuration.defaultTab
    }
  }

  async getPanelLocalApps(): Promise<Array<{ id: string; name: string }>> {
    const document = await this.#store.read(LOCAL_APPS_FILE)
    return this.#readLocalApps(document)
      .filter((app): app is WindowsLocalApp => app.type === 'windows-exe')
      .map(({ id, name }) => ({ id, name }))
  }

  async togglePin(id: string, itemType: string): Promise<boolean> {
    if (itemType === 'local') {
      if (!LOCAL_APP_ID_PATTERN.test(id)) throw new Error('本地软件 ID 无效')
      const raw = await this.config.get('user_settings.json', 'super_panel', {})
      let source: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) source = parsed
      } catch {
        // A damaged group is replaced by the validated defaults below.
      }
      const configuration = decodeSuperPanelConfig(JSON.stringify(source))
      const pinned = new Set(configuration.pinnedLocalApps)
      const nextPinned = !pinned.has(id)
      if (nextPinned) pinned.add(id)
      else pinned.delete(id)
      source.pinnedLocalApps = [...pinned]
      await this.config.set('user_settings.json', 'super_panel', JSON.stringify(source), false)
      return nextPinned
    }
    if (itemType !== 'plugin' || !PLUGIN_ID_PATTERN.test(id)) throw new Error('插件 ID 无效')
    let pinned = false
    await this.#pluginState.update(id, (current) => {
      pinned = current.pinned !== true
      current.pinned = pinned
      current.updated_at = new Date().toISOString()
    })
    return pinned
  }

  async addLocalApps(paths: readonly string[]): Promise<number> {
    this.#assertActive()
    const additions: Array<Record<string, unknown>> = []
    for (const selected of paths.slice(0, 32)) {
      this.#assertActive()
      if (this.#platform === 'darwin') {
        let application: MacApplicationBundle
        try {
          application = await this.#inspectMacApplicationBundle(selected, this.#lifetimeController.signal)
        } catch {
          this.#assertActive()
          continue
        }
        this.#assertActive()
        if (
          application.appPath.length > MAX_LOCAL_APP_PATH_LENGTH ||
          !path.posix.isAbsolute(application.appPath) ||
          path.posix.normalize(application.appPath) !== application.appPath ||
          path.posix.extname(application.appPath).toLowerCase() !== '.app' ||
          !isBundleIdentifier(application.bundleIdentifier)
        ) continue
        const name = path.posix.basename(application.appPath).replace(/\.app$/i, '')
        if (!name || name.length > 256) continue
        additions.push({
          id: macLocalAppId(application.appPath),
          type: 'mac-app-bundle',
          name,
          appPath: application.appPath,
          bundleIdentifier: application.bundleIdentifier,
          source: 'manual',
          panelEnabled: true,
          useCount: 0,
          lastUsedAt: '',
          addedAt: new Date().toISOString()
        })
      } else {
        if (!path.isAbsolute(selected) || selected.includes('\0') || path.extname(selected).toLowerCase() !== '.exe') continue
        const realPath = await fs.realpath(selected).catch(() => '')
        this.#assertActive()
        if (!realPath || path.extname(realPath).toLowerCase() !== '.exe') continue
        const stat = await fs.lstat(realPath).catch(() => undefined)
        this.#assertActive()
        if (!stat?.isFile() || stat.isSymbolicLink()) continue
        additions.push({
          id: localAppId(realPath),
          name: path.basename(realPath, path.extname(realPath)),
          exePath: realPath,
          arguments: '',
          workingDir: path.dirname(realPath),
          iconPath: realPath,
          publisher: '',
          version: '',
          source: 'manual',
          panelEnabled: true,
          useCount: 0,
          lastUsedAt: '',
          addedAt: new Date().toISOString()
        })
      }
    }
    if (additions.length === 0) return 0
    this.#assertActive()
    let added = 0
    await this.#store.update(LOCAL_APPS_FILE, (document) => {
      this.#assertActive()
      const apps: unknown[] = Array.isArray(document.apps) ? document.apps : []
      const indexes = new Map<string, number>()
      apps.slice(0, 1000).forEach((item, index) => {
        if (isRecord(item) && typeof item.id === 'string') indexes.set(item.id.toLowerCase(), index)
      })
      for (const addition of additions) {
        const id = addition.id as string
        const existingIndex = indexes.get(id.toLowerCase())
        if (existingIndex === undefined) {
          if (apps.length >= 1000) continue
          indexes.set(id.toLowerCase(), apps.length)
          apps.push(addition)
          added += 1
        } else {
          const existing = apps[existingIndex]
          if (!isRecord(existing)) continue
          if (
            addition.type === 'mac-app-bundle' &&
            (existing.type !== 'mac-app-bundle' || existing.appPath !== addition.appPath)
          ) {
            throw new Error('本地软件 ID 冲突，拒绝覆盖已有应用')
          }
          apps[existingIndex] = { ...existing, ...addition, panelEnabled: true }
        }
      }
      document.apps = apps
    })
    this.#assertActive()
    return added
  }

  async launchLocalApp(id: string): Promise<void> {
    this.#assertActive()
    if (!LOCAL_APP_ID_PATTERN.test(id)) throw new Error('本地软件 ID 无效')
    const document = await this.#store.read(LOCAL_APPS_FILE)
    this.#assertActive()
    const app = this.#readLocalApps(document).find((item) => item.id.toLowerCase() === id.toLowerCase())
    if (!app) throw new Error('本地软件不存在或不受当前平台支持')
    if (app.type === 'mac-app-bundle') {
      const application = await this.#inspectMacApplicationBundle(app.appPath, this.#lifetimeController.signal)
      this.#assertActive()
      if (application.appPath !== app.appPath || application.bundleIdentifier !== app.bundleIdentifier) {
        throw new Error('macOS 应用身份已变化')
      }
      this.#assertActive()
      const result = await this.openPath(application.appPath)
      this.#assertActive()
      if (result !== '') throw new Error(result)
      await this.#incrementLocalAppUsage(id)
      return
    }
    const args = parseWindowsArguments(app.arguments)
    if (!args) throw new Error('本地软件参数无效')
    const realPath = await fs.realpath(app.exePath).catch(() => '')
    this.#assertActive()
    if (!realPath || path.extname(realPath).toLowerCase() !== '.exe') throw new Error('本地软件路径无效')
    this.#assertActive()
    let workingDir = path.dirname(realPath)
    if (app.workingDir) {
      const candidate = await fs.realpath(app.workingDir).catch(() => '')
      const stats = candidate ? await fs.stat(candidate).catch(() => undefined) : undefined
      if (stats?.isDirectory()) workingDir = candidate
    }
    this.#assertActive()
    const result = args.length === 0
      ? await this.openPath(realPath)
      : await this.launchProcess(realPath, args, workingDir)
    this.#assertActive()
    if (result !== '') throw new Error(result)
    await this.#incrementLocalAppUsage(id)
  }

  async #incrementLocalAppUsage(id: string): Promise<void> {
    this.#assertActive()
    await this.#store.update(LOCAL_APPS_FILE, (nextDocument) => {
      this.#assertActive()
      if (!Array.isArray(nextDocument.apps)) return
      const target = nextDocument.apps.find((item) =>
        isRecord(item) && typeof item.id === 'string' && item.id.toLowerCase() === id.toLowerCase()
      )
      if (!isRecord(target)) return
      const useCount = usageCount(target.useCount)
      target.useCount = Math.min(useCount + 1, Number.MAX_SAFE_INTEGER)
      target.lastUsedAt = new Date().toISOString()
    })
    this.#assertActive()
  }

  #assertActive(): void {
    if (this.#stopped) throw new Error('超级面板数据服务已停止')
  }

  async markPluginUsed(id: string): Promise<void> {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('插件 ID 无效')
    await this.#pluginState.markUsed(id)
  }

  async #readSystemTools(): Promise<SuperPanelItem[]> {
    if (!this.systemTools) return []
    let response: SystemToolsListResult
    try {
      response = await this.systemTools.listTargets()
    } catch {
      return []
    }
    if (response.success !== true || !Array.isArray(response.targets)) return []
    return Promise.all(response.targets.slice(0, 256).map(async (target) => {
      const item = this.#systemToolItem(target)
      if (!item) return undefined
      let iconUrl = ''
      try {
        iconUrl = iconDataUrl(await this.systemTools?.getIcon?.(item.target ?? '') ?? '')
      } catch {
        // A missing shell icon must not hide an otherwise valid system target.
      }
      return { ...item, iconUrl }
    })).then((items) => items.filter((item): item is SuperPanelItem => item !== undefined))
  }

  #systemToolItem(target: SystemToolTarget): SuperPanelItem | undefined {
    const id = stringValue(target.id, 64)
    const name = stringValue(target.name, 256)
    if (!SYSTEM_TOOL_ID_PATTERN.test(id) || !name) return undefined
    const category = stringValue(target.category, 64)
    const keywords = ['系统工具', ...systemToolCategoryKeywords(category)]
    if (id === 'this_pc') keywords.push('我的电脑 计算机')
    else if (id === 'settings') keywords.push('电脑设置 Windows设置 设置中心')
    else if (id === 'powershell') keywords.push('PowerShell 命令行 终端')
    else if (id === 'registry_editor') keywords.push('注册表 regedit')
    else if (id === 'control_panel') keywords.push('控制面板 control')
    return {
      id: `system-tool:${id}`,
      target: id,
      type: 'system_tool',
      name,
      description: stringValue(target.description, 2048),
      iconUrl: '',
      keywords,
      pinned: false,
      recent: false,
      common: false
    }
  }

  async #readLocalIcon(app: { exePath: string; iconPath: string }): Promise<string> {
    if (!this.getFileIcon) return ''
    const source = app.iconPath || app.exePath
    const realPath = await fs.realpath(source).catch(() => '')
    if (!realPath) return ''
    const stat = await fs.lstat(realPath).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink()) return ''
    try {
      return iconDataUrl(await this.getFileIcon(realPath))
    } catch {
      return ''
    }
  }

  async #readConfiguration() {
    const raw = await this.config.get('user_settings.json', 'super_panel', {})
    return decodeSuperPanelConfig(raw)
  }

  #readLocalApps(document: JsonObject): LocalApp[] {
    if (!Array.isArray(document.apps)) return []
    const output: LocalApp[] = []
    for (const value of document.apps.slice(0, 1000)) {
      if (!isRecord(value) || value.panelEnabled === false) continue
      const id = stringValue(value.id, 128)
      const name = stringValue(value.name, 256)
      const useCount = Number.isSafeInteger(value.useCount) && (value.useCount as number) >= 0
        ? value.useCount as number
        : 0
      if (
        this.#platform === 'darwin' &&
        value.type === 'mac-app-bundle' &&
        MAC_LOCAL_APP_ID_PATTERN.test(id)
      ) {
        const appPath = stringValue(value.appPath, MAX_LOCAL_APP_PATH_LENGTH)
        const bundleIdentifier = stringValue(value.bundleIdentifier, 255)
        if (
          !name ||
          !path.posix.isAbsolute(appPath) ||
          path.posix.normalize(appPath) !== appPath ||
          path.posix.extname(appPath).toLowerCase() !== '.app' ||
          id.toLowerCase() !== macLocalAppId(appPath).toLowerCase() ||
          !isBundleIdentifier(bundleIdentifier) ||
          value.arguments !== undefined
        ) continue
        output.push({
          id,
          name,
          type: 'mac-app-bundle',
          appPath,
          bundleIdentifier,
          arguments: '',
          lastUsedAt: stringValue(value.lastUsedAt, 128),
          useCount
        })
        continue
      }

      const isLegacyWindowsApp = value.type === undefined
      if (
        this.#platform === 'win32' &&
        (value.type === 'windows-exe' || isLegacyWindowsApp) &&
        LOCAL_APP_ID_PATTERN.test(id) &&
        !MAC_LOCAL_APP_ID_PATTERN.test(id)
      ) {
        const exePath = stringValue(value.exePath, MAX_LOCAL_APP_PATH_LENGTH)
        if (!name || !path.isAbsolute(exePath)) continue
        output.push({
          id,
          name,
          type: 'windows-exe',
          exePath,
          workingDir: path.isAbsolute(stringValue(value.workingDir, MAX_LOCAL_APP_PATH_LENGTH)) ? stringValue(value.workingDir, MAX_LOCAL_APP_PATH_LENGTH) : '',
          iconPath: path.isAbsolute(stringValue(value.iconPath, MAX_LOCAL_APP_PATH_LENGTH)) ? stringValue(value.iconPath, MAX_LOCAL_APP_PATH_LENGTH) : exePath,
          lastUsedAt: stringValue(value.lastUsedAt, 128),
          arguments: stringValue(value.arguments, 4096),
          useCount
        })
      }
    }
    return output
  }
}

function isBundleIdentifier(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
}

function systemToolCategoryKeywords(category: string): string[] {
  if (category === 'core') return ['常用 核心']
  if (category === 'terminal') return ['终端 命令行']
  if (category === 'management') return ['管理工具 管理控制台']
  if (category === 'system') return ['系统 系统属性']
  if (category === 'network') return ['网络']
  if (category === 'hardware') return ['硬件']
  if (category === 'settings') return ['设置 系统设置']
  return category ? [category] : []
}
