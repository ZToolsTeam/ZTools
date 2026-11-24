import { getCurrentLocale, t } from '@/i18n'
import { matchSupportedLocale, resolveLocale } from '@/utils/locale'
import {
  getLocalizedFeatureCmds,
  getLocalizedFeatureExplain,
  getLocalizedPluginField,
  getLocalizedPluginName
} from '@/utils/pluginI18n'

export const PLUGIN_FEATURE_HOTKEY_QUERY_KEY = 'openPluginFeatureHotkey'

export const OCR_CAPTURE_TRIGGER_ID = 'ocr_capture_hotkey'
export const OCR_CAPTURE_TRIGGER_SOURCE = 'ocr_capture_hotkey'
export const PLUGIN_FEATURE_HOTKEY_SOURCE = 'plugin_feature_hotkey'
export const DYNAMIC_FEATURE_TRIGGER_PREFIX = 'plugin_feature:'

export const SCREENSHOT_HOTKEY_SOURCE = 'screenshot_capture_hotkey'
export const SCREENSHOT_HOTKEY_TRIGGER_IDS = Object.freeze({
  region: 'screenshot_capture_region_hotkey',
  screen: 'screenshot_capture_screen_hotkey',
  window: 'screenshot_capture_window_hotkey'
})

function createBuiltinFeatureItem(base) {
  return Object.freeze({
    ...base,
    get pluginName() {
      return t(`hotkey.features.items.${base.id}.pluginName`)
    },
    get featureName() {
      return t(`hotkey.features.items.${base.id}.featureName`)
    },
    get description() {
      return t(`hotkey.features.items.${base.id}.description`)
    }
  })
}

export const PLUGIN_FEATURE_HOTKEY_ITEMS = Object.freeze([
  createBuiltinFeatureItem({
    id: 'ocr_capture',
    pluginId: 'ocr',
    triggerId: OCR_CAPTURE_TRIGGER_ID
  }),
  createBuiltinFeatureItem({
    id: 'screenshot_region',
    pluginId: 'screenshot',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.region,
    captureMode: 'region'
  })
])

