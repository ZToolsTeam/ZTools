import { describe, expect, it } from 'vitest'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'

async function loadProbe(typesSource) {
  const files = {
    'plugin.json': JSON.stringify({ id: 'enum-probe', name: '枚举加载测试', entry: 'dist/index.js', permissions: [] }),
    'dist/index.js': `import { readTransport } from './audio-service.js';
export default function Command() { return readTransport() }`,
    'dist/audio-service.js': `import * as types from './types.js';
export function readTransport() { return types }`,
    'dist/types.js': typesSource
  }
  return loadInstalledDeclarativePlugin('enum-probe', {
    readFile: async (_id, relativePath) => {
      if (!(relativePath in files)) throw new Error(`不存在的测试模块: ${relativePath}`)
      return files[relativePath]
    }
  })
}

describe('插件导出变量加载', () => {
  it('通过主入口和服务模块读取 TypeScript 枚举构建产物', async () => {
    const plugin = await loadProbe(`export var TransportType;
(function (TransportType) {
  TransportType['Bluetooth'] = 'bluetooth';
  TransportType['BuiltIn'] = 'builtin';
})(TransportType || (TransportType = {}));`)
    expect(plugin.command().TransportType).toEqual({ Bluetooth: 'bluetooth', BuiltIn: 'builtin' })
  })

  it.each(['var', 'let'])('未初始化的 %s 导出会跟随后续赋值', async (declaration) => {
    const plugin = await loadProbe(`export ${declaration} current;
export function setCurrent(value) { current = value; }
export const fixed = 0;`)
    const module = plugin.command()
    expect(module.current).toBeUndefined()
    expect(module.fixed).toBe(0)
    module.setCurrent(false)
    expect(module.current).toBe(false)
    module.setCurrent('updated')
    expect(module.current).toBe('updated')
  })

  it('无效模块仍报加载错误，不把语法错误变成空插件', async () => {
    await expect(loadProbe('export const missingInitializer;')).rejects.toThrow('执行异常')
  })
})
