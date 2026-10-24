import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { createPlatformWindowLifecyclePolicy } from '../../src/main/platform/window-lifecycle.js'

test('Windows keeps its existing last-window and system-tray behavior', () => {
  assert.deepEqual(createPlatformWindowLifecyclePolicy('win32'), {
    quitWhenAllWindowsClose: true,
    quitWhenMainWindowIsDestroyed: true,
    reopenMainWindowOnActivate: false,
    useSystemTray: true
  })
})

test('macOS stays resident without windows and restores from Dock activation without a tray', () => {
  assert.deepEqual(createPlatformWindowLifecyclePolicy('darwin'), {
    quitWhenAllWindowsClose: false,
    quitWhenMainWindowIsDestroyed: false,
    reopenMainWindowOnActivate: true,
    useSystemTray: false
  })
})

test('unsupported operating systems fail closed', () => {
  assert.throws(() => createPlatformWindowLifecyclePolicy('aix'), (error: unknown) =>
    error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})
