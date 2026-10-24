/**
 * ZTools Screenshots Service (M1.5-14)
 * 
 * 本地化工程改造：
 * - 深度适配 Windows 默认截图存储路径（`Pictures/Screenshots`、`OneDrive/Pictures/Screenshots` 以及微信/QQ截图目录）；
 * - 极速流式扫描、文件排序与元数据提取；
 * - 支持最新截图一键回贴到当前活动应用（Paste to Active App）；
 * - 置顶标记、搜索过滤与废纸篓安全移除。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export interface ScreenshotRecord {
  readonly id: string
  readonly filename: string
  readonly path: string
  readonly size: number
  readonly createdAt: number
  readonly modifiedAt: number
  readonly pinned: boolean
  readonly isOnlineOnly?: boolean
}

export interface ScreenshotSearchOptions {
  query?: string
  limit?: number
  pinnedFirst?: boolean
  dateStart?: number
  dateEnd?: number
}

export interface ScreenshotsServiceOptions {
  searchDirectories?: readonly string[]
  maxScanLimit?: number
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.heic', '.tiff'])
const MACOS_DESKTOP_SCREENSHOT_NAME_RE = /^(screen\s*shot|screenshot|截屏|屏幕截图|cleanshot|ishot|xnip|snipaste)/i

/** 截图 id：完整路径的 SHA-256 前 24 位十六进制，同目录不同文件不会撞 id */
export function screenshotIdForPath(fullPath: string): string {
  return `screenshot-${createHash('sha256').update(fullPath).digest('hex').slice(0, 24)}`
}

export interface PasteLatestCallbackResult {
  /** 是否已自动粘贴到前台应用；false 表示只复制到了剪贴板 */
  pasted: boolean
}

export interface PasteLatestResult {
  success: boolean
  screenshot?: ScreenshotRecord
  copied?: boolean
  pasted?: boolean
  code?: string
  message?: string
}

export class ScreenshotsService {
  private customSearchDirs: string[] = []
  private readonly pinnedPaths = new Set<string>()
  private cache: ScreenshotRecord[] = []
  private lastScanTime = 0
  private readonly cacheTtlMs = 5000 // 5秒轻量缓存

  constructor(options: ScreenshotsServiceOptions = {}) {
    if (options.searchDirectories) {
      this.customSearchDirs = [...options.searchDirectories]
    }
  }

