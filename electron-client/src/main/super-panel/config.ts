import type {
  NativeMouseAction,
  NativeMouseButton,
  NativeMouseTriggerConfig
} from '../native-host/native-host-client.js'

export interface SuperPanelConfig {
  enabled: boolean
  keyboard: {
    enabled: boolean
    accelerator: string
  }
  mouse: {
    enabled: boolean
    trigger: NativeMouseTriggerConfig
  }
  position: 'center' | 'cursor'
  size: 'small' | 'medium' | 'large'
  defaultTab: 'history' | 'pinned' | 'local' | 'system_tools' | 'all'
  maxRecentCount: number
  shortcuts: Array<{ prefix: string; pluginId: string }>
  pinnedLocalApps: string[]
}

export const DEFAULT_SUPER_PANEL_CONFIG: SuperPanelConfig = {
  enabled: true,
  keyboard: { enabled: true, accelerator: 'Alt+Space' },
  mouse: {
    enabled: true,
    trigger: { button: 'middle', action: 'long', longPressMs: 300 }
  },
  position: 'center',
  size: 'small',
  defaultTab: 'history',
  maxRecentCount: 10,
  shortcuts: [],
  pinnedLocalApps: []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function enabledByDefault(value: unknown): boolean {
  return value !== false
}

function parseKeyboard(value: unknown): SuperPanelConfig['keyboard'] {
  if (!isRecord(value)) return { ...DEFAULT_SUPER_PANEL_CONFIG.keyboard }
  const modifiers = Array.isArray(value.modifiers)
    ? value.modifiers.filter((item): item is string => typeof item === 'string')
    : ['Alt']
  const normalizedModifiers: string[] = []
  for (const modifier of modifiers.slice(0, 4)) {
    const normalized = modifier.trim().toLowerCase()
    const accelerator = normalized === 'ctrl'
      ? 'Ctrl'
      : normalized === 'control'
        ? 'Control'
        : normalized === 'alt'
          ? 'Alt'
          : normalized === 'shift'
          ? 'Shift'
          : normalized === 'meta' || normalized === 'super' || normalized === 'win'
            ? 'Super'
            : ''
    if (accelerator && !normalizedModifiers.includes(accelerator)) normalizedModifiers.push(accelerator)
  }
  const key = typeof value.key === 'string' && /^[A-Za-z0-9]{1,16}$/.test(value.key.trim())
    ? value.key.trim()
    : 'Space'
  return {
    enabled: enabledByDefault(value.enabled),
    accelerator: [...normalizedModifiers, key].join('+')
  }
}

function parseMouse(value: unknown): SuperPanelConfig['mouse'] {
  if (!isRecord(value)) {
    return {
      enabled: DEFAULT_SUPER_PANEL_CONFIG.mouse.enabled,
      trigger: { ...DEFAULT_SUPER_PANEL_CONFIG.mouse.trigger }
    }
  }
  const rawButton = typeof value.button === 'string' ? value.button.toLowerCase() : 'middle_long'
  const match = /^(middle|right|forward|backward)_(press|long)$/.exec(rawButton)
  const button = (match?.[1] ?? 'middle') as NativeMouseButton
  const action = (match?.[2] ?? 'long') as NativeMouseAction
  const threshold = Number.isInteger(value.longPressMs) &&
    (value.longPressMs as number) >= 200 && (value.longPressMs as number) <= 500
    ? value.longPressMs as number
    : 300
  return {
    enabled: enabledByDefault(value.enabled),
    trigger: { button, action, longPressMs: threshold }
  }
}

function parseShortcuts(value: unknown): SuperPanelConfig['shortcuts'] {
  if (!Array.isArray(value)) return []
  const output: SuperPanelConfig['shortcuts'] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, 100)) {
    if (!isRecord(item) || typeof item.prefix !== 'string' || typeof item.pluginId !== 'string') continue
    const prefix = item.prefix.trim()
    const pluginId = item.pluginId.trim()
    if (!/^\/?[^\s/]{1,32}$/.test(prefix) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId)) continue
    const key = prefix.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    output.push({ prefix, pluginId })
  }
  return output
}

export function parseSuperPanelConfig(value: unknown): SuperPanelConfig {
  const source = isRecord(value) ? value : {}
  const position = source.panelPosition === 'cursor' ? 'cursor' : 'center'
  const size = source.panelSize === 'medium' || source.panelSize === 'large'
    ? source.panelSize
    : 'small'
  const defaultTabs = new Set<SuperPanelConfig['defaultTab']>([
    'history', 'pinned', 'local', 'system_tools', 'all'
  ])
  const defaultTab = typeof source.defaultTab === 'string' &&
    defaultTabs.has(source.defaultTab as SuperPanelConfig['defaultTab'])
    ? source.defaultTab as SuperPanelConfig['defaultTab']
    : 'history'
  const maxRecentCount = Number.isInteger(source.maxRecentCount) &&
    (source.maxRecentCount as number) >= 5 && (source.maxRecentCount as number) <= 20
    ? source.maxRecentCount as number
    : 10
  const pinnedLocalApps = Array.isArray(source.pinnedLocalApps)
    ? source.pinnedLocalApps.filter((item): item is string =>
      typeof item === 'string' && /^localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64})$/i.test(item)
    ).slice(0, 1000)
    : []
  return {
    enabled: enabledByDefault(source.enabled),
    keyboard: parseKeyboard(source.keyboardHotkey),
    mouse: parseMouse(source.mouseHotkey),
    position,
    size,
    defaultTab,
    maxRecentCount,
    shortcuts: parseShortcuts(source.shortcuts),
    pinnedLocalApps: [...new Set(pinnedLocalApps)]
  }
}

export function decodeSuperPanelConfig(source: string): SuperPanelConfig {
  try {
    return parseSuperPanelConfig(JSON.parse(source))
  } catch {
    return parseSuperPanelConfig(undefined)
  }
}

export function panelDimensions(size: SuperPanelConfig['size']): { width: number; height: number } {
  if (size === 'medium') return { width: 400, height: 600 }
  if (size === 'large') return { width: 800, height: 600 }
  return { width: 400, height: 300 }
}
