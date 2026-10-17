import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { getPluginFaIcon, usePluginIcon } from '../usePluginIcon'

describe('getPluginFaIcon', () => {
  it.each([
    // 品牌优先匹配
    ['QQ 工具', 'fa-qq'],
    ['微信助手', 'fa-wechat'],
    // 精确关键词匹配
    ['截图工具', 'fa-scissors'],
    ['视频转换', 'fa-film'],
    ['系统清理', 'fa-trash-o'],
    ['翻译助手', 'fa-language'],
    // 注意：FA_ICON_MAP 按顺序匹配，"管理"在"文件"之前
    ['文件管理', 'fa-cogs'],       // "管理"先匹配
    ['密码管理', 'fa-cogs'],       // "管理"先匹配
    ['代码编辑器', 'fa-edit'],     // "编辑"先匹配
    ['游戏工具', 'fa-wrench'],     // "工具"先匹配
    // 单关键词精确匹配
    ['密码箱', 'fa-lock'],
    ['纯代码', 'fa-terminal'],
    ['小游戏', 'fa-gamepad'],
    ['文件浏览', 'fa-file-o']
  ])('"%s" 匹配到 %s', (name, expected) => {
    expect(getPluginFaIcon(name)).toBe(expected)
  })

  it('无匹配时返回默认图标', () => {
    expect(getPluginFaIcon('xyz-unknown')).toBe('fa-cube')
  })

  it('空名称返回默认图标', () => {
    expect(getPluginFaIcon('')).toBe('fa-cube')
    expect(getPluginFaIcon(null)).toBe('fa-cube')
  })

  it('不区分大小写', () => {
    expect(getPluginFaIcon('JSON 格式化')).toBe('fa-code')
    // "PDF 转换"中"转换"先匹配到 fa-exchange
    expect(getPluginFaIcon('PDF 转换')).toBe('fa-exchange')
    // 纯 pdf 匹配
    expect(getPluginFaIcon('pdf阅读器')).toBe('fa-file-pdf-o')
  })
})

describe('usePluginIcon', () => {
  it('远程图标 URL 优先', () => {
    const plugin = ref({ name: '测试', icon: 'https://example.com/icon.png' })
    const { displayIconUrl, pluginIcon } = usePluginIcon(plugin)
    expect(displayIconUrl.value).toBe('https://example.com/icon.png')
    expect(pluginIcon.value).toBeTruthy()
  })

  it('本地图标路径作为 fallback', () => {
    const plugin = ref({ name: '测试', icon: '', localIconPath: '/local/icon.png' })
    const { displayIconUrl } = usePluginIcon(plugin)
    expect(displayIconUrl.value).toBe('/local/icon.png')
  })

  it('无图标时 displayIconUrl 为空', () => {
    const plugin = ref({ name: '测试', icon: '', localIconPath: '' })
    const { displayIconUrl, showImgOverlay } = usePluginIcon(plugin)
    expect(displayIconUrl.value).toBe('')
    expect(showImgOverlay.value).toBe(false)
  })

  it('支持函数形式的 getter', () => {
    const plugin = { name: '截图', icon: 'https://example.com/a.png' }
    const { displayIconUrl } = usePluginIcon(() => plugin)
    expect(displayIconUrl.value).toBe('https://example.com/a.png')
  })

  it('onIconLoad 和 onIconError 正确更新状态', () => {
    const plugin = ref({ name: '测试', icon: 'https://example.com/icon.png' })
    const { iconLoaded, iconFailed, showImgOverlay, onIconLoad, onIconError } = usePluginIcon(plugin)

    expect(iconLoaded.value).toBe(false)
    onIconLoad()
    expect(iconLoaded.value).toBe(true)
    expect(showImgOverlay.value).toBe(true)

    onIconError()
    expect(iconFailed.value).toBe(true)
    expect(showImgOverlay.value).toBe(false)
  })
})
