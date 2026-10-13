import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decideCloseAction,
  readClosePreferences
} from '../../src/main/windows/close-behavior.js'

test('close preferences read the renderer settings paths and normalize booleans', async () => {
  const calls: Array<[string, string, unknown]> = []
  const config = {
    async get(file: string, path: string, defaultValue: unknown): Promise<string> {
      calls.push([file, path, defaultValue])
      return path.endsWith('closeConfirm') ? 'false' : '1'
    }
  }
  assert.deepEqual(await readClosePreferences(config), {
    closeConfirm: false,
    minimizeToTray: true
  })
  assert.deepEqual(calls, [
    ['user_settings.json', 'system.closeConfirm', 'true'],
    ['user_settings.json', 'system.minimizeToTray', 'true']
  ])
})

test('invalid close preferences preserve the safe defaults', async () => {
  const config = { async get(): Promise<string> { return 'damaged' } }
  assert.deepEqual(await readClosePreferences(config), {
    closeConfirm: true,
    minimizeToTray: true
  })
})

test('close decisions keep confirmation, tray hiding, and explicit exit exclusive', () => {
  assert.equal(decideCloseAction(
    { closeConfirm: true, minimizeToTray: false },
    'closeButton'
  ), 'confirm')
  assert.equal(decideCloseAction(
    { closeConfirm: false, minimizeToTray: true },
    'closeButton'
  ), 'hide')
  assert.equal(decideCloseAction(
    { closeConfirm: false, minimizeToTray: false },
    'closeButton'
  ), 'quit')
  assert.equal(decideCloseAction(
    { closeConfirm: false, minimizeToTray: true },
    'trayMenu'
  ), 'quit')
})
