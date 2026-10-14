import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { RuntimeLock } from '../../src/main/runtime/runtime-lock.js'
import {
  resolveRuntimePaths,
  runtimePathsForBusinessDataRoot
} from '../../src/main/runtime/runtime-paths.js'

test('production paths keep the business data root and isolate runtime state', () => {
  const paths = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    ownerId: 'S-1-5-21-test'
  })
  assert.equal(paths.businessDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data')
  assert.equal(paths.browserProfileRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\ElectronProfile')
  assert.equal(paths.ownerId, 'S-1-5-21-test')
  assert.notEqual(paths.cacheRoot, paths.businessDataRoot)
  assert.notEqual(paths.backupRoot, paths.businessDataRoot)
})

test('production paths honor an explicit isolated business data root', () => {
  const paths = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    productRoot: 'E:\\isolated\\ZTools',
    businessDataRoot: 'E:\\isolated\\ZTools\\Data',
    ownerId: 'test-owner'
  })
  assert.equal(paths.businessDataRoot, 'E:\\isolated\\ZTools\\Data')
  assert.equal(paths.browserProfileRoot, 'E:\\isolated\\ZTools\\ElectronProfile')
  assert.equal(paths.transactionRoot, 'E:\\isolated\\ZTools\\Migration\\Transactions')
  assert.equal(paths.logRoot, 'E:\\isolated\\ZTools\\Logs')
})

test('development and test paths cannot fall back to the production data root', () => {
  const production = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    ownerId: 'test'
  })
  const development = resolveRuntimePaths({
    mode: 'development',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    userDataRoot: 'C:\\Users\\tester\\AppData\\Roaming\\ZTools-Electron',
    installRoot: 'D:\\src\\ztools-electron',
    ownerId: 'test'
  })
  const testRoot = runtimePathsForBusinessDataRoot('C:\\fixtures\\ztools\\Data')
  assert.notEqual(development.businessDataRoot, production.businessDataRoot)
  assert.equal(development.mode, 'development')
  assert.equal(testRoot.mode, 'test')
  assert.equal(testRoot.businessDataRoot, 'C:\\fixtures\\ztools\\Data')
})

test('runtime lock blocks a second writer without creating business data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-lock-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  try {
    const lock = await RuntimeLock.acquire(paths)
    try {
      await assert.rejects(
        RuntimeLock.acquire(paths),
        (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked
      )
      await assert.rejects(fs.access(paths.businessDataRoot))
      assert.equal(lock.record.businessDataRoot, paths.businessDataRoot)
    } finally {
      await lock.release()
    }
    const secondLock = await RuntimeLock.acquire(paths)
    await secondLock.release()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runtime lock recovers a legacy lock whose live PID was reused', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-reused-pid-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  const lockPath = path.join(paths.transactionRoot, 'runtime.lock')
  const staleRecord = {
    schemaVersion: 1, pid: process.pid, ownerId: 'old-owner',
    businessDataRoot: paths.businessDataRoot, acquiredAt: '2000-01-01T00:00:00.000Z'
  }
  try {
    await fs.mkdir(paths.transactionRoot, { recursive: true })
    await fs.writeFile(lockPath, JSON.stringify(staleRecord))
    const lock = await RuntimeLock.acquire(paths)
    try {
      assert.equal(lock.record.ownerId, 'test-owner')
      const quarantined = (await fs.readdir(paths.transactionRoot)).filter((name) => name.startsWith('runtime.lock.stale-'))
      assert.equal(quarantined.length, 1)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(paths.transactionRoot, quarantined[0]!), 'utf8')), staleRecord)
      await assert.rejects(RuntimeLock.acquire(paths),
        (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked)
    } finally {
      await lock.release()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runtime lock preserves a live PID when acquisition time cannot be verified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-unknown-lock-time-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  const lockPath = path.join(paths.transactionRoot, 'runtime.lock')
  const source = JSON.stringify({
    schemaVersion: 1, pid: process.pid, ownerId: 'test-owner',
    businessDataRoot: paths.businessDataRoot, acquiredAt: 'unknown'
  })
  try {
    await fs.mkdir(paths.transactionRoot, { recursive: true })
    await fs.writeFile(lockPath, source)
    await assert.rejects(RuntimeLock.acquire(paths),
      (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked)
    assert.equal(await fs.readFile(lockPath, 'utf8'), source)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
