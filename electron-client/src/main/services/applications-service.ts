/**
 * ZTools Applications & Uninstaller Service (M1.5-15)
 * 
 * 本地化工程改造：
 * - Windows 注册表（HKLM / HKCU 32/64位）全量已安装软件枚举；
 * - 提取 DisplayName、Publisher、Version、InstallLocation、UninstallString 等核心字段；
 * - 加入中文拼音全拼与首字母模糊匹配（如 "wx" / "weixin" -> 微信）；
 * - 支持安全启动官方卸载器（交互式或静默卸载）；
 * - 提供沙箱测试适配器支持跨端与单测覆盖。
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { shell } from 'electron'

const execFileAsync = promisify(execFile)

export interface InstalledApplicationRecord {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly publisher: string
  readonly installDate?: string | undefined
  readonly installLocation: string
  readonly uninstallString: string
  readonly quietUninstallString?: string | undefined
  readonly displayIcon?: string | undefined
  readonly estimatedSizeKb?: number | undefined
  readonly estimatedSize?: number | undefined
  readonly isSystemComponent: boolean
  readonly pinyin: string
  readonly pinyinInitials: string
  readonly bundleId?: string | undefined
  readonly leftoverPaths?: readonly string[] | undefined
}

export interface ApplicationRegistryScanner {
  scan(): Promise<readonly InstalledApplicationRecord[]>
}

export interface ApplicationUninstaller {
  uninstall(command: string, record?: InstalledApplicationRecord): Promise<{ success: boolean; error?: string; removedPaths?: string[] }>
}

/**
 * 拼音轻量简易提取器（针对高频中国软件快速映射）
 */
const KNOWN_PINYIN_MAP: Record<string, { pinyin: string; initials: string }> = {
  '微信': { pinyin: 'weixin', initials: 'wx' },
  '腾讯会议': { pinyin: 'tengxunhuiyi', initials: 'txhy' },
  '钉钉': { pinyin: 'dingding', initials: 'dd' },
  '网易云音乐': { pinyin: 'wangyiyunyinyue', initials: 'wyyyy' },
  '飞书': { pinyin: 'feishu', initials: 'fs' },
  '百度网盘': { pinyin: 'baiduwangpan', initials: 'bdwp' },
  '夸克': { pinyin: 'kuake', initials: 'kk' },
  '哔哩哔哩': { pinyin: 'bilibili', initials: 'blbl' },
  '向日葵': { pinyin: 'xiangrikui', initials: 'xrk' }
}

function computePinyin(name: string): { pinyin: string; initials: string } {
  for (const [key, val] of Object.entries(KNOWN_PINYIN_MAP)) {
    if (name.includes(key)) return val
  }
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return { pinyin: clean, initials: clean.slice(0, 4) }
}

/**
 * 将 Windows 卸载命令行拆分为可执行文件与参数数组（避免 shell: true）
 */
export function splitCommandArgs(commandLine: string): { executable: string; args: string[] } {
  const tokens: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return {
    executable: tokens[0] ?? '',
    args: tokens.slice(1)
  }
}

/**
 * 检索 macOS 应用程序在 ~/Library 下的关联残留路径
 */
export async function findMacosAppLeftovers(
  bundleId: string,
  appName: string,
  homeDir: string = os.homedir()
): Promise<string[]> {
  const cleanBundle = String(bundleId ?? '').trim().toLowerCase()
  const cleanName = String(appName ?? '').trim().toLowerCase()
  if (!cleanBundle && cleanName.length < 3) {
    return []
  }

  const libraryDirs = [
    path.join(homeDir, 'Library', 'Application Support'),
    path.join(homeDir, 'Library', 'Caches'),
    path.join(homeDir, 'Library', 'Preferences'),
    path.join(homeDir, 'Library', 'Saved Application State'),
    path.join(homeDir, 'Library', 'Containers'),
    path.join(homeDir, 'Library', 'Logs')
  ]

  const matchedPaths: string[] = []

  for (const dir of libraryDirs) {
    try {
      const entries = await fsPromises.readdir(dir)
      for (const entry of entries) {
        const lower = entry.toLowerCase()
        const matchByBundle = cleanBundle.length > 0 && lower.includes(cleanBundle)
        const matchByName = cleanName.length >= 3 && (
          lower === cleanName ||
          lower.startsWith(`${cleanName}.`) ||
          lower.includes(`.${cleanName}.`)
        )
        if (matchByBundle || matchByName) {
          matchedPaths.push(path.join(dir, entry))
        }
      }
    } catch {
      // 忽略不存在或无权限的子目录
    }
  }

  return matchedPaths
}

