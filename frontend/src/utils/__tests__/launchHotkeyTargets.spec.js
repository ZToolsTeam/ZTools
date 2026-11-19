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

  it('遇到历史残留的 launch_local_app 触发器时安全忽略并返回 null', () => {
    expect(getLaunchHotkeyTarget({
      pluginId: 'localapp:1234',
      type: 'hotkey',
      action: {
        mode: 'builtin',
        target: 'launch_local_app',
        params: { appId: 'localapp:1234' }
      }
    })).toBeNull()

    expect(getLaunchHotkeyTarget({
      pluginId: 'localapp:5678',
      type: 'hotkey',
      actionMode: 'builtin',
      actionTarget: 'launch_local_app',
      actionParams: { appId: 'localapp:5678' }
    })).toBeNull()
  })

  it('构建映射时排除插件内功能快捷键并自动忽略残留本地软件触发器', () => {
    const map = buildLaunchHotkeyMap([
      {
        id: 'plugin-hotkey',
        pluginId: 'demo',
        type: 'hotkey',
        config: { key: 'Ctrl+D' },
        action: { mode: 'window', target: 'demo', params: {} }
      },
      {
        id: 'legacy-local-app-hotkey',
        pluginId: 'localapp:legacy',
        type: 'hotkey',
        config: { key: 'Ctrl+L' },
        action: { mode: 'builtin', target: 'launch_local_app', params: { appId: 'localapp:legacy' } }
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

  it('仅为插件目标构建窗口启动注册载荷，非插件或空目标抛错拦截', () => {
    expect(buildLaunchHotkeyRegistration(
      { id: 'ocr', kind: 'plugin' },
      'Ctrl+Alt+O'
    )).toEqual({
      pluginId: 'ocr',
      type: 'hotkey',
      enabled: true,
      config: { key: 'Ctrl+Alt+O' },
      actionMode: 'window',
      actionTarget: 'ocr',
      actionParams: {}
    })

    expect(() => buildLaunchHotkeyRegistration(
      { id: 'localapp:abcd', kind: 'localApp' },
      'Ctrl+Alt+A'
    )).toThrow('仅支持为插件注册启动快捷键')
    expect(() => buildLaunchHotkeyRegistration({ id: '', kind: 'plugin' }, 'Ctrl+Alt+A')).toThrow()
    expect(() => buildLaunchHotkeyRegistration(null, 'Ctrl+Alt+A')).toThrow()
  })
})
