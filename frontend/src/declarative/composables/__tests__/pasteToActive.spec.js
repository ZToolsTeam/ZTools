import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDeclarativeBridge } from '@ztools/declarative-ui'

vi.mock('ant-design-vue', () => ({ Modal: { confirm: vi.fn(() => ({ destroy() {} })) } }))
// useDeclarativeStack 内部使用 onUnmounted，脱离组件调用时不需要真实生命周期
vi.mock('vue', async (importOriginal) => ({ ...(await importOriginal()), onUnmounted: () => {} }))

import { useDeclarativeStack } from '../useDeclarativeStack'

function installTransport(handler) {
  const calls = []
  window.__ztoolsElectron = {
    transport: {
      methods: {
        clipboard_hide_and_paste_text: async (request) => {
          calls.push(request.params)
          return handler(request.params)
        }
      }
    }
  }
  return calls
}

describe('声明式 Bridge pasteToActive（粘贴到前台应用）', () => {
  beforeEach(() => {
    useDeclarativeStack(null)
  })
  afterEach(() => {
    delete window.__ztoolsElectron
    vi.unstubAllGlobals()
  })

  it('宿主粘贴成功时正常返回', async () => {
    const calls = installTransport(() => ({ success: true, data: { success: true } }))
    await expect(getDeclarativeBridge().pasteToActive(84)).resolves.toBeUndefined()
    expect(calls).toEqual([{ text: '84' }])
  })

  it('宿主返回 PERMISSION_DENIED（macOS 未授权辅助功能）时把错误抛给插件，不能吞掉', async () => {
    installTransport(() => ({
      success: false,
      error: { code: 'PERMISSION_DENIED', message: '已复制，但无法自动粘贴：请在系统设置 -> 隐私与安全性 -> 辅助功能中授权 ZTools' }
    }))
    await expect(getDeclarativeBridge().pasteToActive('#123456')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: expect.stringContaining('辅助功能')
    })
  })

  it('缺少宿主自动粘贴方法时即使已复制也必须报不支持', async () => {
    delete window.__ztoolsElectron
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(getDeclarativeBridge().pasteToActive('手动粘贴')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
    expect(writeText).toHaveBeenCalledWith('手动粘贴')
    vi.stubGlobal('navigator', {})
    await expect(getDeclarativeBridge().pasteToActive('未复制')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' })
  })

  it('宿主返回无法识别的信封或 IPC 抛错时同样报告失败', async () => {
    installTransport(() => null)
    await expect(getDeclarativeBridge().pasteToActive('x')).rejects.toMatchObject({ code: 'HOST_RESPONSE_INVALID' })
    installTransport(() => {
      throw new Error('IPC 管道断开')
    })
    await expect(getDeclarativeBridge().pasteToActive('x')).rejects.toThrow('IPC 管道断开')
  })
})
