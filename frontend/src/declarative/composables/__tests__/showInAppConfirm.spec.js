import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const modal = vi.hoisted(() => ({ confirm: vi.fn() }))
vi.mock('ant-design-vue', () => ({ Modal: modal }))

import { showInAppConfirm, closeAllConfirms } from '../useDeclarativeStack'

const text = (node) => (typeof node === 'string' ? node : node?.children)
const destroy = vi.fn()

const lastConfig = () => modal.confirm.mock.calls.at(-1)[0]

describe('showInAppConfirm 插件确认框', () => {
  beforeEach(() => {
    modal.confirm.mockReset()
    destroy.mockReset()
    modal.confirm.mockImplementation(() => ({ destroy }))
  })
  afterEach(() => {
    closeAllConfirms()
  })

  it('用站内 Modal，不调用系统原生 window.confirm', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = showInAppConfirm({ title: '清空全部便签？', message: '此操作不可撤销' })
    expect(modal.confirm).toHaveBeenCalledTimes(1)
    expect(lastConfig()).toMatchObject({ title: '清空全部便签？', content: '此操作不可撤销' })
    // 按钮文字包在 span 里，避免 Ant Design 在两个汉字之间插空格
    expect(text(lastConfig().okText)).toBe('确定')
    expect(text(lastConfig().cancelText)).toBe('取消')
    lastConfig().onOk()
    await expect(pending).resolves.toBe(true)
    expect(nativeConfirm).not.toHaveBeenCalled()
    nativeConfirm.mockRestore()
  })

  it('点主操作执行 primaryAction，点取消执行 dismissAction', async () => {
    const primary = vi.fn()
    const dismiss = vi.fn()
    let pending = showInAppConfirm({ title: 'A', primaryAction: { title: '删除', onAction: primary }, dismissAction: { title: '保留', onAction: dismiss } })
    expect(text(lastConfig().okText)).toBe('删除')
    expect(text(lastConfig().cancelText)).toBe('保留')
    lastConfig().onOk()
    await expect(pending).resolves.toBe(true)
    expect(primary).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()

    pending = showInAppConfirm({ title: 'B', primaryAction: { onAction: primary }, dismissAction: { onAction: dismiss } })
    lastConfig().onCancel()
    await expect(pending).resolves.toBe(false)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('危险操作按钮标红并默认聚焦「取消」，误按回车不会执行', () => {
    showInAppConfirm({ title: '清空', primaryAction: { title: '清空', style: 'destructive' } })
    expect(lastConfig().okButtonProps).toEqual({ danger: true })
    expect(lastConfig().autoFocusButton).toBe('cancel')
    showInAppConfirm({ title: '保存' })
    expect(lastConfig().autoFocusButton).toBe('ok')
  })

  it('[破坏性] Esc / 点遮罩关闭按取消处理；确认后再触发关闭不会重复结算', async () => {
    const primary = vi.fn()
    const dismiss = vi.fn()
    let pending = showInAppConfirm({ title: 'x', primaryAction: { onAction: primary }, dismissAction: { onAction: dismiss } })
    lastConfig().afterClose()
    await expect(pending).resolves.toBe(false)
    expect(dismiss).toHaveBeenCalledTimes(1)

    pending = showInAppConfirm({ title: 'y', primaryAction: { onAction: primary }, dismissAction: { onAction: dismiss } })
    const cfg = lastConfig()
    cfg.onOk(); cfg.afterClose(); cfg.onCancel(); cfg.onOk()
    await expect(pending).resolves.toBe(true)
    expect(primary).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })

  it('[破坏性] 回调抛错不影响结果；Modal 打不开时按取消处理，不擅自确认', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = showInAppConfirm({ title: 'z', primaryAction: { onAction: () => { throw new Error('boom') } } })
    lastConfig().onOk()
    await expect(pending).resolves.toBe(true)

    modal.confirm.mockImplementationOnce(() => { throw new Error('渲染失败') })
    const primary = vi.fn()
    await expect(showInAppConfirm({ title: 'w', primaryAction: { onAction: primary } })).resolves.toBe(false)
    expect(primary).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('[边界] 标题缺失或不是字符串时给默认标题', () => {
    showInAppConfirm({ title: '   ' })
    expect(lastConfig().title).toBe('确认操作')
    showInAppConfirm({ title: 42 })
    expect(lastConfig().title).toBe('确认操作')
    showInAppConfirm()
    expect(lastConfig().title).toBe('确认操作')
  })

  it('[破坏性] 确认框打开时 Esc 只关闭确认框，按键不会传到页面（不会触发返回或其他快捷键）', async () => {
    const pageHandler = vi.fn()
    window.addEventListener('keydown', pageHandler)
    const dismiss = vi.fn()
    const pending = showInAppConfirm({ title: '清空', dismissAction: { onAction: dismiss } })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect(pending).resolves.toBe(false)
    expect(destroy).toHaveBeenCalled()
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(pageHandler).not.toHaveBeenCalled()
    // 关闭后不再拦截按键
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(pageHandler).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', pageHandler)
  })

  it('[破坏性] 插件页面卸载时关闭所有未处理的确认框，按取消处理', async () => {
    const primary = vi.fn()
    const a = showInAppConfirm({ title: 'a', primaryAction: { onAction: primary } })
    const b = showInAppConfirm({ title: 'b', primaryAction: { onAction: primary } })
    closeAllConfirms()
    await expect(a).resolves.toBe(false)
    await expect(b).resolves.toBe(false)
    expect(destroy).toHaveBeenCalledTimes(2)
    expect(primary).not.toHaveBeenCalled()
  })

  it('[破坏性] 叠了两个确认框时，Esc 先关最上面那个', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const a = showInAppConfirm({ title: 'a', dismissAction: { onAction: first } })
    const b = showInAppConfirm({ title: 'b', dismissAction: { onAction: second } })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(b).resolves.toBe(false)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(a).resolves.toBe(false)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
