import assert from 'node:assert/strict'
import test from 'node:test'
import {
  argon2id,
  deriveMasterKey,
  encryptAesGcm,
  decryptAesGcm,
  decryptAesGcmString,
  DecryptionError,
  encryptConfigPayload,
  decryptConfigPayload,
  encryptClipboardPayload,
  decryptClipboardPayload
} from '../dist/index.js'

test('Argon2id: derives consistent 32-byte key for same password and salt', () => {
  const password = 'MySuperSecretPassword@2026!'
  const salt = 'UniqueDeviceSalt_9876543210'

  const key1 = argon2id(password, salt, { memoryCost: 64, timeCost: 2 })
  const key2 = argon2id(password, salt, { memoryCost: 64, timeCost: 2 })

  assert.equal(key1.length, 32)
  assert.equal(key2.length, 32)
  assert.equal(key1.toString('hex'), key2.toString('hex'))
})

test('Argon2id: different password or salt produces completely different key', () => {
  const salt = 'UniqueDeviceSalt_9876543210'
  const keyA = argon2id('PasswordA', salt, { memoryCost: 64, timeCost: 2 })
  const keyB = argon2id('PasswordB', salt, { memoryCost: 64, timeCost: 2 })
  const keyC = argon2id('PasswordA', 'AnotherSalt_12345678', { memoryCost: 64, timeCost: 2 })

  assert.notEqual(keyA.toString('hex'), keyB.toString('hex'))
  assert.notEqual(keyA.toString('hex'), keyC.toString('hex'))
})

test('Argon2id: throws error if salt is shorter than 8 bytes', () => {
  assert.throws(
    () => argon2id('password', 'short'),
    /盐值长度至少需要 8 字节/
  )
})

test('deriveMasterKey: generates 256-bit AES master key', () => {
  const key = deriveMasterKey('MasterPassword', 'SystemDeviceSalt123456', { memoryCost: 64, timeCost: 2 })
  assert.equal(key.length, 32)
})

test('AES-256-GCM: encrypts and decrypts string and buffer successfully', () => {
  const key = deriveMasterKey('test-pass', 'test-salt-12345678', { memoryCost: 64, timeCost: 2 })
  const plaintext = '这是需要端到端同步的敏感配置信息 🔐 2026-10-12'

  const payload = encryptAesGcm(plaintext, key, 'aad:config:v1')
  assert.equal(payload.algorithm, 'aes-256-gcm')
  assert.equal(payload.version, 1)
  assert.ok(payload.ciphertext)
  assert.ok(payload.iv)
  assert.ok(payload.tag)
  assert.ok(payload.aad)

  const decrypted = decryptAesGcmString(payload, key)
  assert.equal(decrypted, plaintext)
})

test('AES-256-GCM: detects ciphertext tampering and throws DecryptionError', () => {
  const key = deriveMasterKey('test-pass', 'test-salt-12345678', { memoryCost: 64, timeCost: 2 })
  const payload = encryptAesGcm('secret data', key)

  // 篡改密文
  const tamperedCipher = Buffer.from(payload.ciphertext, 'base64')
  tamperedCipher[0] = tamperedCipher[0] ^ 0xff
  const tamperedPayload = {
    ...payload,
    ciphertext: tamperedCipher.toString('base64')
  }

  assert.throws(
    () => decryptAesGcm(tamperedPayload, key),
    (err) => err instanceof DecryptionError
  )
})

test('AES-256-GCM: detects auth tag tampering', () => {
  const key = deriveMasterKey('test-pass', 'test-salt-12345678', { memoryCost: 64, timeCost: 2 })
  const payload = encryptAesGcm('secret data', key)

  // 篡改 Tag
  const tamperedTag = Buffer.from(payload.tag, 'base64')
  tamperedTag[0] = tamperedTag[0] ^ 0x01
  const tamperedPayload = {
    ...payload,
    tag: tamperedTag.toString('base64')
  }

  assert.throws(
    () => decryptAesGcm(tamperedPayload, key),
    (err) => err instanceof DecryptionError
  )
})

test('AES-256-GCM: detects AAD tampering', () => {
  const key = deriveMasterKey('test-pass', 'test-salt-12345678', { memoryCost: 64, timeCost: 2 })
  const payload = encryptAesGcm('secret data', key, 'correct-aad')

  const tamperedPayload = {
    ...payload,
    aad: Buffer.from('forged-aad').toString('base64')
  }

  assert.throws(
    () => decryptAesGcm(tamperedPayload, key),
    (err) => err instanceof DecryptionError
  )
})

test('AES-256-GCM: rejects decryption with wrong key', () => {
  const key1 = deriveMasterKey('key1', 'salt1-12345678', { memoryCost: 64, timeCost: 2 })
  const key2 = deriveMasterKey('key2', 'salt2-87654321', { memoryCost: 64, timeCost: 2 })

  const payload = encryptAesGcm('secret data', key1)

  assert.throws(
    () => decryptAesGcm(payload, key2),
    (err) => err instanceof DecryptionError
  )
})

test('Config Payload: encrypts and restores full application configuration', () => {
  const key = deriveMasterKey('myMasterPassword', 'DeviceUniqueSalt1234', { memoryCost: 64, timeCost: 2 })

  const originalConfig = {
    schemaVersion: 1,
    updatedAt: '2026-10-12T08:00:00Z',
    deviceId: 'win-client-01',
    settings: {
      theme: 'dark',
      hotkey: 'Alt+Space',
      autoStart: true,
      windowSize: { width: 1024, height: 768 }
    },
    triggers: [
      { id: 'trig1', key: 'Ctrl+Shift+P', target: 'super_panel' }
    ],
    plugins: {
      'plugin-calculator': { enabled: true, pinned: true },
      'plugin-dev-tools': { enabled: true, pinned: false }
    }
  }

  const envelope = encryptConfigPayload(originalConfig, key)
  const restoredConfig = decryptConfigPayload(envelope, key)

  assert.deepEqual(restoredConfig, originalConfig)
})

test('Clipboard Payload: encrypts and restores rich clipboard history data', () => {
  const key = deriveMasterKey('myMasterPassword', 'DeviceUniqueSalt1234', { memoryCost: 64, timeCost: 2 })

  const originalClipboard = {
    schemaVersion: 1,
    updatedAt: '2026-10-12T08:10:00Z',
    deviceId: 'win-client-01',
    items: [
      {
        id: 'clip-1',
        type: 'text',
        content: 'console.log("Hello ZTools E2EE!")',
        timestamp: 1776000000000
      },
      {
        id: 'clip-2',
        type: 'image',
        content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        metadata: { width: 1, height: 1 },
        timestamp: 1776000001000
      }
    ]
  }

  const envelope = encryptClipboardPayload(originalClipboard, key)
  const restoredClipboard = decryptClipboardPayload(envelope, key)

  assert.deepEqual(restoredClipboard, originalClipboard)
})
