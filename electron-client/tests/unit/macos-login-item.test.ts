import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  createMacosLoginItemAdapter,
  type ElectronMacosLoginItemApp,
  type MacosLoginItemAdapter,
  type MacosLoginItemState,
  type MacosLoginItemStatus
} from '../../src/main/platform/macos/login-item.js'
import { LoginItemConfigService } from '../../src/main/services/login-item-config-service.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'

function state(
  openAtLogin: boolean,
  status: MacosLoginItemStatus = openAtLogin ? 'enabled' : 'not-registered',
  wasOpenedAtLogin = false
): MacosLoginItemState {
  return { openAtLogin, status, wasOpenedAtLogin }
}

function createElectronApp(initial: MacosLoginItemState = state(false)) {
  let current = initial
  const calls: Array<{ method: string; openAtLogin?: boolean }> = []
  let getFailure: unknown
  let setFailure: unknown
  let readbackOverride: MacosLoginItemState | undefined
  const app: ElectronMacosLoginItemApp = {
    getLoginItemSettings() {
      calls.push({ method: 'get' })
      if (getFailure) throw getFailure
      return readbackOverride ?? current
    },
    setLoginItemSettings(settings) {
      calls.push({ method: 'set', openAtLogin: settings.openAtLogin })
      if (setFailure) throw setFailure
      current = state(settings.openAtLogin)
    }
  }
  return {
    app,
    calls,
    current: () => current,
    failGet(error: unknown) { getFailure = error },
    failSet(error: unknown) { setFailure = error },
    setReadback(value: MacosLoginItemState | undefined) { readbackOverride = value }
  }
}

function createConfig(initialSystem: Record<string, unknown> = { autostart: false, theme: 'light' }) {
  const system = { ...initialSystem }
  const calls: Array<{ method: string; path?: string; value?: string }> = []
  let failNextSet: unknown

  const getPath = (source: Record<string, unknown>, pathValue: string): unknown => {
    let current: unknown = source
    for (const segment of pathValue.split('.')) {
      if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
    return current
  }

  const toString = (value: unknown, fallback: unknown): string => {
    const selected = value === undefined ? fallback : value
    if (typeof selected === 'string') return selected
    if (typeof selected === 'object' && selected !== null) return JSON.stringify(selected)
    return String(selected ?? '')
  }

  const config = {
    async get(file: string, pathValue: string, defaultValue: unknown) {
      calls.push({ method: 'get', path: pathValue })
      if (file !== 'user_settings.json') return toString(undefined, defaultValue)
      return toString(getPath({ system }, pathValue), defaultValue)
    },
    async set(file: string, pathValue: string, value: string) {
      calls.push({ method: 'set', path: pathValue, value })
      if (failNextSet) {
        const failure = failNextSet
        failNextSet = undefined
        throw failure
      }
      if (file !== 'user_settings.json') return
      const parsed = value.trim() === 'true' ? true
        : value.trim() === 'false' ? false
          : value.trim().startsWith('{') ? JSON.parse(value) : value
      if (pathValue === 'system') {
        for (const key of Object.keys(system)) delete system[key]
        Object.assign(system, parsed)
        return
      }
      const segments = pathValue.split('.')
      let parent: Record<string, unknown> = { system }
      for (const segment of segments.slice(0, -1)) {
        const current = parent[segment]
        if (typeof current !== 'object' || current === null) parent[segment] = {}
        parent = parent[segment] as Record<string, unknown>
      }
      parent[segments.at(-1)!] = parsed
    },
    async getSetting(key: string) {
      const pathValue = key === 'hotkey' ? 'hotkey.global' : key.includes('.') ? key : `system.${key}`
      return toString(getPath({ system }, pathValue), '')
    },
    async setSetting(key: string, value: unknown) {
      const stored = value === null || value === undefined ? ''
        : typeof value === 'object' ? JSON.stringify(value) : String(value)
      const pathValue = key === 'hotkey' ? 'hotkey.global' : key.includes('.') ? key : `system.${key}`
      await config.set('user_settings.json', pathValue, stored)
      return stored
    }
  }

  return {
    config,
    calls,
    system,
    failSet(error: unknown) { failNextSet = error }
  }
}

function createFakeLoginItems(initial: MacosLoginItemState = state(false)) {
  let current = initial
  const calls: string[] = []
  let failEnabled: boolean | undefined
  let failAlways = false
  const adapter: MacosLoginItemAdapter = {
    get() {
      calls.push('get')
      return current
    },
    setEnabled(enabled) {
      calls.push(`set:${enabled}`)
      if (failAlways || failEnabled === enabled) throw new Error('injected login-item failure')
      current = state(enabled)
      return current
    }
  }
  return {
    adapter,
    calls,
    current: () => current,
    failSet(enabled: boolean) { failEnabled = enabled },
    failAllSets() { failAlways = true }
  }
}

test('packaged Darwin adapter reads Electron state and does not mutate it during construction', () => {
  const fake = createElectronApp(state(true, 'requires-approval', true))
  const adapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: fake.app })

  assert.deepEqual(fake.calls, [])
  assert.deepEqual(adapter.get(), state(true, 'requires-approval', true))
  assert.deepEqual(fake.calls, [{ method: 'get' }])
})

