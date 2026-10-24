import fs from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PluginDirectoryProvider, PluginManifest } from './plugin-install-service.js'

export interface ShortcutWriter {
  (shortcutPath: string, options: Electron.ShortcutDetails): boolean
}

function shortcutName(manifest: PluginManifest): string {
  const value = manifest.name
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
  return value || manifest.id
}

async function ordinaryFile(target: string): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => undefined)
  return stat?.isFile() === true && stat.isSymbolicLink() === false
}

export class PluginShortcutService {
  constructor(
    private readonly manifests: PluginDirectoryProvider,
    private readonly desktopPath: string,
    private readonly executablePath: string,
    private readonly writeShortcut: ShortcutWriter,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async create(pluginId: string): Promise<{ success: true; pluginId: string; shortcutPath: string }> {
    if (this.platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, '当前平台不支持桌面快捷方式')
    }
    return this.manifests.withPluginDirectory(pluginId, async (manifest, pluginRoot) => {
      const shortcutPath = path.join(this.desktopPath, `${shortcutName(manifest)}.lnk`)
      const iconPath = path.join(pluginRoot, 'icon.ico')
      const options: Electron.ShortcutDetails = {
        target: this.executablePath,
        args: `--plugin "${manifest.id}"`,
        ...(typeof manifest.description === 'string'
          ? { description: manifest.description.slice(0, 1024) }
          : {}),
        ...(await ordinaryFile(iconPath) ? { icon: iconPath, iconIndex: 0 } : {})
      }
      if (!this.writeShortcut(shortcutPath, options)) {
        throw new ZToolsError(errorCodes.storageError, '创建插件桌面快捷方式失败')
      }
      return { success: true, pluginId: manifest.id, shortcutPath }
    })
  }

  async remove(pluginId: string): Promise<{ success: true; pluginId: string; shortcutPath: string; removed: boolean }> {
    if (this.platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, '当前平台不支持桌面快捷方式')
    }
    return this.manifests.withPluginDirectory(pluginId, async (manifest) => {
      const shortcutPath = path.join(this.desktopPath, `${shortcutName(manifest)}.lnk`)
      const stats = await fs.lstat(shortcutPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new ZToolsError(errorCodes.storageError, '读取插件桌面快捷方式失败')
      })
      if (stats === undefined) return { success: true, pluginId: manifest.id, shortcutPath, removed: false }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new ZToolsError(errorCodes.permissionDenied, '插件桌面快捷方式不是普通文件')
      }
      await fs.rm(shortcutPath)
      return { success: true, pluginId: manifest.id, shortcutPath, removed: true }
    })
  }
}
