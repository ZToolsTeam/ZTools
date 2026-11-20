import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { List, Action } from '@ztools/declarative-ui'
import DeclarativeView from '../DeclarativeView.vue'
import { resolveActionTitle } from '../uiText.js'
import { filterIncomingFiles, normalizeAllowedExtension } from '../fileInputFilter.js'
import { setI18nLocale } from '@/i18n'

beforeEach(() => {
  setI18nLocale('zh-CN')
})

describe('声明式视图文件输入过滤', () => {
  it('名称带点的文件夹以主进程确认的 directories 为准放行，不按后缀误拦', () => {
    const result = filterIncomingFiles(
      ['D:\\票据\\2026.11_报销票据', 'D:\\票据\\a.pdf'],
      ['D:\\票据\\2026.11_报销票据'],
      { extensions: ['.pdf'], allowDirectories: true }
    )
    expect(result).toEqual({
      files: ['D:\\票据\\2026.11_报销票据', 'D:\\票据\\a.pdf'],
      directories: ['D:\\票据\\2026.11_报销票据'],
      rejected: 0
    })
  })

  it('没有后缀的普通文件在允许文件夹时不再被误放行', () => {
    const result = filterIncomingFiles(['D:\\src\\Makefile', 'D:\\src\\assets'], ['D:\\src\\assets'], {
      extensions: ['png'],
      allowDirectories: true
    })
    expect(result.files).toEqual(['D:\\src\\assets'])
    expect(result.directories).toEqual(['D:\\src\\assets'])
    expect(result.rejected).toBe(1)
  })

  it('插件未允许文件夹时，文件夹计入拒绝数', () => {
    const result = filterIncomingFiles(['D:\\dir', 'D:\\a.PNG'], ['D:\\dir'], { extensions: ['.png'] })
    expect(result).toEqual({ files: ['D:\\a.PNG'], directories: [], rejected: 1 })
  })

  it('未限制扩展名时接收全部普通文件', () => {
    const result = filterIncomingFiles(['/tmp/a', '/tmp/b.txt'], undefined, {})
    expect(result).toEqual({ files: ['/tmp/a', '/tmp/b.txt'], directories: [], rejected: 0 })
  })

  it('畸形输入安全降级：非数组、空字符串与非字符串项被忽略', () => {
    expect(filterIncomingFiles(null, null, null)).toEqual({ files: [], directories: [], rejected: 0 })
    expect(filterIncomingFiles(['', '  ', 42, ' /tmp/x.png '], [42, ''], { extensions: ['.png'] })).toEqual({
      files: ['/tmp/x.png'],
      directories: [],
      rejected: 0
    })
  })

  it('扩展名写法统一为小写带点', () => {
    expect(normalizeAllowedExtension('PNG')).toBe('.png')
    expect(normalizeAllowedExtension(' .Jpg ')).toBe('.jpg')
    expect(normalizeAllowedExtension('')).toBe('')
    expect(normalizeAllowedExtension(undefined)).toBe('')
  })
})

describe('DeclarativeView 文件拦截所有权与内置动作默认标题', () => {
  const prevElectron = globalThis.window?.__ztoolsElectron

  beforeEach(() => {
    globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'win32'
  })

  afterEach(() => {
    delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
    if (globalThis.window) {
      globalThis.window.__ztoolsElectron = prevElectron
    }
  })

  it('同窗口同步切换插件实例时，旧实例卸载不会把新实例开启的文件夹拖拽拦截覆盖为 false', async () => {
    const calls = []
    globalThis.window.__ztoolsElectron = {
      setFileInputInterception: (cfg) => calls.push(cfg)
    }

    const PluginA = () => List({ fileInput: { allowDirectories: true }, onFileInput: () => {} }, [])
    const PluginB = () => List({ fileInput: { allowDirectories: true }, onFileInput: () => {} }, [])
    const activeKey = ref('plugin-a')

    const Host = defineComponent({
      setup() {
        return () =>
          h(DeclarativeView, {
            key: activeKey.value,
            rootComponent: activeKey.value === 'plugin-a' ? PluginA : PluginB
          })
      }
    })

    const wrapper = mount(Host, { attachTo: document.body })
    await nextTick()
    expect(calls[calls.length - 1]).toEqual({ enabled: true, allowImage: false, allowDirectories: true })

    // 同步切换 key：复现从缓存加载插件 B 替换插件 A 时 onUnmounted 晚于新组件 setup 执行的真实场景
    activeKey.value = 'plugin-b'
    await nextTick()
    await nextTick()

    expect(calls[calls.length - 1]).toEqual({ enabled: true, allowImage: false, allowDirectories: true })

    // 彻底离开声明式视图后才复位为关闭状态
    wrapper.unmount()
    await nextTick()
    expect(calls[calls.length - 1]).toEqual({ enabled: false, allowImage: false, allowDirectories: false })
  })

  it('resolveActionTitle：未显式传 title 时为内置动作类型生成规范中文名称', () => {
    expect(resolveActionTitle(Action.ShowInFinder({ path: 'D:\\a.png' }), false)).toBe('在资源管理器中显示')
    expect(resolveActionTitle(Action.ShowInFinder({ path: '/tmp/a.png' }), true)).toBe('在访达中显示')
    expect(resolveActionTitle(Action.ShowInFinder({ path: 'D:\\a.png', title: '定位原图' }), false)).toBe('定位原图')
    expect(resolveActionTitle(Action.CopyToClipboard({ content: 'x' }), false)).toBe('复制到剪贴板')
  })
})
