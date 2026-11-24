import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { ConfigService } from '../services/config-service.js'
import type { JsonObject } from '../services/json-file-store.js'
import { PluginStateService, type PluginStateProvider } from '../services/plugin-state-service.js'
import type { SystemToolsListResult, SystemToolsProvider, SystemToolTarget } from '../services/system-tools-service.js'
import { t } from '../i18n/index.js'
import {
  getAllPluginSearchKeywords,
  getLocalizedPluginDescription,
  getLocalizedPluginName,
  getPluginAltNames
} from '../i18n/plugin-i18n.js'
import {
  CURRENT_PINNED_SCHEMA_VERSION,
  MAX_PINNED_ENTRIES,
  PLUGIN_ID_PATTERN,
  SYSTEM_TOOL_ID_PATTERN,
  parsePinnedEntry,
  parseSuperPanelConfig,
  resolvePinKey,
  type PinnedEntry,
  type SuperPanelConfig
} from './config.js'

const FILE_CHECK_CONCURRENCY = 8
const MAX_FILE_ICON_CACHE = 512
const MAX_PIN_KEY_LENGTH = 32_800

export interface SuperPanelDataServiceOptions {
  platform?: NodeJS.Platform
  pluginState?: PluginStateProvider
  resolveAuthorizedReadPath?: (rawPath: string, caller?: CallerIdentity) => Promise<string>
  revealPath?: (fullPath: string) => void | Promise<void>
  readMacosApplicationIcon?: (appPath: string) => Promise<string>
  onChanged?: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, maximum = 4096): string {
  return typeof value === 'string' && value.length <= maximum ? value : ''
}

function normalizeAltNames(raw: unknown, primaryName: string): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0 || trimmed.length > 128 || trimmed === primaryName || seen.has(trimmed)) {
      continue
    }
    seen.add(trimmed)
    result.push(trimmed)
    if (result.length >= 32) break
  }
  return result
}

function pluginState(document: JsonObject, pluginId: string): Record<string, unknown> {
  const value = document[pluginId]
  return isRecord(value) ? value : {}
}

export interface SuperPanelItem {
  id: string
  type: 'plugin' | 'system_tool'
  name: string
  description: string
  iconUrl: string
  keywords: string[]
  altNames?: string[]
  pinned: boolean
  recent: boolean
  common: boolean
  target?: string
}

export interface ResolvedPinnedEntry {
  pinKey: string
  entry: PinnedEntry
  available: boolean
  iconUrl?: string
}

export interface SuperPanelData {
  success: true
  items: SuperPanelItem[]
  pinnedEntries: ResolvedPinnedEntry[]
}

export interface SetPinResult {
  success: true
  pinned: boolean
  pinKey: string
  pinnedEntries: ResolvedPinnedEntry[]
}

export type ReorderPinsResult =
  | { success: true; pinnedEntries: ResolvedPinnedEntry[] }
  | { success: false; stale: true; error: string; pinnedEntries: ResolvedPinnedEntry[] }

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex
        nextIndex += 1
        results[currentIndex] = await worker(items[currentIndex]!, currentIndex)
      }
    })
  )
  return results
}

/** 悬浮条展示的最近使用插件条数（原超级面板可配，现固定为默认值） */
const RECENT_PLUGIN_LIMIT = 10

interface PluginProvider {
  (): Promise<{ success: true; data: Record<string, unknown>[] }>
}