test('packaged Darwin adapter sets only openAtLogin and verifies the Electron readback', () => {
  const fake = createElectronApp()
  const adapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: fake.app })

  assert.deepEqual(adapter.setEnabled(true), state(true))
  assert.deepEqual(fake.calls, [
    { method: 'set', openAtLogin: true },
    { method: 'get' }
  ])
  assert.equal(fake.current().openAtLogin, true)
})

test('Windows and unpackaged Darwin calls are rejected without touching Electron', () => {
  for (const options of [
    { platform: 'win32' as const, isPackaged: true },
    { platform: 'darwin' as const, isPackaged: false }
  ]) {
    const fake = createElectronApp()
    const adapter = createMacosLoginItemAdapter({ ...options, app: fake.app })
    assert.throws(() => adapter.get(), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)
    assert.throws(() => adapter.setEnabled(false), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)
    assert.deepEqual(fake.calls, [])
  }
})

test('adapter surfaces Electron read, set, malformed-state, and readback failures', () => {
  const readFailure = createElectronApp()
  readFailure.failGet(new Error('get failed'))
  const readAdapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: readFailure.app })
  assert.throws(() => readAdapter.get(), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)

  const setFailure = createElectronApp()
  setFailure.failSet(new Error('set failed'))
  const setAdapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: setFailure.app })
  assert.throws(() => setAdapter.setEnabled(true), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)
  assert.deepEqual(setFailure.calls, [{ method: 'set', openAtLogin: true }])

  const invalidState = createElectronApp()
  invalidState.setReadback({ openAtLogin: true, wasOpenedAtLogin: false, status: 'blocked' as MacosLoginItemStatus })
  const invalidAdapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: invalidState.app })
  assert.throws(() => invalidAdapter.get(), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)

  const mismatch = createElectronApp()
  mismatch.setReadback(state(false))
  const mismatchAdapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: mismatch.app })
  assert.throws(() => mismatchAdapter.setEnabled(true), (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported)
})

