import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'

async function loadCommand(source, featureCode = 'convert-color') {
  return loadInstalledDeclarativePlugin('command-probe', {
    featureCode,
    readFile: async (_id, relativePath) => relativePath === 'plugin.json'
      ? JSON.stringify({ id: 'command-probe', entry: 'dist/index.js', permissions: [] })
      : source
  })
}

describe('声明式插件命令选择', () => {
  it.each(['commands', 'features'])('显式 %s 映射优先于同名工具函数', async (mapping) => {
    const plugin = await loadCommand(`
      export function convertColor() { throw new Error('工具函数不是界面入口') }
      function Screen() { return { type: 'List', props: { navigationTitle: '颜色转换' } } }
      export const ${mapping} = { 'convert-color': Screen };
      export default function Default() { throw new Error('没有选择子命令') }
    `)
    expect(plugin.command()).toMatchObject({ type: 'List', props: { navigationTitle: '颜色转换' } })
  })

  it('没有显式映射时继续支持命名导出和默认入口', async () => {
    const source = `export function convertColor() { return 'named' }
      export default function Default() { return 'default' }`
    expect((await loadCommand(source)).command()).toBe('named')
    expect((await loadCommand(source, 'unknown')).command()).toBe('default')
  })

  it.each(['convert-color', 'contrast-check'])('内置取色器 %s 入口返回列表视图', async (featureCode) => {
    const plugin = await loadInstalledDeclarativePlugin('color-picker', {
      featureCode,
      readFile: (_id, relativePath) => fs.readFile(path.resolve('public/bundled-plugins/color-picker', relativePath), 'utf8')
    })
    expect(plugin.command()).toMatchObject({ type: 'List', props: { navigationTitle: '调色板与色彩转换' } })
  })
})
