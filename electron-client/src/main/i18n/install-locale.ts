import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { matchSupportedLocale, resolveLocale, type LocaleSetting, type SupportedLocale } from './index.js'

const execFileAsync = promisify(execFile)

/** 单次注册表查询超时（毫秒） */
export const INSTALL_LOCALE_QUERY_TIMEOUT_MS = 1000

const REGISTRY_QUERY_TARGETS: ReadonlyArray<readonly [keyPath: string, viewFlag: '/reg:32' | '/reg:64']> = Object.freeze([
  ['HKCU\\Software\\ZTools', '/reg:32'],
  ['HKCU\\Software\\ZTools', '/reg:64'],
  ['HKLM\\SOFTWARE\\ZTools', '/reg:32'],
  ['HKLM\\SOFTWARE\\ZTools', '/reg:64']
])

const INSTALL_LOCALE_LINE_PATTERN = /^\s*InstallLocale\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/mi

export type RegQueryRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean; encoding: BufferEncoding }
) => Promise<{ stdout: string }>

export interface ReadInstallLocaleOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: RegQueryRunner
  readonly timeoutMs?: number
}

const defaultRegQueryRunner: RegQueryRunner = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    timeout: options.timeout,
    windowsHide: options.windowsHide,
    encoding: options.encoding
  })
  return { stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '') }
}

function parseRegQueryInstallLocale(stdout: string): SupportedLocale | null {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return null
  const match = INSTALL_LOCALE_LINE_PATTERN.exec(stdout)
  if (!match?.[1]) return null
  return matchSupportedLocale(match[1])
}

/**
 * 依次查询 HKCU\Software\ZTools 与 HKLM\SOFTWARE\ZTools（每个键分别查询 /reg:32 与 /reg:64）的 InstallLocale 值。
 * 单次查询超时 1000ms，全部未命中或失败时返回 null；支持注入 runner 以便无副作用单元测试。
 */
export async function readInstallLocale(
  runnerOrOptions?: RegQueryRunner | ReadInstallLocaleOptions
): Promise<SupportedLocale | null> {
  const options: ReadInstallLocaleOptions = typeof runnerOrOptions === 'function'
    ? { runner: runnerOrOptions }
    : (runnerOrOptions ?? {})
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null

  const runner = options.runner ?? defaultRegQueryRunner
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : INSTALL_LOCALE_QUERY_TIMEOUT_MS

  for (const [keyPath, viewFlag] of REGISTRY_QUERY_TARGETS) {
    try {
      const result = await runner(
        'reg',
        ['query', keyPath, '/v', 'InstallLocale', viewFlag],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }
      )
      const matched = parseRegQueryInstallLocale(result?.stdout ?? '')
      if (matched) return matched
    } catch {
      // 单条注册表视图不存在、无权限或超时时静默跳过，继续检查下一个目标
    }
  }
  return null
}

/**
 * 从命令行参数解析 `--lang=<locale>` 或 `--lang <locale>`。
 * 非受支持语种或空值返回 null，防止误覆盖后续优先级。
 */
export function parseCommandLineLocale(argv: readonly string[]): SupportedLocale | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (typeof arg !== 'string') continue
    if (arg.startsWith('--lang=')) {
      const value = arg.slice('--lang='.length).trim()
      const matched = matchSupportedLocale(value)
      if (matched) return matched
      continue
    }
    if (arg === '--lang' && index + 1 < argv.length) {
      const nextValue = argv[index + 1]
      if (typeof nextValue === 'string' && !nextValue.startsWith('-')) {
        const matched = matchSupportedLocale(nextValue.trim())
        if (matched) return matched
        index += 1
      }
    }
  }
  return null
}

export interface StartupLocaleConfigStore {
  has?(fileName: string, pathValue: string): Promise<boolean>
  get(fileName: string, pathValue: string, defaultValue: unknown): Promise<string>
  set(fileName: string, pathValue: string, value: string, syncEnabled: boolean): Promise<void>
}

export interface ResolveStartupLocaleOptions {
  readonly config: StartupLocaleConfigStore
  readonly argv: readonly string[]
  readonly systemLocale: string
  readonly readInstallLocaleImpl?: () => Promise<SupportedLocale | null>
  readonly onWarn?: (message: string, error?: unknown) => void
}

export interface ResolvedStartupLocale {
  readonly setting: LocaleSetting
  readonly resolved: SupportedLocale
  readonly source: 'config' | 'cli' | 'registry' | 'system'
}

const UNSET_SENTINEL = '__ZTOOLS_LOCALE_UNSET__'

/**
 * 解析冷启动语言优先级：
 * 1. user_settings.json 中已显式存在的 ui.locale 键（含显式设为 'system'，此时绝不查询注册表）；
 * 2. 命令行 --lang=<locale> / --lang <locale>；
 * 3. 注册表 InstallLocale（仅当 ui.locale 键不存在时查询，命中合法值后立即写回配置落盘）；
 * 4. 宿主系统语言 app.getLocale()。
 */
export async function resolveStartupLocale(
  options: ResolveStartupLocaleOptions
): Promise<ResolvedStartupLocale> {
  const { config, argv, systemLocale, onWarn } = options
  const queryInstallLocale = options.readInstallLocaleImpl ?? (() => readInstallLocale())

  let hasPersistedKey = false
  let persistedValue = ''
  try {
    if (typeof config.has === 'function') {
      hasPersistedKey = await config.has('user_settings.json', 'ui.locale')
      if (hasPersistedKey) {
        persistedValue = await config.get('user_settings.json', 'ui.locale', 'system')
      }
    } else {
      const raw = await config.get('user_settings.json', 'ui.locale', UNSET_SENTINEL)
      if (raw !== UNSET_SENTINEL) {
        hasPersistedKey = true
        persistedValue = raw
      }
    }
  } catch (error) {
    onWarn?.('Failed to read ui.locale from user_settings.json; falling back to startup locale chain:', error)
  }

  // 优先级 1：user_settings.json 中已显式存在 ui.locale 键（包括显式设为 'system'）
  if (hasPersistedKey) {
    const trimmed = typeof persistedValue === 'string' ? persistedValue.trim().toLowerCase() : ''
    if (!trimmed || trimmed === 'system') {
      return {
        setting: 'system',
        resolved: resolveLocale('system', systemLocale),
        source: 'config'
      }
    }
    const resolved = resolveLocale(persistedValue, systemLocale)
    return {
      setting: resolved,
      resolved,
      source: 'config'
    }
  }

  // 优先级 2：命令行 --lang
  const cliLocale = parseCommandLineLocale(argv)
  if (cliLocale) {
    return {
      setting: cliLocale,
      resolved: cliLocale,
      source: 'cli'
    }
  }

  // 优先级 3：注册表 InstallLocale（仅 ui.locale 键不存在时查询，读到合法值后立即写回落盘）
  try {
    const installLocale = await queryInstallLocale()
    if (installLocale) {
      try {
        await config.set('user_settings.json', 'ui.locale', installLocale, true)
      } catch (error) {
        onWarn?.('Failed to persist registry InstallLocale to user_settings.json:', error)
      }
      return {
        setting: installLocale,
        resolved: installLocale,
        source: 'registry'
      }
    }
  } catch (error) {
    onWarn?.('Failed to query registry InstallLocale:', error)
  }

  // 优先级 4：系统语言
  return {
    setting: 'system',
    resolved: resolveLocale('system', systemLocale),
    source: 'system'
  }
}
