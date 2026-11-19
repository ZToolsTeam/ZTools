import { describe, expect, it } from 'vitest'
import {
  OCR_CAPTURE_TRIGGER_ID,
  OCR_CAPTURE_TRIGGER_SOURCE,
  PLUGIN_FEATURE_HOTKEY_ITEMS,
  PLUGIN_FEATURE_HOTKEY_SOURCE,
  SCREENSHOT_HOTKEY_SOURCE,
  SCREENSHOT_HOTKEY_TRIGGER_IDS,
  buildPluginFeatureHotkeyItems,
  buildPluginFeatureTriggerId,
  getPluginFeatureHotkeyItemById,
  getPluginFeatureHotkeyItemByTrigger,
  getPluginFeatureHotkeyItemByTriggerId,
  isPluginFeatureHotkeyTriggerId
} from '../pluginFeatureHotkeys'

describe('pluginFeatureHotkeys 动态插件功能扩展与静态兼容', () => {
  it('无插件清单时保留静态内置 OCR 与区域截图条目并兼容旧 ID 查找', () => {
    const items = buildPluginFeatureHotkeyItems()
    expect(items).toHaveLength(PLUGIN_FEATURE_HOTKEY_ITEMS.length)
    expect(items.map((item) => item.id)).toEqual(['ocr_capture', 'screenshot_region'])
    expect(getPluginFeatureHotkeyItemById('ocr_capture')?.triggerId).toBe(OCR_CAPTURE_TRIGGER_ID)
    expect(getPluginFeatureHotkeyItemByTriggerId(SCREENSHOT_HOTKEY_TRIGGER_IDS.region)?.id).toBe('screenshot_region')
  })

  it('合并 installedPlugins 的 features[] 动态生成功能快捷键项，跳过重复内置 ocr:ocr-region', () => {
    const installedPlugins = [
      {
        pluginId: 'ocr',
        name: '文字识别',
        features: [
          { code: 'ocr-region', explain: '已静态占位的截图识别', cmds: [] },
          { code: 'ocr-table', explain: '表格识别', cmds: [] }
        ]
      },
      {
        pluginId: 'json-format',
        name: 'JSON 格式化',
        features: [
          { code: 'format', name: '格式化剪贴板 JSON', explain: '一键格式化 JSON 文本', cmds: ['JSON格式化'] },
          { code: 'minify', title: '压缩 JSON', cmds: [] }
        ]
      }
    ]

    const items = buildPluginFeatureHotkeyItems(installedPlugins)
    expect(items.map((item) => item.id)).toEqual([
      'ocr_capture',
      'screenshot_region',
      'plugin_feature:ocr:ocr-table',
      'plugin_feature:json-format:format',
      'plugin_feature:json-format:minify'
    ])

    const jsonFormatItem = items.find((item) => item.featureCode === 'format')
    expect(jsonFormatItem).toMatchObject({
      dynamic: true,
      pluginId: 'json-format',
      pluginName: 'JSON 格式化',
      featureCode: 'format',
      featureName: '格式化剪贴板 JSON',
      triggerId: buildPluginFeatureTriggerId('json-format', 'format')
    })

    // 未传入清单单参识别动态功能触发器（防止被误判成启动快捷键）
    const dynamicTrigger = {
      id: jsonFormatItem.triggerId,
      pluginId: 'json-format',
      type: 'hotkey',
      config: { key: 'Ctrl+Alt+J' },
      action: {
        mode: 'window',
        target: 'json-format',
        params: {
          source: PLUGIN_FEATURE_HOTKEY_SOURCE,
          featureCode: 'format'
        }
      }
    }
    expect(isPluginFeatureHotkeyTriggerId(jsonFormatItem.triggerId)).toBe(true)
    expect(getPluginFeatureHotkeyItemByTrigger(dynamicTrigger)?.featureCode).toBe('format')
    expect(getPluginFeatureHotkeyItemByTrigger(dynamicTrigger, items)).toEqual(jsonFormatItem)

    // 普通启动触发器不会被误判为功能快捷键
    expect(
      getPluginFeatureHotkeyItemByTrigger({
        id: 'launch_json_format',
        pluginId: 'json-format',
        type: 'hotkey',
        action: { mode: 'window', target: 'json-format', params: {} }
      }, items)
    ).toBeNull()

    // 旧静态截图与 OCR 触发器仍正常识别
    expect(
      getPluginFeatureHotkeyItemByTrigger({
        id: 'custom_id',
        pluginId: 'ocr',
        action: { mode: 'window', target: 'ocr', params: { source: OCR_CAPTURE_TRIGGER_SOURCE } }
      })?.id
    ).toBe('ocr_capture')
    expect(
      getPluginFeatureHotkeyItemByTrigger({
        id: 'custom_id',
        pluginId: 'screenshot',
        action: { mode: 'window', target: 'screenshot', params: { source: SCREENSHOT_HOTKEY_SOURCE, captureMode: 'region' } }
      })?.id
    ).toBe('screenshot_region')
  })
})
