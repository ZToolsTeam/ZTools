import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import Diagnostics from '../Diagnostics.vue'
import { setI18nLocale } from '@/i18n'

vi.mock('@/api/native', () => ({
  isNative: true,
  sys: {},
  fs: {},
  win: {},
  network: {},
  process: {},
  screen: {},
  simulate: {},
  db: {},
  privileged: {},
  trigger: {},
  protocol: {},
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageDelete: vi.fn(),
  getDllPluginList: vi.fn(),
  callDllPlugin: vi.fn()
}))

vi.mock('ant-design-vue', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  Modal: { confirm: vi.fn() },
  // RcSelect / RcAlert / RcDialog 的底层组件：本测试只关心批量诊断逻辑，渲染成空壳即可
  Select: { name: 'ASelect', render: () => null },
  Alert: { name: 'AAlert', render: () => null }
}))

// 页面仍直接使用的 antd 输入类组件渲染成空壳即可（按钮、卡片、分段切换走真实的 Rc 基础组件）；
// a-alert / a-select 会匹配上面 mock 的 AAlert / ASelect，桩元素保留 data-test 属性供断言
const antDesignStubs = Object.fromEntries(
  ['a-alert', 'a-input', 'a-input-number', 'a-select', 'a-slider', 'a-textarea'].map((name) => [
    name,
    true
  ])
)

function createHost(platform, { failPlatformRead = false } = {}) {
  const getInfo = failPlatformRead
    ? vi.fn().mockRejectedValue(new Error('system info unavailable'))
    : vi.fn().mockResolvedValue({ success: true, platform })

  const ztools = {
    isElectron: () => true,
    sys: {
      getInfo,
      getCPUUsage: vi.fn().mockResolvedValue({ success: true, data: { total: 0 } }),
      getMemoryUsage: vi.fn().mockResolvedValue({ success: true, data: { total: 1024 } }),
      getPath: vi.fn().mockResolvedValue('/tmp'),
      privilegedExecute: vi.fn(),
      simulateKeyPress: vi.fn()
    },
    fs: {
      getCurrentDirectory: vi.fn().mockResolvedValue('/tmp'),
      fileExists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue('127.0.0.1 localhost'),
      writeFile: vi.fn()
    },
    events: { on: vi.fn(), off: vi.fn() },
    win: { getBounds: vi.fn().mockResolvedValue({ width: 100, height: 100 }) },
    clipboard: { writeText: vi.fn() },
    screen: {
      getAllDisplays: vi.fn().mockResolvedValue([]),
      getCursorScreenPoint: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
      captureFullScreen: vi.fn()
    },
    process: { list: vi.fn().mockResolvedValue([]) },
    plugin: {
      getList: vi.fn().mockResolvedValue({ success: true, data: [{ pluginId: 'installed', builtin: false }] }),
      uninstall: vi.fn(),
      install: vi.fn()
    },
    dllplugin: { list: vi.fn().mockResolvedValue([]) }
  }
  return { ztools }
}

async function runBatch(wrapper) {
  const runButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes('开始只读体检'))
  expect(runButton).toBeDefined()
  await runButton.trigger('click')
  await vi.runAllTimersAsync()
  await nextTick()
}

async function selectTab(wrapper, key) {
  wrapper.vm.$.setupState.activeTab = key
  await nextTick()
}

