import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { usePluginIcon } from '../usePluginIcon'

describe('usePluginIcon', () => {
  it('远程图标 URL 优先', () => {
    const plugin = ref({ name: '测试', icon: 'https://example.com/icon.png' })
    const { displayIconUrl } = usePluginIcon(plugin)
    expect(displayIconUrl.value).toBe('https://example.com/icon.png')
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
