import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UpdateNotification from '../UpdateNotification.vue'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update'
import ShellAPI from '../../../public/js/cef-ipc/src/api/shell'

const macInfo = {
  version: '1.1.8.3', changelog: '更新说明 <script>test</script>',
  downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-darwin-universal.dmg',
  checksum: 'a'.repeat(64), fileSize: 4096
}
let wrapper
const body = () => new DOMWrapper(document.body)
let transport

beforeEach(() => {
  setActivePinia(createPinia())
  transport = { call: vi.fn().mockResolvedValue({ success: true }) }
  window.ztools = { update: new UpdateAPI(transport), shell: new ShellAPI(transport) }
  window.__ztoolsToast = vi.fn()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.replaceChildren()
  delete window.ztools
  delete window.__ztoolsToast
})

async function show(info) {
  wrapper = mount(UpdateNotification, { attachTo: document.body })
  await wrapper.vm.show('app', info)
  await flushPromises()
}

describe('更新通知的真实 SDK 链路', () => {
  it('更新说明渲染标题、列表和加粗，兼容旧换行并阻止脚本注入', async () => {
    await show({ ...macInfo, changelog: '## 修复\\n\\n- **窗口唤醒**已修复\\n- 安装更顺畅\\n\\n<script>alert(1)</script>\n[恶意链接](javascript:alert(1))' })
    expect(body().get('.update-changelog h2').text()).toBe('修复')
    expect(body().get('.update-changelog strong').text()).toBe('窗口唤醒')
    expect(body().get('.update-changelog').text()).not.toContain('##')
    expect(body().find('.update-changelog script').exists()).toBe(false)
    expect(body().find('.update-changelog a[href^="javascript:"]').exists()).toBe(false)
    expect(body().find('[role="dialog"]').exists()).toBe(true)
  })

  it('强制更新保留主动作，不提供跳过、稍后和关闭入口', async () => {
    await show({ ...macInfo, force: true, changelog: '' })
    expect(body().text()).toContain('新版本已就绪')
    expect(body().find('.update-skip').exists()).toBe(false)
    expect(body().find('.update-btn-ghost').exists()).toBe(false)
    expect(body().find('.rc-dialog-close').exists()).toBe(false)
    expect(body().get('.update-btn-primary').text()).toBe('立即更新')
  })

  it('Mac 检查结果经 SDK 下载并交给安装器，不打开浏览器', async () => {
    transport.call.mockImplementation(async method => method === 'update_check'
      ? { success: true, app: macInfo, web: null } : { success: true })
    const result = await window.ztools.update.check()
    await show(result.app)
    expect(body().text()).toContain('自动重启')
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_check', 'update_download_start', 'update_install_start'])
    expect(transport.call).toHaveBeenCalledWith('update_download_start', expect.objectContaining({ downloadUrl: macInfo.downloadUrl }), { timeout: Infinity })
    expect(window.__ztoolsToast).toHaveBeenCalledWith('success', expect.stringContaining('即将重启'))
  })

  it('Mac 安装准备失败保留错误与重试按钮，不声称已完成', async () => {
    transport.call.mockImplementation(async method => {
      if (method === 'update_install_start') throw new Error('更新包签名不一致')
      return { success: true }
    })
    await show(macInfo)
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('更新包签名不一致')
    expect(body().get('.update-btn-primary').text()).toBe('立即更新')
    expect(window.__ztoolsToast).not.toHaveBeenCalledWith('success', expect.anything())
    transport.call.mockResolvedValue({ success: true })
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(window.__ztoolsToast).toHaveBeenCalledWith('success', expect.any(String))
  })

  it('下载期间不重复请求，取消后迟到的下载成功不会继续安装或提示成功', async () => {
    let finish
    transport.call.mockImplementation(method => method === 'update_download_start'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true, installing: false }))
    await show(macInfo)
    const button = body().get('.update-btn-primary')
    await button.trigger('click')
    await button.trigger('click')
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(body().find('.update-progress').exists()).toBe(true)
    await body().get('.update-btn-ghost').trigger('click')
    finish({ success: true })
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_download_start', 'update_cancel'])
    expect(window.__ztoolsToast).not.toHaveBeenCalled()
  })

  it('原生安装已接管时取消被拒绝，界面继续显示准备重启', async () => {
    let finish
    transport.call.mockImplementation(method => method === 'update_install_start'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true, installing: method === 'update_cancel' }))
    await show(macInfo)
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    await body().get('.update-btn-ghost').trigger('click')
    await flushPromises()
    expect(body().text()).toContain('正在校验并准备重启')
    expect(body().find('.update-btn-ghost').exists()).toBe(false)
    finish({ success: true })
    await flushPromises()
    expect(window.__ztoolsToast).toHaveBeenCalledWith('success', expect.any(String))
  })

  it.each(['failed', 'installing'])('安装先失败、取消随后 %s 时仍显示安装错误并允许重试', async outcome => {
    let failInstall
    let finishCancel
    transport.call.mockImplementation(method => {
      if (method === 'update_install_start') return new Promise((_resolve, reject) => { failInstall = reject })
      if (method === 'update_cancel') return new Promise((resolve, reject) => { finishCancel = () => outcome === 'failed' ? reject(new Error('取消失败')) : resolve({ success: true, installing: true }) })
      return Promise.resolve({ success: true })
    })
    await show(macInfo)
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    await body().get('.update-btn-ghost').trigger('click')
    failInstall(new Error('安装准备失败'))
    await flushPromises()
    finishCancel()
    await flushPromises()
    expect(body().text()).toContain('安装准备失败')
    expect(body().get('.update-btn-primary').text()).toBe('立即更新')
  })

  it('首次下载失败后直接重试，接受新任务进度并在完成下载后关闭取消入口', async () => {
    let progressHandler
    let failDownload
    let finishDownload
    window.ztools.events = {
      subscribe: vi.fn().mockResolvedValue(true),
      on: (_name, handler) => { progressHandler = handler },
      off: vi.fn()
    }
    transport.call.mockImplementationOnce(() => new Promise((_resolve, reject) => { failDownload = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { finishDownload = resolve }))
      .mockResolvedValue({ success: true })
    await show(macInfo)
    await body().get('.update-btn-primary').trigger('click')
    progressHandler({ payload: { type: 'app', operationId: 'first', percent: 40 } })
    failDownload(new Error('下载中断'))
    await flushPromises()
    await body().get('.update-btn-primary').trigger('click')
    progressHandler({ payload: { type: 'app', operationId: 'retry', percent: 30 } })
    await flushPromises()
    expect(body().get('.update-progress').text()).toContain('30%')
    progressHandler({ payload: { type: 'app', operationId: 'retry', percent: 100 } })
    await flushPromises()
    expect(body().text()).toContain('正在校验并准备重启')
    expect(body().find('.update-btn-ghost').exists()).toBe(false)
    finishDownload({ success: true })
    await flushPromises()
  })

  it('Windows 下载失败时不调用安装器，也不显示成功', async () => {
    transport.call.mockResolvedValue({ success: false, message: '下载校验失败' })
    await show({ ...macInfo, manualUpdate: false, downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-windows-x64.exe' })
    expect(body().get('.update-btn-primary').text()).toBe('立即更新')
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_download_start'])
    expect(body().text()).toContain('下载校验失败')
    expect(window.__ztoolsToast).not.toHaveBeenCalledWith('success', expect.anything())
  })

  it('Windows 下载和安装均成功后才提示安装器启动', async () => {
    await show({ ...macInfo, manualUpdate: false, downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-windows-x64.exe' })
    await body().get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_download_start', 'update_install_start'])
    expect(window.__ztoolsToast).toHaveBeenCalledWith('success', expect.stringContaining('更新已准备完成'))
  })

  it('Windows 在清理偏好期间取消，随后恢复也不会开始下载安装', async () => {
    let finish
    window.ztools.db = {
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(null)
    }
    await show({ ...macInfo, manualUpdate: false })
    await body().get('.update-btn-primary').trigger('click')
    await body().get('.update-btn-ghost').trigger('click')
    finish()
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_cancel'])
    expect(window.__ztoolsToast).not.toHaveBeenCalled()
  })
})
