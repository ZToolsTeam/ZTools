import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DEFAULT_GLOBAL_WAKE_HOTKEY, syncGlobalWakeHotkey } from '../globalWakeHotkey'

// mock getHotkey
const hotkeyMock = vi.hoisted(() => ({ getHotkey: vi.fn() }))
vi.mock('@/api/apiserver', () => hotkeyMock)

describe('syncGlobalWakeHotkey', () => {
  let triggerMock

  beforeEach(() => {
    triggerMock = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      register: vi.fn().mockResolvedValue(true),
      unregister: vi.fn().mockResolvedValue(true)
    }
    window.ztools = { trigger: triggerMock }
    hotkeyMock.getHotkey.mockReset()
  })

  afterEach(() => {
    delete window.ztools
  })

  it('直接使用传入的 hotkey 注册', async () => {
    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })
    expect(result).toEqual({ success: true, hotkey: 'Ctrl+Q' })
    expect(triggerMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'global_wake_hotkey', config: { key: 'Ctrl+Q' } })
    )
  })

  it('hotkey 为空时从 getHotkey 获取', async () => {
    hotkeyMock.getHotkey.mockResolvedValue('Alt+Z')
    const result = await syncGlobalWakeHotkey()
    expect(hotkeyMock.getHotkey).toHaveBeenCalled()
    expect(result.hotkey).toBe('Alt+Z')
  })

  it('hotkey 和 getHotkey 都为空且 useDefaultWhenEmpty 为 true 时使用默认值', async () => {
    hotkeyMock.getHotkey.mockResolvedValue('')
    const result = await syncGlobalWakeHotkey({ useDefaultWhenEmpty: true })
    expect(result.hotkey).toBe(DEFAULT_GLOBAL_WAKE_HOTKEY)
  })

  it('trigger 不可用时返回失败', async () => {
    delete window.ztools
    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('trigger_unavailable')
  })

  it('hotkey 最终为空时注销已有触发器', async () => {
    hotkeyMock.getHotkey.mockResolvedValue('')
    triggerMock.list.mockResolvedValue({
      data: [{ id: 'global_wake_hotkey', enabled: true, config: { key: 'Ctrl+Z' } }]
    })
    const result = await syncGlobalWakeHotkey({ hotkey: '' })
    expect(triggerMock.unregister).toHaveBeenCalledWith('global_wake_hotkey')
    expect(triggerMock.register).not.toHaveBeenCalled()
    expect(hotkeyMock.getHotkey).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, hotkey: '' })
  })

  it('已存在相同快捷键且已启用时跳过注册', async () => {
    triggerMock.list.mockResolvedValue({
      data: [{ id: 'global_wake_hotkey', enabled: true, config: { key: 'Ctrl+Q' } }]
    })
    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })
    expect(triggerMock.register).not.toHaveBeenCalled()
    expect(triggerMock.unregister).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, hotkey: 'Ctrl+Q' })
  })

  it('已存在不同快捷键时使用固定 trigger ID 原位替换', async () => {
    triggerMock.list.mockResolvedValue({
      data: [{ id: 'global_wake_hotkey', enabled: true, config: { key: 'Ctrl+Z' } }]
    })
    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })
    expect(triggerMock.unregister).not.toHaveBeenCalled()
    expect(triggerMock.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'global_wake_hotkey',
        config: { key: 'Ctrl+Q' }
      })
    )
    expect(result).toEqual({ success: true, hotkey: 'Ctrl+Q' })
  })

  it('宿主拒绝新快捷键时恢复原触发器并返回失败', async () => {
    const oldTrigger = {
      id: 'global_wake_hotkey',
      pluginId: 'system',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Z' },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    }
    triggerMock.list.mockResolvedValue({ data: [oldTrigger] })
    let registered = oldTrigger
    triggerMock.register.mockImplementation(async (trigger) => {
      if (trigger.config.key === 'Ctrl+Q') throw new Error('快捷键冲突')
      registered = trigger
      return { success: true, data: { triggerId: trigger.id } }
    })

    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })

    expect(result).toMatchObject({
      success: false,
      reason: 'trigger_register_failed',
      hotkey: 'Ctrl+Q',
      message: '快捷键冲突'
    })
    expect(triggerMock.unregister).not.toHaveBeenCalled()
    expect(triggerMock.register).toHaveBeenCalledTimes(2)
    expect(triggerMock.register.mock.calls[1][0]).toMatchObject({
      id: 'global_wake_hotkey',
      config: { key: 'Ctrl+Z' }
    })
    expect(registered.config.key).toBe('Ctrl+Z')
  })

  it('宿主返回 success:false 时恢复原触发器并返回失败', async () => {
    const oldTrigger = {
      id: 'global_wake_hotkey',
      pluginId: 'system',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Z' },
      actionMode: 'builtin',
      actionTarget: 'toggle_main_window',
      actionParams: {}
    }
    triggerMock.list.mockResolvedValue({ data: [oldTrigger] })
    let registered = oldTrigger
    triggerMock.register
      .mockImplementation(async (trigger) => {
        registered = trigger
        if (trigger.config.key === 'Ctrl+Q') {
          return { success: false, error: '快捷键冲突' }
        }
        return { success: true, data: { triggerId: trigger.id } }
      })

    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })

    expect(result).toMatchObject({
      success: false,
      reason: 'trigger_register_failed',
      hotkey: 'Ctrl+Q',
      message: '快捷键冲突'
    })
    expect(triggerMock.unregister).not.toHaveBeenCalled()
    expect(triggerMock.register).toHaveBeenCalledTimes(2)
    expect(triggerMock.register.mock.calls[1][0]).toMatchObject({
      id: 'global_wake_hotkey',
      config: { key: 'Ctrl+Z' }
    })
    expect(registered.config.key).toBe('Ctrl+Z')
  })

  it('已有同键但宿主标记未生效时会重新注册', async () => {
    triggerMock.list.mockResolvedValue({
      data: [{
        id: 'global_wake_hotkey',
        enabled: true,
        effectiveEnabled: false,
        config: { key: 'Ctrl+Q' }
      }]
    })

    const result = await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Q' })

    expect(triggerMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'global_wake_hotkey', config: { key: 'Ctrl+Q' } })
    )
    expect(result.success).toBe(true)
  })

  it('清空注销被宿主拒绝时恢复旧触发器并返回失败', async () => {
    const oldTrigger = {
      id: 'global_wake_hotkey',
      pluginId: 'system',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Z' },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    }
    triggerMock.list.mockResolvedValue({ data: [oldTrigger] })
    let registered = oldTrigger
    triggerMock.unregister.mockImplementation(async () => {
      registered = undefined
      throw new Error('注销失败')
    })
    triggerMock.register.mockImplementation(async (trigger) => {
      registered = trigger
      return { success: true, data: { triggerId: trigger.id } }
    })

    const result = await syncGlobalWakeHotkey({ hotkey: '' })

    expect(result).toMatchObject({
      success: false,
      reason: 'trigger_unregister_failed',
      message: '注销失败'
    })
    expect(triggerMock.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'global_wake_hotkey', config: { key: 'Ctrl+Z' } })
    )
    expect(registered.config.key).toBe('Ctrl+Z')
  })

  it('normalizeHotkey 处理非字符串和空白', async () => {
    const result = await syncGlobalWakeHotkey({ hotkey: '  Ctrl+Q  ' })
    expect(result.hotkey).toBe('Ctrl+Q')
  })
})
