import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useCommandSearch } from '../useCommandSearch.js'
import { usePluginsStore } from '@/stores/plugins'

const appRecord = (display, english, dir = '/Applications') => ({
  name: `${english}.app`, display_name: display, path: `${dir}/${english}.app`, kind: 'application', is_dir: true, size: 0, mtime: 1
})
const fileRecord = (name, dir = '/Users/demo/Documents', extra = {}) => ({ name, path: `${dir}/${name}`, is_dir: false, size: 1, mtime: 1, ...extra })
const APPS = [appRecord('微信', 'WeChat'), appRecord('系统设置', 'System Settings'), appRecord('Adobe Photoshop 2024', 'Adobe Photoshop 2024')]

let scope
let searchFiles
let getFileIcon
let fileResponses
const create = (options) => scope.run(() => useCommandSearch(options))
const settle = () => vi.advanceTimersByTimeAsync(0)
// 文件检索防抖 80ms
const flushFiles = () => vi.advanceTimersByTimeAsync(100)
const names = (state) => state.filteredItems.value.map((item) => item.name)

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.useFakeTimers()
  scope = effectScope()
  fileResponses = new Map()
  searchFiles = vi.fn(async (query, _limit, options) => {
    if (options?.scope === 'applications') return { files: APPS, scope: 'applications' }
    const files = fileResponses.get(query) ?? []
    return { files, ...(options?.scope ? { scope: options.scope } : {}) }
  })
  getFileIcon = vi.fn().mockResolvedValue('data:image/png;base64,aWNvbg==')
  window.__ztoolsLauncher = { searchFiles }
  window.ztools = { sys: { getFileIcon } }
  const store = usePluginsStore()
  store.installedPlugins = [
    { pluginId: 'wechat-multi', name: '微信多开', entry: 'dist/index.js', isDeclarative: true },
    { pluginId: 'docker-manager', name: 'Docker 管理', keywords: ['docker', 'ps'], entry: 'dist/index.js', isDeclarative: true },
    {
      pluginId: 'json-format', name: 'JSON 格式化', entry: 'dist/index.js', isDeclarative: true,
      features: [{ code: 'json-format', explain: 'JSON 格式化' }, { code: 'json-codegen', explain: 'JSON 生成类型' }]
    }
  ]
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.__ztoolsLauncher
  delete window.ztools
})

