import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReferenceClipboardText } from '../../src/contracts/path-clipboard.js'

test('clipboard text reference contract accepts exactly one bounded input and rejects legacy paths and owners', () => {
  assert.deepEqual(parseReferenceClipboardText({ text: '' }), { text: '' })
  const id = 'a'.repeat(43)
  assert.deepEqual(parseReferenceClipboardText({ fileGrantId: id }), { fileGrantId: id })
  for (const value of [null, [], {}, { tempFile: 'C:/raw' }, { fileGrantId: id, owner: 99 }, { text: '', fileGrantId: id },
    { text: 1 }, { fileGrantId: '../bad' }, { text: '字'.repeat(3 * 1024 * 1024) }, Object.assign(Object.create({}), { text: '' })]) {
    assert.throws(() => parseReferenceClipboardText(value), { code: 'INVALID_REQUEST' })
  }
})
