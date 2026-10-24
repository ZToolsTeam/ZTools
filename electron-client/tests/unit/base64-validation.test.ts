import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isValidFileBase64, validateMethodParams } from '../../src/contracts/method-params.js'
import { errorCodes } from '../../src/contracts/errors.js'
import { DatabaseService } from '../../src/main/services/database-service.js'

/** 约 460 万字符：旧的 /^(?:[A-Za-z0-9+/]{4})*...$/ 正则在这里回溯栈溢出（RangeError → 宿主内部错误） */
const HUGE = Buffer.alloc(3_450_000, 0xab).toString('base64')

test('base64 checker accepts multi-megabyte payloads without stack overflow and keeps the regex semantics', () => {
  assert.ok(HUGE.length > 4_500_000)
  assert.equal(isValidFileBase64(HUGE), true)
  for (const valid of ['', 'QQ==', 'QUI=', 'QUJD', 'a+/9', Buffer.from('ZTools 二维码').toString('base64')]) assert.equal(isValidFileBase64(valid), true, valid)
  for (const invalid of ['Q', 'QQ=', 'QQ===', '====', 'Q===', 'QU=I', 'QUJD\n', 'QUJ-', 'QUJ_', ' QUJD', 'QUJDé===']) assert.equal(isValidFileBase64(invalid), false, invalid)
  assert.equal(isValidFileBase64(HUGE.slice(0, -4) + 'QU*D'), false)
  assert.equal(isValidFileBase64(HUGE + '='), false)
})

test('clipboard image validation handles a version-40 QR PNG sized payload and still rejects malformed images', () => {
  for (const method of ['clipboard_copy_image', 'clipboard_hide_and_paste_image'] as const) {
    assert.doesNotThrow(() => validateMethodParams(method, { image: HUGE }))
    assert.doesNotThrow(() => validateMethodParams(method, { image: `data:image/png;base64,${HUGE}` }))
    for (const image of [`${HUGE}!`, `data:image/png;base64,${HUGE.slice(1)}`, `data:image/svg+xml;base64,${HUGE}`, 'data:image/png;base64']) {
      assert.throws(() => validateMethodParams(method, { image }), { code: errorCodes.invalidRequest })
    }
  }
})

test('database base64 values and file write chunks use the same overflow-free validation', async () => {
  assert.doesNotThrow(() => validateMethodParams('db_put', { plugin_id: 'qr-code', key: 'big', value: HUGE, is_base64: true }))
  assert.throws(() => validateMethodParams('db_put', { plugin_id: 'qr-code', key: 'big', value: `${HUGE}%`, is_base64: true }), { code: errorCodes.invalidRequest })
  const chunk = Buffer.alloc(1024, 7).toString('base64')
  assert.doesNotThrow(() => validateMethodParams('filesystem_write_file_chunk', { handle: 'a'.repeat(16), offset: 0, content: chunk }))
  assert.throws(() => validateMethodParams('filesystem_write_file_chunk', { handle: 'a'.repeat(16), offset: 0, content: `${chunk}=` }), { code: errorCodes.invalidRequest })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-base64-db-'))
  const database = new DatabaseService(root)
  const caller = { type: 'main' as const, webContentsId: 1 }
  try {
    await database.put({ plugin_id: 'qr-code', key: 'big', value: HUGE, is_base64: true }, caller, new AbortController().signal)
    const stored = await database.get({ plugin_id: 'qr-code', key: 'big', is_base64: true }, caller, new AbortController().signal)
    assert.equal(stored.data.length, HUGE.length)
    await assert.rejects(database.put({ plugin_id: 'qr-code', key: 'bad', value: 'QQ=', is_base64: true }, caller, new AbortController().signal), { code: errorCodes.invalidRequest })
  } finally {
    await database.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})