/**
 * macOS `.app` 应用程序包扫描器
 */
export class MacosApplicationScanner implements ApplicationRegistryScanner {
  private readonly searchDirs: readonly string[]

  constructor(searchDirs?: readonly string[]) {
    const home = os.homedir()
    this.searchDirs = searchDirs ?? [
      '/Applications',
      '/System/Applications',
      '/System/Applications/Utilities',
      ...(home ? [path.join(home, 'Applications')] : [])
    ]
  }

  async scan(): Promise<readonly InstalledApplicationRecord[]> {
    const records: InstalledApplicationRecord[] = []
    const seenPaths = new Set<string>()
    let index = 0

    for (const rootDir of this.searchDirs) {
      let entries: fs.Dirent[] = []
      try {
        entries = await fsPromises.readdir(rootDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('.app')) {
          continue
        }

        const appPath = path.join(rootDir, entry.name)
        if (seenPaths.has(appPath)) continue
        seenPaths.add(appPath)

        const fallbackName = entry.name.replace(/\.app$/i, '')
        let displayName = fallbackName
        let version = ''
        let bundleId = ''
        let publisher = ''

        const plistPath = path.join(appPath, 'Contents', 'Info.plist')
        if (fs.existsSync(plistPath)) {
          try {
            const { stdout } = await execFileAsync('/usr/bin/plutil', [
              '-convert',
              'json',
              '-o',
              '-',
              plistPath
            ], { encoding: 'utf8', timeout: 3000 })
            const plist = JSON.parse(String(stdout ?? '{}')) as Record<string, unknown>
            const rawName = plist.CFBundleDisplayName || plist.CFBundleName || fallbackName
            if (typeof rawName === 'string' && rawName.trim()) {
              displayName = rawName.trim()
            }
            if (typeof plist.CFBundleShortVersionString === 'string') {
              version = plist.CFBundleShortVersionString.trim()
            } else if (typeof plist.CFBundleVersion === 'string') {
              version = plist.CFBundleVersion.trim()
            }
            if (typeof plist.CFBundleIdentifier === 'string') {
              bundleId = plist.CFBundleIdentifier.trim()
              const parts = bundleId.split('.')
              if (parts.length >= 2) {
                publisher = parts[1] ?? ''
              }
            }
          } catch {
            // fallback to directory name
          }
        }

        const isSystemComponent = appPath.startsWith('/System/Applications') || bundleId.startsWith('com.apple.')
        const { pinyin, initials } = computePinyin(displayName)
        const leftovers = isSystemComponent ? [] : await findMacosAppLeftovers(bundleId, displayName)

        let mtimeDate = ''
        try {
          const stat = await fsPromises.stat(appPath)
          mtimeDate = stat.mtime.toISOString().slice(0, 10)
        } catch {
          // ignore
        }

        records.push({
          id: `app-${index++}-${Buffer.from(appPath).toString('base64url').slice(0, 12)}`,
          name: displayName,
          version: version || '1.0',
          publisher: publisher || (isSystemComponent ? 'Apple Inc.' : 'macOS Application'),
          installDate: mtimeDate,
          installLocation: appPath,
          uninstallString: appPath,
          displayIcon: appPath,
          isSystemComponent,
          pinyin,
          pinyinInitials: initials,
          ...(bundleId ? { bundleId } : {}),
          ...(leftovers.length > 0 ? { leftoverPaths: leftovers } : {})
        })
      }
    }

    return records
  }
}

