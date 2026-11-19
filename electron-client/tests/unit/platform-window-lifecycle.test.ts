import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { createPlatformWindowLifecyclePolicy } from '../../src/main/platform/window-lifecycle.js'
import { shouldQuitOnAllWindowsClosed } from '../../src/main/windows/close-behavior.js'

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

test('shouldQuitOnAllWindowsClosed blocks redundant app.quit during active shutdown', () => {
  assert.equal(shouldQuitOnAllWindowsClosed({
    quitWhenAllWindowsClose: true,
    cancellationRequested: false,
    quitAllowed: false,
    quitInProgress: false
  }), true)

  assert.equal(shouldQuitOnAllWindowsClosed({
    quitWhenAllWindowsClose: false,
    cancellationRequested: false,
    quitAllowed: false,
    quitInProgress: false
  }), false)

  // 清理阶段销毁窗口会触发 window-all-closed，必须拦截防止重入 before-quit
  for (const flags of [
    { cancellationRequested: true, quitAllowed: false, quitInProgress: false },
    { cancellationRequested: false, quitAllowed: true, quitInProgress: false },
    { cancellationRequested: false, quitAllowed: false, quitInProgress: true }
  ]) {
    assert.equal(shouldQuitOnAllWindowsClosed({
      quitWhenAllWindowsClose: true,
      ...flags
    }), false)
  }
})
