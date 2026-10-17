import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  GLYPHS,
  GLYPH_HUES,
  OFFICIAL_PLUGIN_GLYPHS,
  CATEGORY_GLYPHS,
  COMMAND_GLYPHS,
  isGlyph,
  resolvePluginGlyph,
  resolveItemGlyph,
  glyphHue
} from '@/utils/brandIcons'
import { shortcutLabel } from '@/utils/platform'
import { OFFICIAL_PLUGIN_IDS } from '@/utils/officialPlugins'
import RcSquircle from '@/components/base/RcSquircle.vue'
import BrandGlyph from '@/components/base/BrandGlyph.vue'
import BrandMark from '@/components/BrandMark.vue'

describe('品牌图标库完整性', () => {
  it('每个登记的映射都指向真实存在的图形，且每个图形都有色调', () => {
    const referenced = [
      ...Object.values(OFFICIAL_PLUGIN_GLYPHS),
      ...Object.values(CATEGORY_GLYPHS),
      ...Object.values(COMMAND_GLYPHS)
    ]
    for (const kind of referenced) expect(isGlyph(kind), kind).toBe(true)
    for (const kind of Object.keys(GLYPHS)) expect(GLYPH_HUES[kind], kind).toBeTruthy()
  })

  it('所有官方插件 ID 都有对应图形，避免回退到风格不一的自带图标', () => {
    const missing = Object.values(OFFICIAL_PLUGIN_IDS).filter((id) => !resolvePluginGlyph(id))
    expect(missing).toEqual([])
  })

  it('图形只包含 path / rect / circle 三种安全 SVG 元素', () => {
    for (const [kind, elements] of Object.entries(GLYPHS)) {
      for (const [tag, attrs] of elements) {
        expect(['path', 'rect', 'circle'], kind).toContain(tag)
        expect(Object.keys(attrs).some((key) => key.startsWith('on')), kind).toBe(false)
      }
    }
  })
})

describe('resolvePluginGlyph / resolveItemGlyph 边界与对抗输入', () => {
  it('支持字符串与对象两种形态，并忽略大小写与首尾空白', () => {
    expect(resolvePluginGlyph('clipboard-history')).toBe('clipboard')
    expect(resolvePluginGlyph({ pluginId: '  JSON-Format ' })).toBe('json')
    expect(resolvePluginGlyph({ id: 'pdf' })).toBe('pdf')
  })

  it('空值、非字符串与未登记的第三方插件返回空字符串（交由调用方回退）', () => {
    for (const input of [null, undefined, '', 0, 42, {}, [], { pluginId: null }, 'community-plugin']) {
      expect(resolvePluginGlyph(input)).toBe('')
    }
  })

  it('原型链键名不会被当作合法插件或图形', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolvePluginGlyph(key)).toBe('')
      expect(isGlyph(key)).toBe(false)
      expect(glyphHue(key)).toBe('neutral')
      expect(resolveItemGlyph({ key })).toBe('')
    }
  })

  it('条目解析优先级：官方插件 > 内置命令 > 文件 / 文件夹', () => {
    expect(resolveItemGlyph({ pluginId: 'snippets', key: 'system-settings' })).toBe('snippet')
    expect(resolveItemGlyph({ key: 'system-settings' })).toBe('settings')
    expect(resolveItemGlyph({ type: 'file', isDir: true })).toBe('folder')
    expect(resolveItemGlyph({ type: 'file', isDir: false })).toBe('pdf')
    expect(resolveItemGlyph({ pluginId: 'third-party' })).toBe('')
    expect(resolveItemGlyph(null)).toBe('')
    expect(resolveItemGlyph('clipboard-history')).toBe('')
  })
})

describe('shortcutLabel 平台快捷键文案', () => {
  it('macOS 显示系统符号且不带加号，Windows 原样保留', () => {
    expect(shortcutLabel('Ctrl+K', true)).toBe('⌘K')
    expect(shortcutLabel('Alt+Space', true)).toBe('⌥Space')
    expect(shortcutLabel('Ctrl+Shift+O', true)).toBe('⌘⇧O')
    expect(shortcutLabel('Ctrl+K', false)).toBe('Ctrl+K')
    expect(shortcutLabel('Alt+Space', false)).toBe('Alt+Space')
  })

  it('容忍多余空白与空段，非法输入返回空字符串而不是抛错', () => {
    expect(shortcutLabel(' Ctrl + M ', true)).toBe('⌘M')
    expect(shortcutLabel('Ctrl++M', false)).toBe('Ctrl+M')
    for (const input of [null, undefined, '', '   ', 7, {}, []]) {
      expect(shortcutLabel(input, true)).toBe('')
      expect(shortcutLabel(input, false)).toBe('')
    }
  })

  it('未知按键名在 macOS 上原样透传，不会映射到原型属性', () => {
    expect(shortcutLabel('constructor+K', true)).toBe('constructorK')
    expect(shortcutLabel('__proto__', true)).toBe('__proto__')
  })
})

describe('RcSquircle 图标底块渲染优先级', () => {
  it('官方图形优先于图片：不渲染外部图片，使用对应大地色底', () => {
    const wrapper = mount(RcSquircle, { props: { glyph: 'json', src: 'https://example.com/a.png', size: 40 } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.findComponent(BrandGlyph).props('kind')).toBe('json')
    const style = wrapper.attributes('style')
    expect(style).toContain('var(--rc-h-olive-bg)')
    expect(style).toContain('border-radius: 11px') // 40 × 28%
  })

  it('第三方图片加载失败时回退到默认立方体，不留空白', async () => {
    const wrapper = mount(RcSquircle, { props: { src: 'ztools://broken.png', size: 36 } })
    expect(wrapper.find('img').exists()).toBe(true)
    await wrapper.find('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.findComponent(BrandGlyph).props('kind')).toBe('cube')
  })

  it('非法尺寸与未知图形安全降级', () => {
    const wrapper = mount(RcSquircle, { props: { glyph: '__proto__', size: 'abc' } })
    expect(wrapper.attributes('style')).toContain('width: 38px')
    expect(wrapper.attributes('style')).toContain('var(--rc-h-neutral-bg)')
    expect(wrapper.findComponent(BrandGlyph).props('kind')).toBe('cube')
  })
})

describe('BrandMark 标志', () => {
  it('大于 16px 时渲染光晕，且多实例的滤镜 id 互不冲突', () => {
    const wrapper = mount({
      components: { BrandMark },
      template: '<div><BrandMark :size="22" /><BrandMark :size="22" /></div>'
    })
    const ids = wrapper.findAll('filter').map((f) => f.attributes('id'))
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(wrapper.findAll('rect.glow-soft')).toHaveLength(2)
  })

  it('16px 及以下去掉光晕，保证小尺寸清晰（品牌规范）', () => {
    const wrapper = mount(BrandMark, { props: { size: 16 } })
    expect(wrapper.find('filter').exists()).toBe(false)
    expect(wrapper.findAll('rect.ink')).toHaveLength(3)
    expect(wrapper.findAll('rect.lit')).toHaveLength(1)
  })

  it('glow=false 时即便尺寸较大也不渲染光晕', () => {
    const wrapper = mount(BrandMark, { props: { size: 64, glow: false } })
    expect(wrapper.find('.glow-soft').exists()).toBe(false)
  })
})
