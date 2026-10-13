import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import Diagnostics from '../Diagnostics.vue'

const moduleMocks = vi.hoisted(() => ({
  getMarketPlugins: vi.fn(),
  getPluginDetails: vi.fn(),
  getDownloadSign: vi.fn(),
  installPluginNative: vi.fn(),
  uninstallPluginNative: vi.fn()
}))

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
  getLocalPlugins: vi.fn(),
  openPlugin: vi.fn(),
  getDllPluginList: vi.fn(),
  callDllPlugin: vi.fn(),
  installPluginNative: moduleMocks.installPluginNative,
  uninstallPluginNative: moduleMocks.uninstallPluginNative
}))

vi.mock('@/api/apiserver', () => ({
  getMarketPlugins: moduleMocks.getMarketPlugins,
  getPluginDetails: moduleMocks.getPluginDetails,
  getDownloadSign: moduleMocks.getDownloadSign
}))

vi.mock('ant-design-vue', () => ({
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  Modal: { confirm: vi.fn() }
}))

const antDesignStubs = Object.fromEntries(
  [
    'a-alert',
    'a-card',
    'a-input',
    'a-input-number',
    'a-progress',
    'a-select',
    'a-select-option',
    'a-slider',
    'a-tab-pane',
    'a-tabs',
    'a-textarea'
  ].map((name) => [name, true])
)
antDesignStubs['a-tabs'] = {
  props: ['activeKey'],
  template: '<div><slot /></div>'
}
antDesignStubs['a-card'] = {
  props: ['title'],
  template: '<article><slot /></article>'
}
antDesignStubs['a-tab-pane'] = {
  props: ['tab'],
  template: '<section><slot /></section>'
}
antDesignStubs['a-button'] = {
  emits: ['click'],
  template: `<button @click="$emit('click')"><slot /></button>`
}

function createService(methods = {}) {
  return new Proxy(methods, {
    get(target, method) {
      if (typeof method !== 'string') return target[method]
      if (!(method in target)) target[method] = vi.fn().mockResolvedValue(true)
      return target[method]
    }
  })
}

function createHost(platform, { failPlatformRead = false, runtime = 'electron' } = {}) {
  const files = new Map()
  const database = new Map()
  const secureDatabase = new Map()
  const eventListeners = new Map()
  let clipboardText = ''

  const getInfo = failPlatformRead
    ? vi.fn().mockRejectedValue(new Error('system info unavailable'))
    : vi.fn().mockResolvedValue({ platform })

  const sys = createService({
    getInfo,
    getNativeId: vi.fn().mockResolvedValue('native-id'),
    getCPUUsage: vi.fn().mockResolvedValue(10),
    getMemoryUsage: vi.fn().mockResolvedValue(20),
    getPath: vi.fn().mockResolvedValue('/tmp'),
    privilegedExecute: vi.fn().mockResolvedValue({ success: true }),
    simulateKeyPress: vi.fn().mockResolvedValue(true)
  })

  const fs = createService({
    getCurrentDirectory: vi.fn().mockResolvedValue('/tmp'),
    fileExists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn(async (path) => files.get(path) || '127.0.0.1 localhost'),
    writeFile: vi.fn(async (path, content) => files.set(path, content)),
    deleteFile: vi.fn(async (path) => files.delete(path)),
    createDirectory: vi.fn().mockResolvedValue(true),
    getDirectoryContents: vi.fn().mockResolvedValue([])
  })

  const db = createService({
    setPluginId: vi.fn().mockResolvedValue(true),
    put: vi.fn(async (document) => database.set(document._id, document)),
    get: vi.fn(async (id) => database.get(id)),
    remove: vi.fn(async (id) => database.delete(id)),
    allDocs: vi.fn().mockResolvedValue([]),
    putSecure: vi.fn(async (key, value) => secureDatabase.set(key, value)),
    getSecure: vi.fn(async (key) => secureDatabase.get(key))
  })

  const events = {
    on: vi.fn((name, handler) => {
      const listeners = eventListeners.get(name) || new Set()
      listeners.add(handler)
      eventListeners.set(name, listeners)
    }),
    off: vi.fn((name, handler) => eventListeners.get(name)?.delete(handler)),
    emit: vi.fn(async (name, payload) => {
      for (const listener of eventListeners.get(name) || []) listener(payload)
      return true
    })
  }

  const ztools = {
    isElectron: vi.fn().mockReturnValue(runtime === 'electron'),
    isCEF: vi.fn().mockReturnValue(runtime === 'cef'),
    sys,
    fs,
    db,
    events,
    win: createService({
      getBounds: vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 100 }),
      setOpacity: vi.fn().mockResolvedValue(true)
    }),
    clipboard: createService({
      writeText: vi.fn(async (text) => {
        clipboardText = text
      }),
      readText: vi.fn(async () => clipboardText)
    }),
    shell: createService({
      beep: vi.fn().mockResolvedValue(true),
      exec: vi.fn().mockResolvedValue('test')
    }),
    screen: createService({
      getAllDisplays: vi.fn().mockResolvedValue([{}]),
      getCursorScreenPoint: vi.fn().mockResolvedValue({ x: 1, y: 2 }),
      captureFullScreen: vi.fn().mockResolvedValue('base64')
    }),
    network: createService({ get: vi.fn().mockResolvedValue({ statusCode: 200 }) }),
    process: createService({ list: vi.fn().mockResolvedValue([]) }),
    plugin: createService({ getList: vi.fn().mockResolvedValue({ data: [] }) }),
    dllplugin: createService({ list: vi.fn().mockResolvedValue([]) }),
    trigger: createService({
      register: vi.fn().mockResolvedValue(true),
      unregister: vi.fn().mockResolvedValue(true)
    })
  }

  return { ztools, sys, fs, events }
}

