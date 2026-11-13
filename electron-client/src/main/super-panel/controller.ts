import {
  app,
  dialog,
  shell,
  type BrowserWindow
} from 'electron'
import type { ConfigService } from '../services/config-service.js'
import type { PluginStateProvider } from '../services/plugin-state-service.js'
import type { SystemToolsProvider } from '../services/system-tools-service.js'
import { SuperPanelDataService } from './data-service.js'

const ITEM_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64}))$/i
const SYSTEM_TOOL_ITEM_ID_PATTERN = /^system-tool:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label} 无效`)
  }
  return value
}

export interface SuperPanelControllerOptions {
  dataRoot: string
  config: Pick<ConfigService, 'get' | 'set'>
  getInstalledPlugins(): Promise<{ success: true; data: Record<string, unknown>[] }>
  openPlugin(pluginId: string): Promise<unknown>
  systemTools?: SystemToolsProvider
  pluginState?: PluginStateProvider
}

/**
 * 悬浮条的数据能力（固定项、本地软件、系统工具、最近使用）。
 * 旧超级面板窗口已移除，这里只保留悬浮条与本地软件快捷键在用的数据接口。
 */
export class SuperPanelController {
  readonly #data: SuperPanelDataService
  #stopping = false

  constructor(private readonly options: SuperPanelControllerOptions) {
    this.#data = new SuperPanelDataService(
      options.dataRoot,
      options.config,
      options.getInstalledPlugins,
      (target) => shell.openPath(target),
      options.pluginState,
      undefined,
      async (target) => (await app.getFileIcon(target, { size: 'large' })).toDataURL(),
      options.systemTools
    )
  }

  launchLocalApp(appId: string): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error('应用正在退出'))
    if (!/^localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64})$/i.test(appId)) {
      return Promise.reject(new Error('本地应用快捷键目标不受支持'))
    }
    return this.#data.launchLocalApp(appId)
  }

  getPanelLocalApps(): Promise<Array<{ id: string; name: string }>> {
    return this.#data.getPanelLocalApps()
  }

  getData(): ReturnType<SuperPanelDataService['getData']> {
    if (this.#stopping) return Promise.reject(new Error('应用正在退出'))
    return this.#data.getData()
  }

  async togglePin(id: string, itemType: string): Promise<{ success: true; pinned: boolean }> {
    if (this.#stopping) throw new Error('应用正在退出')
    const validId = requireText(id, '项目 ID', 128)
    const validType = requireText(itemType, '项目类型', 32)
    return { success: true, pinned: await this.#data.togglePin(validId, validType) }
  }

  async addLocalAppsForWindow(targetWindow: BrowserWindow | null): Promise<{ success: true; added: number }> {
    if (this.#stopping) throw new Error('应用正在退出')
    const dialogParent = targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined
    const dialogOptions: Electron.OpenDialogOptions = {
      title: '添加本地软件',
      properties: ['openFile', 'multiSelections'],
      filters: process.platform === 'darwin'
        ? [{ name: 'macOS 应用程序', extensions: ['app'] }]
        : [{ name: 'Windows 程序', extensions: ['exe'] }]
    }
    const result = dialogParent
      ? await dialog.showOpenDialog(dialogParent, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
    const added = result.canceled ? 0 : await this.#data.addLocalApps(result.filePaths)
    if (!result.canceled && dialogParent && !dialogParent.isDestroyed() && dialogParent.isVisible()) {
      dialogParent.focus()
    }
    return { success: true, added }
  }

  async openPanelItem(id: string, itemType: string, query?: string): Promise<{ success: true }> {
    if (this.#stopping) throw new Error('应用正在退出')
    const validId = requireText(id, '项目 ID', 128)
    const validType = requireText(itemType, '项目类型', 32)
    const isValid = validType === 'system_tool'
      ? SYSTEM_TOOL_ITEM_ID_PATTERN.test(validId)
      : ITEM_ID_PATTERN.test(validId)
    if (!isValid || !['plugin', 'local', 'system_tool'].includes(validType)) {
      throw new Error('悬浮条项目无效')
    }
    if (query !== undefined && (typeof query !== 'string' || query.length > 512)) {
      throw new Error('搜索文本无效')
    }
    if (validType === 'local') {
      await this.#data.launchLocalApp(validId)
    } else if (validType === 'system_tool') {
      if (!this.options.systemTools) throw new Error('系统工具不可用')
      await this.options.systemTools.openTarget(validId.slice('system-tool:'.length))
    } else {
      await this.#data.markPluginUsed(validId)
      await this.options.openPlugin(validId)
    }
    return { success: true }
  }

  async stop(): Promise<void> {
    if (this.#stopping) return
    this.#stopping = true
    this.#data.stop()
  }
}
