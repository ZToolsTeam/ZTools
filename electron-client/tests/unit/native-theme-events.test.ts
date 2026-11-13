import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { bindNativeThemeEvents } from '../../src/main/platform/native-theme-events.js'
import {
  getTitleBarOverlayOptions,
  getWindowBackgroundColor,
  normalizeAccentTheme
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

test('6 fixed accent themes map window background and title bar overlay colors accurately and reject unknown values safely', () => {
  assert.equal(normalizeAccentTheme('glacier'), 'glacier')
  assert.equal(normalizeAccentTheme('mono'), 'mono')
  assert.equal(normalizeAccentTheme('#123456'), 'ember')
  assert.equal(normalizeAccentTheme(null), 'ember')

  assert.equal(getWindowBackgroundColor(false, 'ember'), '#f4f3f0')
  assert.equal(getWindowBackgroundColor(true, 'ember'), '#0b0b0c')
  assert.equal(getWindowBackgroundColor(false, 'glacier'), '#f2f5f8')
  assert.equal(getWindowBackgroundColor(true, 'glacier'), '#0a0d12')
  assert.equal(getWindowBackgroundColor(false, 'jade'), '#f1f5f3')
  assert.equal(getWindowBackgroundColor(true, 'iris'), '#0b0a10')
  assert.equal(getWindowBackgroundColor(false, 'crimson'), '#f5f3f4')
  assert.equal(getWindowBackgroundColor(true, 'mono'), '#09090b')

  assert.deepEqual(getTitleBarOverlayOptions(false, 52, 'glacier'), {
    color: '#f5f8fb',
    symbolColor: '#475569',
    height: 52
  })
  assert.deepEqual(getTitleBarOverlayOptions(true, 52, 'glacier'), {
    color: '#0d1117',
    symbolColor: '#94a3b8',
    height: 52
  })
})
