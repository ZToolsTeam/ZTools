import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { isPluginSupportedOnCurrentPlatform, WINDOWS_EXCLUSIVE_PLUGIN_IDS, UNAVAILABLE_PLUGIN_IDS, shortcutKeys, isSymbolKey, getPluginPlatforms, getPluginPlatformLabel } from '@/utils/platform'
import { getBundledPluginEntries } from '@/utils/bundledPlugins'
import fs from 'node:fs'
import path from 'node:path'
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

  it('macOS 上隐藏实现完全依赖 Windows 的官方插件，而升级为声明式 2.0 的 35 款自营插件双端均可用', () => {
    asPlatform('mac')
    for (const id of ['windows-run', 'windows-shortcuts', 'winget']) {
      expect(isPluginSupportedOnCurrentPlatform(id), id).toBe(false)
      expect(isPluginSupportedOnCurrentPlatform({ pluginId: id }), id).toBe(false)
    }
    // 跨平台与声明式 2.0 升级后的自营插件在 macOS 与 Windows 均可用
    for (const id of ['json-format', 'system', 'cleaner', 'boost', 'batch-video', 'disk-analyzer', 'kill-process']) {
      expect(isPluginSupportedOnCurrentPlatform({ pluginId: id }), id).toBe(true)
    }
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
        'clipboard-history',
        'emoji-picker',
        'everything-file-search',
        'google-translate',
        'kill-process',
        'password-vault',
        'quicklinks',
        'snippets',
        'system',
        'window-management'
      ])
    )
    // 与内置插件重复的旧实现已从官方列表移除，只保留内置版本
    for (const id of ['calculator', 'json-format', 'qr-code', 'color-picker', 'notes', 'file-compare']) {
      expect(OFFICIAL_PLUGINS_LIST.some((p) => p.pluginId === id), id).toBe(false)
    }
    for (const id of WINDOWS_EXCLUSIVE_PLUGIN_IDS) expect(mac).not.toContain(id)
    for (const id of UNAVAILABLE_PLUGIN_IDS) expect(mac).not.toContain(id)
    vi.restoreAllMocks()
    asPlatform('win')
    const win = OFFICIAL_PLUGINS_LIST.filter(isPluginSupportedOnCurrentPlatform).map((p) => p.pluginId)
    expect(win.length).toBeGreaterThan(mac.length)
    expect(win).toEqual(expect.arrayContaining(['clipboard-history', 'system', 'winget', 'cleaner', 'pdf']))
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


describe('插件平台声明（plugin.json 的 targets）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const target = (platform, runtime = 'electron') => ({ id: `${platform}-${runtime}-any`, platform, runtime, arch: 'any' })
  const both = { pluginId: 'demo-both', targets: [target('windows'), target('macos')] }
  const winOnly = { pluginId: 'demo-win', targets: [target('windows')] }
  const macOnly = { pluginId: 'demo-mac', targets: [target('macos')] }

  it('读出平台并给出「跨平台 / 仅 Windows / 仅 macOS」标签；未声明时不显示标签', () => {
    expect(getPluginPlatforms(both)).toEqual(['windows', 'macos'])
    expect(getPluginPlatformLabel(both)).toBe('跨平台')
    expect(getPluginPlatformLabel(winOnly)).toBe('仅 Windows')
    expect(getPluginPlatformLabel(macOnly)).toBe('仅 macOS')
    expect(getPluginPlatforms({ pluginId: 'legacy' })).toBeNull()
    expect(getPluginPlatformLabel({ pluginId: 'legacy' })).toBe('')
    // 兼容旧的 platforms 字符串写法
    expect(getPluginPlatformLabel({ platforms: ['darwin'] })).toBe('仅 macOS')
  })

  it('按声明过滤：Mac 上不显示仅 Windows 的插件，Windows 上不显示仅 macOS 的插件', () => {
    asPlatform('mac')
    expect(isPluginSupportedOnCurrentPlatform(both)).toBe(true)
    expect(isPluginSupportedOnCurrentPlatform(macOnly)).toBe(true)
    expect(isPluginSupportedOnCurrentPlatform(winOnly)).toBe(false)
    vi.restoreAllMocks()
    asPlatform('win')
    expect(isPluginSupportedOnCurrentPlatform(both)).toBe(true)
    expect(isPluginSupportedOnCurrentPlatform(winOnly)).toBe(true)
    expect(isPluginSupportedOnCurrentPlatform(macOnly)).toBe(false)
  })

  it('[破坏性] 只有旧版 Delphi 目标、平台名无效或条目损坏时，两端都视为不支持，不会因此报错', () => {
    const broken = [
      { pluginId: 'old', targets: [target('windows', 'legacy-delphi')] },
      { pluginId: 'bad', targets: [{ platform: 'linux', runtime: 'electron' }] },
      { pluginId: 'junk', targets: [null, 'windows', 42] }
    ]
    for (const os of ['mac', 'win']) {
      vi.restoreAllMocks()
      asPlatform(os)
      for (const plugin of broken) {
        expect(isPluginSupportedOnCurrentPlatform(plugin), `${os}:${plugin.pluginId}`).toBe(false)
        expect(getPluginPlatformLabel(plugin)).toBe('')
      }
    }
  })

  // 需要插件源码目录；只有界面层源码时（例如单独克隆客户端仓库）跳过
  const pluginsRoot = path.resolve(__dirname, '../../../../plugins')
  it.skipIf(!fs.existsSync(pluginsRoot))('[集成] 内置插件条目带上 plugin.json 里的平台声明，标签与过滤都按声明走', () => {
    const entries = getBundledPluginEntries()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginsRoot, entry.pluginId, 'plugin.json'), 'utf8'))
      expect(entry.targets, entry.pluginId).toEqual(manifest.targets)
      const declared = manifest.targets.map((t) => t.platform)
      const onMac = declared.includes('macos')
      const onWin = declared.includes('windows')
      expect(onMac || onWin, `${entry.pluginId} 至少声明一个平台`).toBe(true)
      expect(getPluginPlatformLabel(entry), entry.pluginId).toBe(onMac && onWin ? '跨平台' : onWin ? '仅 Windows' : '仅 macOS')
      // 只传 ID（别名跳转、旧快捷方式）时同样按内置插件的声明判断，不会在未声明的系统上打开
      for (const [os, expected] of [['mac', onMac], ['win', onWin]]) {
        vi.restoreAllMocks()
        asPlatform(os)
        expect(isPluginSupportedOnCurrentPlatform(entry), `${os}:${entry.pluginId}`).toBe(expected)
        expect(isPluginSupportedOnCurrentPlatform(entry.pluginId), `${os}:${entry.pluginId}（只传 ID）`).toBe(expected)
        expect(isPluginSupportedOnCurrentPlatform({ pluginId: entry.pluginId }), `${os}:${entry.pluginId}（无声明对象）`).toBe(expected)
      }
    }
  })
})