describe('Diagnostics batch platform filtering', () => {
  let wrapper

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    delete window.ztools
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function mountDiagnostics(platform, options) {
    const host = createHost(platform, options)
    window.ztools = host.ztools
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }))
    vi.useFakeTimers()

    wrapper = mount(Diagnostics, { global: { stubs: antDesignStubs } })
    await nextTick()
    await runBatch(wrapper)
    return host
  }

  it('runs Windows read-only checks and leaves installed plugins and user data untouched', async () => {
    const { ztools } = await mountDiagnostics('windows')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '检测平台：Windows'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 0')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(true)
    await selectTab(wrapper, '8')
    expect(wrapper.find('[data-test="windows-advanced-diagnostics"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-simulation-disabled"]').exists()).toBe(true)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.fs.readFile).not.toHaveBeenCalled()
    expect(ztools.plugin.uninstall).not.toHaveBeenCalled()
    expect(ztools.plugin.install).not.toHaveBeenCalled()
    expect(ztools.fs.writeFile).not.toHaveBeenCalled()
    expect(ztools.clipboard.writeText).not.toHaveBeenCalled()
    expect(ztools.screen.captureFullScreen).not.toHaveBeenCalled()
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(ztools.sys.simulateKeyPress).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(
      'ztools://web/index.html'
    )
  })

  it('skips Windows-specific tests on macOS without counting failures', async () => {
    const { ztools } = await mountDiagnostics('macos')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '检测平台：macOS'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 1')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(false)
    await selectTab(wrapper, '8')
    expect(wrapper.find('[data-test="windows-advanced-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-advanced-diagnostics"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-simulation-disabled"]').exists()).toBe(true)
    expect(ztools.process.list).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.fs.readFile).not.toHaveBeenCalledWith(
      'C:\\Windows\\System32\\drivers\\etc\\hosts'
    )
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('ztools://web/index.html')
    expect(wrapper.text()).toContain('Windows 专用测试')
  })

  it('skips Windows-specific tests and reports unknown host platforms', async () => {
    const { ztools } = await mountDiagnostics('unknown')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '宿主平台“unknown”'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 1')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(false)
    expect(ztools.process.list).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('ztools://web/index.html')
  })

  it('marks platform-read failures clearly and excludes Windows tests from scoring', async () => {
    const { ztools } = await mountDiagnostics('', { failPlatformRead: true })

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '无法读取宿主平台'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 1')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 1')
    expect(ztools.process.list).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('ztools://web/index.html')
    expect(wrapper.text()).not.toMatch(/\[PASS\] (文件存在性|读取文件|特权服务)/)
    expect(wrapper.text()).not.toMatch(/\[FAIL\] (文件存在性|读取文件|特权服务)/)
  })

  it('counts returned errors, malformed data, and protocol failures separately from successful checks', async () => {
    const { ztools } = await mountDiagnostics('windows')
    ztools.plugin.getList.mockResolvedValue({ success: false, error: 'plugin registry unavailable', data: [] })
    ztools.process.list.mockResolvedValue(null)
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 })
    await runBatch(wrapper)
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 3')
    expect(wrapper.text()).toContain('plugin registry unavailable')
    expect(wrapper.text()).toContain('HTTP 403')
    expect(wrapper.text()).toContain('宿主返回的数据无效')
  })

  it('stops the batch after leaving the page while a host read is pending', async () => {
    const { ztools } = createHost('macos')
    const pending = Promise.withResolvers()
    ztools.sys.getCPUUsage.mockReturnValue(pending.promise)
    window.ztools = ztools
    wrapper = mount(Diagnostics, { global: { stubs: antDesignStubs } })
    await wrapper.findAll('button').find(button => button.text() === '开始只读体检').trigger('click')
    await flushPromises()
    expect(ztools.sys.getCPUUsage).toHaveBeenCalledOnce()
    wrapper.unmount()
    wrapper = null
    pending.resolve({ success: true, data: { total: 0 } })
    await flushPromises()
    expect(ztools.sys.getPath).not.toHaveBeenCalled()
  })

  it('ignores an old read when a cached diagnostics page starts another batch', async () => {
    const { ztools } = createHost('macos')
    const oldRead = Promise.withResolvers()
    ztools.sys.getCPUUsage.mockReturnValueOnce(oldRead.promise)
    window.ztools = ztools
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }))
    wrapper = mount({
      components: { Diagnostics },
      data: () => ({ visible: true }),
      template: '<KeepAlive><Diagnostics v-if="visible" /></KeepAlive>'
    }, { global: { stubs: antDesignStubs } })
    const start = () => wrapper.findAll('button').find(button => button.text() === '开始只读体检').trigger('click')
    await start()
    await flushPromises()
    await wrapper.setData({ visible: false })
    await wrapper.setData({ visible: true })
    await start()
    await flushPromises()
    oldRead.resolve({ success: false })
    await flushPromises()
    expect(ztools.sys.getCPUUsage).toHaveBeenCalledTimes(2)
    expect(ztools.process.list).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
  })

  it('switches UI labels, batch results, and toLocaleTimeString locale when switching to en-US', async () => {
    const timeSpy = vi.spyOn(Date.prototype, 'toLocaleTimeString')
    setI18nLocale('en-US')
    const host = createHost('macos')
    window.ztools = host.ztools
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<html></html>' }))
    vi.useFakeTimers()

    wrapper = mount(Diagnostics, { global: { stubs: antDesignStubs } })
    await nextTick()

    expect(wrapper.find('.page-title').text()).toBe('API Diagnostics')
    expect(wrapper.find('.diag-mode').text()).toContain('Host Mode')
    expect(timeSpy).toHaveBeenCalledWith('en-US')

    const runButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Run read-only checks'))
    expect(runButton).toBeDefined()
    await runButton.trigger('click')
    await vi.runAllTimersAsync()
    await nextTick()

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain('Detected platform: macOS')
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('Failed: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('Skipped: 1')
    expect(wrapper.text()).toContain('Live Logs')

    // 热切回中文后，已有批量平台状态与标签即时更新为中文
    setI18nLocale('zh-CN')
    await nextTick()
    expect(wrapper.find('.page-title').text()).toBe('API 诊断中心')
    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain('检测平台：macOS')
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    timeSpy.mockRestore()
  })
})