test('adapter rejects non-boolean writes before calling Electron', () => {
  const fake = createElectronApp()
  const adapter = createMacosLoginItemAdapter({ platform: 'darwin', isPackaged: true, app: fake.app })
  assert.throws(
    () => adapter.setEnabled('true' as unknown as boolean),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.deepEqual(fake.calls, [])
})

test('config wrapper exposes OS state and approval status through existing config getters', async () => {
  const fakeConfig = createConfig({ autostart: false, theme: 'dark' })
  const loginItems = createFakeLoginItems(state(true, 'requires-approval'))
  const config = new LoginItemConfigService(fakeConfig.config, loginItems.adapter)

  assert.equal(await config.get('user_settings.json', 'system.autostart', 'false'), 'true')
  assert.equal(await config.get('user_settings.json', 'system.autostartStatus', ''), 'requires-approval')
  assert.deepEqual(JSON.parse(await config.get('user_settings.json', 'system', '{}')), {
    autostart: true,
    theme: 'dark',
    autostartStatus: 'requires-approval'
  })
  assert.equal(await config.getSetting('system.autostartStatus'), 'requires-approval')
  assert.deepEqual(loginItems.calls, ['get', 'get', 'get', 'get'])
})

test('config wrapper sets OS first, persists the confirmed value, and routes settings_set through the same guard', async () => {
  const fakeConfig = createConfig()
  const loginItems = createFakeLoginItems()
  const config = new LoginItemConfigService(fakeConfig.config, loginItems.adapter)

  await config.set('user_settings.json', 'system.autostart', 'true', true)
  assert.equal(loginItems.current().openAtLogin, true)
  assert.equal(fakeConfig.system.autostart, true)
  assert.deepEqual(loginItems.calls, ['get', 'set:true'])
  assert.equal(fakeConfig.calls.at(-1)?.path, 'system.autostart')

  await config.setSetting('system.autostart', false)
  assert.equal(loginItems.current().openAtLogin, false)
  assert.equal(fakeConfig.system.autostart, false)
  assert.deepEqual(loginItems.calls.slice(2), ['get', 'set:false'])
})

test('whole-system writes cannot bypass the OS adapter and preserve autostart when omitted', async () => {
  const fakeConfig = createConfig({ autostart: false, theme: 'light' })
  const loginItems = createFakeLoginItems(state(true))
  const config = new LoginItemConfigService(fakeConfig.config, loginItems.adapter)

  await config.set('user_settings.json', 'system', JSON.stringify({ theme: 'dark', autostart: false }), true)
  assert.equal(loginItems.current().openAtLogin, false)
  assert.equal(fakeConfig.system.autostart, false)
  assert.equal(fakeConfig.system.theme, 'dark')

  loginItems.adapter.setEnabled(true)
  await config.set('user_settings.json', 'system', JSON.stringify({ theme: 'blue' }), true)
  assert.equal(fakeConfig.system.autostart, true)
  assert.equal(fakeConfig.system.theme, 'blue')
  assert.equal(loginItems.current().openAtLogin, true)
})

test('config persistence failure rolls back the OS state; failed rollback reports an explicit inconsistency', async () => {
  const fakeConfig = createConfig()
  const loginItems = createFakeLoginItems()
  const config = new LoginItemConfigService(fakeConfig.config, loginItems.adapter)
  fakeConfig.failSet(new Error('disk failure'))

  await assert.rejects(config.set('user_settings.json', 'system.autostart', 'true', true), /disk failure/)
  assert.equal(loginItems.current().openAtLogin, false)
  assert.deepEqual(loginItems.calls, ['get', 'set:true', 'set:false'])

  const brokenConfig = createConfig()
  const brokenLoginItems = createFakeLoginItems()
  const brokenService = new LoginItemConfigService(brokenConfig.config, brokenLoginItems.adapter)
  brokenConfig.failSet(new Error('disk failure'))
  brokenLoginItems.failSet(false)
  await assert.rejects(
    brokenService.set('user_settings.json', 'system.autostart', 'true', true),
    (error) => error instanceof ZToolsError && error.code === errorCodes.fileWriteOutcomeUnknown && /状态不一致/.test(error.message)
  )
})

test('OS failure prevents config success, status is read-only, and malformed booleans are rejected', async () => {
  const fakeConfig = createConfig()
  const loginItems = createFakeLoginItems()
  const config = new LoginItemConfigService(fakeConfig.config, loginItems.adapter)
  loginItems.failSet(true)

  await assert.rejects(config.set('user_settings.json', 'system.autostart', 'true', true), /injected login-item failure/)
  assert.equal(fakeConfig.calls.some(call => call.method === 'set'), false)
  await assert.rejects(config.set('user_settings.json', 'system.autostart', '1', true), /必须是布尔值/)
  await assert.rejects(config.set('user_settings.json', 'system.autostartStatus', 'enabled', true), /只允许读取/)
  await assert.rejects(
    config.set('user_settings.json', 'system', JSON.stringify({ autostartStatus: 'enabled' }), true),
    /只允许读取/
  )
  await assert.rejects(config.set('user_settings.json', 'system.autostart.nested', 'true', true), /不能包含子路径/)
})

test('without a packaged-macOS adapter the wrapper preserves the original config flow', async () => {
  const fakeConfig = createConfig()
  const config = new LoginItemConfigService(fakeConfig.config)

  assert.equal(await config.get('user_settings.json', 'system.autostart', 'false'), 'false')
  await config.set('user_settings.json', 'system.autostart', 'true', true)
  assert.equal(fakeConfig.system.autostart, true)
  assert.deepEqual(fakeConfig.calls.map(call => call.method), ['get', 'set'])
})

test('wrapper persists through the real user_settings.json nested-config API', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-login-item-config-'))
  const base = new ConfigService(new JsonFileStore(root, ConfigService.allowedStoreFiles))
  const loginItems = createFakeLoginItems()
  const config = new LoginItemConfigService(base, loginItems.adapter)

  try {
    await config.set('user_settings.json', 'system.autostart', 'true', true)
    assert.equal(await base.get('user_settings.json', 'system.autostart', 'false'), 'true')
    assert.equal(await config.get('user_settings.json', 'system.autostartStatus', ''), 'enabled')

    await config.set('user_settings.json', 'system', JSON.stringify({ theme: 'dark' }), true)
    assert.deepEqual(JSON.parse(await base.get('user_settings.json', 'system', '{}')), {
      theme: 'dark',
      autostart: true
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
