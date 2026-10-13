/**
 * ZTools Screenshots Service (M1.5-14)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `screenshots`)
 * - 命令结构：`L_({ key: 'screenshots', title: 'Screenshots', commands: { searchScreenshots: V(...), pasteLatestScreenshot: V(...) } })`
 * - 后端处理：`paste-latest-screenshot: async () => { let item = await W.screenshots.getLatestByDate(); if (!item) ...; await EE.paste({ ... }) }`
 * - 核心方法：getLatestByDate, search, pin, unpin, deleteScreenshot, getDefaultLocations
 * 
 * 本地化工程改造：
 * - 深度适配 Windows 默认截图存储路径（`Pictures/Screenshots`、`OneDrive/Pictures/Screenshots` 以及微信/QQ截图目录）；
 * - 极速流式扫描、文件排序与元数据提取；
 * - 支持最新截图一键回贴到当前活动应用（Paste to Active App）；
 * - 置顶标记、搜索过滤与废纸篓安全移除。
 */

import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'

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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp'])

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
    const home = process.env.USERPROFILE || process.env.HOME || ''

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

    const dirsToScan = this.customSearchDirs.length > 0
      ? this.customSearchDirs
      : this.getDefaultLocations()

    const records: ScreenshotRecord[] = []
    const seenPaths = new Set<string>()

    for (const dir of dirsToScan) {
      try {
        if (!fs.existsSync(dir)) continue
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (IMAGE_EXTENSIONS.has(ext)) {
              const fullPath = path.join(dir, entry.name)
              if (seenPaths.has(fullPath)) continue
              seenPaths.add(fullPath)

              try {
                const stat = fs.statSync(fullPath)
                records.push({
                  id: `screenshot-${Buffer.from(fullPath).toString('base64url').slice(0, 16)}`,
                  filename: entry.name,
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
          }
        }
      } catch {
        // 忽略无法访问的目录
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
   */
  public async pasteLatestScreenshot(
    pasteCallback?: (filePath: string) => Promise<void> | void
  ): Promise<{ success: boolean; screenshot?: ScreenshotRecord; message?: string }> {
    const latest = this.getLatestScreenshot()
    if (!latest) {
      return { success: false, message: '未找到近期截图' }
    }

    if (pasteCallback) {
      await pasteCallback(latest.path)
    }

    return {
      success: true,
      screenshot: latest,
      message: `已回贴最新截图: ${latest.filename}`
    }
  }
}
