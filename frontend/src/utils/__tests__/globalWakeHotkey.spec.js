import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DEFAULT_GLOBAL_WAKE_HOTKEY,
  DEFAULT_GLOBAL_LAUNCHER_HOTKEY,
  GLOBAL_LAUNCHER_TRIGGER_ID,
  MOUSE_WAKE_OPTIONS,
  MOUSE_WAKE_TRIGGER_ID,
  buildMouseWakeTrigger,
  clampMouseLongPressMs,
  currentGlobalWakeHotkey,
  currentGlobalLauncherHotkey,
  parseMouseWakeTrigger,
  refreshCurrentGlobalWakeHotkey,
  refreshCurrentGlobalLauncherHotkey,
  syncFullscreenDndToTriggers,
  syncGlobalWakeHotkey,
  syncGlobalLauncherHotkey,
  syncMouseWakeHook
} from '../globalWakeHotkey'

// mock getHotkey / getLauncherHotkey
const hotkeyMock = vi.hoisted(() => ({ getHotkey: vi.fn(), getLauncherHotkey: vi.fn() }))
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

  it('配置里是空串（用户已关闭全局唤醒）时启动同步注销触发器，不退回默认值', async () => {
    hotkeyMock.getHotkey.mockResolvedValue('')
    triggerMock.list.mockResolvedValue({
      data: [{ id: 'global_wake_hotkey', enabled: true, config: { key: DEFAULT_GLOBAL_WAKE_HOTKEY } }]
    })
    const result = await syncGlobalWakeHotkey()
    expect(result).toEqual({ success: true, hotkey: '' })
    expect(triggerMock.unregister).toHaveBeenCalledWith('global_wake_hotkey')
    expect(triggerMock.register).not.toHaveBeenCalled()
  })

  it('[破坏性] 读取配置失败时抛错，不注销也不改动现有注册', async () => {
    hotkeyMock.getHotkey.mockRejectedValue(new Error('IPC 超时'))
    await expect(syncGlobalWakeHotkey()).rejects.toThrow('IPC 超时')
    expect(triggerMock.list).not.toHaveBeenCalled()
    expect(triggerMock.unregister).not.toHaveBeenCalled()
    expect(triggerMock.register).not.toHaveBeenCalled()
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

describe('当前唤醒快捷键（界面提示用）', () => {
  let triggerMock

  beforeEach(() => {
    triggerMock = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      register: vi.fn().mockResolvedValue(true),
      unregister: vi.fn().mockResolvedValue(true)
    }
    window.ztools = { trigger: triggerMock }
    hotkeyMock.getHotkey.mockReset()
    currentGlobalWakeHotkey.value = DEFAULT_GLOBAL_WAKE_HOTKEY
  })

  afterEach(() => {
    delete window.ztools
  })

  it('注册成功后提示跟着换成新快捷键', async () => {
    await syncGlobalWakeHotkey({ hotkey: 'Ctrl+Shift+Z' })
    expect(currentGlobalWakeHotkey.value).toBe('Ctrl+Shift+Z')
  })

  it('[破坏性] 注册被拒（例如已被其他程序占用）时提示保持原样，不显示没生效的键', async () => {
    triggerMock.register.mockResolvedValueOnce({ success: false, error: { message: '快捷键 Alt+Space 已被其他程序占用，请换一个组合键' } })
    const result = await syncGlobalWakeHotkey({ hotkey: 'Alt+Space' })
    expect(result.success).toBe(false)
    expect(result.message).toContain('已被其他程序占用')
    expect(currentGlobalWakeHotkey.value).toBe(DEFAULT_GLOBAL_WAKE_HOTKEY)
    currentGlobalWakeHotkey.value = 'Ctrl+Q'
    triggerMock.register.mockRejectedValueOnce(new Error('IPC 断开'))
    await syncGlobalWakeHotkey({ hotkey: 'Alt+Space' })
    expect(currentGlobalWakeHotkey.value).toBe('Ctrl+Q')
  })

  it('关闭全局唤醒后提示清空', async () => {
    triggerMock.list.mockResolvedValue({ data: [{ id: 'global_wake_hotkey', config: { key: 'Ctrl+Q' } }] })
    await syncGlobalWakeHotkey({ hotkey: '' })
    expect(currentGlobalWakeHotkey.value).toBe('')
  })

  it('从配置刷新：已关闭（空串）显示为空；读取失败保留当前值', async () => {
    hotkeyMock.getHotkey.mockResolvedValueOnce('  Ctrl+Shift+Z ')
    expect(await refreshCurrentGlobalWakeHotkey()).toBe('Ctrl+Shift+Z')
    hotkeyMock.getHotkey.mockResolvedValueOnce('')
    expect(await refreshCurrentGlobalWakeHotkey()).toBe('')
    currentGlobalWakeHotkey.value = 'Ctrl+Q'
    hotkeyMock.getHotkey.mockRejectedValueOnce(new Error('IPC 超时'))
    expect(await refreshCurrentGlobalWakeHotkey()).toBe('Ctrl+Q')
  })
})

describe('Windows 原生鼠标快捷唤醒与全屏免打扰同步', () => {
  let triggerMock

  beforeEach(() => {
    triggerMock = {
      list: vi.fn().mockResolvedValue({ data: [] }),
      register: vi.fn().mockResolvedValue({ success: true, data: { triggerId: MOUSE_WAKE_TRIGGER_ID } }),
      unregister: vi.fn().mockResolvedValue({ success: true })
    }
    window.ztools = { trigger: triggerMock }
  })

  afterEach(() => {
    delete window.ztools
  })

  it('鼠标选项严格排除右键单击，并正确钳制 200~500ms 长按阈值', () => {
    expect(MOUSE_WAKE_OPTIONS.map((item) => item.value)).toEqual([
      'off',
      'middle:press',
      'middle:long',
      'right:long',
      'backward:press',
      'backward:long',
      'forward:press',
      'forward:long'
    ])
    expect(MOUSE_WAKE_OPTIONS.some((item) => item.value === 'right:press')).toBe(false)

    expect(clampMouseLongPressMs(50)).toBe(200)
    expect(clampMouseLongPressMs(900)).toBe(500)
    expect(clampMouseLongPressMs(349.6)).toBe(350)
    expect(clampMouseLongPressMs('invalid')).toBe(300)
  })

  it('构建的鼠标钩子触发器满足主进程 validateMethodParams(trigger_register) 契约并能正确解析和同步关闭', async () => {
    const { validateMethodParams } = await import('../../../../electron-client/src/contracts/method-params.ts')

    const payload = buildMouseWakeTrigger({
      mode: 'right:long',
      longPressMs: 350,
      fullscreenDnd: true
    })
    expect(() => validateMethodParams('trigger_register', structuredClone(payload))).not.toThrow()
    expect(payload).toMatchObject({
      id: MOUSE_WAKE_TRIGGER_ID,
      pluginId: 'system',
      type: 'hook',
      config: { kind: 'mouse', button: 'right', action: 'long', longPressMs: 350, fullscreenDnd: true },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    })

    // 解析触发器列表还原配置（未配置时默认开启全屏免打扰）
    expect(parseMouseWakeTrigger([])).toEqual({
      exists: false,
      mode: 'off',
      longPressMs: 300,
      fullscreenDnd: true
    })
    expect(parseMouseWakeTrigger([payload])).toEqual({
      exists: true,
      mode: 'right:long',
      longPressMs: 350,
      fullscreenDnd: true
    })

    // 注册保存鼠标钩子
    const regResult = await syncMouseWakeHook({ mode: 'middle:press', longPressMs: 100, fullscreenDnd: false })
    expect(regResult.success).toBe(true)
    expect(triggerMock.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MOUSE_WAKE_TRIGGER_ID,
        type: 'hook',
        config: expect.objectContaining({ kind: 'mouse', button: 'middle', action: 'press', longPressMs: 200 })
      })
    )

    // 关闭时仅注销存在的 mouse_wake_hook
    triggerMock.list.mockResolvedValue({ data: [payload] })
    const offResult = await syncMouseWakeHook({ mode: 'off' })
    expect(offResult.success).toBe(true)
    expect(triggerMock.unregister).toHaveBeenCalledWith(MOUSE_WAKE_TRIGGER_ID)
  })

  it('全屏免打扰开关仅同步至 mouse_wake_hook 与 Double* 热键触发器', async () => {
    const mouseTrigger = {
      id: MOUSE_WAKE_TRIGGER_ID,
      pluginId: 'system',
      type: 'hook',
      enabled: true,
      config: { kind: 'mouse', button: 'middle', action: 'long', longPressMs: 300, fullscreenDnd: false },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    }
    const doubleCtrlTrigger = {
      id: 'global_wake_hotkey',
      pluginId: 'system',
      type: 'hotkey',
      enabled: true,
      config: { key: 'DoubleCtrl', fullscreenDnd: false },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    }
    const normalHotkeyTrigger = {
      id: 'plugin_launch_demo',
      pluginId: 'demo',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+D' },
      action: { mode: 'window', target: 'demo', params: {} }
    }
    triggerMock.list.mockResolvedValue({ data: [mouseTrigger, doubleCtrlTrigger, normalHotkeyTrigger] })

    const res = await syncFullscreenDndToTriggers(true)
    expect(res).toMatchObject({ success: true, updatedCount: 2 })
    expect(triggerMock.register).toHaveBeenCalledTimes(2)
    expect(triggerMock.register.mock.calls[0][0].config.fullscreenDnd).toBe(true)
    expect(triggerMock.register.mock.calls[1][0].config.fullscreenDnd).toBe(true)
  })

  it('syncGlobalLauncherHotkey 独立注册 toggle_launcher 且满足主进程契约、支持注销与失败回滚', async () => {
    const { validateMethodParams } = await import('../../../../electron-client/src/contracts/method-params.ts')
    hotkeyMock.getLauncherHotkey.mockResolvedValue(DEFAULT_GLOBAL_LAUNCHER_HOTKEY)

    const regRes = await syncGlobalLauncherHotkey()
    expect(regRes).toEqual({ success: true, hotkey: DEFAULT_GLOBAL_LAUNCHER_HOTKEY })
    expect(currentGlobalLauncherHotkey.value).toBe(DEFAULT_GLOBAL_LAUNCHER_HOTKEY)
    const registeredPayload = triggerMock.register.mock.calls[0][0]
    expect(() => validateMethodParams('trigger_register', structuredClone(registeredPayload))).not.toThrow()
    expect(registeredPayload).toMatchObject({
      id: GLOBAL_LAUNCHER_TRIGGER_ID,
      pluginId: 'system',
      type: 'hotkey',
      config: { key: DEFAULT_GLOBAL_LAUNCHER_HOTKEY },
      actionMode: 'builtin',
      actionTarget: 'toggle_launcher'
    })

    // 仅注销 global_launcher_hotkey，不触碰 global_wake_hotkey
    triggerMock.list.mockResolvedValue({
      data: [
        { id: 'global_wake_hotkey', enabled: true, config: { key: 'Alt+Space' }, action: { mode: 'builtin', target: 'toggle_main_window', params: {} } },
        { id: GLOBAL_LAUNCHER_TRIGGER_ID, enabled: true, config: { key: DEFAULT_GLOBAL_LAUNCHER_HOTKEY }, action: { mode: 'builtin', target: 'toggle_launcher', params: {} } }
      ]
    })
    const clearRes = await syncGlobalLauncherHotkey({ hotkey: '' })
    expect(clearRes).toEqual({ success: true, hotkey: '' })
    expect(triggerMock.unregister).toHaveBeenCalledWith(GLOBAL_LAUNCHER_TRIGGER_ID)
    expect(triggerMock.unregister).not.toHaveBeenCalledWith('global_wake_hotkey')
    expect(currentGlobalLauncherHotkey.value).toBe('')

    // 注册新热键失败时自动恢复原 global_launcher_hotkey（且保留 toggle_launcher）
    triggerMock.register.mockReset()
    triggerMock.register
      .mockRejectedValueOnce(new Error('操作系统拒绝注册'))
      .mockResolvedValueOnce({ success: true })
    const failRes = await syncGlobalLauncherHotkey({ hotkey: 'Ctrl+Alt+Space' })
    expect(failRes.success).toBe(false)
    expect(failRes.reason).toBe('trigger_register_failed')
    expect(triggerMock.register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: GLOBAL_LAUNCHER_TRIGGER_ID,
        config: { key: DEFAULT_GLOBAL_LAUNCHER_HOTKEY },
        action: expect.objectContaining({ mode: 'builtin', target: 'toggle_launcher' })
      })
    )

    // refreshCurrentGlobalLauncherHotkey 读取最新配置
    hotkeyMock.getLauncherHotkey.mockResolvedValue('Ctrl+Alt+L')
    await expect(refreshCurrentGlobalLauncherHotkey()).resolves.toBe('Ctrl+Alt+L')
    expect(currentGlobalLauncherHotkey.value).toBe('Ctrl+Alt+L')
  })
})
