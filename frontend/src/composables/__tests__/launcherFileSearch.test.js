import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useCommandSearch, truncatePath } from '../useCommandSearch.js'
import { resolveItemGlyph } from '@/utils/brandIcons'

const file = name => ({ name, path: `/files/${name}`, is_dir: false })
let scope
let searchFiles
let getFileIcon
const create = () => scope.run(() => useCommandSearch())
const flush = () => vi.advanceTimersByTimeAsync(45)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  scope = effectScope()
  searchFiles = vi.fn().mockResolvedValue({ files: [] })
  getFileIcon = vi.fn().mockResolvedValue('data:image/png;base64,aWNvbg==')
  window.__ztoolsLauncher = { searchFiles }
  window.ztools = { sys: { getFileIcon } }
})
afterEach(() => {
  scope.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete window.__ztoolsLauncher
  delete window.ztools
})

describe('悬浮条真实文件结果与异步状态', () => {
  it('旧请求在新查询 debounce 期间返回时也不能覆盖新状态', async () => {
    let resolveOld
    searchFiles.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const state = create()
    state.search('old'); await flush()
    state.search('new')
    resolveOld({ files: [file('old.png')] })
    await Promise.resolve(); await Promise.resolve()
    expect(state.fileResults.value).toEqual([])
    expect(state.isSearching.value).toBe(true)
    searchFiles.mockResolvedValue({ files: [file('new.png')] })
    await flush()
    expect(state.fileResults.value[0].name).toBe('new.png')
    expect(state.isSearching.value).toBe(false)
  })

  it('中文应用名、原始文件名、路径和真实图标保持各自语义', async () => {
    searchFiles.mockResolvedValue({ files: [{ ...file('Notes.app'), path: '/System/Applications/Notes.app',
      kind: 'application', display_name: '备忘录', is_dir: true }] })
    const state = create(); state.search('备忘录'); await flush()
    const app = state.fileResults.value[0]
    expect(app).toMatchObject({ name: '备忘录', fileName: 'Notes.app', badge: '应用', isApplication: true,
      description: '/System/Applications', path: '/System/Applications/Notes.app', icon: 'data:image/png;base64,aWNvbg==' })
    expect(resolveItemGlyph(app)).toBe('')
    state.search('备忘录'); await flush()
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })

  it('失效索引保留部分结果，IPC 失败清除旧结果并显示错误', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = create()
    searchFiles.mockResolvedValue({ files: [file('partial.png')], degraded: true })
    state.search('png'); await flush()
    expect(state.fileSearchDegraded.value).toBe(true)
    expect(state.fileResults.value).toHaveLength(1)
    searchFiles.mockRejectedValue(new Error('IPC disconnected'))
    state.search('pdf'); await flush()
    expect(state.fileResults.value).toEqual([])
    expect(state.fileSearchError.value).toBeTruthy()
    expect(state.isSearching.value).toBe(false)
    state.clearSearch()
    expect(state.fileSearchError.value).toBe('')
  })

  it('缺少桥接显示错误而不是伪装空结果', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete window.__ztoolsLauncher
    const state = create(); state.search('notes'); await flush()
    expect(state.fileSearchError.value).toBeTruthy()
    expect(state.isSearching.value).toBe(false)
  })

  it('图标失败不丢失应用，畸形记录被过滤', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    getFileIcon.mockRejectedValue(new Error('unavailable'))
    searchFiles.mockResolvedValue({ files: [null, {}, { ...file('Notes.app'), kind: 'application', is_dir: true }] })
    const state = create(); state.search('notes'); await flush()
    expect(state.fileResults.value).toHaveLength(1)
    expect(resolveItemGlyph(state.fileResults.value[0])).toBe('apps')
    expect(state.fileSearchError.value).toBe('')
  })

  it('销毁搜索作用域取消防抖，晚到响应不写回', async () => {
    let resolveSearch
    searchFiles.mockImplementation(() => new Promise(resolve => { resolveSearch = resolve }))
    const state = create(); state.search('old'); await flush()
    scope.stop()
    resolveSearch({ files: [file('old.png')] })
    await flush()
    expect(state.fileResults.value).toEqual([])
  })

  it('平台路径分隔符与图片图标正确', () => {
    expect(truncatePath('/Users/someone/a-long-folder-name/another-long-folder-name/image.png')).not.toContain('\\')
    expect(truncatePath('C:\\Users\\someone\\a-long-folder-name\\another-long-folder-name\\image.png')).toContain('\\')
    expect(resolveItemGlyph({ type: 'file', faIcon: 'fa-file-image-o', isDir: false })).toBe('image')
  })

  it('已安装应用（如微信、Antigravity）按匹配度排在弱描述匹配的插件之前，普通文件保持在后', async () => {
    const { usePluginsStore } = await import('@/stores/plugins')
    const pluginsStore = usePluginsStore()
    pluginsStore.installedPlugins = [
      {
        pluginId: 'weak-desc-plugin',
        name: '通用效率工具',
        description: '支持导出到微信或 Antigravity 的辅助说明',
        entry: 'dist/index.js',
        isDeclarative: true
      }
    ]
    searchFiles.mockResolvedValue({
      files: [
        {
          name: 'WeChat.app',
          display_name: '微信',
          path: '/Applications/WeChat.app',
          kind: 'application',
          is_dir: true,
          acronym: 'wx wc',
          pinyin: 'weixin wechat'
        },
        {
          name: '微信账单.csv',
          path: '/Users/demo/Downloads/微信账单.csv',
          is_dir: false
        }
      ]
    })
    const state = create()
    state.search('微信')
    await flush()
    expect(state.filteredItems.value[0]?.name).toBe('微信')
    expect(state.filteredItems.value[0]?.isApplication).toBe(true)
    expect(state.filteredItems.value.at(-1)?.name).toBe('微信账单.csv')
  })
})
