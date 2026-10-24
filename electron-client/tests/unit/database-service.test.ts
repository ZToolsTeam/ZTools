import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ClassicLevel } from 'classic-level'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { CredentialProtection, CredentialProtectionStatus } from '../../src/main/services/credential-protection.js'
import {
  DatabaseService,
  decryptLegacySecure,
  encryptLegacySecure
} from '../../src/main/services/database-service.js'

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 2,
  pluginId: 'plugin.database-test'
}
const timestampCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 3,
  pluginId: 'timestamp'
}
const legacyTimeCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 4,
  pluginId: 'time'
}
const credentialCallerA: CallerIdentity = {
  type: 'plugin', webContentsId: 20, pluginId: 'plugin.credentials', pluginInstanceId: 'credential-instance-a'
}
const credentialCallerB: CallerIdentity = {
  type: 'plugin', webContentsId: 21, pluginId: 'plugin.credentials', pluginInstanceId: 'credential-instance-b'
}
const otherCredentialCaller: CallerIdentity = {
  type: 'plugin', webContentsId: 22, pluginId: 'other.credentials', pluginInstanceId: 'credential-instance-c'
}

function signal(): AbortSignal {
  return new AbortController().signal
}

async function createService(): Promise<{ root: string; service: DatabaseService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-database-'))
  return { root, service: new DatabaseService(path.join(root, 'LevelDB')) }
}

class TestCredentialProtection implements CredentialProtection {
  readonly #key = randomBytes(32)
  statusValue: CredentialProtectionStatus = { status: 'available' }
  requestReEncryption = false
  encryptCalls = 0

