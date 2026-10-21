import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import LoginModal from '../LoginModal.vue'
import { useUIStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'

const authMocks = vi.hoisted(() => ({
  generateQrcode: vi.fn(),
  checkQrcodeStatus: vi.fn(),
  deviceLogin: vi.fn()
}))

const toastMocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('@/api/auth', () => ({
  generateQrcode: authMocks.generateQrcode,
  checkQrcodeStatus: authMocks.checkQrcodeStatus,
  deviceLogin: authMocks.deviceLogin
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMocks
}))

describe('LoginModal 组件与设备号登录', () => {
  let pinia

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    pinia = createPinia()
    setActivePinia(pinia)

    authMocks.generateQrcode.mockResolvedValue({
      qrcode_url: 'http://test.url/qrcode.png',
      scene_id: 'test-scene-123',
      expires_at: new Date(Date.now() + 600000).toISOString()
    })
    authMocks.checkQrcodeStatus.mockResolvedValue({
      status: 'pending'
    })
    authMocks.deviceLogin.mockResolvedValue({
      token: 'mock-device-jwt-token',
      user: { id: 100, nickname: 'AI测试专用设备号' }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('弹窗打开时渲染设备号模拟登录按钮', async () => {
    const uiStore = useUIStore()
    uiStore.showLoginModal = true

    const wrapper = mount(LoginModal, {
      global: {
        plugins: [pinia],
        stubs: {
          'a-modal': {
            template: '<div class="ant-modal-stub"><slot /></div>'
          }
        }
      }
    })

    await flushPromises()
    const deviceBtn = wrapper.find('.device-login-link')
    expect(deviceBtn.exists()).toBe(true)
    expect(deviceBtn.text()).toContain('设备号一键模拟登录')
  })

  it('点击设备号登录成功完成鉴权并关闭弹窗', async () => {
    const uiStore = useUIStore()
    const userStore = useUserStore()
    const checkLoginSpy = vi.spyOn(userStore, 'checkLoginStatus').mockResolvedValue(true)
    uiStore.showLoginModal = true

    const wrapper = mount(LoginModal, {
      global: {
        plugins: [pinia],
        stubs: {
          'a-modal': {
            template: '<div class="ant-modal-stub"><slot /></div>'
          }
        }
      }
    })

    await flushPromises()
    const deviceBtn = wrapper.find('.device-login-link')
    await deviceBtn.trigger('click')
    await flushPromises()

    expect(authMocks.deviceLogin).toHaveBeenCalledWith('ZTOOLS-TEST-DEVICE-0001', 'AI测试专用设备号')
    expect(checkLoginSpy).toHaveBeenCalled()
    expect(toastMocks.toastSuccess).toHaveBeenCalledWith('测试设备号登录成功！')

    // 推进定时器关闭弹窗
    vi.advanceTimersByTime(1000)
    expect(uiStore.showLoginModal).toBe(false)
  })

  it('设备号登录失败时展示错误提示并恢复状态', async () => {
    authMocks.deviceLogin.mockRejectedValueOnce(new Error('设备授权异常'))

    const uiStore = useUIStore()
    uiStore.showLoginModal = true

    const wrapper = mount(LoginModal, {
      global: {
        plugins: [pinia],
        stubs: {
          'a-modal': {
            template: '<div class="ant-modal-stub"><slot /></div>'
          }
        }
      }
    })

    await flushPromises()
    const deviceBtn = wrapper.find('.device-login-link')
    await deviceBtn.trigger('click')
    await flushPromises()

    expect(toastMocks.toastError).toHaveBeenCalledWith('设备授权异常')
    // 弹窗未被强制关闭
    expect(uiStore.showLoginModal).toBe(true)
  })

  it('正式包（非开发版）不显示设备号模拟登录按钮，只保留扫码登录', async () => {
    vi.stubEnv('DEV', false)
    try {
      const uiStore = useUIStore()
      uiStore.showLoginModal = true

      const wrapper = mount(LoginModal, {
        global: {
          plugins: [pinia],
          stubs: {
            'a-modal': {
              template: '<div class="ant-modal-stub"><slot /></div>'
            }
          }
        }
      })

      await flushPromises()
      expect(wrapper.find('.device-login-link').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('设备号一键模拟登录')
      expect(authMocks.deviceLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
