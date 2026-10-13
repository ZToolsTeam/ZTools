import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { bindNativeThemeEvents } from '../../src/main/platform/native-theme-events.js'

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