  async status(): Promise<CredentialProtectionStatus> {
    return this.statusValue
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    this.encryptCalls += 1
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  async decrypt(ciphertext: Buffer): Promise<{ readonly plaintext: string; readonly shouldReEncrypt: boolean }> {
    if (ciphertext.byteLength < 28) throw new Error('invalid test ciphertext')
    const iv = ciphertext.subarray(0, 12)
    const tag = ciphertext.subarray(12, 28)
    const body = ciphertext.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', this.#key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    const shouldReEncrypt = this.requestReEncryption
    this.requestReEncryption = false
    return { plaintext, shouldReEncrypt }
  }
}

async function createSecureService(protection: CredentialProtection): Promise<{ root: string; service: DatabaseService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-credential-'))
  return { root, service: new DatabaseService(path.join(root, 'LevelDB'), protection) }
}

async function dispose(root: string, ...services: DatabaseService[]): Promise<void> {
  await Promise.allSettled(services.map((service) => service.stop()))
  await fs.rm(root, { recursive: true, force: true })
}

test('database stores text, JSON and binary values with bounded prefix queries', async () => {
  const { root, service } = await createService()
  try {
    await service.put({ plugin_id: 'main.test', key: 'item:1', value: '文本值' }, mainCaller, signal())
    await service.put({ plugin_id: 'main.test', key: 'item:2', value: { ok: true } }, mainCaller, signal())
    await service.put({ plugin_id: 'main.test', key: 'raw', value: 'AP+A', is_base64: true }, mainCaller, signal())

    assert.equal((await service.get({ plugin_id: 'main.test', key: 'item:1' }, mainCaller, signal())).data, '文本值')
    assert.equal((await service.get({ plugin_id: 'main.test', key: 'item:2' }, mainCaller, signal())).data, '{"ok":true}')
    assert.equal((await service.get({ plugin_id: 'main.test', key: 'raw', is_base64: true }, mainCaller, signal())).data, 'AP+A')
    assert.equal((await service.exists({ plugin_id: 'main.test', key: 'item:1' }, mainCaller, signal())).data, true)
    assert.deepEqual(
      (await service.query({ plugin_id: 'main.test', prefix: 'item:', limit: 1 }, mainCaller, signal())).data,
      [{ key: 'item:1', value: '文本值' }]
    )
  } finally {
    await dispose(root, service)
  }
})

test('database query limit zero preserves the legacy unbounded meaning until the response budget', async () => {
  const { root, service } = await createService()
  try {
    await service.batch({
      plugin_id: 'main.unbounded',
      operations: Array.from({ length: 10_001 }, (_value, index) => ({
        op: 'put' as const,
        key: `item:${String(index).padStart(5, '0')}`,
        value: String(index)
      }))
    }, mainCaller, signal())
    const result = await service.query({
      plugin_id: 'main.unbounded',
      prefix: 'item:',
      limit: 0
    }, mainCaller, signal())
    assert.equal(result.data.length, 10_001)
  } finally {
    await dispose(root, service)
  }
})

test('database batch applies ordered puts and deletes atomically', async () => {
  const { root, service } = await createService()
  try {
    await service.put({ plugin_id: 'main.batch', key: 'old', value: 'old' }, mainCaller, signal())
    await service.batch({
      plugin_id: 'main.batch',
      operations: [
        { op: 'put', key: 'first', value: { index: 1 } },
        { op: 'put', key: 'old', value: 'replacement' },
        { op: 'delete', key: 'old' }
      ]
    }, mainCaller, signal())
    assert.equal((await service.exists({ plugin_id: 'main.batch', key: 'old' }, mainCaller, signal())).data, false)
    assert.equal((await service.get({ plugin_id: 'main.batch', key: 'first' }, mainCaller, signal())).data, '{"index":1}')
  } finally {
    await dispose(root, service)
  }
})

test('legacy secure values round-trip UTF-16 text and remain deterministic', async () => {
  const pluginId = 'plugin.database-test'
  const key = '凭据-key'
  const value = 'token-中文-😀'
  const encrypted = encryptLegacySecure(pluginId, key, value)
  assert.equal(encryptLegacySecure(pluginId, key, value), encrypted)
  assert.equal(decryptLegacySecure(pluginId, key, encrypted), value)

  const { root, service } = await createService()
  try {
    await service.putSecure({ plugin_id: pluginId, key, value }, pluginCaller, signal())
    assert.equal((await service.getSecure({ plugin_id: pluginId, key }, pluginCaller, signal())).data, value)
  } finally {
    await dispose(root, service)
  }
})

test('opens a physical uncompressed LevelDB fixture and preserves new writes for a raw reader', async () => {
  const { root, service } = await createService()
  const namespace = 'legacy.fixture'
  const location = path.join(root, 'LevelDB', namespace)
  const legacyValue = '旧数据库值'
  try {
    await fs.mkdir(path.dirname(location), { recursive: true })
    const fixture = new ClassicLevel<string, Buffer>(location, {
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
      compression: false
    })
    await fixture.open()
    await fixture.put('legacy:key', Buffer.from(legacyValue, 'utf8'), { sync: true })
    await fixture.put(
      'secure:token',
      Buffer.from(encryptLegacySecure(namespace, 'token', 'secret-中文'), 'utf8'),
      { sync: true }
    )
    await fixture.close()

    assert.equal(
      (await service.get({ plugin_id: namespace, key: 'legacy:key' }, mainCaller, signal())).data,
      legacyValue
    )
    assert.equal(
      (await service.getSecure({ plugin_id: namespace, key: 'token' }, mainCaller, signal())).data,
      'secret-中文'
    )
    await service.put({ plugin_id: namespace, key: 'new:key', value: 'new-value' }, mainCaller, signal())
    await service.stop()

    const reopened = new ClassicLevel<string, Buffer>(location, {
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
      compression: false
    })
    await reopened.open()
    try {
      assert.equal((await reopened.get('legacy:key'))!.toString('utf8'), legacyValue)
      assert.equal((await reopened.get('new:key'))!.toString('utf8'), 'new-value')
    } finally {
      await reopened.close()
    }
  } finally {
    await dispose(root, service)
  }
})

test('plugin callers cannot spoof namespaces or escape the database root', async () => {
  const { root, service } = await createService()
  try {
    await assert.rejects(
      service.put({ plugin_id: 'other-plugin', key: 'key', value: 'value' }, pluginCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await assert.rejects(
      service.put({ plugin_id: '../outside', key: 'key', value: 'value' }, mainCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  } finally {
    await dispose(root, service)
  }
})

test('timestamp callers use only the legacy time namespace and keep its physical store', async () => {
  const { root, service } = await createService()
  try {
    await service.put({ plugin_id: 'time', key: 'from-timestamp', value: { unit: 'second' } }, timestampCaller, signal())
    assert.equal(
      (await service.get({ plugin_id: 'time', key: 'from-timestamp' }, timestampCaller, signal())).data,
      '{"unit":"second"}'
    )
    await service.put({ plugin_id: 'timestamp', key: 'from-canonical', value: 'canonical' }, timestampCaller, signal())
    assert.equal(
      (await service.get({ plugin_id: 'time', key: 'from-canonical' }, timestampCaller, signal())).data,
      'canonical'
    )
    await assert.rejects(
      service.get({ plugin_id: 'other-plugin', key: 'from-timestamp' }, timestampCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )

    assert.deepEqual(await fs.readdir(path.join(root, 'LevelDB')), ['time'])
  } finally {
    await dispose(root, service)
  }
})

test('other plugin callers cannot use time and historical time callers remain supported', async () => {
  const { root, service } = await createService()
  try {
    await service.put({ plugin_id: 'time', key: 'from-time', value: 'legacy' }, legacyTimeCaller, signal())
    assert.equal(
      (await service.get({ plugin_id: 'time', key: 'from-time' }, legacyTimeCaller, signal())).data,
      'legacy'
    )
    assert.equal(
      (await service.get({ plugin_id: 'time', key: 'from-time' }, timestampCaller, signal())).data,
      'legacy'
    )
    await assert.rejects(
      service.get({ plugin_id: 'time', key: 'from-time' }, pluginCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )

    assert.deepEqual(await fs.readdir(path.join(root, 'LevelDB')), ['time'])
  } finally {
    await dispose(root, service)
  }
})

test('missing keys and invalid secure payloads return structured errors', async () => {
  const { root, service } = await createService()
  try {
    await assert.rejects(
      service.get({ plugin_id: 'main.errors', key: 'missing' }, mainCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.databaseKeyNotFound
    )
    await service.put({ plugin_id: 'main.errors', key: 'secure:key', value: 'not-base64' }, mainCaller, signal())
    await assert.rejects(
      service.getSecure({ plugin_id: 'main.errors', key: 'key' }, mainCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.dataCorrupt
    )
  } finally {
    await dispose(root, service)
  }
})

test('simultaneous service startup keeps one writer and allows retry after lock release', async () => {
  const { root, service } = await createService()
  const second = new DatabaseService(path.join(root, 'LevelDB'))
  const params = (value: string) => ({ plugin_id: 'main.concurrent', key: 'owner', value })
  try {
    const writes = await Promise.allSettled([
      service.put(params('first'), mainCaller, signal()),
      second.put(params('second'), mainCaller, signal())
    ])
    const winnerIndex = writes.findIndex((result) => result.status === 'fulfilled')
    assert.notEqual(winnerIndex, -1, 'one concurrent startup must acquire the LevelDB writer lock')
    const loser = writes[winnerIndex === 0 ? 1 : 0]
    assert.ok(loser && loser.status === 'rejected')
    assert.ok(loser.reason instanceof ZToolsError)
    assert.equal(loser.reason.code, errorCodes.databaseLocked)

    const winner = winnerIndex === 0 ? service : second
    const retrying = winnerIndex === 0 ? second : service
    const persisted = winnerIndex === 0 ? 'first' : 'second'
    assert.equal(
      (await winner.get({ plugin_id: 'main.concurrent', key: 'owner' }, mainCaller, signal())).data,
      persisted
    )
    assert.deepEqual(await fs.readdir(path.join(root, 'LevelDB')), ['main.concurrent'])

    await winner.stop()
    assert.equal(
      (await retrying.get({ plugin_id: 'main.concurrent', key: 'owner' }, mainCaller, signal())).data,
      persisted
    )
  } finally {
    await dispose(root, service, second)
  }
})
test('a second service reports the LevelDB lock and stopped services reject calls', async () => {
  const { root, service } = await createService()
  const second = new DatabaseService(path.join(root, 'LevelDB'))
  try {
    await service.put({ plugin_id: 'main.lock', key: 'key', value: 'value' }, mainCaller, signal())
    await assert.rejects(
      second.get({ plugin_id: 'main.lock', key: 'key' }, mainCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked
    )
    await service.stop()
    await assert.rejects(
      service.exists({ plugin_id: 'main.lock', key: 'key' }, mainCaller, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.appStopping
    )
  } finally {
    await dispose(root, service, second)
  }
})

test('credential v1 is OS-protection-port gated, plugin-bound, persistent across same-plugin instances and overwrite/delete safe', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  try {
    assert.deepEqual((await service.credentialV1Status(credentialCallerA)).data, { status: 'available' })
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'oauth:refresh-token' }, credentialCallerA, signal())).data,
      { status: 'missing' }
    )
    await service.credentialV1Set({ key: 'boundary', value: '\0'.repeat(64 * 1024) }, credentialCallerA, signal())
    assert.equal(
      (await service.credentialV1Get({ key: 'boundary' }, credentialCallerA, signal())).data.status,
      'present'
    )

    await service.credentialV1Set(
      { key: 'oauth:refresh-token', value: 'refresh-token-中文-😀' }, credentialCallerA, signal()
    )
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'oauth:refresh-token' }, credentialCallerB, signal())).data,
      { status: 'present', value: 'refresh-token-中文-😀' }
    )
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'oauth:refresh-token' }, otherCredentialCaller, signal())).data,
      { status: 'missing' }
    )

