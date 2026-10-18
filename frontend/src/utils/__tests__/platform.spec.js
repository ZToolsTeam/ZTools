import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { isPluginSupportedOnCurrentPlatform, WINDOWS_EXCLUSIVE_PLUGIN_IDS, UNAVAILABLE_PLUGIN_IDS, shortcutKeys, isSymbolKey } from '@/utils/platform'
import { OFFICIAL_PLUGINS_LIST } from '@/utils/officialPlugins'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'

function asPlatform(platform) {
  const ua = platform === 'mac'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform === 'mac' ? 'MacIntel' : 'Win32')
}

describe('isPluginSupportedOnCurrentPlatform', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('macOS 上隐藏实现完全依赖 Windows 的官方插件', () => {
    asPlatform('mac')
    for (const id of ['windows-run', 'windows-shortcuts', 'winget', 'boost', 'cleaner']) {
      expect(isPluginSupportedOnCurrentPlatform(id), id).toBe(false)
      expect(isPluginSupportedOnCurrentPlatform({ pluginId: id }), id).toBe(false)
    }
    // 跨平台插件不受影响
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'json-format' })).toBe(true)
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'system' })).toBe(true)
  })

  it('Windows 上所有 Windows 专用插件都可用', () => {
    asPlatform('win')
    for (const id of WINDOWS_EXCLUSIVE_PLUGIN_IDS) {
      expect(isPluginSupportedOnCurrentPlatform(id), id).toBe(true)
    }
  })

  it('只能展示示例数据或假成功的内置插件，在两个系统上都不展示', () => {
    for (const platform of ['mac', 'win']) {
      asPlatform(platform)
      for (const id of UNAVAILABLE_PLUGIN_IDS) {
        expect(isPluginSupportedOnCurrentPlatform(id), `${platform}:${id}`).toBe(false)
        expect(isPluginSupportedOnCurrentPlatform({ pluginId: ` ${id.toUpperCase()} ` }), `${platform}:${id}`).toBe(false)
      }
      vi.restoreAllMocks()
    }
  })

  it('[破坏性] 插件清单自称支持所有平台也不能绕过不可用名单', () => {
    asPlatform('mac')
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'trial-nudges', platforms: ['darwin', 'win32'] })).toBe(false)
  })

  it('Mac 上实际可见的内置插件包含已打通宿主的跨平台核心插件；Windows 多出依赖 Windows 组件的插件', () => {
    asPlatform('mac')
    const mac = OFFICIAL_PLUGINS_LIST.filter(isPluginSupportedOnCurrentPlatform).map((p) => p.pluginId).sort()
    expect(mac).toEqual(
      expect.arrayContaining([
        'calculator',
        'clipboard-history',
        'emoji-picker',
        'everything-file-search',
        'google-translate',
        'json-format',
        'kill-process',
        'notes',
        'password-vault',
        'quicklinks',
        'snippets',
        'system',
        'window-management'
      ])
    )
    for (const id of WINDOWS_EXCLUSIVE_PLUGIN_IDS) expect(mac).not.toContain(id)
    for (const id of UNAVAILABLE_PLUGIN_IDS) expect(mac).not.toContain(id)
    vi.restoreAllMocks()
    asPlatform('win')
    const win = OFFICIAL_PLUGINS_LIST.filter(isPluginSupportedOnCurrentPlatform).map((p) => p.pluginId)
    expect(win.length).toBeGreaterThan(mac.length)
    expect(win).toEqual(expect.arrayContaining(['calculator', 'clipboard-history', 'system', 'winget', 'cleaner', 'pdf']))
    for (const id of UNAVAILABLE_PLUGIN_IDS) expect(win).not.toContain(id)
  })

  it('不可用名单与 Windows 专用名单里的每个 ID 都对应真实存在的内置插件（防止拼错导致没生效）', () => {
    const ids = new Set(OFFICIAL_PLUGINS_LIST.map((p) => p.pluginId))
    const known = new Set([...ids, 'context-menu', 'network-adapter', 'network-rescue'])
    for (const id of [...UNAVAILABLE_PLUGIN_IDS, ...WINDOWS_EXCLUSIVE_PLUGIN_IDS]) {
      expect(known.has(id), id).toBe(true)
    }
  })

  it('大小写与首尾空白不影响判断，避免数据格式差异绕过过滤', () => {
    asPlatform('mac')
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: '  Windows-Run ' })).toBe(false)
    expect(isPluginSupportedOnCurrentPlatform({ id: 'WINGET' })).toBe(false)
  })

  it('插件清单显式声明 platforms 时按声明判断', () => {
    asPlatform('mac')
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'community-a', platforms: ['win32'] })).toBe(false)
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'community-b', platforms: ['darwin', 'win32'] })).toBe(true)
    // 空数组视为未声明
    expect(isPluginSupportedOnCurrentPlatform({ pluginId: 'community-c', platforms: [] })).toBe(true)
  })

  it('[破坏性] 空值与非法输入一律判为不支持，不抛异常', () => {
    asPlatform('mac')
    for (const input of [null, undefined, '', 0]) {
      expect(isPluginSupportedOnCurrentPlatform(input)).toBe(false)
    }
  })
})