  /**
   * 获取默认截图探测目录
   */
  public getDefaultLocations(): readonly string[] {
    const locations: string[] = []
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || ''

    if (process.platform === 'darwin') {
      try {
        const customLoc = execFileSync('/usr/bin/defaults', [
          'read',
          'com.apple.screencapture',
          'location'
        ], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (customLoc) {
          const resolved = customLoc.startsWith('~') && home
            ? path.join(home, customLoc.slice(1))
            : customLoc
          if (fs.existsSync(resolved) && !locations.includes(resolved)) {
            locations.push(resolved)
          }
        }
      } catch {
        // 未自定义 com.apple.screencapture location 时使用默认目录
      }

      if (home) {
        const desktopDir = path.join(home, 'Desktop')
        if (fs.existsSync(desktopDir) && !locations.includes(desktopDir)) {
          locations.push(desktopDir)
        }
        const macScreenshots = path.join(home, 'Pictures', 'Screenshots')
        if (fs.existsSync(macScreenshots) && !locations.includes(macScreenshots)) {
          locations.push(macScreenshots)
        }
      }
      return locations
    }

    if (home) {
      // 1. Windows 标准截图目录 Win + PrtScn
      const winScreenshots = path.join(home, 'Pictures', 'Screenshots')
      if (fs.existsSync(winScreenshots)) {
        locations.push(winScreenshots)
      }

      // 2. OneDrive 同步截图目录
      const oneDriveScreenshots = path.join(home, 'OneDrive', 'Pictures', 'Screenshots')
      if (fs.existsSync(oneDriveScreenshots)) {
        locations.push(oneDriveScreenshots)
      }

      // 3. 图片主目录
      const pictures = path.join(home, 'Pictures')
      if (fs.existsSync(pictures) && !locations.includes(pictures)) {
        locations.push(pictures)
      }
    }

    return locations
  }

  public setSearchDirectories(dirs: readonly string[]): void {
    this.customSearchDirs = [...dirs]
    this.cache = []
    this.lastScanTime = 0
  }

  /**
   * 扫描目录获取所有截图文件
   */
  public scanScreenshots(forceRefresh = false): readonly ScreenshotRecord[] {
    const now = Date.now()
    if (!forceRefresh && this.cache.length > 0 && now - this.lastScanTime < this.cacheTtlMs) {
      return this.cache
    }

    const usingCustomDirs = this.customSearchDirs.length > 0
    const dirsToScan = usingCustomDirs
      ? this.customSearchDirs
      : this.getDefaultLocations()

    const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || ''
    const macDesktopDir = process.platform === 'darwin' && home ? path.resolve(home, 'Desktop') : ''

    const records: ScreenshotRecord[] = []
    const seenPaths = new Set<string>()

    const addFileRecord = (fullPath: string, filename: string) => {
      if (seenPaths.has(fullPath)) return
      seenPaths.add(fullPath)
      try {
        const stat = fs.statSync(fullPath)
        if (!stat.isFile()) return
        records.push({
          id: screenshotIdForPath(fullPath),
          filename,
          path: fullPath,
          size: stat.size,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          modifiedAt: stat.mtimeMs,
          pinned: this.pinnedPaths.has(fullPath)
        })
      } catch {
        // 忽略单个文件状态读取异常
      }
    }

    for (const dir of dirsToScan) {
      try {
        if (!fs.existsSync(dir)) continue
        const isMacDesktop = !usingCustomDirs && macDesktopDir && path.resolve(dir) === macDesktopDir
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (IMAGE_EXTENSIONS.has(ext)) {
              if (isMacDesktop && !MACOS_DESKTOP_SCREENSHOT_NAME_RE.test(entry.name)) {
                continue
              }
              const fullPath = path.join(dir, entry.name)
              addFileRecord(fullPath, entry.name)
            }
          }
        }
      } catch {
        // 忽略无法访问的目录
      }
    }

    // macOS Spotlight 元数据 kMDItemIsScreenCapture == 1 补充探测
    if (process.platform === 'darwin' && !usingCustomDirs) {
      try {
        const stdout = execFileSync('/usr/bin/mdfind', ['kMDItemIsScreenCapture == 1'], {
          encoding: 'utf8',
          timeout: 2000,
          maxBuffer: 2 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        const lines = String(stdout ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 150)
        for (const filePath of lines) {
          const ext = path.extname(filePath).toLowerCase()
          if (IMAGE_EXTENSIONS.has(ext)) {
            addFileRecord(filePath, path.basename(filePath))
          }
        }
      } catch {
        // 忽略 mdfind 不可用或超时
      }
    }

    // 默认按修改时间降序排序
    records.sort((a, b) => b.modifiedAt - a.modifiedAt)
    this.cache = records
    this.lastScanTime = now
    return this.cache
  }

  /**
   * 搜索截图记录
   */
  public searchScreenshots(options: ScreenshotSearchOptions = {}): readonly ScreenshotRecord[] {
    const all = this.scanScreenshots()
    const rawQuery = (options.query || '').trim().toLowerCase()
    const limit = options.limit && options.limit > 0 ? options.limit : 100
    const pinnedFirst = options.pinnedFirst !== false

    let filtered = all

    if (rawQuery) {
      filtered = filtered.filter(item => item.filename.toLowerCase().includes(rawQuery) || item.path.toLowerCase().includes(rawQuery))
    }

    if (options.dateStart) {
      filtered = filtered.filter(item => item.modifiedAt >= options.dateStart!)
    }

    if (options.dateEnd) {
      filtered = filtered.filter(item => item.modifiedAt <= options.dateEnd!)
    }

    if (pinnedFirst) {
      filtered = [...filtered].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.modifiedAt - a.modifiedAt
      })
    }

