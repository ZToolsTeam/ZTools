import { BrowserWindow, type Session } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ClassicLevel } from 'classic-level'
import {
  COMPATIBILITY_MIGRATION_PATH
} from '../protocol/ztools-protocol.js'

const LEGACY_PLUGIN_ORIGIN = 'ztools://plugins'
const MAX_LOCAL_STORAGE_VALUE_BYTES = 16 * 1024 * 1024
const MAX_LOCAL_STORAGE_RECORDS = 10000
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf16leDecoder = new TextDecoder('utf-16le', { fatal: true })

export interface LegacyLocalStorageRecord {
  origin: string
  key: string
  value: string
  encoding: 'utf8' | 'utf16le' | 'latin1'
}

export interface LegacyStoragePolicy {
  pluginId: string
  exactKeys: readonly string[]
  prefixes: readonly string[]
}

export const LEGACY_LOCAL_STORAGE_POLICIES: readonly LegacyStoragePolicy[] = [
  {
    pluginId: 'password',
    exactKeys: ['PASSWORD_LOGIN_INFO'],
    prefixes: ['specialCharacters@', 'charTypes@', 'lengthValue@']
  },
  {
    pluginId: 'batch-audio',
    exactKeys: ['batch_audio_output_dir'],
    prefixes: []
  },
  {
    pluginId: 'batch-video',
    exactKeys: ['batch_video_output_dir', 'batch_video_output_type'],
    prefixes: []
  },
  {
    pluginId: 'chinese-number-converter',
    exactKeys: ['chinese-number-converter:ticket-rules'],
    prefixes: []
  },
  {
    pluginId: 'everything',
    exactKeys: ['everything_settings', 'pdfjs.signature', 'pdfjs.preferences', 'pdfjs.history'],
    prefixes: []
  },
  {
    pluginId: 'flow-guard',
    exactKeys: ['flowGuardSettings', 'flowGuardExportDirectory'],
    prefixes: []
  },
  {
    pluginId: 'memo',
    exactKeys: [],
    prefixes: ['memo_']
  },
  {
    pluginId: 'ocr',
    exactKeys: ['ocr_history_items_v1', 'ocr_hide_window_on_capture'],
    prefixes: []
  },
  {
    pluginId: 'pdf',
    exactKeys: ['pdfPlugin_outputDirectory'],
    prefixes: []
  },
  {
    pluginId: 'quick-folders',
    exactKeys: [
      'quick-folders:favorites',
      'quick-folders:customizations',
      'quick-folders:system-records'
    ],
    prefixes: []
  },
  {
    pluginId: 'record',
    exactKeys: ['record_media_dir', 'record_output_dir', 'record_screenshot_dir'],
    prefixes: []
  },
  {
    pluginId: 'screen-color-picker',
    exactKeys: [],
    prefixes: []
  },
  {
    pluginId: 'shutdown-timer',
    exactKeys: ['shutdown-timer-settings'],
    prefixes: []
  },
  {
    pluginId: 'super-markdown',
    exactKeys: ['super-markdown:notes', 'super-markdown:folders', 'super-markdown:settings'],
    prefixes: []
  },
  {
    pluginId: 'translator',
    exactKeys: ['translator:history', 'translator:startup-payload'],
    prefixes: []
  },
  {
    pluginId: 'unit-converter',
    exactKeys: ['unit-converter:settings'],
    prefixes: []
  }
]

export interface LegacyBrowserStorageSnapshot {
  sourceFound: boolean
  localStorage: LegacyLocalStorageRecord[]
  indexedDbOrigins: string[]
  cookiesPresent: boolean
  unsupported: string[]
  decodeFailures: number
}

export interface LegacyStorageWriteResult {
  imported: number
  existingPreserved: number
}

export interface LegacyPluginMigrationResult {
  pluginId: string
  status: 'imported' | 'skipped' | 'failed'
  scanned: number
  imported: number
  existingPreserved: number
  unmapped: number
  unsupported: string[]
}