describe('悬浮条本地程序列表：程序随按键当场出结果，文件晚到排在下面', () => {
  it('程序列表加载后按键同步出程序（不等文件检索），文件检索只要文件，晚到的文件排在下面且不重复程序', async () => {
    fileResponses.set('微信', [fileRecord('微信账单.csv'), { ...APPS[0] }])
    const state = create()
    await settle()
    expect(searchFiles).toHaveBeenCalledWith('', 12, { scope: 'applications' })

    state.search('微信')
    // 同一帧：程序与插件已经排好，文件检索还没发出
    expect(names(state).slice(0, 2)).toEqual(['微信', '微信多开'])
    expect(state.filteredItems.value[0].isApplication).toBe(true)
    expect(state.isSearching.value).toBe(true)

    await flushFiles()
    expect(searchFiles).toHaveBeenLastCalledWith('微信', 12, { scope: 'files' })
    expect(names(state)).toEqual(['微信', '微信多开', '微信账单.csv'])
    expect(state.isSearching.value).toBe(false)
  })

  it('同一档里程序排在插件与内置命令前；英文名也能搜到程序；高亮区间来自排序结果', async () => {
    const state = create()
    await settle()
    state.search('设置')
    expect(state.filteredItems.value[0]).toMatchObject({ name: '系统设置', isApplication: true })
    expect(names(state)).toContain('系统设置')
    expect(state.highlightParts(state.filteredItems.value[0])).toEqual([
      { text: '系统', hit: false }, { text: '设置', hit: true }
    ])

    state.search('wechat')
    expect(state.filteredItems.value[0].name).toBe('微信')
  })

  it('程序与文件所在路径不当作描述参与匹配（ys 不会命中 /System/Applications 下的程序）', async () => {
    fileResponses.set('ys', [fileRecord('notes.txt', '/Users/demo/system-files')])
    const state = create()
    await settle()
    state.search('ys')
    await flushFiles()
    expect(names(state).some((name) => ['微信', '系统设置', 'Adobe Photoshop 2024'].includes(name))).toBe(false)
    // 主进程按路径命中的文件仍保留在文件段末尾，不被丢弃
    expect(names(state)).toContain('notes.txt')
  })

  it('与插件同名的默认子命令只出现一次', async () => {
    const state = create({ enableFileSearch: false })
    state.search('json')
    expect(names(state).filter((name) => name === 'JSON 格式化')).toHaveLength(1)
    expect(names(state)).toContain('JSON 生成类型')
  })

  it('输入同一个词时上次选中的那一项排第一（ps：选过 Photoshop 后它排在触发词完全一致的插件前）', async () => {
    const state = create()
    await settle()
    state.search('ps')
    expect(state.filteredItems.value[0].name).toBe('Docker 管理')
    const photoshop = state.filteredItems.value.find((item) => item.name === 'Adobe Photoshop 2024')
    expect(photoshop).toBeTruthy()
    state.recordUsage(photoshop.key)

    state.search('')
    state.search('ps')
    expect(state.filteredItems.value[0].name).toBe('Adobe Photoshop 2024')
    // 别的词不受影响
    state.search('docker')
    expect(state.filteredItems.value[0].name).toBe('Docker 管理')
  })

  it('只输入一个英文字母不发文件检索，程序与插件照常出现', async () => {
    const state = create()
    await settle()
    searchFiles.mockClear()
    state.search('w')
    await flushFiles()
    expect(searchFiles).not.toHaveBeenCalled()
    expect(state.isSearching.value).toBe(false)
    expect(names(state)).toContain('微信')
    // 单个汉字照常检索文件
    state.search('图')
    await flushFiles()
    expect(searchFiles).toHaveBeenCalledWith('图', 12, { scope: 'files' })
  })

  it('继续输入时保留仍然匹配的旧文件，新结果到达再替换；不再匹配的先去掉；同档时文件夹、最近修改的在前', async () => {
    fileResponses.set('rep', [
      fileRecord('report-old.pdf', '/Users/demo', { mtime: 10 }),
      fileRecord('reports', '/Users/demo', { is_dir: true, mtime: 1 }),
      fileRecord('report-new.pdf', '/Users/demo', { mtime: 99 }),
      fileRecord('rep.txt', '/Users/demo/a/b')
    ])
    const state = create()
    await settle()
    state.search('rep')
    await flushFiles()
    expect(names(state)).toEqual(['rep.txt', 'reports', 'report-new.pdf', 'report-old.pdf'])

    let release
    searchFiles.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    state.search('repo')
    expect(names(state)).toEqual(['reports', 'report-new.pdf', 'report-old.pdf'])
    await flushFiles()
    release({ files: [fileRecord('repository')], scope: 'files' })
    await settle()
    expect(names(state)).toEqual(['repository'])
  })

  it('[兼容] 旧版主进程不认识范围：程序随文件结果返回并与插件混排，文件检索不带范围', async () => {
    searchFiles.mockImplementation(async (query) => (query === '微信'
      ? { files: [{ ...APPS[0] }, fileRecord('微信账单.csv')] }
      : { files: [fileRecord('recent.txt')] }))
    const state = create()
    await settle()
    state.search('微信')
    expect(names(state)).toEqual(['微信多开'])
    await flushFiles()
    expect(searchFiles).toHaveBeenLastCalledWith('微信', 12)
    expect(names(state)).toEqual(['微信', '微信多开', '微信账单.csv'])
  })

  it('[故障] 读取程序列表失败：如实告警并退回旧行为；获得焦点后节流重试，成功后改为本地匹配', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    searchFiles.mockImplementationOnce(async () => ({ success: false, error: { message: 'IPC disconnected' } }))
    const state = create()
    await settle()
    expect(warn).toHaveBeenCalledWith('[useCommandSearch] 读取程序列表失败:', expect.any(Error))

    state.search('微信')
    expect(names(state)).toEqual(['微信多开'])
    await flushFiles()
    expect(searchFiles).toHaveBeenLastCalledWith('微信', 12)

    window.dispatchEvent(new Event('focus'))
    await settle()
    state.search('微信')
    expect(names(state)[0]).toBe('微信')

    // 5 秒内再次获得焦点不重复读取
    const calls = searchFiles.mock.calls.filter(([, , options]) => options?.scope === 'applications').length
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(searchFiles.mock.calls.filter(([, , options]) => options?.scope === 'applications')).toHaveLength(calls)
    await vi.advanceTimersByTimeAsync(5001)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(searchFiles.mock.calls.filter(([, , options]) => options?.scope === 'applications')).toHaveLength(calls + 1)
  })

  it('窗口开着时每 10 分钟刷新一次程序列表（打开授权 30 分钟过期），销毁后停止', async () => {
    create()
    await settle()
    const listCalls = () => searchFiles.mock.calls.filter(([, , options]) => options?.scope === 'applications').length
    expect(listCalls()).toBe(1)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(listCalls()).toBe(2)
    scope.stop()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(listCalls()).toBe(2)
  })

  it('排在前面的程序按需取图标，同一程序只取一次；取不到的本次不再重试', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getFileIcon.mockImplementation(async (path) => {
      if (path.includes('System Settings')) throw new Error('unavailable')
      return 'data:image/png;base64,aWNvbg=='
    })
    const state = create()
    await settle()
    state.search('wx')
    await settle()
    expect(state.filteredItems.value[0].icon).toBe('data:image/png;base64,aWNvbg==')
    state.search('weixin')
    await settle()
    expect(getFileIcon.mock.calls.filter(([path]) => path.includes('WeChat'))).toHaveLength(1)

    state.search('设置')
    await settle()
    state.search('xtsz')
    await settle()
    expect(getFileIcon.mock.calls.filter(([path]) => path.includes('System Settings'))).toHaveLength(1)
    expect(state.filteredItems.value[0].icon).toBe('')
  })

  it('空查询不展示程序；作用域销毁后晚到的程序列表与文件结果都不写回', async () => {
    let releaseApps
    searchFiles.mockImplementationOnce(() => new Promise((resolve) => { releaseApps = resolve }))
    const state = create()
    expect(names(state).some((name) => name === '微信')).toBe(false)
    scope.stop()
    releaseApps({ files: APPS, scope: 'applications' })
    await settle()
    state.search('微信')
    expect(names(state)).toEqual(['微信多开'])
  })
})