/**
 * 默认 Windows 注册表扫描器
 */
export class WindowsRegistryScanner implements ApplicationRegistryScanner {
  async scan(): Promise<readonly InstalledApplicationRecord[]> {
    if (process.platform !== 'win32') {
      return []
    }

    // PowerShell 查询 3 大标准注册表卸载路径并输出 UTF-8 编码 JSON
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'SilentlyContinue'
      $paths = @(
        "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
        "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
        "HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
      )
      $apps = Get-ItemProperty $paths -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and $_.UninstallString -and -not $_.ParentKeyName } |
        Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation, InstallDate, UninstallString, QuietUninstallString, DisplayIcon, EstimatedSize, SystemComponent |
        Sort-Object DisplayName -Unique
      $apps | ConvertTo-Json -Compress
    `

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        psScript
      ], { maxBuffer: 30 * 1024 * 1024, windowsHide: true, timeout: 15000, encoding: 'utf8' })

      const raw = stdout.trim()
      if (!raw) return []

      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : [parsed]

      return list.map((item: Record<string, unknown>, index: number): InstalledApplicationRecord => {
        const name = String(item.DisplayName || '').trim()
        const { pinyin, initials } = computePinyin(name)
        const sizeKb = typeof item.EstimatedSize === 'number' && item.EstimatedSize > 0 ? item.EstimatedSize : undefined
        return {
          id: `app-${index}-${Buffer.from(name).toString('base64url').slice(0, 12)}`,
          name,
          version: String(item.DisplayVersion || ''),
          publisher: String(item.Publisher || ''),
          installDate: String(item.InstallDate || ''),
          installLocation: String(item.InstallLocation || ''),
          uninstallString: String(item.UninstallString || ''),
          isSystemComponent: Number(item.SystemComponent) === 1,
          pinyin,
          pinyinInitials: initials,
          ...(item.QuietUninstallString ? { quietUninstallString: String(item.QuietUninstallString) } : {}),
          ...(item.DisplayIcon ? { displayIcon: String(item.DisplayIcon) } : {}),
          ...(sizeKb !== undefined ? { estimatedSizeKb: sizeKb, estimatedSize: sizeKb * 1024 } : {})
        }
      })
    } catch (err) {
      console.warn('[ApplicationsService] Registry scan error:', err)
      return []
    }
  }
}

async function movePathToTrash(targetPath: string): Promise<void> {
  if (shell && typeof shell.trashItem === 'function') {
    await shell.trashItem(targetPath)
    return
  }
  if (process.platform === 'darwin') {
    await execFileAsync('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      'function run(argv) { var app = Application("Finder"); app.delete(Path(argv[0])); }',
      targetPath
    ], { timeout: 10000 })
    return
  }
  await fsPromises.rm(targetPath, { recursive: true, force: true })
}

export class DefaultApplicationUninstaller implements ApplicationUninstaller {
  async uninstall(
    command: string,
    record?: InstalledApplicationRecord
  ): Promise<{ success: boolean; error?: string; removedPaths?: string[] }> {
    const trimmed = command?.trim()
    if (!trimmed) throw new Error('卸载指令为空')

    // macOS `.app` 包与残留文件安全移入废纸篓
    if (process.platform === 'darwin' || trimmed.toLowerCase().endsWith('.app')) {
      if (
        record?.isSystemComponent ||
        trimmed.startsWith('/System/Applications') ||
        record?.installLocation?.startsWith('/System/Applications')
      ) {
        return { success: false, error: `系统应用 [${record?.name ?? trimmed}] 受系统保护，禁止卸载` }
      }
      try {
        const removedPaths: string[] = []
        if (fs.existsSync(trimmed)) {
          await movePathToTrash(trimmed)
          removedPaths.push(trimmed)
        }
        const leftovers = record?.leftoverPaths ?? (
          record?.bundleId ? await findMacosAppLeftovers(record.bundleId, record.name) : []
        )
        for (const itemPath of leftovers) {
          try {
            if (fs.existsSync(itemPath)) {
              await movePathToTrash(itemPath)
              removedPaths.push(itemPath)
            }
          } catch {
            // 忽略单个残留清理失败
          }
        }
        return { success: true, removedPaths }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    try {
      const { executable, args } = splitCommandArgs(trimmed)
      if (!executable) {
        return { success: false, error: '无效的卸载程序路径' }
      }
      const child = spawn(executable, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

export class ApplicationsService {
  private readonly scanner: ApplicationRegistryScanner
  private readonly uninstaller: ApplicationUninstaller
  private cachedApps: readonly InstalledApplicationRecord[] = []
  private lastScanned = 0
  private readonly cacheTtlMs = 60000 // 60秒缓存

  constructor(options: { scanner?: ApplicationRegistryScanner; uninstaller?: ApplicationUninstaller } = {}) {
    this.scanner = options.scanner || (
      process.platform === 'darwin' ? new MacosApplicationScanner() : new WindowsRegistryScanner()
    )
    this.uninstaller = options.uninstaller || new DefaultApplicationUninstaller()
  }

  /**
   * 获取所有已安装软件
   */
  public async getInstalledApplications(forceRefresh = false): Promise<readonly InstalledApplicationRecord[]> {
    const now = Date.now()
    if (!forceRefresh && this.lastScanned > 0 && now - this.lastScanned < this.cacheTtlMs) {
      return this.cachedApps
    }

    const apps = await this.scanner.scan()
    this.cachedApps = apps
    this.lastScanned = now
    return apps
  }

  /**
   * 搜索软件（支持中英文名称、发布者与拼音）
   */
  public async searchApplications(
    query: string = '',
    options: { includeSystemComponents?: boolean | undefined; forceRefresh?: boolean | undefined } = {}
  ): Promise<readonly InstalledApplicationRecord[]> {
    const raw = (typeof query === 'string' ? query : '').trim().toLowerCase()
    const all = await this.getInstalledApplications(options.forceRefresh)

    return all.filter((app) => {
      if (!options.includeSystemComponents && app.isSystemComponent) {
        return false
      }
      if (!raw) return true

      if (app.name.toLowerCase().includes(raw)) return true
      if (app.publisher.toLowerCase().includes(raw)) return true
      if (app.pinyin.includes(raw)) return true
      if (app.pinyinInitials.includes(raw)) return true
      if (app.bundleId && app.bundleId.toLowerCase().includes(raw)) return true
      return false
    })
  }

  /**
   * 启动官方卸载器或将 macOS .app 移至废纸篓
   */
  public async launchUninstall(appIdOrName: string, quiet = false): Promise<{ success: boolean; message: string; error?: string }> {
    const all = await this.getInstalledApplications()
    const matched = all.find(a => a.id === appIdOrName || a.name.toLowerCase() === appIdOrName.toLowerCase())

    if (!matched) {
      throw new Error(`未找到应用程序: ${appIdOrName}`)
    }

    if (
      matched.installLocation.startsWith('/System/Applications') ||
      matched.uninstallString.startsWith('/System/Applications')
    ) {
      throw new Error(`系统核心应用 [${matched.name}] 受系统保护，禁止卸载`)
    }

    const uninstallCmd = (quiet && matched.quietUninstallString)
      ? matched.quietUninstallString
      : matched.uninstallString

    if (!uninstallCmd) {
      throw new Error(`应用 [${matched.name}] 未提供有效卸载命令`)
    }

    const res = await this.uninstaller.uninstall(uninstallCmd, matched)
    if (!res.success) {
      throw new Error(res.error || `启动卸载程序失败: ${matched.name}`)
    }

    return {
      success: true,
      message: `已启动 [${matched.name}] 卸载程序`
    }
  }

  public async uninstallApplication(appIdOrName: string): Promise<{ success: boolean; message: string; error?: string }> {
    return this.launchUninstall(appIdOrName)
  }
}
