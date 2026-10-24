import type { PluginOpenParams } from '../../contracts/method-params.js'
import {
  PluginWindowManager,
  type PluginWindowManagerOptions,
  type PluginOpenResult,
  type PluginWindowState,
  type PluginCrashDetails
} from '../windows/plugin-window-manager.js'

export interface PluginViewManagerOptions extends PluginWindowManagerOptions {}

export type {
  PluginWindowState,
  PluginCrashDetails,
  PluginOpenResult
}

/**
 * 插件视图与实例管理器服务 (PluginViewManager)
 * 统一承载插件 WebContents 容器实例调度、后台休眠挂起、崩溃容灾隔离与优雅资源析构。
 */
export class PluginViewManager {
  readonly #windowManager: PluginWindowManager

  constructor(optionsOrManager: PluginViewManagerOptions | PluginWindowManager) {
    if (optionsOrManager instanceof PluginWindowManager) {
      this.#windowManager = optionsOrManager
    } else {
      this.#windowManager = new PluginWindowManager(optionsOrManager)
    }
  }

  get rawWindowManager(): PluginWindowManager {
    return this.#windowManager
  }

  /** 打开或复用插件实例 */
  open(params: PluginOpenParams): Promise<PluginOpenResult> {
    return this.#windowManager.open(params)
  }

  /** 关闭指定插件窗口实例 */
  close(pluginId: string, instanceId?: string): Promise<{ success: true; closed: number }> {
    return this.#windowManager.close(pluginId, instanceId)
  }

  /** 关闭指定插件所有窗口（或指定实例）并强制清理 */
  closePlugin(pluginId: string, instanceId?: string): Promise<{ success: true; closed: number }> {
    return this.#windowManager.closePlugin(pluginId, instanceId)
  }

  /** 显式触发插件后台轻量级休眠挂起 */
  suspend(pluginId: string, instanceId?: string): boolean {
    return this.#windowManager.suspend(pluginId, instanceId)
  }

  /** 显式触发插件从休眠恢复（秒开唤醒） */
  resume(pluginId: string, instanceId?: string): boolean {
    return this.#windowManager.resume(pluginId, instanceId)
  }

  /** 一键重载刷新 / 崩溃实例容灾恢复 */
  reload(pluginId: string, instanceId?: string): Promise<{ success: boolean; recovered: boolean }> {
    return this.#windowManager.reload(pluginId, instanceId)
  }

  /** 获取插件当前运行状态机状态 */
  getState(pluginId: string, instanceId?: string): PluginWindowState | undefined {
    return this.#windowManager.getPluginState(pluginId, instanceId)
  }

  /** 获取插件崩溃元数据（若处于 crashed 状态） */
  getCrashDetails(pluginId: string, instanceId?: string): PluginCrashDetails | undefined {
    return this.#windowManager.getCrashDetails(pluginId, instanceId)
  }

  /** 停止服务并释放所有资源与 Session 强引用 */
  stop(): Promise<void> {
    return this.#windowManager.stop()
  }
}
