export interface PluginUninstallSteps {
  /** 停掉插件正在运行的部分：会话授权、防休眠、窗口、DLL */
  stopRuntime(pluginId: string): Promise<void>
  /** 卸载前记下桌面快捷方式位置（卸载后清单就没了），返回卸载成功后的删除动作 */
  planShortcutCleanup(pluginId: string): Promise<() => Promise<void>>
  uninstall(pluginId: string): Promise<{ success: true }>
  /** 删除插件的快捷键（触发器）并持久化 */
  removeTriggers(pluginId: string): Promise<void>
  warn(message: string, error: unknown): void
}

/**
 * 卸载插件。快捷键与桌面快捷方式只在插件确实卸载后才清理：卸载失败（不存在、被占用、内置插件）时保持原样；
 * 插件已经卸载后，残留的快捷键或快捷方式只记日志，不能把这次卸载报成失败。
 */
export async function uninstallPluginWithCleanup(
  pluginId: string,
  steps: PluginUninstallSteps
): Promise<{ success: true }> {
  await steps.stopRuntime(pluginId)
  const removeShortcut = await steps.planShortcutCleanup(pluginId)
  const result = await steps.uninstall(pluginId)
  await steps.removeTriggers(pluginId).catch((error: unknown) =>
    steps.warn(`插件 ${pluginId} 已卸载，清理快捷键失败:`, error)
  )
  await removeShortcut().catch((error: unknown) =>
    steps.warn(`插件 ${pluginId} 已卸载，删除桌面快捷方式失败:`, error)
  )
  return result
}
