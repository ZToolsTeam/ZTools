import { afterEach, describe, expect, it, vi } from 'vitest'
import native, { DEFAULT_GLOBAL_WAKE_HOTKEY } from '../native.js'

describe('native 全局唤醒快捷键读取', () => {
  afterEach(() => {
    delete window.ztools
  })

  it('从未设置时由配置服务返回默认值 Alt+Space', async () => {
    // 模拟主进程 config_get：配置项不存在时返回调用方给的默认值
    const get = vi.fn(async (_path, defaultValue) => defaultValue)
    window.ztools = { config: { get } }

    await expect(native.getHotkey()).resolves.toBe(DEFAULT_GLOBAL_WAKE_HOTKEY)
    expect(get).toHaveBeenCalledWith('hotkey.global', DEFAULT_GLOBAL_WAKE_HOTKEY)
  })

  it('用户已关闭（存的是空串）时返回空串，不退回默认值', async () => {
    window.ztools = { config: { get: vi.fn().mockResolvedValue('') } }
    await expect(native.getHotkey()).resolves.toBe('')
  })

  it('去掉首尾空白，非字符串按已关闭处理', async () => {
    window.ztools = { config: { get: vi.fn().mockResolvedValueOnce('  Ctrl+Q ').mockResolvedValueOnce(null) } }
    await expect(native.getHotkey()).resolves.toBe('Ctrl+Q')
    await expect(native.getHotkey()).resolves.toBe('')
  })

  it('[破坏性] 读取失败时抛错，不能把失败当成用户关闭了唤醒快捷键', async () => {
    window.ztools = { config: { get: vi.fn().mockRejectedValue(new Error('IPC 超时')) } }
    await expect(native.getHotkey()).rejects.toThrow('IPC 超时')
  })
})
