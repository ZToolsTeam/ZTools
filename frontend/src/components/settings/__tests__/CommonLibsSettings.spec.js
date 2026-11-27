import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn()
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMocks
}))

import CommonLibsSettings from '../CommonLibsSettings.vue'
import { setI18nLocale } from '@/i18n'

describe('CommonLibsSettings 引擎工具池与存储管理组件', () => {
  beforeEach(() => {
    setI18nLocale('zh-CN')
    Object.values(toastMocks).forEach((fn) => fn.mockReset())
    delete global.window.ztools
    delete global.window.__ztoolsElectron
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete global.window.ztools
    delete global.window.__ztoolsElectron
  })

  it('无数据时如实渲染空状态与 0 B 占用（零假数据）', async () => {
    const listMock = vi.fn().mockResolvedValue({
      items: [],
      totalSizeBytes: 0
    })
    global.window.__ztoolsElectron = {
      ipc: {
        tool_commonlibs_list: listMock,
        tool_commonlibs_clean: vi.fn()
      }
    }

    const wrapper = mount(CommonLibsSettings)
    await flushPromises()

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="commonlibs-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="commonlibs-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="commonlibs-summary"]').text()).toContain('总占用 0 B')
    expect(wrapper.find('[data-testid="commonlibs-summary"]').text()).toContain('共 0 个版本')

    wrapper.unmount()
  })

  it('正确渲染工具版本列表、格式化磁盘占用、关联引用与四种状态徽章，且引用中项不可手动清理', async () => {
    const listMock = vi.fn().mockResolvedValue({
      totalSizeBytes: 157286400 + 2097152 + 51200 + 1024,
      items: [
        {
          toolId: 'media-engine-7.1.0',
          toolName: 'media-engine',
          version: '7.1.0',
          platformArch: 'win32-x64',
          sizeBytes: 157286400, // 150 MB
          installedAt: '2026-10-01T00:00:00.000Z',
          status: 'ready',
          referencedByCapabilities: ['media.probe', 'media.transcode'],
          referencedByPlugins: ['batch-video', 'batch-audio'],
          canManualClean: false
        },
        {
          toolId: 'stream-engine-2.0.0',
          toolName: 'stream-engine',
          version: '2.0.0',
          platformArch: 'darwin-arm64',
          sizeBytes: 2097152, // 2.0 MB
          installedAt: '2026-09-01T00:00:00.000Z',
          status: 'unreferenced',
          referencedByCapabilities: [],
          referencedByPlugins: [],
          canManualClean: true
        },
        {
          toolId: 'legacy-engine-1.0.0',
          toolName: 'legacy-engine',
          version: '1.0.0',
          platformArch: 'win32-x64',
          sizeBytes: 51200, // 50.0 KB
          installedAt: '2026-08-01T00:00:00.000Z',
          status: 'revoked',
          referencedByCapabilities: [],
          referencedByPlugins: [],
          canManualClean: true,
          revokedReason: '存在已知高危漏洞 CVE-2026-0001'
        },
        {
          toolId: 'broken-engine-0.9.0',
          toolName: 'broken-engine',
          version: '0.9.0',
          platformArch: 'darwin-x64',
          sizeBytes: 1024, // 1.0 KB
          installedAt: '2026-07-01T00:00:00.000Z',
          status: 'corrupted',
          referencedByCapabilities: [],
          referencedByPlugins: [],
          canManualClean: true
        }
      ]
    })

    global.window.ztools = {
      toolRuntime: {
        listCommonLibs: listMock,
        cleanCommonLibs: vi.fn()
      }
    }

    const wrapper = mount(CommonLibsSettings)
    await flushPromises()

    expect(wrapper.find('[data-testid="commonlibs-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="commonlibs-summary"]').text()).toContain('共 4 个版本')

    // 就绪且引用中项：不可删，展示「使用中」
    const readyRow = wrapper.find('[data-testid="commonlib-row-media-engine-7.1.0"]')
    expect(readyRow.find('[data-testid="commonlib-status-tag"]').text()).toBe('就绪')
    expect(readyRow.find('[data-testid="commonlib-arch-tag"]').text()).toBe('win32-x64')
    expect(readyRow.find('[data-testid="commonlib-size"]').text()).toBe('150 MB')
    expect(readyRow.find('[data-testid="commonlib-refs"]').text()).toContain('media.probe, media.transcode')
    expect(readyRow.find('[data-testid="commonlib-refs"]').text()).toContain('batch-video, batch-audio')
    expect(readyRow.find('[data-testid="commonlib-clean-btn-media-engine-7.1.0"]').exists()).toBe(false)
    expect(readyRow.find('[data-testid="commonlib-in-use-media-engine-7.1.0"]').text()).toBe('使用中')

    // 待回收项：可手动清理
    const unrefRow = wrapper.find('[data-testid="commonlib-row-stream-engine-2.0.0"]')
    expect(unrefRow.find('[data-testid="commonlib-status-tag"]').text()).toBe('待回收')
    expect(unrefRow.find('[data-testid="commonlib-size"]').text()).toBe('2.0 MB')
    expect(unrefRow.find('[data-testid="commonlib-clean-btn-stream-engine-2.0.0"]').exists()).toBe(true)

    // 已撤销项：展示撤销原因且可清理
    const revokedRow = wrapper.find('[data-testid="commonlib-row-legacy-engine-1.0.0"]')
    expect(revokedRow.find('[data-testid="commonlib-status-tag"]').text()).toBe('已撤销')
    expect(revokedRow.find('[data-testid="commonlib-size"]').text()).toBe('50.0 KB')
    expect(revokedRow.find('[data-testid="commonlib-revoked-reason"]').text()).toContain('CVE-2026-0001')

    // 损坏项
    const brokenRow = wrapper.find('[data-testid="commonlib-row-broken-engine-0.9.0"]')
    expect(brokenRow.find('[data-testid="commonlib-status-tag"]').text()).toBe('损坏')
    expect(brokenRow.find('[data-testid="commonlib-size"]').text()).toBe('1.0 KB')

    wrapper.unmount()
  })

  it('点击单个「立即清理」与顶部「清理过期引擎」准确调用 IPC 并刷新列表', async () => {
    const listMock = vi.fn()
      .mockResolvedValueOnce({
        totalSizeBytes: 5242880,
        items: [
          {
            toolId: 'unused-tool-1.0.0',
            toolName: 'unused-tool',
            version: '1.0.0',
            platformArch: 'win32-x64',
            sizeBytes: 5242880,
            installedAt: '2026-09-01T00:00:00.000Z',
            status: 'unreferenced',
            referencedByCapabilities: [],
            referencedByPlugins: [],
            canManualClean: true
          }
        ]
      })
      .mockResolvedValue({
        totalSizeBytes: 0,
        items: []
      })

    const cleanMock = vi.fn()
      .mockResolvedValueOnce({
        removedToolIds: ['unused-tool-1.0.0'],
        skippedToolIds: [],
        reclaimedBytes: 5242880
      })
      .mockResolvedValueOnce({
        removedToolIds: [],
        skippedToolIds: [],
        reclaimedBytes: 0
      })

    global.window.__ztoolsElectron = {
      ipc: {
        tool_commonlibs_list: listMock,
        tool_commonlibs_clean: cleanMock
      }
    }

    const wrapper = mount(CommonLibsSettings)
    await flushPromises()

    // 点击单项立即清理
    await wrapper.find('[data-testid="commonlib-clean-btn-unused-tool-1.0.0"]').trigger('click')
    await flushPromises()

    expect(cleanMock).toHaveBeenCalledWith({ toolId: 'unused-tool-1.0.0' })
    expect(toastMocks.success).toHaveBeenCalledWith('已清理「unused-tool-1.0.0」，释放 5.0 MB')
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="commonlibs-empty"]').exists()).toBe(true)

    // 点击顶部清理过期引擎
    await wrapper.find('[data-testid="commonlibs-clean-expired-btn"]').trigger('click')
    await flushPromises()

    expect(cleanMock).toHaveBeenLastCalledWith({ runGc: true })
    expect(toastMocks.success).toHaveBeenLastCalledWith('当前没有可回收的过期引擎')

    wrapper.unmount()
  })

  it('IPC 加载失败与清理报错时清晰展示错误提示，不静默吞错也不伪造成功', async () => {
    const listMock = vi.fn()
      .mockRejectedValueOnce(new Error('DISK_ACCESS_DENIED'))
      .mockResolvedValueOnce({
        totalSizeBytes: 2048,
        items: [
          {
            toolId: 'locked-tool-1.0.0',
            toolName: 'locked-tool',
            version: '1.0.0',
            platformArch: 'win32-x64',
            sizeBytes: 2048,
            installedAt: '2026-09-01T00:00:00.000Z',
            status: 'unreferenced',
            referencedByCapabilities: [],
            referencedByPlugins: [],
            canManualClean: true
          }
        ]
      })

    const cleanMock = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'TOOL_EXECUTION_FAILED', message: '目标进程占用中，无法删除' }
    })

    global.window.__ztoolsElectron = {
      ipc: {
        tool_commonlibs_list: listMock,
        tool_commonlibs_clean: cleanMock
      }
    }

    const wrapper = mount(CommonLibsSettings)
    await flushPromises()

    // 首次加载报错展示错误横幅，不显示空状态也不造假数据
    expect(wrapper.find('[data-testid="commonlibs-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="commonlibs-load-error"]').text()).toContain('DISK_ACCESS_DENIED')
    expect(wrapper.find('[data-testid="commonlibs-empty"]').exists()).toBe(false)

    // 点击重试恢复列表
    await wrapper.find('[data-testid="commonlibs-retry-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="commonlibs-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="commonlib-row-locked-tool-1.0.0"]').exists()).toBe(true)

    // 清理返回错误信封时清晰展示错误提示且不弹出成功提示
    await wrapper.find('[data-testid="commonlib-clean-btn-locked-tool-1.0.0"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="commonlibs-action-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="commonlibs-action-error"]').text()).toContain('目标进程占用中，无法删除')
    expect(toastMocks.error).toHaveBeenCalledWith('清理引擎失败：目标进程占用中，无法删除')
    expect(toastMocks.success).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