    return filtered.slice(0, limit)
  }

  /**
   * 获取最新拍摄的一张截图
   */
  public getLatestScreenshot(): ScreenshotRecord | null {
    const all = this.scanScreenshots(true)
    return all.length > 0 ? (all[0] ?? null) : null
  }

  /**
   * 校验调用方传入的路径必须是宿主扫描到的截图（先查缓存，未命中再强制重扫一次），
   * 返回扫描记录；其余路径（任意文件、../ 穿越、目录内的符号链接等）一律拒绝。
   */
  public async resolveScannedScreenshot(filePath: unknown): Promise<ScreenshotRecord> {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) {
      throw new ZToolsError(errorCodes.invalidRequest, '截图路径无效')
    }
    const candidates = new Set<string>([path.resolve(filePath)])
    try {
      candidates.add(await fs.promises.realpath(filePath))
    } catch {
      // 文件不存在时只按规范化路径匹配
    }
    const find = (records: readonly ScreenshotRecord[]) =>
      records.find((item) => candidates.has(path.resolve(item.path)))
    const target = find(this.cache) ?? find(this.scanScreenshots(true))
    if (!target) {
      throw new ZToolsError(errorCodes.permissionDenied, '只能操作截图列表中的文件')
    }
    let isRegularFile = false
    try {
      isRegularFile = (await fs.promises.lstat(target.path)).isFile()
    } catch {
      this.cache = this.cache.filter((item) => item.path !== target.path)
      throw new ZToolsError(errorCodes.fileError, `文件不存在: ${target.path}`)
    }
    if (!isRegularFile) {
      throw new ZToolsError(errorCodes.permissionDenied, '只能操作截图列表中的普通文件')
    }
    return target
  }

  /**
   * 置顶/取消置顶截图
   */
  public pinScreenshot(filePath: string): boolean {
    if (!filePath) return false
    this.pinnedPaths.add(filePath)
    this.cache = this.cache.map(item => item.path === filePath ? { ...item, pinned: true } : item)
    return true
  }

  public unpinScreenshot(filePath: string): boolean {
    if (!filePath) return false
    this.pinnedPaths.delete(filePath)
    this.cache = this.cache.map(item => item.path === filePath ? { ...item, pinned: false } : item)
    return true
  }

  public togglePin(filePath: string): boolean {
    if (this.pinnedPaths.has(filePath)) {
      this.unpinScreenshot(filePath)
      return false
    } else {
      this.pinScreenshot(filePath)
      return true
    }
  }

  /**
   * 删除截图（移至废纸篓）
   */
  public async deleteScreenshot(filePath: string): Promise<boolean> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`)
    }

    try {
      if (shell && typeof shell.trashItem === 'function') {
        await shell.trashItem(filePath)
      } else {
        await fs.promises.unlink(filePath)
      }

      this.cache = this.cache.filter(item => item.path !== filePath)
      this.pinnedPaths.delete(filePath)
      return true
    } catch (err) {
      throw new Error(`删除截图失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 一键回贴最新截图 (Paste Latest Screenshot)
   * pasteCallback 负责把图片写入剪贴板并尽量粘贴到前台应用；没有回调时如实返回不支持。
   */
  public async pasteLatestScreenshot(
    pasteCallback?: (filePath: string) => Promise<PasteLatestCallbackResult> | PasteLatestCallbackResult
  ): Promise<PasteLatestResult> {
    const latest = this.getLatestScreenshot()
    if (!latest) {
      return { success: false, code: 'NO_SCREENSHOTS', message: '未找到近期截图' }
    }

    if (!pasteCallback) {
      return { success: false, code: errorCodes.notSupported, screenshot: latest, message: '当前环境不支持回贴截图' }
    }

    let pasted = false
    try {
      pasted = Boolean((await pasteCallback(latest.path))?.pasted)
    } catch (err) {
      return {
        success: false,
        code: err instanceof ZToolsError ? err.code : errorCodes.clipboardError,
        screenshot: latest,
        copied: false,
        pasted: false,
        message: `复制截图失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const pasteKey = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
    return {
      success: true,
      screenshot: latest,
      copied: true,
      pasted,
      message: pasted
        ? `已粘贴最新截图: ${latest.filename}`
        : `已复制最新截图: ${latest.filename}，请按 ${pasteKey} 粘贴`
    }
  }
}
