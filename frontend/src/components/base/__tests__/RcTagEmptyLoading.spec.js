import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { InboxIcon } from '@lucide/vue'
import RcTag from '../RcTag.vue'
import RcEmpty from '../RcEmpty.vue'
import RcLoading from '../RcLoading.vue'

describe('RcTag 状态标签', () => {
  it('默认是中性浅底标签', () => {
    const tag = mount(RcTag, { slots: { default: '待处理' } })
    expect(tag.classes()).toEqual(expect.arrayContaining(['rc-tag', 'is-soft', 'tone-neutral']))
    expect(tag.text()).toBe('待处理')
  })

  it.each(['soft', 'dot', 'text'])('variant=%s 与语义色调组合', (variant) => {
    const tag = mount(RcTag, { props: { variant, tone: 'error' }, slots: { default: '已下架' } })
    expect(tag.classes()).toEqual(expect.arrayContaining([`is-${variant}`, 'tone-error']))
  })

  it('[边界] 非法 tone / variant 会触发属性校验告警', () => {
    const { validator: toneValidator } = RcTag.props.tone
    const { validator: variantValidator } = RcTag.props.variant
    expect(toneValidator('blue')).toBe(false)
    expect(variantValidator('pill')).toBe(false)
    expect(toneValidator('info')).toBe(true)
  })
})

describe('RcEmpty / RcLoading', () => {
  it('空状态：图标、标题、说明与操作插槽；没有说明时不渲染说明行', () => {
    const empty = mount(RcEmpty, { props: { icon: InboxIcon, title: '暂无反馈', description: '换个分类看看' }, slots: { action: '<button>去提交</button>' } })
    expect(empty.find('.rc-empty-title').text()).toBe('暂无反馈')
    expect(empty.find('.rc-empty-desc').text()).toBe('换个分类看看')
    expect(empty.find('.rc-empty-action button').exists()).toBe(true)
    expect(empty.attributes('role')).toBe('status')
    const bare = mount(RcEmpty, { props: { title: '空' } })
    expect(bare.find('.rc-empty-desc').exists()).toBe(false)
    expect(bare.find('.rc-empty-icon').exists()).toBe(false)
  })

  it('加载态：块级默认文案，行内形态用自定义文案', () => {
    expect(mount(RcLoading).text()).toBe('加载中…')
    const inline = mount(RcLoading, { props: { inline: true, text: '同步中' } })
    expect(inline.classes()).toContain('is-inline')
    expect(inline.text()).toBe('同步中')
  })
})
