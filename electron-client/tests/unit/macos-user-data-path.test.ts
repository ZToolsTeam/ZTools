import assert from 'node:assert/strict'
import test from 'node:test'
import os from 'node:os'
import path from 'node:path'
import {
  configureMacosUserDataPath,
  type MacosUserDataPathApp
} from '../../src/main/platform/macos/user-data-path.js'

function createApp(appDataPath: string, ready = false, order: string[] = []): MacosUserDataPathApp {
  return {
    isReady: () => ready,
    getPath(name) {
      assert.equal(name, 'appData')
      order.push('get-app-data')
      return appDataPath
    },
    setPath(name, value) {
      assert.equal(name, 'userData')
      order.push(`set:${value}`)
    }
  }
}

test('macOS userData is stable under the ZTools Application Support root and set after directory creation', () => {
  const appDataPath = path.join(os.tmpdir(), 'Application Support')
  const expected = path.join(appDataPath, 'ZTools')
  const order: string[] = []
  const app = createApp(appDataPath, false, order)

  const result = configureMacosUserDataPath(app, (targetPath) => {
    assert.equal(targetPath, expected)
    order.push(`mkdir:${targetPath}`)
  })

  assert.equal(result, expected)
  assert.deepEqual(order, ['get-app-data', `mkdir:${expected}`, `set:${expected}`])
})

test('macOS userData configuration fails after ready without creating or changing paths', () => {
  const order: string[] = []
  const app = createApp(path.join(os.tmpdir(), 'Application Support'), true, order)

  assert.throws(() => configureMacosUserDataPath(app, () => order.push('mkdir')), /before Electron is ready/)
  assert.deepEqual(order, [])
})

test('macOS userData configuration rejects a non-absolute appData path before side effects', () => {
  const order: string[] = []
  const app = createApp('relative/Application Support', false, order)

  assert.throws(() => configureMacosUserDataPath(app, () => order.push('mkdir')), /must be absolute/)
  assert.deepEqual(order, ['get-app-data'])
})

test('directory creation failure does not reassign Electron userData', () => {
  const expected = path.join(os.tmpdir(), 'Application Support', 'ZTools')
  const order: string[] = []
  const app = createApp(path.dirname(expected), false, order)

  assert.throws(() => configureMacosUserDataPath(app, () => {
    order.push('mkdir')
    throw new Error('read-only home')
  }), /read-only home/)
  assert.deepEqual(order, ['get-app-data', 'mkdir'])
})