export interface LegacyBrowserStorageWriter {
  write(
    targetSession: Session,
    pluginId: string,
    entries: readonly LegacyLocalStorageRecord[]
  ): Promise<LegacyStorageWriteResult>
}

interface CompatibilityWindow {
  loadURL(url: string): Promise<unknown>
  isDestroyed(): boolean
  destroy(): void
  webContents: {
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>
  }
}

export type LegacyBrowserWindowFactory = (targetSession: Session) => CompatibilityWindow

export interface LegacyBrowserStorageMigratorOptions {
  sourceRoot: string
  transactionRoot: string
  policies?: readonly LegacyStoragePolicy[]
  writer?: LegacyBrowserStorageWriter
}

export function buildLegacyStorageImportScript(
  entries: readonly LegacyLocalStorageRecord[]
): string {
  const serialized = JSON.stringify(entries.map(({ key, value }) => [key, value]))
  if (serialized === undefined) throw new Error('无法序列化兼容存储记录')
  return [
    '(function () {',
    'const entries = ',
    serialized,
    ';',
    'let imported = 0;',
    'let existingPreserved = 0;',
    'for (const [key, value] of entries) {',
    'if (localStorage.getItem(key) === null) { localStorage.setItem(key, value); imported += 1; }',
    'else { existingPreserved += 1; }',
    '}',
    'return { imported, existingPreserved };',
    '})()'
  ].join('')
}

export function decodeLegacyStorageValue(
  raw: Buffer
): { value: string; encoding: LegacyLocalStorageRecord['encoding'] } | undefined {
  if (raw.length > 0 && raw[0] === 0 && (raw.length - 1) % 2 === 0) {
    try {
      const value = utf16leDecoder.decode(new Uint8Array(raw.subarray(1))).replace(/^\uFEFF/, '')
      return { value, encoding: 'utf16le' }
    } catch {
      // Fall through to the strict UTF-8 decoder for unmarked data.
    }
  }
  if (raw.length > 0 && raw[0] === 1) {
    return { value: raw.subarray(1).toString('latin1'), encoding: 'latin1' }
  }
  try {
    return { value: utf8Decoder.decode(new Uint8Array(raw)), encoding: 'utf8' }
  } catch {
    return undefined
  }
}

export class ElectronLegacyBrowserStorageWriter implements LegacyBrowserStorageWriter {
  readonly #createWindow: LegacyBrowserWindowFactory

  constructor(createWindow?: LegacyBrowserWindowFactory) {
    this.#createWindow = createWindow ?? ((targetSession) => new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        session: targetSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    }))
  }

  async write(
    targetSession: Session,
    _pluginId: string,
    entries: readonly LegacyLocalStorageRecord[]
  ): Promise<LegacyStorageWriteResult> {
    if (entries.length === 0) return { imported: 0, existingPreserved: 0 }
    const window = this.#createWindow(targetSession)
    try {
      await window.loadURL('ztools://plugins' + COMPATIBILITY_MIGRATION_PATH)
      const result = await window.webContents.executeJavaScript(
        buildLegacyStorageImportScript(entries),
        true
      )
      await targetSession.flushStorageData()
      return normalizeWriteResult(result, entries.length)
    } finally {
      if (!window.isDestroyed()) window.destroy()
    }
  }
}

export class LegacyBrowserStorageMigrator {
  readonly #sourceRoot: string
  readonly #transactionRoot: string
  readonly #policies: readonly LegacyStoragePolicy[]
  readonly #writer: LegacyBrowserStorageWriter
  readonly #inFlight = new Map<string, Promise<LegacyPluginMigrationResult>>()

  constructor(options: LegacyBrowserStorageMigratorOptions) {
    this.#sourceRoot = options.sourceRoot
    this.#transactionRoot = options.transactionRoot
    this.#policies = options.policies ?? LEGACY_LOCAL_STORAGE_POLICIES
    this.#writer = options.writer ?? new ElectronLegacyBrowserStorageWriter()
  }

