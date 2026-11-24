import {
  app,
  shell
} from 'electron'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { t } from '../i18n/index.js'
import { readMacosApplicationIconCached } from '../platform/macos/application-icon.js'
import type { ConfigService } from '../services/config-service.js'
import type { PluginStateProvider } from '../services/plugin-state-service.js'
import type { SystemToolsProvider } from '../services/system-tools-service.js'
import { PLUGIN_ID_PATTERN } from './config.js'
import { SuperPanelDataService } from './data-service.js'

const ITEM_ID_PATTERN = PLUGIN_ID_PATTERN
const SYSTEM_TOOL_ITEM_ID_PATTERN = /^system-tool:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function requireText(value: unknown, errorKey: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(t(errorKey))
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
  resolveAuthorizedReadPath?: (rawPath: string, caller?: CallerIdentity) => Promise<string>
  revealPath?: (fullPath: string) => void | Promise<void>
  readMacosApplicationIcon?: (appPath: string) => Promise<string>
  onChanged?: () => void
}

/**
 * 悬浮条的数据能力（全类型固定项、系统工具、最近使用插件）。
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
      {
        ...(options.pluginState ? { pluginState: options.pluginState } : {}),
        ...(options.resolveAuthorizedReadPath ? { resolveAuthorizedReadPath: options.resolveAuthorizedReadPath } : {}),
        revealPath: options.revealPath ?? ((target) => shell.showItemInFolder(target)),
        readMacosApplicationIcon: options.readMacosApplicationIcon ?? readMacosApplicationIconCached,
        ...(options.onChanged ? { onChanged: options.onChanged } : {})
      },
      async (target) => (await app.getFileIcon(target, { size: 'large' })).toDataURL(),
      options.systemTools
    )
  }

  getData(): ReturnType<SuperPanelDataService['getData']> {
    if (this.#stopping) return Promise.reject(new Error(t('superPanel.error.appStopping')))
    return this.#data.getData()
  }

  setPin(entry: unknown, pinned: unknown, caller?: CallerIdentity): ReturnType<SuperPanelDataService['setPin']> {
    if (this.#stopping) return Promise.reject(new Error(t('superPanel.error.appStopping')))
    return this.#data.setPin(entry, pinned, caller)
  }

  reorderPins(order: unknown): ReturnType<SuperPanelDataService['reorderPins']> {
    if (this.#stopping) return Promise.reject(new Error(t('superPanel.error.appStopping')))
    return this.#data.reorderPins(order)
  }

  async togglePin(id: string, itemType: string): Promise<{ success: true; pinned: boolean }> {
    if (this.#stopping) throw new Error(t('superPanel.error.appStopping'))
    const validId = requireText(id, 'superPanel.error.invalidItemId', 128)
    const validType = requireText(itemType, 'superPanel.error.invalidItemType', 32)
    return { success: true, pinned: await this.#data.togglePin(validId, validType) }
  }

  async openPanelItem(
    id: string,
    itemType: string,
    query?: string,
    action?: unknown
  ): Promise<{ success: true }> {
    if (this.#stopping) throw new Error(t('superPanel.error.appStopping'))
    const validType = requireText(itemType, 'superPanel.error.invalidItemType', 32)
    if (query !== undefined && (typeof query !== 'string' || query.length > 512)) {
      throw new Error(t('superPanel.error.invalidQuery'))
    }
    if (validType === 'pinned') {
      const pinKey = requireText(id, 'superPanel.error.invalidPinKey', 32_800)
      const resolvedAction = action === undefined ? 'open' : action
      if (resolvedAction !== 'open' && resolvedAction !== 'reveal') {
        throw new Error(t('superPanel.error.invalidOpenAction'))
      }
      await this.#data.openPinnedFile(pinKey, resolvedAction)
      return { success: true }
    }
    const validId = requireText(id, 'superPanel.error.invalidItemId', 128)
    const isValid = validType === 'system_tool'
      ? SYSTEM_TOOL_ITEM_ID_PATTERN.test(validId)
      : ITEM_ID_PATTERN.test(validId)
    if (!isValid || !['plugin', 'system_tool'].includes(validType)) {
      throw new Error(t('superPanel.error.invalidItem'))
    }
    if (validType === 'system_tool') {
      if (!this.options.systemTools) throw new Error(t('superPanel.error.systemToolsUnavailable'))
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
