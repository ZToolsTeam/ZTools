import { describe, expect, it } from 'vitest'
import {
  buildLaunchHotkeyMap,
  buildLaunchHotkeyRegistration,
  getLaunchHotkeyTarget
} from '../launchHotkeyTargets'

describe('launchHotkeyTargets', () => {
  it('识别插件窗口启动快捷键', () => {
    expect(getLaunchHotkeyTarget({
      pluginId: 'ocr',
      type: 'hotkey',
      action: { mode: 'window', target: 'ocr', params: {} }
    })).toEqual({ id: 'ocr', kind: 'plugin', ownerId: 'ocr' })
  })

  it('识别本地软件启动快捷键', () => {
    expect(getLaunchHotkeyTarget({
      pluginId: 'localapp:1234',
      type: 'hotkey',
      action: {
        mode: 'builtin',
        target: 'launch_local_app',
        params: { appId: 'localapp:1234' }
      }
    })).toEqual({
      id: 'localapp:1234',
      kind: 'localApp',
      ownerId: 'localapp:1234'
    })
  })

  it('构建映射时排除插件内功能快捷键', () => {
    const map = buildLaunchHotkeyMap([
      {
        id: 'plugin-hotkey',
        pluginId: 'demo',
        type: 'hotkey',
        config: { key: 'Ctrl+D' },
        action: { mode: 'window', target: 'demo', params: {} }
      },
      {
        id: 'feature-hotkey',
        pluginId: 'ocr',
        type: 'hotkey',
        config: { key: 'Ctrl+O' },
        action: { mode: 'window', target: 'ocr', params: { source: 'feature' } }
      }
    ], trigger => trigger.id === 'feature-hotkey')

    expect(map).toEqual({
      demo: {
        triggerId: 'plugin-hotkey',
        triggerIds: ['plugin-hotkey'],
        key: 'Ctrl+D',
        kind: 'plugin',
        ownerId: 'demo'
      }
    })
  })

  it('同一启动目标存在历史重复项时保留全部触发器 ID', () => {
    const map = buildLaunchHotkeyMap([
      {
        id: 'old-trigger',
        pluginId: 'demo',
        type: 'hotkey',
        config: { key: 'Ctrl+A' },
        action: { mode: 'window', target: 'demo', params: {} }
      },
      {
        id: 'new-trigger',
        pluginId: 'demo',
        type: 'hotkey',
        config: { key: 'Ctrl+B' },
        action: { mode: 'window', target: 'demo', params: {} }
      }
    ])

    expect(map.demo).toEqual({
      triggerId: 'new-trigger',
      triggerIds: ['old-trigger', 'new-trigger'],
      key: 'Ctrl+B',
      kind: 'plugin',
      ownerId: 'demo'
    })
  })

  it('为本地软件生成受控的 builtin 动作', () => {
    expect(buildLaunchHotkeyRegistration(
      { id: 'localapp:abcd', kind: 'localApp' },
      'Ctrl+Alt+A'
    )).toEqual({
      pluginId: 'localapp:abcd',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+A' },
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId: 'localapp:abcd' }
    })
  })
})
