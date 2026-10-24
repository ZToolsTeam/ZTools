import { dialog, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { ReferenceDialogProvider } from '../services/path-reference-dialogs.js'
interface DialogDependencies {
  open?: (window: BrowserWindow, options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>
  save?: (window: BrowserWindow, options: Electron.SaveDialogOptions) => Promise<Electron.SaveDialogReturnValue>
  inspect?: (selectedPath: string) => Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }>
}

/** Reuse WindowService's existing trusted window/filter/property policies at the native UI boundary. */
export function createElectronReferenceDialogProvider(resolveWindow: (caller: CallerIdentity) => BrowserWindow,
  parseFilters: (value?: string) => Electron.FileFilter[] | undefined,
  normalizeProperties: (value?: string[]) => NonNullable<Electron.OpenDialogOptions['properties']>, dependencies: DialogDependencies = {}): ReferenceDialogProvider {
  return {
    async select(mode, options, caller) {
      const window = resolveWindow(caller)
      const suffix = mode === 'save' ? '写入授权' : mode === 'folder' && options.access === 'read-write' ? '读写授权' : '只读授权'
      const title = `${options.title ?? (mode === 'save' ? '保存文件' : mode === 'folder' ? '选择目录' : '选择文件')}（${suffix}）`
      const filters = parseFilters(options.filters)
      if (mode === 'save') {
        const result = await (dependencies.save ?? ((target, params) => dialog.showSaveDialog(target, params)))(window, { title, ...(filters ? { filters } : {}),
          ...(options.defaultName ? { defaultPath: options.defaultName } : {}) })
        if (result.canceled || window.isDestroyed()) return { canceled: true, selections: [] }
        if (!result.filePath) throw new ZToolsError(errorCodes.fileError, '保存选择未返回有效目标')
        return { canceled: false, selections: [{ absolutePath: result.filePath, kind: 'save' }] }
      }
      const result = await (dependencies.open ?? ((target, params) => dialog.showOpenDialog(target, params)))(window, { title, ...(filters ? { filters } : {}),
        properties: mode === 'folder' ? ['openDirectory'] : normalizeProperties(options.properties ? [...options.properties] : undefined) })
      if (result.canceled || window.isDestroyed()) return { canceled: true, selections: [] }
      if (!result.filePaths.length || result.filePaths.length > 64) throw new ZToolsError(errorCodes.fileError, '打开选择数量无效')
      const selections: { absolutePath: string; kind: 'file' | 'directory' }[] = []
      for (const selected of result.filePaths) {
        // Classification only; authorization and I/O are still performed by the native pinned object bridge.
        const metadata = await (dependencies.inspect ?? (selectedPath => fs.lstat(selectedPath)))(selected).catch(() => {
          throw new ZToolsError(errorCodes.fileError, '无法确认所选文件对象')
        })
        if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) throw new ZToolsError(errorCodes.permissionDenied, '文件选择不能授权链接或特殊对象')
        selections.push({ absolutePath: selected, kind: metadata.isDirectory() ? 'directory' : 'file' })
      }
      if (window.isDestroyed()) return { canceled: true, selections: [] }
      return { canceled: false, selections }
    }
  }
}