  inspect(): Promise<LegacyBrowserStorageSnapshot> {
    return this.#readSnapshot()
  }

  migratePlugin(
    pluginId: string,
    targetSession: Session
  ): Promise<LegacyPluginMigrationResult> {
    const normalizedPluginId = normalizePluginId(pluginId)
    const existing = this.#inFlight.get(normalizedPluginId)
    if (existing) return existing
    const pending = this.#migratePlugin(normalizedPluginId, targetSession).finally(() => {
      if (this.#inFlight.get(normalizedPluginId) === pending) {
        this.#inFlight.delete(normalizedPluginId)
      }
    })
    this.#inFlight.set(normalizedPluginId, pending)
    return pending
  }

  async #migratePlugin(
    pluginId: string,
    targetSession: Session
  ): Promise<LegacyPluginMigrationResult> {
    const policy = this.#policies.find((candidate) => normalizePluginId(candidate.pluginId) === pluginId)
    if (!policy || (policy.exactKeys.length === 0 && policy.prefixes.length === 0)) {
      return skippedResult(pluginId)
    }

    let snapshot: LegacyBrowserStorageSnapshot
    try {
      snapshot = await this.#readSnapshot()
    } catch {
      return failedResult(pluginId, ['legacy-profile-read-failed'])
    }

    const unsupported = snapshot.decodeFailures > 0
      ? [...snapshot.unsupported, 'local-storage-decode-failures']
      : snapshot.unsupported
    const entries = snapshot.localStorage.filter((entry) => ownsKey(policy, entry.key))
    const unmapped = snapshot.localStorage.filter((entry) =>
      !this.#policies.some((candidate) => ownsKey(candidate, entry.key))
    ).length
    if (entries.length === 0) {
      return {
        pluginId,
        status: 'skipped',
        scanned: snapshot.localStorage.length,
        imported: 0,
        existingPreserved: 0,
        unmapped,
        unsupported
      }
    }

    try {
      const written = await this.#writer.write(targetSession, pluginId, entries)
      return {
        pluginId,
        status: 'imported',
        scanned: snapshot.localStorage.length,
        imported: written.imported,
        existingPreserved: written.existingPreserved,
        unmapped,
        unsupported
      }
    } catch {
      return {
        pluginId,
        status: 'failed',
        scanned: snapshot.localStorage.length,
        imported: 0,
        existingPreserved: 0,
        unmapped,
        unsupported: [...unsupported, 'local-storage-write-failed']
      }
    }
  }

  async #readSnapshot(): Promise<LegacyBrowserStorageSnapshot> {
    let sourceStats
    try {
      sourceStats = await fs.lstat(this.#sourceRoot)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptySnapshot(false)
      return emptySnapshot(true, ['legacy-profile-read-failed'])
    }
    if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
      return emptySnapshot(true, ['legacy-profile-is-not-directory'])
    }

    const unsupported: string[] = []
    let sourceCanonical: string
    try {
      sourceCanonical = await fs.realpath(this.#sourceRoot)
    } catch {
      return emptySnapshot(true, ['legacy-profile-read-failed'])
    }

    const indexedDbOrigins = await inspectIndexedDb(
      path.join(this.#sourceRoot, 'IndexedDB'),
      sourceCanonical,
      unsupported
    )
    const cookiesPresent = await inspectCookies(this.#sourceRoot, sourceCanonical, unsupported)
    if (indexedDbOrigins.length > 0) unsupported.push('indexeddb-not-imported')
    if (cookiesPresent) unsupported.push('cookies-not-imported')

    const levelDbSource = path.join(this.#sourceRoot, 'Local Storage', 'leveldb')
    let levelDbStats
    try {
      levelDbStats = await fs.lstat(levelDbSource)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { sourceFound: true, localStorage: [], indexedDbOrigins, cookiesPresent, unsupported, decodeFailures: 0 }
      }
      return {
        sourceFound: true,
        localStorage: [],
        indexedDbOrigins,
        cookiesPresent,
        unsupported: [...unsupported, 'local-storage-read-failed'],
        decodeFailures: 0
      }
    }
    if (levelDbStats.isSymbolicLink() || !levelDbStats.isDirectory()) {
      return {
        sourceFound: true,
        localStorage: [],
        indexedDbOrigins,
        cookiesPresent,
        unsupported: [...unsupported, 'local-storage-is-not-directory'],
        decodeFailures: 0
      }
    }

    await fs.mkdir(this.#transactionRoot, { recursive: true })
    const stageRoot = await fs.mkdtemp(path.join(this.#transactionRoot, 'legacy-browser-storage-'))
    const stagedLevelDb = path.join(stageRoot, 'leveldb')
    try {
      await copyClosedDirectory(levelDbSource, stagedLevelDb, sourceCanonical)
      const result = await readLegacyLocalStorage(stagedLevelDb)
      return {
        sourceFound: true,
        localStorage: result.records,
        indexedDbOrigins,
        cookiesPresent,
        unsupported: [...unsupported, ...result.unsupported],
        decodeFailures: result.decodeFailures
      }
    } catch {
      return {
        sourceFound: true,
        localStorage: [],
        indexedDbOrigins,
        cookiesPresent,
        unsupported: [...unsupported, 'local-storage-read-failed'],
        decodeFailures: 0
      }
    } finally {
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function normalizePluginId(pluginId: string): string {
  return pluginId.toLocaleLowerCase('en-US')
}

function ownsKey(policy: LegacyStoragePolicy, key: string): boolean {
  return policy.exactKeys.includes(key) || policy.prefixes.some((prefix) => key.startsWith(prefix))
}

function skippedResult(pluginId: string): LegacyPluginMigrationResult {
  return {
    pluginId,
    status: 'skipped',
    scanned: 0,
    imported: 0,
    existingPreserved: 0,
    unmapped: 0,
    unsupported: []
  }
}

function failedResult(pluginId: string, unsupported: string[]): LegacyPluginMigrationResult {
  return {
    pluginId,
    status: 'failed',
    scanned: 0,
    imported: 0,
    existingPreserved: 0,
    unmapped: 0,
    unsupported
  }
}

function emptySnapshot(sourceFound: boolean, unsupported: string[] = []): LegacyBrowserStorageSnapshot {
  return {
    sourceFound,
    localStorage: [],
    indexedDbOrigins: [],
    cookiesPresent: false,
    unsupported,
    decodeFailures: 0
  }
}

async function readLegacyLocalStorage(
  levelDbPath: string
): Promise<{ records: LegacyLocalStorageRecord[]; unsupported: string[]; decodeFailures: number }> {
  const records: LegacyLocalStorageRecord[] = []
  let decodeFailures = 0
  let store: ClassicLevel<Buffer, Buffer> | undefined
  try {
    store = new ClassicLevel<Buffer, Buffer>(levelDbPath, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
      errorIfExists: false,
      compression: false
    })
    await store.open()
    for await (const [rawKey, rawValue] of store.iterator()) {
      if (records.length >= MAX_LOCAL_STORAGE_RECORDS) {
        return {
          records,
          unsupported: ['local-storage-record-limit'],
          decodeFailures
        }
      }
      const parsedKey = parseLegacyLocalStorageKey(rawKey)
      if (!parsedKey || rawValue.byteLength > MAX_LOCAL_STORAGE_VALUE_BYTES) continue
      const decoded = decodeLegacyStorageValue(rawValue)
      if (!decoded) {
        decodeFailures += 1
        continue
      }
      records.push({ ...parsedKey, ...decoded })
    }
    return { records, unsupported: [], decodeFailures }
  } finally {
    if (store && (store.status === 'open' || store.status === 'opening')) {
      await store.close().catch(() => undefined)
    }
  }
}

function parseLegacyLocalStorageKey(
  rawKey: Buffer
): { origin: string; key: string } | undefined {
  if (rawKey.length < 2 || rawKey[0] !== 0x5f) return undefined
  const separator = rawKey.indexOf(0, 1)
  if (separator < 0) return undefined
  let origin: string
  let key: string
  try {
    origin = utf8Decoder.decode(new Uint8Array(rawKey.subarray(1, separator)))
    key = utf8Decoder.decode(new Uint8Array(rawKey.subarray(separator + 1)))
  } catch {
    return undefined
  }
  if (origin !== LEGACY_PLUGIN_ORIGIN && origin !== LEGACY_PLUGIN_ORIGIN + '/') return undefined
  return { origin: LEGACY_PLUGIN_ORIGIN, key }
}

async function copyClosedDirectory(
  source: string,
  target: string,
  sourceCanonical: string
): Promise<void> {
  const stats = await fs.lstat(source)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('旧浏览器目录不是普通目录')
  }
  await fs.mkdir(target, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'LOCK') continue
    const sourceChild = path.join(source, entry.name)
    const sourceChildCanonical = await fs.realpath(sourceChild)
    if (!isWithin(sourceCanonical, sourceChildCanonical)) {
      throw new Error('旧浏览器目录包含越界重解析点')
    }
    const childStats = await fs.lstat(sourceChild)
    if (childStats.isSymbolicLink()) throw new Error('旧浏览器目录包含符号链接')
    const targetChild = path.join(target, entry.name)
    if (childStats.isDirectory()) {
      await copyClosedDirectory(sourceChild, targetChild, sourceCanonical)
    } else if (childStats.isFile()) {
      await fs.copyFile(sourceChild, targetChild)
    } else {
      throw new Error('旧浏览器目录包含无法识别的文件')
    }
  }
}

async function inspectIndexedDb(
  root: string,
  sourceCanonical: string,
  unsupported: string[]
): Promise<string[]> {
  let stats
  try {
    stats = await fs.lstat(root)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    unsupported.push('indexeddb-read-failed')
    return []
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unsupported.push('indexeddb-not-directory')
    return []
  }
  const origins: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    try {
      const canonical = await fs.realpath(target)
      if (!isWithin(sourceCanonical, canonical)) {
        unsupported.push('indexeddb-contains-reparse-point')
        continue
      }
      const childStats = await fs.lstat(target)
      if (!childStats.isSymbolicLink()) origins.push(entry.name)
    } catch {
      unsupported.push('indexeddb-read-failed')
    }
  }
  return origins
}

async function inspectCookies(
  sourceRoot: string,
  sourceCanonical: string,
  unsupported: string[]
): Promise<boolean> {
  for (const relativePath of ['Cookies', path.join('Network', 'Cookies')]) {
    const target = path.join(sourceRoot, relativePath)
    try {
      const canonical = await fs.realpath(target)
      if (!isWithin(sourceCanonical, canonical)) {
        unsupported.push('cookies-contains-reparse-point')
        continue
      }
      const stats = await fs.lstat(target)
      if (stats.isSymbolicLink()) {
        unsupported.push('cookies-contains-symbolic-link')
        continue
      }
      if (stats.isFile()) return true
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') unsupported.push('cookies-read-failed')
    }
  }
  return false
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' ||
    (relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative))
}

function normalizeWriteResult(result: unknown, fallbackImported: number): LegacyStorageWriteResult {
  if (typeof result === 'object' && result !== null) {
    const value = result as { imported?: unknown; existingPreserved?: unknown }
    if (typeof value.imported === 'number' && typeof value.existingPreserved === 'number') {
      return {
        imported: Math.max(0, Math.floor(value.imported)),
        existingPreserved: Math.max(0, Math.floor(value.existingPreserved))
      }
    }
  }
  return { imported: fallbackImported, existingPreserved: 0 }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
