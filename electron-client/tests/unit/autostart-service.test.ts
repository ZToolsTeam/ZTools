import assert from 'node:assert/strict'
import test from 'node:test'
import { AutostartService, type LoginItemSettings } from '../../src/main/services/autostart-service.js'

test('autostart service reads and writes the current-user login item contract', () => {
  const calls: Array<{ type: 'get' | 'set'; path: string; args: readonly string[]; openAtLogin?: boolean; openAsHidden?: boolean }> = []
  let current: LoginItemSettings = { openAtLogin: false }
  const service = new AutostartService({
    executablePath: 'C:\\Program Files\\ZTools\\ZTools.exe',
    platform: 'win32',
    adapter: {
      getLoginItemSettings(options) {
        calls.push({ type: 'get', path: options.path, args: options.args })
        return current
      },
      setLoginItemSettings(options) {
        calls.push({
          type: 'set',
          path: options.path,
          args: options.args,
          openAtLogin: options.openAtLogin,
          openAsHidden: options.openAsHidden
        })
        current = { openAtLogin: options.openAtLogin }
      }
    }
  })

  assert.deepEqual(service.get(), { success: true, enabled: false })
  assert.deepEqual(service.set(true), { success: true, enabled: true })
  assert.deepEqual(service.get(), { success: true, enabled: true })
  assert.deepEqual(calls, [
    {
      type: 'get',
      path: 'C:\\Program Files\\ZTools\\ZTools.exe',
      args: ['--autostart', '--source=autostart']
    },
    {
      type: 'set',
      path: 'C:\\Program Files\\ZTools\\ZTools.exe',
      args: ['--autostart', '--source=autostart'],
      openAtLogin: true,
      openAsHidden: true
    },
    {
      type: 'get',
      path: 'C:\\Program Files\\ZTools\\ZTools.exe',
      args: ['--autostart', '--source=autostart']
    }
  ])
})

test('autostart service refuses non-Windows platforms', () => {
  const service = new AutostartService({
    executablePath: '/opt/ztools/ZTools',
    platform: 'linux',
    adapter: {
      getLoginItemSettings() { throw new Error('must not call adapter') },
      setLoginItemSettings() { throw new Error('must not call adapter') }
    }
  })
  assert.throws(() => service.get(), (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'NOT_SUPPORTED'
  )
})
