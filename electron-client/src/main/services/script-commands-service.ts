import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import type { HudService, HudMessagePayload } from './hud-service.js'
import type { FrecencyRankingService } from './frecency-ranking-service.js'

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000
export const TRUST_STORE_FILE = 'script_commands_trust.json'
export const VIEW_DESCRIPTOR_SYMBOL = Symbol.for('ztools.declarative.descriptor')

export type ScriptMode = 'fullOutput' | 'compact' | 'silent' | 'inline'

export interface ScriptArgument {
  name: string // 'argument1' | 'argument2' | 'argument3'
  type?: 'text' | 'password' | 'dropdown'
  placeholder?: string
  optional?: boolean
  percentEncoded?: boolean
  data?: Array<{ title: string; value: string }>
}

export interface ScriptMetadata {
  schemaVersion: number
  title: string
  mode: ScriptMode
  packageName?: string
  icon?: string
  alias?: string
  description?: string
  author?: string
  authorURL?: string
  currentDirectoryPath?: string
  needsConfirmation?: boolean
  refreshTime?: string
  arguments: ScriptArgument[]
  rawHeaders: Record<string, string>
}

export interface ScriptCommand {
  id: string
  scriptPath: string
  title: string
  mode: ScriptMode
  packageName: string
  icon: string
  alias?: string
  description: string
  arguments: ScriptArgument[]
  metadata: ScriptMetadata
}

export interface DeclarativeViewDescriptor<TProps = Record<string, unknown>> {
  readonly $$typeof: symbol
  readonly type: string
  readonly props: TProps
  readonly children: ReadonlyArray<DeclarativeViewDescriptor | unknown>
}

export interface ScriptExecutionResult {
  success: boolean
  commandId: string
  scriptPath: string
  mode: ScriptMode
  exitCode: number | null
  stdout: string
  stderr: string
  output: string // trimmed output / last line for compact & silent & inline
  durationMs: number
  timedOut: boolean
  cancelled?: boolean
  error?: string
  viewDescriptor?: DeclarativeViewDescriptor
  hudPayload?: HudMessagePayload
}

export interface ScriptConfirmInfo {
  scriptPath: string
  title: string
  command: string
  codeSummary: string
  sha256: string
}

export type ScriptConfirmHandler = (info: ScriptConfirmInfo) => Promise<boolean>

export interface WindowVisibilityManager {
  hideMainWindow(): void
  isMainWindowVisible?(): boolean
}

export interface ScriptCommandsServiceOptions {
  dataRoot: string
  scriptsDir?: string
  defaultTimeoutMs?: number
  confirmHandler?: ScriptConfirmHandler
  hudService?: HudService
  windowManager?: WindowVisibilityManager
  onScriptsUpdated?: (commands: ScriptCommand[]) => void
  logger?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: unknown) => void
}

export interface ScriptCommandSearchItem {
  id: string
  type: 'script_command'
  name: string
  title: string
  description: string
  packageName: string
  iconUrl: string
  icon: string
  alias?: string
  keywords: string[]
  scriptPath: string
  mode: ScriptMode
  arguments: ScriptArgument[]
}

export interface TrustedScriptRecord {
  sha256: string
  title: string
  trustedAt: string
}

export interface TrustStoreDocument {
  version: 1
  trustedScripts: Record<string, TrustedScriptRecord>
}

const SUPPORTED_EXTENSIONS = new Set([
  '.ps1',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.bat',
  '.cmd',
  '.sh',
  '.bash'
])

const VALID_MODES = new Set<ScriptMode>(['fullOutput', 'compact', 'silent', 'inline'])

/**
 * 转义 Windows CMD / Batch 脚本参数，防止空格、引号及元字符 (&, |, <, >, ^, %) 造成 shell 注入与参数截断
 */
export function escapeCmdArg(arg: string): string {
  if (arg === '') return '""'
  const escaped = String(arg)
    .replace(/\^/g, '^^')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>')
    .replace(/%/g, '%%')
    .replace(/"/g, '""')
  return `"${escaped}"`
}

/**
 * 字符编码容错解码：先尝试 UTF-8 严格解码，乱码后自动降级为 GBK (与 GB18030) 解码
 */
export function decodeOutput(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      try {
        return new TextDecoder('gb18030').decode(buffer)
      } catch {
        return buffer.toString('utf8')
      }
    }
  }
}

