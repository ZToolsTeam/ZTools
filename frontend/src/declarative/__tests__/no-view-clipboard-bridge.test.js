import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setDeclarativeBridge } from '@ztools/declarative-ui'
import { executeDeclarativeNoViewCommand } from '@/utils/declarativePluginLoader'
import { ensureHostBridge, markPageBridgeInstalled } from '../hostClipboardBridge.js'

// 无界面命令在本窗口还没打开过插件页面时执行：Clipboard.copy 必须真的写进宿主剪贴板，失败必须报错
const pluginFiles = (id) => ({
  'plugin.json': JSON.stringify({
    id, name: '剪贴板命令', version: '1.0.0', description: 'test', author: 'Indie Dev', entry: 'dist/index.js', icon: 'icon.svg',
    permissions: ['clipboard'], features: [{ code: 'copy-now', explain: '复制', mode: 'no-view' }]
  }),
  'dist/index.js': `
    import { Clipboard } from '@ztools/declarative-ui'
    export async function copyNow() { await Clipboard.copy('识别出的文字'); return '已复制' }
  `
})

let calls
let copyResult
beforeEach(() => {
  setDeclarativeBridge(null)
  calls = []
  copyResult = { success: true, data: { success: true } }
  window.__ztoolsElectron = {
    transport: {
      methods: new Proxy({}, {
        get: (_t, method) => async (request) => {
          calls.push([method, request?.params])
          if (method === 'clipboard_copy_text') return { messageId: request.messageId, ...copyResult }
          return { messageId: request?.messageId, success: false, error: { code: 'NOT_SUPPORTED', message: `未实现 ${method}` } }
        }
      })
    }
  }
})
afterEach(() => {
  delete window.__ztoolsElectron
  setDeclarativeBridge(null)
})

describe('无界面命令的剪贴板 Bridge', () => {
  it('没有页面 Bridge 时补上宿主剪贴板，复制真正写入宿主', async () => {
    const files = pluginFiles('clip-cmd-ok')
    const result = await executeDeclarativeNoViewCommand('clip-cmd-ok', { featureCode: 'copy-now', readFile: async (_pid, p) => files[p] })
    expect(result.message).toBe('已复制')
    expect(calls.filter(([m]) => m === 'clipboard_copy_text').map(([, p]) => p)).toEqual([{ text: '识别出的文字' }])
  })

  it('宿主拒绝写入时命令失败，不能提示已复制', async () => {
    copyResult = { success: false, error: { code: 'RESPONSE_TOO_LARGE', message: '剪贴板文本超过 8 MiB 上限' } }
    const files = pluginFiles('clip-cmd-fail')
    await expect(
      executeDeclarativeNoViewCommand('clip-cmd-fail', { featureCode: 'copy-now', readFile: async (_pid, p) => files[p] })
    ).rejects.toMatchObject({ code: 'NO_VIEW_EXECUTION_ERROR', message: expect.stringContaining('8 MiB') })
  })

  it('页面已注册完整 Bridge 时不覆盖', async () => {
    const copied = []
    markPageBridgeInstalled()
    setDeclarativeBridge({ copyToClipboard: async (text) => { copied.push(text) } })
    ensureHostBridge()
    const files = pluginFiles('clip-cmd-page')
    await executeDeclarativeNoViewCommand('clip-cmd-page', { featureCode: 'copy-now', readFile: async (_pid, p) => files[p] })
    expect(copied).toEqual(['识别出的文字'])
    expect(calls.some(([m]) => m === 'clipboard_copy_text')).toBe(false)
  })
})