async function runBatch(wrapper) {
  const runButton = wrapper
    .findAll('button')
    .find((button) => button.text().includes('开始一键批量体检'))
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
    moduleMocks.getMarketPlugins.mockResolvedValue({ list: [], total: 0 })
    moduleMocks.getPluginDetails.mockResolvedValue({ name: 'Demo', version: '1.0' })
    moduleMocks.getDownloadSign.mockResolvedValue({ downloadUrl: 'https://example.test/demo' })
    moduleMocks.installPluginNative.mockResolvedValue({ success: true })
    moduleMocks.uninstallPluginNative.mockResolvedValue({ success: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => 'hosts file' }))
    vi.useFakeTimers()

    wrapper = mount(Diagnostics, { global: { stubs: antDesignStubs } })
    await nextTick()
    await runBatch(wrapper)
    return host
  }

  it('runs Windows-specific path, protocol, and privileged tests on Windows', async () => {
    const { ztools } = await mountDiagnostics('windows')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '检测平台：Windows'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 1')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(true)
    await selectTab(wrapper, '8')
    expect(wrapper.find('[data-test="windows-advanced-diagnostics"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-simulation-disabled"]').exists()).toBe(true)
    expect(ztools.fs.fileExists).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\notepad.exe'
    )
    expect(ztools.fs.readFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\drivers\\etc\\hosts'
    )
    expect(ztools.sys.privilegedExecute).toHaveBeenCalledTimes(1)
    expect(ztools.sys.simulateKeyPress).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(
      'ztools://file/C:/Windows/System32/drivers/etc/hosts'
    )
  })

  it('skips Windows-specific tests on macOS without counting failures', async () => {
    const { ztools } = await mountDiagnostics('macos')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '检测平台：macOS'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 6')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(false)
    await selectTab(wrapper, '8')
    expect(wrapper.find('[data-test="windows-advanced-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-advanced-diagnostics"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-simulation-disabled"]').exists()).toBe(true)
    expect(ztools.sys.getNativeId).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.fs.readFile).not.toHaveBeenCalledWith(
      'C:\\Windows\\System32\\drivers\\etc\\hosts'
    )
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Windows 专用测试')
  })

  it('skips Windows-specific tests and reports unknown host platforms', async () => {
    const { ztools } = await mountDiagnostics('unknown')

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '宿主平台“unknown”'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 6')
    await selectTab(wrapper, '3')
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics-disabled"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="windows-filesystem-diagnostics"]').exists()).toBe(false)
    expect(ztools.sys.getNativeId).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('marks platform-read failures clearly and excludes Windows tests from scoring', async () => {
    const { ztools } = await mountDiagnostics('', { failPlatformRead: true })

    expect(wrapper.find('[data-test="batch-platform-status"]').text()).toContain(
      '无法读取宿主平台'
    )
    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 1')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 6')
    expect(ztools.sys.getNativeId).toHaveBeenCalledTimes(1)
    expect(ztools.fs.fileExists).not.toHaveBeenCalled()
    expect(ztools.sys.privilegedExecute).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toMatch(/\[PASS\] (文件存在性|读取文件|协议URL生成|协议读取|特权服务)/)
    expect(wrapper.text()).not.toMatch(/\[FAIL\] (文件存在性|读取文件|协议URL生成|协议读取|特权服务)/)
  })

  it('在 Windows CEF 旧宿主执行按键注入测试', async () => {
    const { ztools } = await mountDiagnostics('windows', { runtime: 'cef' })

    expect(wrapper.find('[data-test="batch-fail-count"]').text()).toBe('失败: 0')
    expect(wrapper.find('[data-test="batch-skip-count"]').text()).toBe('已跳过: 0')
    expect(ztools.sys.simulateKeyPress).toHaveBeenCalledWith('Esc')
    expect(wrapper.find('[data-test="input-simulation-disabled"]').exists()).toBe(false)
  })
})