/**
 * 终结进程树：Windows 下调用 taskkill /pid <PID> /T /F，POSIX 下尝试 kill 进程组或子进程
 */
export function terminateProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 忽略可能已经退出的进程
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 忽略
      }
    }
  }
}

/**
 * 解析 Raycast 官方脚本头部注释元数据
 */
export function parseScriptMetadata(
  content: string,
  filePath?: string,
  logger?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: unknown) => void
): ScriptMetadata | null {
  if (typeof content !== 'string' || content.length === 0) {
    logger?.('WARN', '脚本内容为空，已跳过', { filePath })
    return null
  }

  const lines = content.split(/\r?\n/)
  const headers: Record<string, string> = {}
  const rawHeaders: Record<string, string> = {}

  // 读取头部注释行 (通常在前 60 行内定义，支持 #, //, REM, ::)
  const commentLinePattern = /^\s*(?:#|\/\/|REM\b|::)\s*(?:@raycast\.([A-Za-z0-9_]+))\s*(.*)$/i
  const maxHeaderLines = Math.min(lines.length, 60)

  for (let i = 0; i < maxHeaderLines; i++) {
    const line = lines[i]
    if (!line) continue
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const match = commentLinePattern.exec(trimmed)
    if (match) {
      const key = (match[1] || '').trim().toLowerCase()
      const rawKey = (match[1] || '').trim()
      const value = (match[2] || '').trim()
      headers[key] = value
      rawHeaders[rawKey] = value
    }
  }

  // 1. 验证 schemaVersion (必须为正整数)
  const rawSchemaVersion = headers.schemaversion
  if (!rawSchemaVersion) {
    logger?.('WARN', '脚本缺少 @raycast.schemaVersion 字段，已跳过', { filePath })
    return null
  }
  const schemaVersion = parseInt(rawSchemaVersion, 10)
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    logger?.('WARN', '脚本 @raycast.schemaVersion 格式不正确，必须为正整数，已跳过', { filePath, rawSchemaVersion })
    return null
  }

  // 2. 验证 title (必须非空)
  const title = (headers.title || '').trim()
  if (!title) {
    logger?.('WARN', '脚本缺少 @raycast.title 字段，已跳过', { filePath })
    return null
  }

  // 3. 验证 mode (必须为 fullOutput, compact, silent, inline 之一)
  const rawMode = headers.mode
  if (!rawMode || !VALID_MODES.has(rawMode as ScriptMode)) {
    logger?.('WARN', '脚本 @raycast.mode 必须为 fullOutput, compact, silent, inline 之一，已跳过', { filePath, rawMode })
    return null
  }
  const mode = rawMode as ScriptMode

  // 4. 解析参数列表 argument1 ~ argument3
  const scriptArgs: ScriptArgument[] = []
  for (let i = 1; i <= 3; i++) {
    const argKey = `argument${i}`
    const rawArgValue = headers[argKey]
    if (rawArgValue !== undefined && rawArgValue.length > 0) {
      let parsedArg: Partial<ScriptArgument> = {}
      if (rawArgValue.startsWith('{') && rawArgValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(rawArgValue)
          if (typeof parsed === 'object' && parsed !== null) {
            parsedArg = parsed
          }
        } catch {
          parsedArg = { placeholder: rawArgValue }
        }
      } else {
        parsedArg = { placeholder: rawArgValue }
      }
      scriptArgs.push({
        name: argKey,
        type: parsedArg.type === 'password' ? 'password' : parsedArg.type === 'dropdown' ? 'dropdown' : 'text',
        placeholder: typeof parsedArg.placeholder === 'string' ? parsedArg.placeholder : `参数 ${i}`,
        optional: Boolean(parsedArg.optional),
        percentEncoded: Boolean(parsedArg.percentEncoded),
        ...(Array.isArray(parsedArg.data) ? { data: parsedArg.data } : {})
      })
    }
  }

  return {
    schemaVersion,
    title,
    mode,
    ...(headers.packagename ? { packageName: headers.packagename } : {}),
    ...(headers.icon ? { icon: headers.icon } : {}),
    ...(headers.alias ? { alias: headers.alias } : headers.shortcode ? { alias: headers.shortcode } : {}),
    ...(headers.description ? { description: headers.description } : {}),
    ...(headers.author ? { author: headers.author } : {}),
    ...(headers.authorurl ? { authorURL: headers.authorurl } : {}),
    ...(headers.currentdirectorypath ? { currentDirectoryPath: headers.currentdirectorypath } : {}),
    ...(headers.needsconfirmation ? { needsConfirmation: headers.needsconfirmation.toLowerCase() === 'true' } : {}),
    ...(headers.refreshtime ? { refreshTime: headers.refreshtime } : {}),
    arguments: scriptArgs,
    rawHeaders
  }
}

