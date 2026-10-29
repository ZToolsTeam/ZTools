import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircleHelpIcon, TriangleAlertIcon } from '@lucide/vue'

const confirmMock = vi.hoisted(() => vi.fn(() => ({ destroy: vi.fn() })))
vi.mock('ant-design-vue', () => ({ Modal: { confirm: confirmMock } }))

import { isGlyph, resolveKeywordGlyph, resolvePluginGlyph } from '../brandIcons'
import { confirmDialog } from '../confirmDialog'

describe('没有图标的插件按名称关键词挑图形', () => {
  it.each([
    ['剪贴板历史', 'clipboard'],
    ['计算器', 'calculator'],
    ['颜色转换', 'color'],
    ['Base64 图片转换', 'hash'],
    ['中文数字与金额转换', 'currency'],
    ['万年历与节气助手', 'clock'],
    ['JSON 格式化', 'json'],
    ['批量重命名', 'rename']
  ])('%s → %s', (name, glyph) => {
    expect(resolveKeywordGlyph(name)).toBe(glyph)
    expect(isGlyph(glyph)).toBe(true)
  })

  it('更具体的关键词优先：文件夹不被「文件」抢走，定时关机不被「关机」抢走', () => {
    expect(resolveKeywordGlyph('快捷文件夹')).toBe('folder')
    expect(resolveKeywordGlyph('定时关机')).toBe('clock')
  })

  it('无匹配、空名称、非字符串时返回空字符串，由调用方显示默认立方体', () => {
    expect(resolveKeywordGlyph('xyz')).toBe('')
    expect(resolveKeywordGlyph('')).toBe('')
    expect(resolveKeywordGlyph(null)).toBe('')
    expect(resolveKeywordGlyph(42)).toBe('')
  })

  it('关键词图形只用于第三方插件：测试插件 qa-calculator 不算官方插件', () => {
    expect(resolvePluginGlyph('qa-calculator')).toBe('')
    expect(resolveKeywordGlyph('计算器')).toBe('calculator')
  })
})

describe('统一确认框', () => {
  beforeEach(() => confirmMock.mockClear())

  it('普通确认用问号图标，危险操作用警示图标，并带统一外观类名', () => {
    confirmDialog({ title: '确定要更新吗？' })
    confirmDialog({ title: '确定要卸载吗？', okType: 'danger', wrapClassName: 'extra' })
    confirmDialog({ title: '删除', okButtonProps: { danger: true } })
    const [normal, danger, dangerByButton] = confirmMock.mock.calls.map(([options]) => options)
    expect(normal.icon.children[0].type).toBe(CircleHelpIcon)
    expect(normal.wrapClassName).toBe('rc-confirm-wrap')
    expect(danger.icon.children[0].type).toBe(TriangleAlertIcon)
    expect(danger.icon.props.class).toContain('is-danger')
    expect(danger.wrapClassName).toBe('rc-confirm-wrap extra')
    expect(dangerByButton.icon.children[0].type).toBe(TriangleAlertIcon)
  })

  it('调用方传入的 icon 覆盖默认图标，其余参数与返回值原样透传', () => {
    const custom = { custom: true }
    const result = confirmDialog({ title: 'x', icon: custom, onOk: () => 1 })
    const [options] = confirmMock.mock.calls[0]
    expect(options.icon).toBe(custom)
    expect(options.onOk()).toBe(1)
    expect(result).toBe(confirmMock.mock.results[0].value)
  })
})