interface OpenPathAdapter {
  (fullPath: string): Promise<string>
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

interface LoadedSuperPanelState {
  source: Record<string, unknown>
  config: SuperPanelConfig
}

export class SuperPanelDataService {
  readonly #platform: NodeJS.Platform
  readonly #resolveAuthorizedReadPath: ((rawPath: string, caller?: CallerIdentity) => Promise<string>) | undefined
  readonly #revealPath: ((fullPath: string) => void | Promise<void>) | undefined
  readonly #readMacosApplicationIcon: ((appPath: string) => Promise<string>) | undefined
  readonly #onChanged: (() => void) | undefined
  readonly #fileIconCache = new Map<string, string>()
  #configWriteQueue: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(
    dataRoot: string,
    private readonly config: Pick<ConfigService, 'get' | 'set'>,
    private readonly getPlugins: PluginProvider,
    private readonly openPath: OpenPathAdapter,
    optionsOrState: SuperPanelDataServiceOptions | PluginStateProvider = {},
    private readonly getFileIcon?: FileIconAdapter,
    private readonly systemTools?: SystemToolsProvider,
    extraOptions?: SuperPanelDataServiceOptions
  ) {
    const hasProvider = 'readAll' in optionsOrState
    const options: SuperPanelDataServiceOptions = hasProvider
      ? (extraOptions ?? {})
      : { ...optionsOrState, ...extraOptions }
    this.#pluginState = hasProvider
      ? optionsOrState
      : (options.pluginState ?? new PluginStateService(dataRoot))
    this.#platform = options.platform ?? process.platform
    this.#resolveAuthorizedReadPath = options.resolveAuthorizedReadPath
    this.#revealPath = options.revealPath
    this.#readMacosApplicationIcon = options.readMacosApplicationIcon
    this.#onChanged = options.onChanged
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#fileIconCache.clear()
  }

  readonly #pluginState: PluginStateProvider