/**
 * 根据文件扩展名选择解释器与参数
 */
export function resolveScriptInterpreter(
  scriptPath: string,
  userArgs: readonly string[] = []
): { executable: string; args: string[]; useCmdEscaping: boolean } {
  const ext = path.extname(scriptPath).toLowerCase()

  switch (ext) {
    case '.ps1': {
      const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
      return {
        executable,
        args: [
          '-NoProfile',
          '-NonInteractive',
          ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
          '-File',
          scriptPath,
          ...userArgs
        ],
        useCmdEscaping: false
      }
    }
    case '.py': {
      const executable = process.platform === 'win32' ? 'python' : 'python3'
      return {
        executable,
        args: [scriptPath, ...userArgs],
        useCmdEscaping: false
      }
    }
    case '.js':
    case '.mjs':
    case '.cjs': {
      return {
        executable: process.execPath,
        args: [scriptPath, ...userArgs],
        useCmdEscaping: false
      }
    }
    case '.bat':
    case '.cmd': {
      const comspec = process.env.ComSpec || 'cmd.exe'
      // 对参数转义后以数组形式传参，严禁拼接 shell 字符串
      const escapedArgs = userArgs.map(escapeCmdArg)
      return {
        executable: comspec,
        args: ['/d', '/c', scriptPath, ...escapedArgs],
        useCmdEscaping: true
      }
    }
    case '.sh':
    case '.bash': {
      return {
        executable: 'bash',
        args: [scriptPath, ...userArgs],
        useCmdEscaping: false
      }
    }
    default:
      throw new Error(`不支持的脚本格式: ${ext}`)
  }
}

/**
 * 构造声明式 Detail 视图描述符（符合 @ztools/raycast-compat 规约）
 */
export function createDetailViewDescriptor(
  title: string,
  markdown: string,
  meta?: {
    status: string
    duration: string
    exitCode: string | number
    scriptPath: string
    interpreter: string
  }
): DeclarativeViewDescriptor {
  const metadataChildren: DeclarativeViewDescriptor[] = []

  if (meta) {
    metadataChildren.push({
      $$typeof: VIEW_DESCRIPTOR_SYMBOL,
      type: 'Detail.Metadata.Label',
      props: { title: '状态', text: meta.status },
      children: []
    })
    metadataChildren.push({
      $$typeof: VIEW_DESCRIPTOR_SYMBOL,
      type: 'Detail.Metadata.Label',
      props: { title: '执行耗时', text: meta.duration },
      children: []
    })
    metadataChildren.push({
      $$typeof: VIEW_DESCRIPTOR_SYMBOL,
      type: 'Detail.Metadata.Label',
      props: { title: '退出码', text: String(meta.exitCode) },
      children: []
    })
    metadataChildren.push({
      $$typeof: VIEW_DESCRIPTOR_SYMBOL,
      type: 'Detail.Metadata.Label',
      props: { title: '脚本路径', text: meta.scriptPath },
      children: []
    })
    metadataChildren.push({
      $$typeof: VIEW_DESCRIPTOR_SYMBOL,
      type: 'Detail.Metadata.Label',
      props: { title: '解释器', text: meta.interpreter },
      children: []
    })
  }

  const detailMetadata: DeclarativeViewDescriptor = {
    $$typeof: VIEW_DESCRIPTOR_SYMBOL,
    type: 'Detail.Metadata',
    props: {},
    children: metadataChildren
  }

  return {
    $$typeof: VIEW_DESCRIPTOR_SYMBOL,
    type: 'Detail',
    props: {
      navigationTitle: `${title} - 执行结果`,
      markdown,
      metadata: detailMetadata
    },
    children: []
  }
}

