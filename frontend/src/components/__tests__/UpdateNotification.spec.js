import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import UpdateNotification from '../UpdateNotification.vue'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update'
import ShellAPI from '../../../public/js/cef-ipc/src/api/shell'

const macInfo = {
  version: '1.1.8.3', changelog: '更新说明 <script>test</script>',
  downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-darwin-universal.dmg',
  checksum: 'a'.repeat(64), fileSize: 4096, manualUpdate: true
}
let wrapper
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
  delete window.ztools
  delete window.__ztoolsToast
})

async function show(info) {
  wrapper = mount(UpdateNotification)
  await wrapper.vm.show('app', info)
  await flushPromises()
}

describe('更新通知的真实 SDK 链路', () => {
  it('Mac 检查结果经 SDK 传到组件，打开 DMG 并提示手动替换', async () => {
    transport.call.mockImplementation(async method => method === 'update_check'
      ? { success: true, app: macInfo, web: null } : { success: true })
    const result = await window.ztools.update.check()
    await show(result.app)
    expect(wrapper.text()).toContain('打开 DMG')
    expect(wrapper.find('script').exists()).toBe(false)
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call).toHaveBeenCalledWith('shell_open_external', { url: macInfo.downloadUrl })
    expect(transport.call.mock.calls.some(([method]) => method.startsWith('update_download') || method === 'update_install_start')).toBe(false)
    expect(window.__ztoolsToast).toHaveBeenCalledWith('info', expect.stringContaining('手动替换'))
    expect(window.__ztoolsToast).not.toHaveBeenCalledWith('success', expect.anything())
  })

  it('Mac 打开失败保留错误与重试按钮，不声称已经安装', async () => {
    transport.call.mockResolvedValue({ success: false })
    await show(macInfo)
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('无法打开安装包下载')
    expect(wrapper.get('.update-btn-primary').text()).toBe('下载 macOS 安装包')
    expect(window.__ztoolsToast).not.toHaveBeenCalled()
    transport.call.mockResolvedValue({ success: true })
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(window.__ztoolsToast).toHaveBeenCalledWith('info', expect.any(String))
  })

  it('Mac 拒绝旧版地址与非 DMG 地址，不调用系统打开', async () => {
    await show({ ...macInfo, downloadUrl: 'https://cdn.ztools.cn/app-setup/old.exe' })
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('安装包信息无效')
    expect(transport.call).not.toHaveBeenCalled()
  })

  it('Mac 等待系统打开期间不会重复发起下载', async () => {
    let finish
    transport.call.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await show(macInfo)
    await wrapper.get('.update-btn-primary').trigger('click')
    await wrapper.get('.update-btn-primary').trigger('click')
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.update-progress').exists()).toBe(false)
    finish({ success: true })
    await flushPromises()
  })

  it('Windows 下载失败时不调用安装器，也不显示成功', async () => {
    transport.call.mockResolvedValue({ success: false, message: '下载校验失败' })
    await show({ ...macInfo, manualUpdate: false, downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-win32-x64.exe' })
    expect(wrapper.get('.update-btn-primary').text()).toBe('立即更新')
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_download_start'])
    expect(wrapper.text()).toContain('下载校验失败')
    expect(window.__ztoolsToast).not.toHaveBeenCalledWith('success', expect.anything())
  })

  it('Windows 下载和安装均成功后才提示安装器启动', async () => {
    await show({ ...macInfo, manualUpdate: false, downloadUrl: 'https://cdn.ztools.cn/client-v2/1.1.8.3/ZTools-1.1.8.3-win32-x64.exe' })
    await wrapper.get('.update-btn-primary').trigger('click')
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_download_start', 'update_install_start'])
    expect(window.__ztoolsToast).toHaveBeenCalledWith('success', expect.stringContaining('安装器已启动'))
  })

  it('Windows 在清理偏好期间取消，随后恢复也不会开始下载安装', async () => {
    let finish
    window.ztools.db = {
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(null)
    }
    await show({ ...macInfo, manualUpdate: false })
    await wrapper.get('.update-btn-primary').trigger('click')
    await wrapper.get('.update-btn-ghost').trigger('click')
    finish()
    await flushPromises()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['update_cancel'])
    expect(window.__ztoolsToast).not.toHaveBeenCalled()
  })
})