  async getData(): Promise<SuperPanelData> {
    const [configuration, state, pluginResult, systemTools] = await Promise.all([
      this.#ensureMigratedConfiguration(),
      this.#pluginState.readAll(),
      this.getPlugins(),
      this.#readSystemTools()
    ])
    const pinnedPluginIds = new Set<string>()
    for (const entry of configuration.pinnedEntries) {
      if (entry.kind === 'plugin') pinnedPluginIds.add(entry.pluginId)
    }
    const pluginItems: PanelItemEntry[] = []
    for (const manifest of pluginResult.data.slice(0, 1000)) {
      const id = stringValue(manifest.id, 128)
      const baseName = stringValue(manifest.name, 256)
      if (!PLUGIN_ID_PATTERN.test(id) || !baseName) continue
      const localizedName = stringValue(getLocalizedPluginName(manifest), 256) || baseName
      const localizedDescription = stringValue(getLocalizedPluginDescription(manifest), 2048)
      const altNames = getPluginAltNames(manifest)
      const currentState = pluginState(state, id)
      const enabled = typeof currentState.enabled === 'boolean'
        ? currentState.enabled
        : manifest.enabled !== false
      if (!enabled) continue
      const pinned = pinnedPluginIds.has(id)
      const lastUsedAt = stringValue(currentState.last_used_at, 128)
      const recent = lastUsedAt !== ''
      const iconUrl = stringValue(currentState.icon_url, 32 * 1024)
      pluginItems.push({
        item: {
          id,
          type: 'plugin',
          name: localizedName,
          description: localizedDescription,
          iconUrl,
          keywords: getAllPluginSearchKeywords(manifest),
          ...(altNames.length > 0 ? { altNames } : {}),
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
    const recentLimit = RECENT_PLUGIN_LIMIT
    const orderedPlugins = [
      ...pluginItems.filter(({ item }) => item.pinned),
      ...pluginItems
        .filter(({ item, lastUsedTimestamp }) => !item.pinned && lastUsedTimestamp !== null)
        .sort(compareRecentUsage)
        .slice(0, recentLimit),
      ...pluginItems.filter(({ item, lastUsedTimestamp }) => !item.pinned && lastUsedTimestamp === null)
    ].map(({ item }) => item)
    const pinnedEntries = await this.#resolvePinnedEntries(configuration.pinnedEntries)
    return {
      success: true,
      items: [...orderedPlugins, ...systemTools],
      pinnedEntries
    }
  }

  async setPin(entryInput: unknown, pinned: unknown, caller?: CallerIdentity): Promise<SetPinResult> {
    this.#assertActive()
    if (typeof pinned !== 'boolean') {
      throw new Error(t('superPanel.error.pinnedMustBeBoolean'))
    }
    const parsedEntry = parsePinnedEntry(entryInput, this.#platform)
    if (!parsedEntry) {
      throw new Error(t('superPanel.error.invalidPinEntry'))
    }

    let targetEntry: PinnedEntry = parsedEntry
    if (pinned && parsedEntry.kind === 'file') {
      targetEntry = await this.#authorizeAndNormalizePinnedFile(parsedEntry, caller)
    }

    return this.#enqueueConfigWrite(async () => {
      const state = await this.#loadMigratedStateInLock()
      return this.#applySetPinInLock(state, targetEntry, pinned)
    })
  }

  async reorderPins(order: unknown): Promise<ReorderPinsResult> {
    this.#assertActive()
    if (!Array.isArray(order) || order.length > MAX_PINNED_ENTRIES) {
      throw new Error(t('superPanel.error.invalidPinOrder'))
    }
    const normalizedOrder: string[] = []
    const seen = new Set<string>()
    for (const item of order) {
      if (typeof item !== 'string' || item.length === 0 || item.length > MAX_PIN_KEY_LENGTH || item.includes('\0')) {
        throw new Error(t('superPanel.error.invalidPinOrder'))
      }
      if (seen.has(item)) {
        throw new Error(t('superPanel.error.duplicatePinOrder'))
      }
      seen.add(item)
      normalizedOrder.push(item)
    }

    return this.#enqueueConfigWrite(async () => {
      const state = await this.#loadMigratedStateInLock()
      const currentEntries = state.config.pinnedEntries
      const entryByKey = new Map<string, PinnedEntry>()
      for (const entry of currentEntries) {
        entryByKey.set(resolvePinKey(entry, this.#platform), entry)
      }

      const matchesSet =
        normalizedOrder.length === entryByKey.size &&
        normalizedOrder.every((key) => entryByKey.has(key))

      if (!matchesSet) {
        return {
          success: false,
          stale: true,
          error: t('superPanel.error.pinListStale'),
          pinnedEntries: await this.#resolvePinnedEntries(currentEntries)
        }
      }

      const nextEntries = normalizedOrder.map((key) => entryByKey.get(key)!)
      const nextSource: Record<string, unknown> = {
        ...state.source,
        pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
        pinnedEntries: nextEntries
      }
      delete nextSource.pinnedLocalApps
      await this.config.set('user_settings.json', 'super_panel', JSON.stringify(nextSource), false)
      this.#notifyChanged()
      return {
        success: true,
        pinnedEntries: await this.#resolvePinnedEntries(nextEntries)
      }
    })
  }

  async togglePin(id: string, itemType: string): Promise<boolean> {
    this.#assertActive()
    if (itemType !== 'plugin') {
      throw new Error(t('superPanel.error.unsupportedItemType'))
    }
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(t('superPanel.error.invalidPluginId'))
    const entry: PinnedEntry = { kind: 'plugin', pluginId: id }

    return this.#enqueueConfigWrite(async () => {
      const state = await this.#loadMigratedStateInLock()
      const pinKey = resolvePinKey(entry, this.#platform)
      const currentlyPinned = state.config.pinnedEntries.some(
        (item) => resolvePinKey(item, this.#platform) === pinKey
      )
      const nextPinned = !currentlyPinned
      await this.#applySetPinInLock(state, entry, nextPinned)
      return nextPinned
    })
  }

  async openPinnedFile(pinKey: string, action: 'open' | 'reveal' = 'open'): Promise<void> {
    this.#assertActive()
    if (
      typeof pinKey !== 'string' ||
      !pinKey.startsWith('file:') ||
      pinKey.length > MAX_PIN_KEY_LENGTH ||
      pinKey.includes('\0')
    ) {
      throw new Error(t('superPanel.error.pinTargetInvalid'))
    }
    if (action !== 'open' && action !== 'reveal') {
      throw new Error(t('superPanel.error.invalidOpenAction'))
    }

    const configuration = await this.#ensureMigratedConfiguration()
    this.#assertActive()
    const targetEntry = configuration.pinnedEntries.find(
      (entry): entry is Extract<PinnedEntry, { kind: 'file' }> =>
        entry.kind === 'file' && resolvePinKey(entry, this.#platform) === pinKey
    )
    if (!targetEntry) {
      throw new Error(t('superPanel.error.pinTargetInvalid'))
    }

    const lstatResult = await fs.lstat(targetEntry.path).catch(() => undefined)
    this.#assertActive()
    if (!lstatResult || lstatResult.isSymbolicLink()) {
      throw new Error(t('superPanel.error.pinTargetInvalid'))
    }
    const realPath = await fs.realpath(targetEntry.path).catch(() => '')
    this.#assertActive()
    if (!realPath) {
      throw new Error(t('superPanel.error.pinTargetInvalid'))
    }
    const realStat = await fs.lstat(realPath).catch(() => undefined)
    this.#assertActive()
    if (!realStat || realStat.isSymbolicLink() || (!realStat.isFile() && !realStat.isDirectory())) {
      throw new Error(t('superPanel.error.pinTargetInvalid'))
    }

    if (action === 'reveal') {
      if (realStat.isDirectory()) {
        const result = await this.openPath(realPath)
        if (result !== '') throw new Error(result)
        return
      }
      if (!this.#revealPath) {
        throw new Error(t('superPanel.error.revealUnavailable'))
      }
      await this.#revealPath(realPath)
      return
    }

    const result = await this.openPath(realPath)
    if (result !== '') throw new Error(result)
  }

  #assertActive(): void {
    if (this.#stopped) throw new Error(t('superPanel.error.dataServiceStopped'))
  }

  async markPluginUsed(id: string): Promise<void> {
    if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(t('superPanel.error.invalidPluginId'))
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
    const altNames = normalizeAltNames(target.altNames, name)
    const keywords = [t('systemTools.category.root'), ...systemToolCategoryKeywords(category)]
    if (id === 'this_pc') keywords.push(t('systemTools.aliases.this_pc'))
    else if (id === 'settings') keywords.push(t('systemTools.aliases.settings'))
    else if (id === 'powershell') keywords.push(t('systemTools.aliases.powershell'))
    else if (id === 'registry_editor') keywords.push(t('systemTools.aliases.registry_editor'))
    else if (id === 'control_panel') keywords.push(t('systemTools.aliases.control_panel'))
    for (const alt of altNames) {
      if (!keywords.includes(alt)) keywords.push(alt)
    }
    return {
      id: `system-tool:${id}`,
      target: id,
      type: 'system_tool',
      name,
      description: stringValue(target.description, 2048),
      iconUrl: '',
      keywords,
      ...(altNames.length > 0 ? { altNames } : {}),
      pinned: false,
      recent: false,
      common: false
    }
  }

  #enqueueConfigWrite<T>(task: () => Promise<T>): Promise<T> {
    this.#assertActive()
    const next = this.#configWriteQueue.then(async () => {
      this.#assertActive()
      return task()
    })
    this.#configWriteQueue = next.then(() => undefined, () => undefined)
    return next
  }

  async #readRawSuperPanelState(): Promise<LoadedSuperPanelState> {
    const raw = await this.config.get('user_settings.json', 'super_panel', {})
    let source: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isRecord(parsed)) source = parsed
    } catch {
      // 损坏的 super_panel 分组由 parseSuperPanelConfig 安全回退为默认值
    }
    return {
      source,
      config: parseSuperPanelConfig(source, this.#platform)
    }
  }

  async #ensureMigratedConfiguration(): Promise<SuperPanelConfig> {
    const loaded = await this.#readRawSuperPanelState()
    if (loaded.config.pinnedSchemaVersion === CURRENT_PINNED_SCHEMA_VERSION) {
      return loaded.config
    }
    const migrated = await this.#enqueueConfigWrite(() => this.#loadMigratedStateInLock())
    return migrated.config
  }

  async #loadMigratedStateInLock(): Promise<LoadedSuperPanelState> {
    const loaded = await this.#readRawSuperPanelState()
    if (loaded.config.pinnedSchemaVersion === CURRENT_PINNED_SCHEMA_VERSION) {
      return loaded
    }

    const pluginDoc = await this.#pluginState.readAll()
    const candidates: PinnedEntry[] = []
    for (const [pluginId, rawState] of Object.entries(pluginDoc)) {
      if (
        isRecord(rawState) &&
        rawState.pinned === true &&
        PLUGIN_ID_PATTERN.test(pluginId)
      ) {
        candidates.push({ kind: 'plugin', pluginId })
      }
    }
    for (const entry of loaded.config.pinnedEntries) {
      candidates.push(entry)
    }

    const mergedEntries: PinnedEntry[] = []
    const seenKeys = new Set<string>()
    for (const entry of candidates) {
      const key = resolvePinKey(entry, this.#platform)
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      mergedEntries.push(entry)
      if (mergedEntries.length >= MAX_PINNED_ENTRIES) break
    }

    const nextSource: Record<string, unknown> = {
      ...loaded.source,
      pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
      pinnedEntries: mergedEntries
    }
    delete nextSource.pinnedLocalApps
    await this.config.set('user_settings.json', 'super_panel', JSON.stringify(nextSource), false)
    return {
      source: nextSource,
      config: {
        pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
        pinnedEntries: mergedEntries
      }
    }
  }

  async #authorizeAndNormalizePinnedFile(
    entry: Extract<PinnedEntry, { kind: 'file' }>,
    caller?: CallerIdentity
  ): Promise<Extract<PinnedEntry, { kind: 'file' }>> {
    if (!this.#resolveAuthorizedReadPath) {
      throw new Error(t('superPanel.error.readAuthorizerMissing'))
    }
    const authorizedPath = await this.#resolveAuthorizedReadPath(entry.path, caller)
    this.#assertActive()
    const inputStat = await fs.lstat(entry.path).catch(() => undefined)
    this.#assertActive()
    if (!inputStat || inputStat.isSymbolicLink()) {
      throw new Error(t('superPanel.error.symlinkOrInvalidPath'))
    }
    const realPath = await fs.realpath(authorizedPath).catch(() => '')
    this.#assertActive()
    if (!realPath) {
      throw new Error(t('superPanel.error.targetNotFound'))
    }
    const realStat = await fs.lstat(realPath).catch(() => undefined)
    this.#assertActive()
    if (!realStat || realStat.isSymbolicLink() || (!realStat.isFile() && !realStat.isDirectory())) {
      throw new Error(t('superPanel.error.targetNotRegularFileOrDir'))
    }
    return { ...entry, path: realPath }
  }

  async #applySetPinInLock(
    state: LoadedSuperPanelState,
    entry: PinnedEntry,
    pinned: boolean
  ): Promise<SetPinResult> {
    const pinKey = resolvePinKey(entry, this.#platform)
    const currentEntries = state.config.pinnedEntries
    const exists = currentEntries.some((item) => resolvePinKey(item, this.#platform) === pinKey)

    if (pinned) {
      if (exists) {
        return {
          success: true,
          pinned: true,
          pinKey,
          pinnedEntries: await this.#resolvePinnedEntries(currentEntries)
        }
      }
      if (currentEntries.length >= MAX_PINNED_ENTRIES) {
        throw new Error(t('superPanel.error.pinLimitReached'))
      }
      const nextEntries = [...currentEntries, entry]
      const nextSource: Record<string, unknown> = {
        ...state.source,
        pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
        pinnedEntries: nextEntries
      }
      delete nextSource.pinnedLocalApps
      await this.config.set('user_settings.json', 'super_panel', JSON.stringify(nextSource), false)
      if (entry.kind === 'plugin') {
        await this.#pluginState.update(entry.pluginId, (current) => {
          current.pinned = true
          current.updated_at = new Date().toISOString()
        })
      }
      this.#notifyChanged()
      return {
        success: true,
        pinned: true,
        pinKey,
        pinnedEntries: await this.#resolvePinnedEntries(nextEntries)
      }
    }

    const nextEntries = currentEntries.filter((item) => resolvePinKey(item, this.#platform) !== pinKey)
    const removed = nextEntries.length !== currentEntries.length
    const nextSource: Record<string, unknown> = {
      ...state.source,
      pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
      pinnedEntries: nextEntries
    }
    delete nextSource.pinnedLocalApps
    if (removed) {
      await this.config.set('user_settings.json', 'super_panel', JSON.stringify(nextSource), false)
    }
    if (entry.kind === 'plugin' && removed) {
      await this.#pluginState.update(entry.pluginId, (current) => {
        current.pinned = false
        current.updated_at = new Date().toISOString()
      })
    }
    if (removed) {
      this.#notifyChanged()
    }
    return {
      success: true,
      pinned: false,
      pinKey,
      pinnedEntries: await this.#resolvePinnedEntries(nextEntries)
    }
  }

  async #resolvePinnedEntries(entries: readonly PinnedEntry[]): Promise<ResolvedPinnedEntry[]> {
    return mapWithConcurrency(entries, FILE_CHECK_CONCURRENCY, async (entry): Promise<ResolvedPinnedEntry> => {
      const pinKey = resolvePinKey(entry, this.#platform)
      if (entry.kind !== 'file') {
        return { pinKey, entry, available: true }
      }
      let stat: Stats | undefined
      try {
        stat = await fs.lstat(entry.path)
      } catch {
        return { pinKey, entry, available: false }
      }
      const available = !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory())
      if (!available) {
        return { pinKey, entry, available: false }
      }
      if (!entry.isApplication) {
        return { pinKey, entry, available: true }
      }
      const iconUrl = await this.#readPinnedFileIcon(pinKey, entry.path, stat.mtimeMs)
      return iconUrl ? { pinKey, entry, available: true, iconUrl } : { pinKey, entry, available: true }
    })
  }

  async #readPinnedFileIcon(pinKey: string, filePath: string, mtimeMs: number): Promise<string> {
    const cacheKey = `${pinKey}:${mtimeMs}`
    const cached = this.#fileIconCache.get(cacheKey)
    if (cached !== undefined) {
      this.#fileIconCache.delete(cacheKey)
      this.#fileIconCache.set(cacheKey, cached)
      return cached
    }
    try {
      const rawIcon = this.#platform === 'darwin' && filePath.toLowerCase().endsWith('.app')
        ? await (this.#readMacosApplicationIcon?.(filePath) ?? this.getFileIcon?.(filePath) ?? Promise.resolve(''))
        : await (this.getFileIcon?.(filePath) ?? Promise.resolve(''))
      const validated = iconDataUrl(rawIcon)
      if (!validated) return ''
      if (this.#fileIconCache.size >= MAX_FILE_ICON_CACHE) {
        const oldest = this.#fileIconCache.keys().next().value
        if (oldest !== undefined) this.#fileIconCache.delete(oldest)
      }
      this.#fileIconCache.set(cacheKey, validated)
      return validated
    } catch (error) {
      console.warn('读取固定应用图标失败:', error instanceof Error ? error.message : String(error))
      return ''
    }
  }

  #notifyChanged(): void {
    try {
      this.#onChanged?.()
    } catch (error) {
      console.warn('通知悬浮条固定变更失败:', error instanceof Error ? error.message : String(error))
    }
  }
}

function systemToolCategoryKeywords(category: string): string[] {
  if (category === 'core') return [t('systemTools.category.core')]
  if (category === 'terminal') return [t('systemTools.category.terminal')]
  if (category === 'management') return [t('systemTools.category.management')]
  if (category === 'system') return [t('systemTools.category.system')]
  if (category === 'network') return [t('systemTools.category.network')]
  if (category === 'hardware') return [t('systemTools.category.hardware')]
  if (category === 'settings') return [t('systemTools.category.settings')]
  return category ? [category] : []
}