    await service.credentialV1Set(
      { key: 'oauth:refresh-token', value: 'overwritten' }, credentialCallerB, signal()
    )
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'oauth:refresh-token' }, credentialCallerA, signal())).data,
      { status: 'present', value: 'overwritten' }
    )
    await service.credentialV1Delete({ key: 'oauth:refresh-token' }, credentialCallerB, signal())
    await service.credentialV1Delete({ key: 'oauth:refresh-token' }, credentialCallerA, signal())
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'oauth:refresh-token' }, credentialCallerA, signal())).data,
      { status: 'missing' }
    )
  } finally {
    await dispose(root, service)
  }
})

test('credential v1 rejects missing or malformed host instance identity and does not accept renderer plugin IDs', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  try {
    for (const caller of [
      { type: 'plugin', webContentsId: 30, pluginId: 'plugin.credentials' },
      { type: 'plugin', webContentsId: 0, pluginId: 'plugin.credentials', pluginInstanceId: 'instance' },
      { type: 'plugin', webContentsId: 30, pluginId: 'plugin.credentials', pluginInstanceId: '' }
    ] as CallerIdentity[]) {
      await assert.rejects(
        service.credentialV1Status(caller),
        (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
      )
    }
  } finally {
    await dispose(root, service)
  }
})

test('credential v1 separates plugin IDs that share the legacy timestamp/time database alias', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  const timestamp: CallerIdentity = {
    type: 'plugin', webContentsId: 40, pluginId: 'timestamp', pluginInstanceId: 'timestamp-instance'
  }
  const time: CallerIdentity = {
    type: 'plugin', webContentsId: 41, pluginId: 'time', pluginInstanceId: 'time-instance'
  }
  try {
    await service.credentialV1Set({ key: 'shared-key', value: 'timestamp-value' }, timestamp, signal())
    await service.credentialV1Set({ key: 'shared-key', value: 'time-value' }, time, signal())
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'shared-key' }, timestamp, signal())).data,
      { status: 'present', value: 'timestamp-value' }
    )
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'shared-key' }, time, signal())).data,
      { status: 'present', value: 'time-value' }
    )
    await service.credentialV1Delete({ key: 'shared-key' }, timestamp, signal())
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'shared-key' }, timestamp, signal())).data,
      { status: 'missing' }
    )
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'shared-key' }, time, signal())).data,
      { status: 'present', value: 'time-value' }
    )
  } finally {
    await dispose(root, service)
  }
})

