export const PLUGIN_FEATURE_HOTKEY_QUERY_KEY = 'openPluginFeatureHotkey'

export const OCR_CAPTURE_TRIGGER_ID = 'ocr_capture_hotkey'
export const OCR_CAPTURE_TRIGGER_SOURCE = 'ocr_capture_hotkey'

export const SCREENSHOT_HOTKEY_SOURCE = 'screenshot_capture_hotkey'
export const SCREENSHOT_HOTKEY_TRIGGER_IDS = Object.freeze({
  region: 'screenshot_capture_region_hotkey',
  screen: 'screenshot_capture_screen_hotkey',
  window: 'screenshot_capture_window_hotkey'
})

export const PLUGIN_FEATURE_HOTKEY_ITEMS = Object.freeze([
  {
    id: 'ocr_capture',
    pluginId: 'ocr',
    pluginName: 'OCR',
    featureName: '截图识别',
    description: '触发后打开 OCR，并立即进入截图识别。',
    triggerId: OCR_CAPTURE_TRIGGER_ID
  },
  {
    id: 'screenshot_region',
    pluginId: 'screenshot',
    pluginName: '截图工具',
    featureName: '区域截图',
    description: '直接进入框选截图，并覆盖插件缓存中的上一张截图。',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.region,
    captureMode: 'region'
  }
])

export const DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS = Object.freeze([
  {
    id: 'screenshot_screen',
    pluginId: 'screenshot',
    pluginName: '截图工具',
    featureName: '全屏截图',
    description: '按当前多屏选择直接保存，并覆盖上一张缓存截图。',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.screen,
    captureMode: 'screen',
    deprecated: true
  },
  {
    id: 'screenshot_window',
    pluginId: 'screenshot',
    pluginName: '截图工具',
    featureName: '窗口截图',
    description: '按当前窗口选择直接截图，并覆盖上一张缓存截图。',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.window,
    captureMode: 'window',
    deprecated: true
  }
])

const ALL_PLUGIN_FEATURE_HOTKEY_ITEMS = Object.freeze([
  ...PLUGIN_FEATURE_HOTKEY_ITEMS,
  ...DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS
])

const FEATURE_ITEM_MAP = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS.reduce((map, item) => {
  map[item.id] = item
  return map
}, {})

const FEATURE_TRIGGER_ID_MAP = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS.reduce((map, item) => {
  map[item.triggerId] = item
  return map
}, {})

export const getPluginFeatureHotkeyItemById = (id) => FEATURE_ITEM_MAP[id] || null

export const getPluginFeatureHotkeyItemByTriggerId = (triggerId) =>
  FEATURE_TRIGGER_ID_MAP[triggerId] || null

export const isPluginFeatureHotkeyTriggerId = (triggerId) =>
  Boolean(getPluginFeatureHotkeyItemByTriggerId(triggerId))

export const isDeprecatedPluginFeatureHotkeyItem = (item) =>
  Boolean(item?.deprecated)

export const getPluginFeatureHotkeyItemByTrigger = (trigger) => {
  if (!trigger) return null

  const byId = getPluginFeatureHotkeyItemByTriggerId(trigger.id)
  if (byId) return byId

  const pluginId = String(trigger.pluginId || '')
  const params = trigger?.action?.params || trigger?.actionParams || {}

  if (
    pluginId === 'ocr' &&
    params.source === OCR_CAPTURE_TRIGGER_SOURCE
  ) {
    return getPluginFeatureHotkeyItemById('ocr_capture')
  }

  if (
    pluginId === 'screenshot' &&
    params.source === SCREENSHOT_HOTKEY_SOURCE
  ) {
    return ALL_PLUGIN_FEATURE_HOTKEY_ITEMS.find(
      (item) => item.captureMode && item.captureMode === params.captureMode
    ) || null
  }

  return null
}
