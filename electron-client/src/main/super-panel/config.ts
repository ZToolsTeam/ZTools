/**
 * 悬浮条固定本地软件的配置解析。
 *
 * 旧超级面板已移除，`user_settings.json` 中的 `super_panel` 配置组只保留 `pinnedLocalApps`
 * （悬浮条固定的本地软件）。沿用原配置键是为了不丢失用户已固定的数据；组内其它旧字段
 * （热键、面板位置、快捷方式前缀等）不再读取。
 */
export interface SuperPanelConfig {
  pinnedLocalApps: string[]
}

const LOCAL_APP_ID_PATTERN = /^localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64})$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSuperPanelConfig(value: unknown): SuperPanelConfig {
  const source = isRecord(value) ? value : {}
  const pinnedLocalApps = Array.isArray(source.pinnedLocalApps)
    ? source.pinnedLocalApps.filter((item): item is string =>
      typeof item === 'string' && LOCAL_APP_ID_PATTERN.test(item)
    ).slice(0, 1000)
    : []
  return { pinnedLocalApps: [...new Set(pinnedLocalApps)] }
}

export function decodeSuperPanelConfig(source: string): SuperPanelConfig {
  try {
    return parseSuperPanelConfig(JSON.parse(source))
  } catch {
    return parseSuperPanelConfig(undefined)
  }
}