export const DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS = Object.freeze([
  createBuiltinFeatureItem({
    id: 'screenshot_screen',
    pluginId: 'screenshot',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.screen,
    captureMode: 'screen',
    deprecated: true
  }),
  createBuiltinFeatureItem({
    id: 'screenshot_window',
    pluginId: 'screenshot',
    triggerId: SCREENSHOT_HOTKEY_TRIGGER_IDS.window,
    captureMode: 'window',
    deprecated: true
  })
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

function sanitizeTriggerSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * 构建符合宿主 triggerId 契约（^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$）的动态功能快捷键标识
 */
export function buildPluginFeatureTriggerId(pluginId, featureCode) {
  const pid = sanitizeTriggerSegment(pluginId) || 'plugin'
  const code = sanitizeTriggerSegment(featureCode) || 'feature'
  const raw = `${DYNAMIC_FEATURE_TRIGGER_PREFIX}${pid}:${code}`
  return raw.slice(0, 128)
}

function findMatchedLocaleEntry(i18nMap, targetLocale) {
  if (!i18nMap || typeof i18nMap !== 'object' || Array.isArray(i18nMap)) return null
  const exact = i18nMap[targetLocale]
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) return exact
  for (const [key, entry] of Object.entries(i18nMap)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (matchSupportedLocale(key) === targetLocale) {
      return entry
    }
  }
  return null
}

function resolveFeatureName(plugin, feature, featureCode, locale) {
  const targetLocale = resolveLocale(locale)
  const localizedEntry =
    findMatchedLocaleEntry(plugin?.i18n, targetLocale)?.features?.[featureCode] ||
    findMatchedLocaleEntry(plugin?.manifest?.i18n, targetLocale)?.features?.[featureCode] ||
    null
  const localizedCmds = getLocalizedFeatureCmds(plugin, feature, targetLocale)
  const firstCmd =
    localizedCmds.find((cmd) => typeof cmd === 'string' && cmd.trim()) ||
    localizedCmds.find((cmd) => cmd && typeof cmd.label === 'string' && cmd.label.trim())?.label ||
    ''
  const localizedExplain = getLocalizedFeatureExplain(plugin, feature, targetLocale)
  const validExplain = localizedExplain && localizedExplain !== featureCode ? localizedExplain : ''

  const candidates = [
    localizedEntry?.name,
    localizedEntry?.title,
    localizedEntry?.featureName,
    getLocalizedPluginField(feature, 'name', targetLocale),
    getLocalizedPluginField(feature, 'title', targetLocale),
    getLocalizedPluginField(feature, 'featureName', targetLocale),
    firstCmd,
    localizedEntry?.explain,
    validExplain
  ]
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return featureCode
}

/**
 * 合并内置保留功能热键（ocr_capture / screenshot_region）与已安装插件清单中的 features[]，
 * 生成完整的功能快捷键候选列表
 */
export function buildPluginFeatureHotkeyItems(installedPlugins = []) {
  const items = [...PLUGIN_FEATURE_HOTKEY_ITEMS]
  const seenKeys = new Set(['ocr:ocr-region'])
  const seenTriggerIds = new Set(items.map((item) => item.triggerId))

  if (!Array.isArray(installedPlugins)) return items

  const locale = getCurrentLocale()

  for (const plugin of installedPlugins) {
    if (!plugin || typeof plugin !== 'object') continue
    const pluginId = String(plugin.pluginId || plugin.id || '').trim()
    if (!pluginId || !Array.isArray(plugin.features) || plugin.features.length === 0) continue
    const pluginName = getLocalizedPluginName(plugin, locale) || String(plugin.name || plugin.title || pluginId).trim() || pluginId

    for (const feature of plugin.features) {
      if (!feature || typeof feature !== 'object') continue
      const featureCode = String(feature.code || feature.id || '').trim()
      if (!featureCode) continue

      const dedupeKey = `${pluginId.toLowerCase()}:${featureCode.toLowerCase()}`
      if (seenKeys.has(dedupeKey)) continue

      const triggerId = buildPluginFeatureTriggerId(pluginId, featureCode)
      if (seenTriggerIds.has(triggerId)) continue

      seenKeys.add(dedupeKey)
      seenTriggerIds.add(triggerId)

      const featureName = resolveFeatureName(plugin, feature, featureCode, locale)
      const localizedExplain = getLocalizedFeatureExplain(plugin, feature, locale)
      const resolvedExplain = localizedExplain && localizedExplain !== featureCode ? localizedExplain : ''
      const description =
        resolvedExplain ||
        getLocalizedPluginField(feature, 'description', locale) ||
        t('hotkey.features.dynamicDesc', { pluginName, featureName })

      items.push({
        id: `${DYNAMIC_FEATURE_TRIGGER_PREFIX}${pluginId}:${featureCode}`,
        pluginId,
        pluginName,
        featureCode,
        featureName,
        description,
        triggerId,
        source: PLUGIN_FEATURE_HOTKEY_SOURCE,
        dynamic: true,
        mode: feature.mode || 'view'
      })
    }
  }

  return items
}

export const getPluginFeatureHotkeyItemById = (id, items = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS) => {
  if (FEATURE_ITEM_MAP[id]) return FEATURE_ITEM_MAP[id]
  if (Array.isArray(items)) {
    return items.find((item) => item?.id === id) || null
  }
  return null
}

export const getPluginFeatureHotkeyItemByTriggerId = (
  triggerId,
  items = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS
) => {
  if (FEATURE_TRIGGER_ID_MAP[triggerId]) return FEATURE_TRIGGER_ID_MAP[triggerId]
  if (Array.isArray(items)) {
    return items.find((item) => item?.triggerId === triggerId) || null
  }
  return null
}

export const isPluginFeatureHotkeyTriggerId = (
  triggerId,
  items = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS
) =>
  Boolean(getPluginFeatureHotkeyItemByTriggerId(triggerId, items)) ||
  (typeof triggerId === 'string' && triggerId.startsWith(DYNAMIC_FEATURE_TRIGGER_PREFIX))

export const isDeprecatedPluginFeatureHotkeyItem = (item) =>
  Boolean(item?.deprecated)

export const getPluginFeatureHotkeyItemByTrigger = (
  trigger,
  itemsOrPlugins = ALL_PLUGIN_FEATURE_HOTKEY_ITEMS
) => {
  if (!trigger) return null

  const byStaticId = getPluginFeatureHotkeyItemByTriggerId(trigger.id)
  if (byStaticId) return byStaticId

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

  // 从动态合并列表匹配（支持传入已构建条目数组或 installedPlugins 数组）
  const dynamicItems = Array.isArray(itemsOrPlugins)
    ? itemsOrPlugins.some((entry) => Array.isArray(entry?.features))
      ? buildPluginFeatureHotkeyItems(itemsOrPlugins)
      : itemsOrPlugins
    : ALL_PLUGIN_FEATURE_HOTKEY_ITEMS

  const matchedDynamic = dynamicItems.find((item) => {
    if (!item?.dynamic) return false
    if (trigger.id && item.triggerId === trigger.id) return true
    return (
      params.source === PLUGIN_FEATURE_HOTKEY_SOURCE &&
      pluginId &&
      item.pluginId === pluginId &&
      params.featureCode &&
      item.featureCode === params.featureCode
    )
  })
  if (matchedDynamic) return matchedDynamic

  // 未传动态列表时也必须识别动态特征热键，防止被误当作插件启动快捷键展示
  const isDynamicFeatureTrigger =
    (typeof trigger.id === 'string' && trigger.id.startsWith(DYNAMIC_FEATURE_TRIGGER_PREFIX)) ||
    params.source === PLUGIN_FEATURE_HOTKEY_SOURCE

  if (isDynamicFeatureTrigger) {
    const featureCode =
      typeof params.featureCode === 'string' && params.featureCode.trim()
        ? params.featureCode.trim()
        : typeof trigger.id === 'string' && trigger.id.startsWith(DYNAMIC_FEATURE_TRIGGER_PREFIX)
          ? trigger.id.split(':').slice(2).join(':')
          : ''
    const resolvedPluginId =
      pluginId ||
      (typeof trigger.id === 'string' && trigger.id.startsWith(DYNAMIC_FEATURE_TRIGGER_PREFIX)
        ? trigger.id.split(':')[1] || ''
        : '')
    return {
      id: trigger.id || buildPluginFeatureTriggerId(resolvedPluginId, featureCode),
      pluginId: resolvedPluginId,
      pluginName: resolvedPluginId || t('hotkey.features.fallbackPlugin'),
      featureCode,
      featureName: featureCode || t('hotkey.features.fallbackFeature'),
      description: '',
      triggerId: trigger.id || buildPluginFeatureTriggerId(resolvedPluginId, featureCode),
      source: PLUGIN_FEATURE_HOTKEY_SOURCE,
      dynamic: true
    }
  }

  return null
}