test('credential v1 fails closed when encryption is unavailable but allows idempotent deletion', async () => {
  const protection = new TestCredentialProtection()
  protection.statusValue = { status: 'unavailable', reason: 'insecure-backend' }
  const { root, service } = await createSecureService(protection)
  try {
    assert.deepEqual((await service.credentialV1Status(credentialCallerA)).data, {
      status: 'unavailable', reason: 'insecure-backend'
    })
    await assert.rejects(
      service.credentialV1Set({ key: 'api-token', value: 'never-plain' }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
    await assert.rejects(
      service.credentialV1Get({ key: 'api-token' }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
    await service.credentialV1Delete({ key: 'api-token' }, credentialCallerA, signal())
  } finally {
    await dispose(root, service)
  }
})

test('credential v1 enforces UTF-8 limits, protects reserved database rows and never reads reversible legacy secure data', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  const pluginId = credentialCallerA.pluginId as string
  try {
    await service.putSecure({ plugin_id: pluginId, key: 'api-token', value: 'legacy-reversible' }, credentialCallerA, signal())
    assert.deepEqual(
      (await service.credentialV1Get({ key: 'api-token' }, credentialCallerA, signal())).data,
      { status: 'missing' }
    )
    await assert.rejects(
      service.credentialV1Set({ key: 'too-large', value: '😀'.repeat(16_385) }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
    )
    await assert.rejects(
      service.put({ plugin_id: pluginId, key: '__ztools_credential_v1__:blocked', value: 'plaintext' }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    for (const operation of [
      service.get({ plugin_id: pluginId, key: '__ztools_credential_v1__:blocked' }, credentialCallerA, signal()),
      service.delete({ plugin_id: pluginId, key: '__ztools_credential_v1__:blocked' }, credentialCallerA, signal()),
      service.exists({ plugin_id: pluginId, key: '__ztools_credential_v1__:blocked' }, credentialCallerA, signal())
    ]) {
      await assert.rejects(
        operation,
        (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
      )
    }
    await assert.rejects(
      service.batch({
        plugin_id: pluginId,
        operations: [{ op: 'put', key: '__ztools_credential_v1__:blocked', value: 'plaintext' }]
      }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await service.credentialV1Set({ key: 'visible-check', value: 'secret' }, credentialCallerA, signal())
    await service.put({ plugin_id: pluginId, key: 'ordinary-visible', value: 'safe' }, credentialCallerA, signal())
    const visibleRows = (await service.query({ plugin_id: pluginId, prefix: '', limit: 0 }, credentialCallerA, signal())).data
    assert.deepEqual(visibleRows.map((row) => row.key), ['ordinary-visible', 'secure:api-token'])
    assert.equal(visibleRows.some((row) => row.key.startsWith('__ztools_credential_v1__:')), false)
  } finally {
    await dispose(root, service)
  }
})

test('credential v1 writes opaque records, detects corrupt binding and re-encrypts rotated records', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  const pluginId = credentialCallerA.pluginId as string
  const credentialKey = '__ztools_credential_v1__:'.concat(Buffer.from('api-token').toString('base64url'))
  const pluginHash = createHash('sha256').update(pluginId, 'utf8').digest('hex')
  const location = path.join(root, 'LevelDB', `__ztools_credential_v1__${pluginHash}`)
  const key = 'api-token'
  try {
    await service.credentialV1Set({ key, value: 'opaque-credential-value' }, credentialCallerA, signal())
    protection.requestReEncryption = true
    assert.deepEqual(
      (await service.credentialV1Get({ key }, credentialCallerA, signal())).data,
      { status: 'present', value: 'opaque-credential-value' }
    )
    assert.equal(protection.encryptCalls, 2, 'a safeStorage key rotation requests a replacement encrypted record')
    await service.stop()

    const rawStore = new ClassicLevel<string, Buffer>(location, {
      keyEncoding: 'utf8', valueEncoding: 'buffer', compression: false
    })
    await rawStore.open()
    try {
      const rawValue = await rawStore.get(credentialKey)
      assert.ok(rawValue)
      const raw = rawValue.toString('utf8')
      assert.match(raw, /^ztools-credential-v1:/)
      assert.equal(raw.includes('opaque-credential-value'), false)

      const wrongEnvelope = JSON.stringify({
        format: 'ztools-credential-envelope-v1',
        pluginId: 'other.credentials',
        key,
        value: 'wrong-owner'
      })
      const wrongCiphertext = await protection.encrypt(wrongEnvelope)
      await rawStore.put(credentialKey, Buffer.from(`ztools-credential-v1:${wrongCiphertext.toString('base64')}`, 'utf8'), { sync: true })
    } finally {
      await rawStore.close()
    }

    const reopened = new DatabaseService(path.join(root, 'LevelDB'), protection)
    await assert.rejects(
      reopened.credentialV1Get({ key }, credentialCallerA, signal()),
      (error) => error instanceof ZToolsError && error.code === errorCodes.dataCorrupt
    )
    await reopened.stop()
  } finally {
    await dispose(root, service)
  }
})

test('普通CAS：同一旧值并发只有一个提交，其他命名空间不互相覆盖', async () => {
  const { root, service } = await createService()
  const own = { plugin_id: pluginCaller.pluginId!, key: 'cas-counter' }
  try {
    await service.put({ ...own, value: '0' }, pluginCaller, signal())
    const results = await Promise.all(['1', '2', '3'].map(value => service.compareAndSet({ ...own, expectedValue: '0', value }, pluginCaller, signal())))
    assert.equal(results.filter(r => r.data).length, 1)
    const winner = (await service.get(own, pluginCaller, signal())).data
    assert.ok(['1', '2', '3'].includes(winner))
    await service.compareAndSet({ plugin_id: 'separate', key: own.key, expectedValue: null, value: 'different' }, mainCaller, signal())
    assert.equal((await service.get(own, pluginCaller, signal())).data, winner)
    await assert.rejects(service.compareAndSet({ plugin_id: 'separate', key: own.key, expectedValue: 'different', value: 'hijack' }, pluginCaller, signal()), { code: errorCodes.permissionDenied })
  } finally { await dispose(root, service) }
})

test('普通CAS：提交后取消仍返回成功；读取期间取消不写入且释放锁', async (t) => {
  const { root, service } = await createService()
  const params = { plugin_id: 'cas-cancel', key: 'counter' }
  const originalPut = ClassicLevel.prototype.put
  const originalGet = ClassicLevel.prototype.get
  try {
    await service.put({ ...params, value: '0' }, mainCaller, signal())
    const afterCommit = new AbortController()
    const putMock = t.mock.method(ClassicLevel.prototype, 'put', async function (this: ClassicLevel<any, any>, ...args: any[]) {
      await Reflect.apply(originalPut, this, args)
      if (args[0] === params.key) afterCommit.abort(errorCodes.callerDestroyed)
    })
    assert.deepEqual(await service.compareAndSet({ ...params, expectedValue: '0', value: '1' }, mainCaller, afterCommit.signal), { success: true, data: true })
    putMock.mock.restore()
    assert.equal((await service.get(params, mainCaller, signal())).data, '1')
    const beforeWrite = new AbortController()
    const getMock = t.mock.method(ClassicLevel.prototype, 'get', async function (this: ClassicLevel<any, any>, ...args: any[]) {
      const value = await Reflect.apply(originalGet, this, args)
      if (args[0] === params.key) beforeWrite.abort(errorCodes.callerDestroyed)
      return value
    })
    await assert.rejects(service.compareAndSet({ ...params, expectedValue: '1', value: '2' }, mainCaller, beforeWrite.signal), { code: errorCodes.callerDestroyed })
    getMock.mock.restore()
    assert.equal((await service.get(params, mainCaller, signal())).data, '1')
    assert.equal((await service.compareAndSet({ ...params, expectedValue: '1', value: '3' }, mainCaller, signal())).data, true)
  } finally { t.mock.restoreAll(); await dispose(root, service) }
})

test('安全CAS：同插件多窗口并发只有一个提交，其他插件同key隔离', async () => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  try {
    await service.credentialV1Set({ key: 'counter', value: '0' }, credentialCallerA, signal())
    const results = await Promise.all([
      service.credentialV1Set({ key: 'counter', value: '1', expectedValue: '0' }, credentialCallerA, signal()),
      service.credentialV1Set({ key: 'counter', value: '2', expectedValue: '0' }, credentialCallerB, signal())
    ])
    assert.deepEqual(results.map(r => r.data).sort(), ['CONFLICT', 'OK'])
    assert.equal((await service.credentialV1Set({ key: 'counter', value: 'private', expectedValue: null }, otherCredentialCaller, signal())).data, 'OK')
    const own = (await service.credentialV1Get({ key: 'counter' }, credentialCallerA, signal())).data
    assert.equal(own.status, 'present')
    assert.notEqual(own.status === 'present' ? own.value : null, 'private')
  } finally { await dispose(root, service) }
})

test('安全CAS：解密旧值期间取消不覆盖；存在性读取期间取消不创建', async (t) => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  const originalDecrypt = protection.decrypt.bind(protection)
  const originalHas = ClassicLevel.prototype.has
  try {
    await service.credentialV1Set({ key: 'counter', value: 'old' }, credentialCallerA, signal())
    const controller = new AbortController()
    const decryptMock = t.mock.method(protection, 'decrypt', async (cipher: Buffer) => {
      const result = await originalDecrypt(cipher)
      controller.abort(errorCodes.callerDestroyed)
      return result
    })
    await assert.rejects(service.credentialV1Set({ key: 'counter', value: 'new', expectedValue: 'old' }, credentialCallerA, controller.signal), { code: errorCodes.callerDestroyed })
    decryptMock.mock.restore()
    assert.deepEqual((await service.credentialV1Get({ key: 'counter' }, credentialCallerA, signal())).data, { status: 'present', value: 'old' })
    const absent = new AbortController()
    const hasMock = t.mock.method(ClassicLevel.prototype, 'has', async function (this: ClassicLevel<any, any>, ...args: any[]) {
      const exists = await Reflect.apply(originalHas, this, args)
      absent.abort(errorCodes.callerDestroyed)
      return exists
    })
    await assert.rejects(service.credentialV1Set({ key: 'new-key', value: 'new', ifAbsent: true }, credentialCallerA, absent.signal), { code: errorCodes.callerDestroyed })
    hasMock.mock.restore()
    assert.deepEqual((await service.credentialV1Get({ key: 'new-key' }, credentialCallerA, signal())).data, { status: 'missing' })
  } finally { t.mock.restoreAll(); await dispose(root, service) }
})

test('安全凭据：重新加密期间取消不得写回；锁释放后仍能正常读取', async (t) => {
  const protection = new TestCredentialProtection()
  const { root, service } = await createSecureService(protection)
  const originalEncrypt = protection.encrypt.bind(protection)
  const originalPut = ClassicLevel.prototype.put
  try {
    await service.credentialV1Set({ key: 'rotate', value: 'unchanged' }, credentialCallerA, signal())
    const controller = new AbortController()
    let writes = 0
    t.mock.method(ClassicLevel.prototype, 'put', async function (this: ClassicLevel<any, any>, ...args: any[]) { writes++; return Reflect.apply(originalPut, this, args) })
    const encryptMock = t.mock.method(protection, 'encrypt', async (text: string) => { const result = await originalEncrypt(text); controller.abort(errorCodes.callerDestroyed); return result })
    protection.requestReEncryption = true
    await assert.rejects(service.credentialV1Get({ key: 'rotate' }, credentialCallerA, controller.signal), { code: errorCodes.callerDestroyed })
    assert.equal(writes, 0)
    encryptMock.mock.restore()
    assert.deepEqual((await service.credentialV1Get({ key: 'rotate' }, credentialCallerA, signal())).data, { status: 'present', value: 'unchanged' })
  } finally { t.mock.restoreAll(); await dispose(root, service) }
})