export class ScriptCommandsService {
  readonly #dataRoot: string
  readonly #scriptsDir: string
  readonly #defaultTimeoutMs: number
  readonly #confirmHandler: ScriptConfirmHandler | undefined
  readonly #hudService: HudService | undefined
  readonly #windowManager: WindowVisibilityManager | undefined
  readonly #onScriptsUpdated: ((commands: ScriptCommand[]) => void) | undefined
  readonly #logger: (level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: unknown) => void

  readonly #commands = new Map<string, ScriptCommand>()
  #watcher: fs.FSWatcher | null = null
  #watchDebounceTimer: NodeJS.Timeout | null = null
  #activeProcesses = new Set<ChildProcess>()
  #stopped = false

  constructor(options: ScriptCommandsServiceOptions) {
    this.#dataRoot = path.resolve(options.dataRoot)
    this.#scriptsDir = path.resolve(options.scriptsDir ?? path.join(this.#dataRoot, 'scripts'))
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS
    this.#confirmHandler = options.confirmHandler
    this.#hudService = options.hudService
    this.#windowManager = options.windowManager
    this.#onScriptsUpdated = options.onScriptsUpdated
    this.#logger = options.logger ?? ((level, message, details) => {
      if (level === 'ERROR') console.error(`[ScriptCommands] ${message}`, details ?? '')
      else if (level === 'WARN') console.warn(`[ScriptCommands] ${message}`, details ?? '')
    })
  }

  get scriptsDir(): string {
    return this.#scriptsDir
  }

  get commands(): ReadonlyMap<string, ScriptCommand> {
    return this.#commands
  }

  /**
   * 初始化服务：确保目录存在、执行首次扫描并启动目录热监听
   */
  async start(): Promise<void> {
    if (this.#stopped) return
    try {
      await fsPromises.mkdir(this.#scriptsDir, { recursive: true })
    } catch (err) {
      this.#logger('ERROR', '创建脚本目录失败', { scriptsDir: this.#scriptsDir, error: err })
    }

    await this.scanScripts()
    this.#startWatcher()
  }

  /**
   * 停止服务与清理定时器/监听器
   */
  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#watchDebounceTimer) {
      clearTimeout(this.#watchDebounceTimer)
      this.#watchDebounceTimer = null
    }
    if (this.#watcher) {
      try {
        this.#watcher.close()
      } catch {
        // 忽略
      }
      this.#watcher = null
    }

    // 终结仍在运行中的子进程树
    for (const child of this.#activeProcesses) {
      if (child.pid) {
        terminateProcessTree(child.pid)
      }
    }
    this.#activeProcesses.clear()
  }

  /**
   * 扫描脚本目录，提取并注册合法脚本命令
   */
  async scanScripts(): Promise<ScriptCommand[]> {
    if (this.#stopped) return []
    const results: ScriptCommand[] = []

    try {
      const exists = await fsPromises.stat(this.#scriptsDir).then(s => s.isDirectory()).catch(() => false)
      if (!exists) return []

      const files = await this.#collectScriptFiles(this.#scriptsDir)

      for (const filePath of files) {
        try {
          const content = await fsPromises.readFile(filePath, 'utf8')
          const metadata = parseScriptMetadata(content, filePath, this.#logger)
          if (!metadata) continue

          const relativePath = path.relative(this.#scriptsDir, filePath).replaceAll('\\', '/')
          const slug = relativePath
            .replace(/\.[^/.]+$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '-')
          const id = `script:${slug}`

          const command: ScriptCommand = {
            id,
            scriptPath: filePath,
            title: metadata.title,
            mode: metadata.mode,
            packageName: metadata.packageName || 'Script Commands',
            icon: metadata.icon || 'terminal',
            ...(metadata.alias ? { alias: metadata.alias } : {}),
            description: metadata.description || metadata.packageName || '',
            arguments: metadata.arguments,
            metadata
          }

          results.push(command)
        } catch (err) {
          this.#logger('WARN', '读取脚本文件失败，已跳过', { filePath, error: err })
        }
      }

      this.#commands.clear()
      for (const cmd of results) {
        this.#commands.set(cmd.id, cmd)
      }

      this.#onScriptsUpdated?.(results)
      return results
    } catch (err) {
      this.#logger('ERROR', '扫描脚本目录失败', { scriptsDir: this.#scriptsDir, error: err })
      return []
    }
  }

  /**
   * 递归检索支持格式的脚本文件
   */
  async #collectScriptFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 4) return []
    const results: string[] = []

    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

        if (entry.isDirectory()) {
          const subFiles = await this.#collectScriptFiles(fullPath, depth + 1)
          results.push(...subFiles)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            results.push(fullPath)
          }
        }
      }
    } catch (err) {
      this.#logger('WARN', '读取子目录失败', { dir, error: err })
    }

    return results
  }

  /**
   * 启动本地目录热监听
   */
  #startWatcher(): void {
    if (this.#watcher || this.#stopped) return

    try {
      this.#watcher = fs.watch(this.#scriptsDir, { recursive: true }, () => {
        if (this.#stopped) return
        if (this.#watchDebounceTimer) {
          clearTimeout(this.#watchDebounceTimer)
        }
        this.#watchDebounceTimer = setTimeout(() => {
          this.#watchDebounceTimer = null
          void this.scanScripts()
        }, 150)
      })
      this.#watcher.on('error', (err) => {
        this.#logger('WARN', '脚本目录监听器发生异常', { error: err })
      })
    } catch (err) {
      this.#logger('WARN', '创建脚本目录监听器失败', { scriptsDir: this.#scriptsDir, error: err })
    }
  }

  /**
   * 计算脚本文件的 SHA-256 哈希
   */
  async calculateScriptHash(scriptPath: string): Promise<string> {
    const buffer = await fsPromises.readFile(scriptPath)
    return createHash('sha256').update(buffer).digest('hex')
  }

  /**
   * 读取信任白名单文档
   */
  async readTrustStore(): Promise<TrustStoreDocument> {
    const storePath = path.join(this.#dataRoot, TRUST_STORE_FILE)
    try {
      const text = await fsPromises.readFile(storePath, 'utf8')
      const parsed = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && parsed.version === 1 && typeof parsed.trustedScripts === 'object') {
        return parsed as TrustStoreDocument
      }
    } catch {
      // 文件缺失或损坏时初始化默认结构
    }
    return { version: 1, trustedScripts: {} }
  }

  /**
   * 保存信任白名单文档
   */
  async saveTrustStore(doc: TrustStoreDocument): Promise<void> {
    const storePath = path.join(this.#dataRoot, TRUST_STORE_FILE)
    await fsPromises.mkdir(this.#dataRoot, { recursive: true })
    const tmpPath = `${storePath}.${randomUUID()}.tmp`
    await fsPromises.writeFile(tmpPath, JSON.stringify(doc, null, 2), 'utf8')
    await fsPromises.rename(tmpPath, storePath)
  }

  /**
   * 检查脚本当前是否已受信任（基于路径与 SHA-256 强校验）
   */
  async isScriptTrusted(scriptPath: string, currentHash?: string): Promise<boolean> {
    const normalizedPath = path.resolve(scriptPath).toLowerCase()
    const hash = currentHash ?? await this.calculateScriptHash(scriptPath)
    const store = await this.readTrustStore()
    const entry = store.trustedScripts[normalizedPath]
    if (!entry) return false
    return entry.sha256 === hash
  }

  /**
   * 信任指定脚本并持久化记录
   */
  async trustScript(scriptPath: string, hash?: string, title?: string): Promise<void> {
    const normalizedPath = path.resolve(scriptPath).toLowerCase()
    const sha256 = hash ?? await this.calculateScriptHash(scriptPath)
    const store = await this.readTrustStore()
    store.trustedScripts[normalizedPath] = {
      sha256,
      title: title ?? path.basename(scriptPath),
      trustedAt: new Date().toISOString()
    }
    await this.saveTrustStore(store)
  }

  /**
   * 撤回对指定脚本的信任
   */
  async revokeTrust(scriptPath: string): Promise<void> {
    const normalizedPath = path.resolve(scriptPath).toLowerCase()
    const store = await this.readTrustStore()
    delete store.trustedScripts[normalizedPath]
    await this.saveTrustStore(store)
  }

  /**
   * 清空所有已信任的脚本记录
   */
  async clearTrust(): Promise<void> {
    const store: TrustStoreDocument = { version: 1, trustedScripts: {} }
    await this.saveTrustStore(store)
  }

  /**
   * 列出所有受信任脚本信息
   */
  async listTrustedScripts(): Promise<Record<string, TrustedScriptRecord>> {
    const store = await this.readTrustStore()
    return store.trustedScripts
  }

  /**
   * 转换为系统统一搜索条目格式
   */
  getSearchItems(): ScriptCommandSearchItem[] {
    return Array.from(this.#commands.values()).map((cmd) => ({
      id: cmd.id,
      type: 'script_command',
      name: cmd.title,
      title: cmd.title,
      description: cmd.description,
      packageName: cmd.packageName,
      iconUrl: cmd.icon,
      icon: cmd.icon,
      ...(cmd.alias ? { alias: cmd.alias } : {}),
      keywords: [cmd.packageName, cmd.title, path.basename(cmd.scriptPath)],
      scriptPath: cmd.scriptPath,
      mode: cmd.mode,
      arguments: cmd.arguments
    }))
  }

  /**
   * 结合 FrecencyRankingService 进行搜索排序
   */
  rankScriptCommands(frecency: FrecencyRankingService, query?: string): ScriptCommand[] {
    return frecency.rankItems(
      Array.from(this.#commands.values()),
      {
        getId: (item) => item.id,
        getAlias: (item) => item.alias,
        getTitle: (item) => item.title,
        getSubtitle: (item) => item.description || item.packageName,
        getKeywords: (item) => [item.packageName, item.title, path.basename(item.scriptPath)]
      },
      query
    )
  }

  /**
   * 核心执行入口：首次安全确认、解释器调度、看门狗防护、编码容错与四种模式分发
   */
  async executeCommand(
    commandIdOrPath: string,
    userArgs: readonly string[] = [],
    options?: { timeoutMs?: number }
  ): Promise<ScriptExecutionResult> {
    const startTime = Date.now()

    // 1. 查找或解析命令
    let command = this.#commands.get(commandIdOrPath)
    let scriptPath = command ? command.scriptPath : path.resolve(commandIdOrPath)

    if (!command) {
      // 允许直接传入物理脚本路径即时解析
      try {
        const content = await fsPromises.readFile(scriptPath, 'utf8')
        const metadata = parseScriptMetadata(content, scriptPath, this.#logger)
        if (!metadata) {
          return {
            success: false,
            commandId: commandIdOrPath,
            scriptPath,
            mode: 'fullOutput',
            exitCode: -1,
            stdout: '',
            stderr: '',
            output: '',
            durationMs: 0,
            timedOut: false,
            error: '无效或缺少必要头部字段的脚本'
          }
        }
        command = {
          id: `script:${path.basename(scriptPath)}`,
          scriptPath,
          title: metadata.title,
          mode: metadata.mode,
          packageName: metadata.packageName || 'Script Commands',
          icon: metadata.icon || 'terminal',
          ...(metadata.alias ? { alias: metadata.alias } : {}),
          description: metadata.description || '',
          arguments: metadata.arguments,
          metadata
        }
      } catch (err) {
        return {
          success: false,
          commandId: commandIdOrPath,
          scriptPath,
          mode: 'fullOutput',
          exitCode: -1,
          stdout: '',
          stderr: '',
          output: '',
          durationMs: 0,
          timedOut: false,
          error: `无法读取脚本文件: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }

    const metadata = command.metadata
    const commandId = command.id
    scriptPath = command.scriptPath

    // 2. 首次运行确认机制与防篡改验证 (M3-4)
    let currentHash = ''
    try {
      currentHash = await this.calculateScriptHash(scriptPath)
    } catch (err) {
      return {
        success: false,
        commandId,
        scriptPath,
        mode: command.mode,
        exitCode: -1,
        stdout: '',
        stderr: '',
        output: '',
        durationMs: 0,
        timedOut: false,
        error: `计算脚本哈希失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const isTrusted = await this.isScriptTrusted(scriptPath, currentHash)

    if (!isTrusted) {
      // 提取代码摘要 (前 15 行或前 500 字符)
      let codeSummary = ''
      try {
        const fileContent = await fsPromises.readFile(scriptPath, 'utf8')
        const summaryLines = fileContent.split(/\r?\n/).slice(0, 15).join('\n')
        codeSummary = summaryLines.slice(0, 500)
      } catch {
        codeSummary = '(无法读取代码摘要)'
      }

      // 获取执行命令预览
      let commandPreview = ''
      try {
        const resolved = resolveScriptInterpreter(scriptPath, userArgs)
        commandPreview = `${resolved.executable} ${resolved.args.join(' ')}`
      } catch {
        commandPreview = scriptPath
      }

      const confirmInfo: ScriptConfirmInfo = {
        scriptPath,
        title: command.title,
        command: commandPreview,
        codeSummary,
        sha256: currentHash
      }

      let confirmed = false
      if (this.#confirmHandler) {
        try {
          confirmed = await this.#confirmHandler(confirmInfo)
        } catch {
          confirmed = false
        }
      }

      if (!confirmed) {
        return {
          success: false,
          commandId,
          scriptPath,
          mode: command.mode,
          exitCode: null,
          stdout: '',
          stderr: '',
          output: '',
          durationMs: Date.now() - startTime,
          timedOut: false,
          cancelled: true,
          error: '用户取消执行未受信任的脚本'
        }
      }

      // 用户确认执行，将当前哈希写入白名单
      await this.trustScript(scriptPath, currentHash, command.title)
    }

    // 3. 处理参数编码 (如果元数据声明了 percentEncoded: true)
    const effectiveArgs: string[] = []
    for (let i = 0; i < userArgs.length; i++) {
      const rawArg = userArgs[i] ?? ''
      const argDef = metadata.arguments[i]
      if (argDef && argDef.percentEncoded) {
        effectiveArgs.push(encodeURIComponent(rawArg))
      } else {
        effectiveArgs.push(rawArg)
      }
    }

    // 4. 解析解释器与参数
    let invocation: { executable: string; args: string[]; useCmdEscaping: boolean }
    try {
      invocation = resolveScriptInterpreter(scriptPath, effectiveArgs)
    } catch (err) {
      return {
        success: false,
        commandId,
        scriptPath,
        mode: command.mode,
        exitCode: -1,
        stdout: '',
        stderr: '',
        output: '',
        durationMs: Date.now() - startTime,
        timedOut: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }

    // 5. 如果是 silent 模式，立即隐藏主窗口
    if (command.mode === 'silent') {
      try {
        this.#windowManager?.hideMainWindow()
      } catch {
        // 忽略
      }
    }

    // 6. 执行子进程与启动看门狗 (M3-2)
    const timeoutMs = options?.timeoutMs ?? this.#defaultTimeoutMs
    let timedOut = false
    let watchdogTimer: NodeJS.Timeout | null = null

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const cwd = metadata.currentDirectoryPath && fs.existsSync(metadata.currentDirectoryPath)
      ? metadata.currentDirectoryPath
      : path.dirname(scriptPath)

    const executionPromise = new Promise<{ exitCode: number | null; error?: Error }>((resolve) => {
      let child: ChildProcess

      try {
        child = spawn(invocation.executable, invocation.args, {
          cwd,
          shell: false,
          windowsHide: true,
          ...(invocation.useCmdEscaping && process.platform === 'win32'
            ? { windowsVerbatimArguments: true }
            : {})
        })
      } catch (err) {
        resolve({ exitCode: -1, error: err instanceof Error ? err : new Error(String(err)) })
        return
      }

      this.#activeProcesses.add(child)

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
      }

      // 超时看门狗：到期后终结整个子进程树
      watchdogTimer = setTimeout(() => {
        timedOut = true
        if (child.pid) {
          terminateProcessTree(child.pid)
        }
      }, timeoutMs)

      child.on('error', (err) => {
        if (watchdogTimer) clearTimeout(watchdogTimer)
        this.#activeProcesses.delete(child)
        resolve({ exitCode: -1, error: err })
      })

      child.on('close', (code) => {
        if (watchdogTimer) clearTimeout(watchdogTimer)
        this.#activeProcesses.delete(child)
        resolve({ exitCode: code })
      })
    })

    const execResult = await executionPromise
    const durationMs = Date.now() - startTime

    // 7. 解码标准输出与标准错误（UTF-8 优先，GBK 容错）
    const stdout = decodeOutput(Buffer.concat(stdoutChunks))
    const stderr = decodeOutput(Buffer.concat(stderrChunks))

    const isSuccess = !timedOut && execResult.exitCode === 0 && !execResult.error

    // 提取最后一行输出用于 compact / silent / inline
    const allLines = (stdout.trim() ? stdout : stderr)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
    const lastLine = allLines.length > 0 ? allLines[allLines.length - 1] ?? '' : ''
    const outputSummary = stdout.trim() || stderr.trim()

    let viewDescriptor: DeclarativeViewDescriptor | undefined
    let hudPayload: HudMessagePayload | undefined

    // 8. 处理四种输出模式 (fullOutput, compact, silent, inline)
    if (command.mode === 'fullOutput') {
      const statusText = timedOut ? '超时 (已终止)' : isSuccess ? '成功' : '失败'
      const markdownContent = [
        `# ${command.title}`,
        '',
        `> **包名**：${command.packageName} | **模式**：fullOutput | **状态**：${statusText} | **耗时**：${durationMs}ms`,
        '',
        '### 标准输出',
        '```bash',
        stdout.trim() || '(无标准输出)',
        '```',
        ...(stderr.trim() ? ['', '### 错误输出', '```bash', stderr.trim(), '```'] : [])
      ].join('\n')

      viewDescriptor = createDetailViewDescriptor(command.title, markdownContent, {
        status: statusText,
        duration: `${durationMs}ms`,
        exitCode: execResult.exitCode ?? 'N/A',
        scriptPath,
        interpreter: invocation.executable
      })
    } else if (command.mode === 'compact') {
      const message = lastLine || (isSuccess ? '执行完成' : '执行失败')
      if (this.#hudService) {
        hudPayload = await this.#hudService.showHUD(message, {
          icon: isSuccess ? '✓' : 'x'
        })
      }
    } else if (command.mode === 'silent') {
      if (!isSuccess) {
        const errorMsg = timedOut
          ? `脚本超时 (${timeoutMs}ms)`
          : execResult.error?.message || lastLine || '执行失败'
        if (this.#hudService) {
          hudPayload = await this.#hudService.showHUD(`执行失败: ${errorMsg}`, {
            icon: 'error'
          })
        }
      }
    }

    let errorString: string | undefined
    if (timedOut) {
      errorString = `脚本执行超时 (${timeoutMs}ms)，子进程树已被完全终结`
    } else if (execResult.error) {
      errorString = execResult.error.message
    } else if (execResult.exitCode !== 0 && execResult.exitCode !== null) {
      errorString = `进程退出码非零: ${execResult.exitCode}`
    }

    return {
      success: isSuccess,
      commandId,
      scriptPath,
      mode: command.mode,
      exitCode: execResult.exitCode,
      stdout,
      stderr,
      output: lastLine || outputSummary,
      durationMs,
      timedOut,
      ...(errorString ? { error: errorString } : {}),
      ...(viewDescriptor ? { viewDescriptor } : {}),
      ...(hudPayload ? { hudPayload } : {})
    }
  }
}