describe('shortcutKeys：逐键拆分的键帽文本', () => {
  it('macOS 用系统符号，Windows 用按键名，各占一枚键帽', () => {
    expect(shortcutKeys('Ctrl+Shift+O', true)).toEqual(['⌘', '⇧', 'O'])
    expect(shortcutKeys('Ctrl+Shift+O', false)).toEqual(['Ctrl', 'Shift', 'O'])
    expect(shortcutKeys('Alt+Space', true)).toEqual(['⌥', 'Space'])
    expect(shortcutKeys('Alt+Space', false)).toEqual(['Alt', 'Space'])
  })

  it('特殊键按平台习惯显示，单字母统一大写', () => {
    expect(shortcutKeys('Enter', true)).toEqual(['↵'])
    expect(shortcutKeys('Enter', false)).toEqual(['Enter'])
    expect(shortcutKeys('Escape', true)).toEqual(['Esc'])
    expect(shortcutKeys('ctrl+k', true)).toEqual(['⌘', 'K'])
    expect(shortcutKeys('ArrowUp', false)).toEqual(['↑'])
  })

  it('[破坏性] 非法输入返回空数组；原型链键名原样显示，不命中映射表', () => {
    for (const value of [null, undefined, '', '  ', 3, {}]) expect(shortcutKeys(value, true)).toEqual([])
    expect(shortcutKeys('constructor+K', true)).toEqual(['constructor', 'K'])
    expect(shortcutKeys('__proto__', false)).toEqual(['__proto__'])
    expect(shortcutKeys('Ctrl++M', false)).toEqual(['Ctrl', 'M'])
  })

  it('isSymbolKey 只认单字符系统符号', () => {
    expect(isSymbolKey('⌘')).toBe(true)
    expect(isSymbolKey('↵')).toBe(true)
    expect(isSymbolKey('K')).toBe(false)
    expect(isSymbolKey('Esc')).toBe(false)
    expect(isSymbolKey(undefined)).toBe(false)
  })
})

describe('ShortcutKeys 组件', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('macOS：⌘K 渲染为两枚键帽，符号键单独放大，并提供可读的 aria-label', () => {
    asPlatform('mac')
    const wrapper = mount(ShortcutKeys, { props: { combo: 'Ctrl+K' } })
    const caps = wrapper.findAll('kbd')
    expect(caps.map((c) => c.text())).toEqual(['⌘', 'K'])
    expect(caps[0].classes()).toContain('is-symbol')
    expect(caps[1].classes()).not.toContain('is-symbol')
    expect(wrapper.attributes('aria-label')).toBe('⌘ K')
  })

  it('Windows：Ctrl+K 渲染为 Ctrl 与 K 两枚键帽', () => {
    asPlatform('win')
    const wrapper = mount(ShortcutKeys, { props: { combo: 'Ctrl+K' } })
    expect(wrapper.findAll('kbd').map((c) => c.text())).toEqual(['Ctrl', 'K'])
  })

  it('[破坏性] 空组合键不渲染任何元素；橙色按钮上使用深色键帽', () => {
    asPlatform('mac')
    expect(mount(ShortcutKeys, { props: { combo: '' } }).find('kbd').exists()).toBe(false)
    expect(mount(ShortcutKeys, { props: { combo: 'Enter', tone: 'onAccent' } }).classes()).toContain('is-onAccent')
  })
})

