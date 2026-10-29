import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { shell } from 'electron'
import type { SidecarManager, SearchFilesResult } from './sidecar-manager.js'

export interface FileActionResult {
  success: boolean
  path: string
  error?: string
}

export interface FileSha256Result {
  success: boolean
  path: string
  sha256?: string
  sizeBytes?: number
  elapsedMs?: number
  error?: string
}

export interface FileSearchServiceOptions {
  sidecarManager: SidecarManager
}

/**
 * 文件秒搜服务 (File Search Service)
 * Windows 联动 C++ 辅助进程 ztools-indexer.exe，macOS 使用 Spotlight (mdfind)，支持全盘文件毫秒检索、打开、定位、Quick Look 与 SHA-256 哈希计算
 */
export class FileSearchService {
  constructor(private readonly options: FileSearchServiceOptions) {}

  /**
   * 检索文件 (调用 Rust 侧车、macOS Spotlight 或内存回退)
   */
  public async search(query: string, limit = 50): Promise<SearchFilesResult> {
    const cleanQuery = typeof query === 'string' ? query.trim() : ''
    return this.options.sidecarManager.searchFiles(cleanQuery, limit)
  }

  /**
   * 调起系统默认应用打开文件
   */
  public async openFile(targetPath: string): Promise<FileActionResult> {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, path: '', error: '无效的文件路径' }
    }
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) {
      return { success: false, path: resolved, error: '文件不存在' }
    }

    try {
      const errMsg = await shell.openPath(resolved)
      if (errMsg) {
        return { success: false, path: resolved, error: errMsg }
      }
      return { success: true, path: resolved }
    } catch (err: unknown) {
      return { success: false, path: resolved, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 在文件管理器 (Explorer / Finder) 中定位并选中文件
   */
  public revealFile(targetPath: string): FileActionResult {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, path: '', error: '无效的文件路径' }
    }
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) {
      return { success: false, path: resolved, error: '文件或目录不存在' }
    }

    try {
      shell.showItemInFolder(resolved)
      return { success: true, path: resolved }
    } catch (err: unknown) {
      return { success: false, path: resolved, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 唤起系统级快速预览 (macOS Quick Look: /usr/bin/qlmanage -p <path>)
   */
  public async quickLookSelection(filePath: string): Promise<FileActionResult> {
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
      return { success: false, path: '', error: '无效的文件路径' }
    }
    const normalized = path.resolve(filePath.trim())
    if (!fs.existsSync(normalized)) {
      return { success: false, path: normalized, error: '文件不存在' }
    }

    if (process.platform === 'darwin') {
      try {
        const child = spawn('/usr/bin/qlmanage', ['-p', normalized], {
          detached: true,
          stdio: 'ignore'
        })
        child.on('error', (err) => console.warn('[QuickLook] 进程启动失败:', err))
        child.unref()
        return { success: true, path: normalized }
      } catch (err: unknown) {
        return { success: false, path: normalized, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return this.revealFile(normalized)
  }

  /**
   * 流式计算文件 SHA-256 校验和 (严控内存占用，支持大文件)
   */
  public async calculateSha256(targetPath: string): Promise<FileSha256Result> {
    if (!targetPath || typeof targetPath !== 'string') {
      return { success: false, path: '', error: '无效的文件路径' }
    }
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) {
      return { success: false, path: resolved, error: '文件不存在' }
    }

    const t0 = performance.now()
    try {
      const stat = await fs.promises.stat(resolved)
      if (stat.isDirectory()) {
        return { success: false, path: resolved, error: '目标为目录，无法直接计算单个文件哈希' }
      }

      return await new Promise<FileSha256Result>((resolve) => {
        const hash = createHash('sha256')
        const stream = fs.createReadStream(resolved)

        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('error', (err) => {
          resolve({
            success: false,
            path: resolved,
            error: `读取流失败: ${err.message}`
          })
        })
        stream.on('end', () => {
          const sha256 = hash.digest('hex')
          const elapsedMs = performance.now() - t0
          resolve({
            success: true,
            path: resolved,
            sha256,
            sizeBytes: stat.size,
            elapsedMs: Math.round(elapsedMs * 100) / 100
          })
        })
      })
    } catch (err: unknown) {
      return { success: false, path: resolved, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 触发重新索引指定目录
   */
  public async indexPath(dirPath: string) {
    return this.options.sidecarManager.indexPath(dirPath)
  }
}
