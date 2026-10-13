import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getSuperPanelConfig,
  setSuperPanelConfig,
  reloadHotkeys,
  validateConfig
} from '../superPanel'

describe('superPanel API', () => {
  beforeEach(() => {
    delete window.ztools
  })

  afterEach(() => {
    delete window.ztools
  })

  describe('getSuperPanelConfig', () => {
    it('从 ztools.config 获取配置', async () => {
      const config = { enabled: true }
      window.ztools = { config: { get: vi.fn().mockResolvedValue(config) } }
      const result = await getSuperPanelConfig()
      expect(result).toEqual(config)
    })

    it('config 返回 null 时使用默认配置', async () => {
      window.ztools = { config: { get: vi.fn().mockResolvedValue(null) } }
      const result = await getSuperPanelConfig()
      expect(result.enabled).toBe(true)
      expect(result.keyboardHotkey).toBeDefined()
    })

    it('非 CEF 环境返回默认配置', async () => {
      const result = await getSuperPanelConfig()
      expect(result.enabled).toBe(true)
    })
  })

  describe('setSuperPanelConfig', () => {
    it('保存配置到 ztools.config', async () => {
      const setMock = vi.fn().mockResolvedValue(true)
      window.ztools = { config: { set: setMock } }
      await setSuperPanelConfig({ enabled: false })
      expect(setMock).toHaveBeenCalledWith('super_panel', { enabled: false })
    })

    it('非 CEF 环境抛出错误', async () => {
      await expect(setSuperPanelConfig({})).rejects.toThrow('ZTools API not available')
    })
  })

  describe('reloadHotkeys', () => {
    it('调用 ztools.sys.reloadHotkeys', async () => {
      const reloadMock = vi.fn().mockResolvedValue(true)
      window.ztools = { sys: { reloadHotkeys: reloadMock } }
      await reloadHotkeys()
      expect(reloadMock).toHaveBeenCalled()
    })

    it('非 CEF 环境抛出错误', async () => {
      await expect(reloadHotkeys()).rejects.toThrow('ZTools API not available')
    })
  })

  describe('validateConfig', () => {
    it('有效配置返回 true', () => {
      expect(validateConfig({
        enabled: true,
        keyboardHotkey: { enabled: true, modifiers: ['Alt'], key: 'Space' },
        mouseHotkey: { enabled: true, button: 'middle_long', longPressMs: 300 },
        panelPosition: 'center',
        panelSize: 'small',
        defaultTab: 'history',
        maxRecentCount: 10
      })).toBe(true)
    })

    it('null/非对象返回 false', () => {
      expect(validateConfig(null)).toBe(false)
      expect(validateConfig('string')).toBe(false)
    })

    it('modifiers 非数组返回 false', () => {
      expect(validateConfig({
        keyboardHotkey: { modifiers: 'Alt', key: 'Space' }
      })).toBe(false)
    })

    it('key 非字符串返回 false', () => {
      expect(validateConfig({
        keyboardHotkey: { modifiers: ['Alt'], key: 123 }
      })).toBe(false)
    })

    it('无效鼠标按钮返回 false', () => {
      expect(validateConfig({
        mouseHotkey: { button: 'invalid', longPressMs: 300 }
      })).toBe(false)
    })

    it('longPressMs 超出范围返回 false', () => {
      expect(validateConfig({
        mouseHotkey: { button: 'middle_long', longPressMs: 100 }
      })).toBe(false)
      expect(validateConfig({
        mouseHotkey: { button: 'middle_long', longPressMs: 600 }
      })).toBe(false)
    })

    it('无效面板位置返回 false', () => {
      expect(validateConfig({ panelPosition: 'left' })).toBe(false)
    })

    it('无效面板大小返回 false', () => {
      expect(validateConfig({ panelSize: 'wide' })).toBe(false)
    })

    it('无效默认 tab 返回 false', () => {
      expect(validateConfig({ defaultTab: 'settings' })).toBe(false)
    })

    it('系统工具是有效的默认 tab', () => {
      expect(validateConfig({ defaultTab: 'system_tools' })).toBe(true)
    })

    it('maxRecentCount 超出范围返回 false', () => {
      expect(validateConfig({ maxRecentCount: 3 })).toBe(false)
      expect(validateConfig({ maxRecentCount: 25 })).toBe(false)
    })

    it('所有有效鼠标按钮类型', () => {
      const validButtons = [
        'middle_press', 'middle_long', 'right_press', 'right_long',
        'forward_press', 'forward_long', 'backward_press', 'backward_long'
      ]
      for (const button of validButtons) {
        expect(validateConfig({
          mouseHotkey: { button, longPressMs: 300 }
        })).toBe(true)
      }
    })
  })
})
