import fs from 'node:fs/promises'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  ShellOpenExternalParams,
  ShellPathParams
} from '../../contracts/method-params.js'
import type { FileSystemService } from './file-system-service.js'

export interface ShellAdapter {
  openPath(target: string): Promise<string>
  trashItem(target: string): Promise<void>
  showItemInFolder(target: string): void
  openExternal(url: string, options?: { activate?: boolean }): Promise<void>
  beep(): void
}

export class ShellService {
  constructor(
    private readonly files: FileSystemService,
    private readonly adapter: ShellAdapter
  ) {}

  async openPath(params: ShellPathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.#resolve(params.fullPath, caller, 'read', false)
    const stats = await this.#stat(target)
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new ZToolsError(errorCodes.shellError, 'Only regular files or directories can be opened')
    }
    const message = await this.adapter.openPath(target)
    if (message !== '') throw new ZToolsError(errorCodes.shellError, 'Failed to open path')
    return { success: true }
  }

  async trashItem(params: ShellPathParams, caller: CallerIdentity): Promise<{ success: true }> {
    // trash 访问级别：普通 write 授权，或宿主扫描 / 搜索给同一插件的普通文件结果授权（只有这里使用 trash）
    const target = await this.#resolve(params.fullPath, caller, 'trash', false)
    const stats = await this.#stat(target)
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new ZToolsError(errorCodes.shellError, 'Only regular files or directories can be moved to trash')
    }
    try {
      await this.adapter.trashItem(target)
      return { success: true }
    } catch {
      throw new ZToolsError(errorCodes.shellError, 'Failed to move item to trash')
    }
  }

  async showItemInFolder(params: ShellPathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.#resolve(params.fullPath, caller, 'read', true)
    try {
      const stats = await fs.stat(target)
      if (stats.isDirectory()) {
        const message = await this.adapter.openPath(target)
        if (message !== '') throw new ZToolsError(errorCodes.shellError, 'Failed to open directory')
      } else if (stats.isFile()) {
        this.adapter.showItemInFolder(target)
      } else {
        throw new ZToolsError(errorCodes.shellError, 'Target is not a regular file or directory')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(target)
      const parentStats = await this.#stat(parent)
      if (!parentStats.isDirectory()) throw new ZToolsError(errorCodes.shellError, 'Target parent directory does not exist')
      const message = await this.adapter.openPath(parent)
      if (message !== '') throw new ZToolsError(errorCodes.shellError, 'Failed to open directory')
    }
    return { success: true }
  }

  async openExternal(params: ShellOpenExternalParams): Promise<{ success: true }> {
    let target: URL
    try {
      target = new URL(params.url)
    } catch {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid URL')
    }
    if (
      (target.protocol !== 'http:' && target.protocol !== 'https:') ||
      target.username !== '' ||
      target.password !== ''
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Only credential-free HTTP/HTTPS URLs are allowed')
    }
    try {
      await this.adapter.openExternal(target.href, { activate: true })
      return { success: true }
    } catch {
      throw new ZToolsError(errorCodes.shellError, 'Failed to open external URL')
    }
  }

  beep(): { success: true } {
    this.adapter.beep()
    return { success: true }
  }

  exec(): never {
    throw new ZToolsError(errorCodes.notSupported, 'Arbitrary shell execution from renderer is not allowed in Electron')
  }

  async #resolve(
    value: string,
    caller: CallerIdentity,
    access: 'read' | 'write' | 'trash',
    allowMissing: boolean
  ): Promise<string> {
    if (value.toLowerCase().startsWith('ztools://file/')) {
      if (!this.files.canLoadFileCapability(value, caller.webContentsId)) {
        throw new ZToolsError(errorCodes.permissionDenied, 'File capability does not belong to the current window')
      }
      const target = await this.files.resolveFileCapability(value)
      return this.files.resolveAuthorizedPath(target, caller, access, allowMissing)
    }
    return this.files.resolveAuthorizedPath(value, caller, access, allowMissing)
  }

  async #stat(target: string): Promise<Awaited<ReturnType<typeof fs.stat>>> {
    try {
      return await fs.stat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ZToolsError(errorCodes.shellError, 'File or directory does not exist')
      }
      throw new ZToolsError(errorCodes.shellError, 'Unable to access file or directory')
    }
  }
}
