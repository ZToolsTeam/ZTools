/**
 * ZTools Applications & Uninstaller Service (M1.5-15)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `applications`)
 * - 命令结构：`L_({ key: 'applications', title: 'Applications', commands: { uninstall: V({ title: 'Uninstall Applications' }), manageAutoQuits: V(...) } })`
 * - 动作处理：`uninstall: { name: 'uninstall', title: 'Uninstall Application', handler: 'uninstall-application' }`
 * 
 * 本地化工程改造：
 * - Windows 注册表（HKLM / HKCU 32/64位）全量已安装软件枚举；
 * - 提取 DisplayName、Publisher、Version、InstallLocation、UninstallString 等核心字段；
 * - 加入中文拼音全拼与首字母模糊匹配（如 "wx" / "weixin" -> 微信）；
 * - 支持安全启动官方卸载器（交互式或静默卸载）；
 * - 提供沙箱测试适配器支持跨端与单测覆盖。
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

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
}

export interface ApplicationRegistryScanner {
  scan(): Promise<readonly InstalledApplicationRecord[]>
}

export interface ApplicationUninstaller {
  uninstall(command: string): Promise<{ success: boolean; error?: string }>
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

export class DefaultApplicationUninstaller implements ApplicationUninstaller {
  async uninstall(command: string): Promise<{ success: boolean; error?: string }> {
    if (!command?.trim()) throw new Error('卸载指令为空')
    try {
      // 启动卸载程序进程
      const child = spawn(command, { shell: true, detached: true, stdio: 'ignore' })
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
    this.scanner = options.scanner || new WindowsRegistryScanner()
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
      return false
    })
  }

  /**
   * 启动官方卸载器
   */
  public async launchUninstall(appIdOrName: string, quiet = false): Promise<{ success: boolean; message: string; error?: string }> {
    const all = await this.getInstalledApplications()
    const matched = all.find(a => a.id === appIdOrName || a.name.toLowerCase() === appIdOrName.toLowerCase())

    if (!matched) {
      throw new Error(`未找到应用程序: ${appIdOrName}`)
    }

    const uninstallCmd = (quiet && matched.quietUninstallString)
      ? matched.quietUninstallString
      : matched.uninstallString

    if (!uninstallCmd) {
      throw new Error(`应用 [${matched.name}] 未提供有效卸载命令`)
    }

    const res = await this.uninstaller.uninstall(uninstallCmd)
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
