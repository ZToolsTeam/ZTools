import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { bindNativeThemeEvents } from '../../src/main/platform/native-theme-events.js'
import {
  getTitleBarOverlayOptions,
  getWindowBackgroundColor,
  MAIN_TITLE_BAR_HEIGHT,
  normalizeAccentTheme,
  POPOUT_TITLE_BAR_HEIGHT,
  TRANSPARENT_TITLE_BAR_OVERLAY_COLOR,
  updateMainWindowTheme,
  updateWindowTheme
} from '../../src/main/windows/main-window.js'

test('native theme changes publish only changed actual state and stop symmetrically', () => {
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true })
  const published: { type: string; payload: unknown }[] = []
  const stop = bindNativeThemeEvents(theme, { publishHost: (type, payload) => published.push({ type, payload }) })
  assert.equal(theme.listenerCount('updated'), 1)
  theme.emit('updated')
  assert.equal(published.length, 0)
  theme.shouldUseDarkColors = false
  theme.emit('updated')
  theme.emit('updated')
  theme.shouldUseDarkColors = true
  theme.emit('updated')
  assert.deepEqual(published, [{ type: 'system.DarkModeChange', payload: { isDark: false } }, { type: 'system.DarkModeChange', payload: { isDark: true } }])
  const late = theme.listeners('updated')[0]!
  stop(); stop()
  assert.equal(theme.listenerCount('updated'), 0)
  theme.shouldUseDarkColors = false
  late()
  assert.equal(published.length, 2)
})

test('6 fixed accent themes map window background and transparent title bar overlay accurately and reject invalid inputs safely', () => {
  assert.equal(normalizeAccentTheme('glacier'), 'glacier')
  assert.equal(normalizeAccentTheme('mono'), 'mono')
  assert.equal(normalizeAccentTheme('#123456'), 'ember')
  assert.equal(normalizeAccentTheme(null), 'ember')
  assert.equal(normalizeAccentTheme(undefined), 'ember')
  assert.equal(normalizeAccentTheme(''), 'ember')
  assert.equal(normalizeAccentTheme('constructor'), 'ember')
  assert.equal(normalizeAccentTheme('__proto__'), 'ember')

  assert.equal(getWindowBackgroundColor(false, 'ember'), '#f4f3f0')
  assert.equal(getWindowBackgroundColor(true, 'ember'), '#0b0b0c')
  assert.equal(getWindowBackgroundColor(false, 'glacier'), '#f2f5f8')
  assert.equal(getWindowBackgroundColor(true, 'glacier'), '#0a0d12')
  assert.equal(getWindowBackgroundColor(false, 'jade'), '#f1f5f3')
  assert.equal(getWindowBackgroundColor(true, 'iris'), '#0b0a10')
  assert.equal(getWindowBackgroundColor(false, 'crimson'), '#f5f3f4')
  assert.equal(getWindowBackgroundColor(true, 'mono'), '#09090b')

  assert.equal(TRANSPARENT_TITLE_BAR_OVERLAY_COLOR, '#00000000')
  assert.deepEqual(getTitleBarOverlayOptions(false, 52, 'glacier'), {
    color: '#00000000',
    symbolColor: '#475569',
    height: 52
  })
  assert.deepEqual(getTitleBarOverlayOptions(true, 52, 'glacier'), {
    color: '#00000000',
    symbolColor: '#94a3b8',
    height: 52
  })

  // 边界与异常高度参数防御（0、负数、NaN、Infinity 回退默认主标题栏高度，浮点数取整）
  assert.equal(getTitleBarOverlayOptions(false, 0, 'ember').height, MAIN_TITLE_BAR_HEIGHT)
  assert.equal(getTitleBarOverlayOptions(false, -20, 'ember').height, MAIN_TITLE_BAR_HEIGHT)
  assert.equal(getTitleBarOverlayOptions(false, Number.NaN, 'ember').height, MAIN_TITLE_BAR_HEIGHT)
  assert.equal(getTitleBarOverlayOptions(false, Number.POSITIVE_INFINITY, 'ember').height, MAIN_TITLE_BAR_HEIGHT)
  assert.equal(getTitleBarOverlayOptions(true, 41.6, 'mono').height, POPOUT_TITLE_BAR_HEIGHT)
})

test('updateMainWindowTheme and updateWindowTheme apply platform-gated overlay, skip destroyed windows, and isolate native errors', () => {
  const overlays: Electron.TitleBarOverlayOptions[] = []
  const backgrounds: string[] = []
  let destroyed = false
  let throwOverlayError = false

  const win = {
    isDestroyed: () => destroyed,
    setTitleBarOverlay: (opts: Electron.TitleBarOverlayOptions) => {
      if (throwOverlayError) throw new Error('HWND_INVALID')
      overlays.push(opts)
    },
    setBackgroundColor: (bg: string) => {
      backgrounds.push(bg)
    }
  }

  // Windows 下同时更新透明 titleBarOverlay 与窗口背景色
  updateMainWindowTheme(win, false, 'glacier', 'win32')
  assert.deepEqual(overlays, [{ color: '#00000000', symbolColor: '#475569', height: MAIN_TITLE_BAR_HEIGHT }])
  assert.deepEqual(backgrounds, ['#f2f5f8'])

  // macOS 下不调用 setTitleBarOverlay，仅同步窗口背景色
  updateWindowTheme(win, true, 'jade', POPOUT_TITLE_BAR_HEIGHT, 'darwin')
  assert.equal(overlays.length, 1)
  assert.equal(backgrounds.at(-1), '#090e0c')

  // setTitleBarOverlay 底层瞬态抛错时不得阻断 setBackgroundColor 更新
  throwOverlayError = true
  updateWindowTheme(win, true, 'crimson', POPOUT_TITLE_BAR_HEIGHT, 'win32')
  assert.equal(overlays.length, 1)
  assert.equal(backgrounds.at(-1), '#0c0a0b')

  // 窗口销毁后零副作用幂等跳过
  throwOverlayError = false
  destroyed = true
  updateMainWindowTheme(win, false, 'mono', 'win32')
  assert.equal(overlays.length, 1)
  assert.equal(backgrounds.length, 3)
})
