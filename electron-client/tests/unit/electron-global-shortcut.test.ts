import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createElectronGlobalShortcutAdapter,
  toElectronAccelerator
} from '../../src/main/platform/common/electron-global-shortcut.js'

test('maps the portable Ctrl modifier to Electron CommandOrControl', () => {
  assert.equal(toElectronAccelerator('Ctrl+Shift+Z'), 'CommandOrControl+Shift+Z')
  assert.equal(toElectronAccelerator('Alt+Ctrl+Space'), 'Alt+CommandOrControl+Space')
})

test('preserves physical Control and unrelated accelerator tokens', () => {
  assert.equal(toElectronAccelerator('Control+Alt+K'), 'Control+Alt+K')
  assert.equal(toElectronAccelerator('Super+Space'), 'Super+Space')
  assert.equal(toElectronAccelerator('commandorcontrol+K'), 'commandorcontrol+K')
})

test('uses the same normalized accelerator for registration and removal', () => {
  const calls: string[] = []
  const electron = {
    register(accelerator: string, _callback: () => void) {
      calls.push(`register:${accelerator}`)
      return true
    },
    unregister(accelerator: string) {
      calls.push(`unregister:${accelerator}`)
    }
  }
  const adapter = createElectronGlobalShortcutAdapter(electron)

  assert.equal(adapter.register('Ctrl+Shift+Z', () => undefined), true)
  adapter.unregister('Ctrl+Shift+Z')

  assert.deepEqual(calls, [
    'register:CommandOrControl+Shift+Z',
    'unregister:CommandOrControl+Shift+Z'
  ])
})
