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
      throw new ZToolsError(errorCodes.shellError, '只允许打开普通文件或目录')
    }
    const message = await this.adapter.openPath(target)
    if (message !== '') throw new ZToolsError(errorCodes.shellError, '打开失败')
    return { success: true }
  }

  async trashItem(params: ShellPathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.#resolve(params.fullPath, caller, 'write', false)
    const stats = await this.#stat(target)
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new ZToolsError(errorCodes.shellError, '只允许回收普通文件或目录')
    }
    try {
      await this.adapter.trashItem(target)
      return { success: true }
    } catch {
      throw new ZToolsError(errorCodes.shellError, '移动到回收站失败')
    }
  }

  async showItemInFolder(params: ShellPathParams, caller: CallerIdentity): Promise<{ success: true }> {
    const target = await this.#resolve(params.fullPath, caller, 'read', true)
    try {
      const stats = await fs.stat(target)
      if (stats.isDirectory()) {
        const message = await this.adapter.openPath(target)
        if (message !== '') throw new ZToolsError(errorCodes.shellError, '打开目录失败')
      } else if (stats.isFile()) {
        this.adapter.showItemInFolder(target)
      } else {
        throw new ZToolsError(errorCodes.shellError, '目标不是普通文件或目录')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(target)
      const parentStats = await this.#stat(parent)
      if (!parentStats.isDirectory()) throw new ZToolsError(errorCodes.shellError, '目标父目录不存在')
      const message = await this.adapter.openPath(parent)
      if (message !== '') throw new ZToolsError(errorCodes.shellError, '打开目录失败')
    }
    return { success: true }
  }

  async openExternal(params: ShellOpenExternalParams): Promise<{ success: true }> {
    let target: URL
    try {
      target = new URL(params.url)
    } catch {
      throw new ZToolsError(errorCodes.invalidRequest, 'url 无效')
    }
    if (
      (target.protocol !== 'http:' && target.protocol !== 'https:') ||
      target.username !== '' ||
      target.password !== ''
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, '只允许无凭据的 HTTP/HTTPS URL')
    }
    try {
      await this.adapter.openExternal(target.href, { activate: true })
      return { success: true }
    } catch {
      throw new ZToolsError(errorCodes.shellError, '打开外部 URL 失败')
    }
  }

  beep(): { success: true } {
    this.adapter.beep()
    return { success: true }
  }

  exec(): never {
    throw new ZToolsError(errorCodes.notSupported, 'Electron 不允许 renderer 执行任意 shell 命令')
  }

  async #resolve(
    value: string,
    caller: CallerIdentity,
    access: 'read' | 'write',
    allowMissing: boolean
  ): Promise<string> {
    if (value.toLowerCase().startsWith('ztools://file/')) {
      if (!this.files.canLoadFileCapability(value, caller.webContentsId)) {
        throw new ZToolsError(errorCodes.permissionDenied, '文件 capability 不属于当前窗口')
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
        throw new ZToolsError(errorCodes.shellError, '文件或目录不存在')
      }
      throw new ZToolsError(errorCodes.shellError, '无法访问文件或目录')
    }
  }
}
