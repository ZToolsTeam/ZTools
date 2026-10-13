import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReferenceRead, parseReferenceRange, parseReferenceWrite, parseReferenceCopy, parseReferenceDirectory, parseReferenceRemove, parseReferenceMove, grantId } from '../../src/contracts/path-reference.js'

const file = 'a'.repeat(43), save = 'b'.repeat(43), directory = 'c'.repeat(43)
test('range reference enforces safe integers, byte ceilings and no path or encoding fallback', () => {
  assert.deepEqual(parseReferenceRange({ grantId: file, offset: 0, length: 0 }), { grantId: file, relativePath: '', offset: 0, length: 0 })
  assert.equal(parseReferenceRange({ grantId: file, offset: 4_294_967_297, length: 16 * 1024 * 1024 }).offset, 4_294_967_297)
  assert.equal(parseReferenceRange({ grantId: file, offset: Number.MAX_SAFE_INTEGER, length: 0 }).length, 0)
  for (const offset of [-1, 0.5, NaN, Infinity, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseReferenceRange({ grantId: file, offset, length: 1 }))
  for (const length of [-1, 0.5, NaN, Infinity, '1', null, undefined, 16 * 1024 * 1024 + 1]) assert.throws(() => parseReferenceRange({ grantId: file, offset: 0, length }))
  assert.throws(() => parseReferenceRange({ grantId: file, offset: Number.MAX_SAFE_INTEGER, length: 1 }))
  for (const extra of [{ path: '/secret' }, { encoding: 'utf8' }, { owner: 42 }, { relativePath: '../secret' }]) assert.throws(() => parseReferenceRange({ grantId: file, offset: 0, length: 1, ...extra }))
})
test('reference contract requires opaque IDs and explicitly defaults to no overwrite', () => {
  assert.deepEqual(parseReferenceRead({ grantId: file }), { grantId: file, relativePath: '', encoding: 'utf8' })
  assert.deepEqual(parseReferenceWrite({ saveGrantId: save, content: '' }), { saveGrantId: save, content: '', encoding: 'utf8', replace: false })
  assert.deepEqual(parseReferenceCopy({ fileGrantId: file, saveGrantId: save }), { fileGrantId: file, saveGrantId: save, replace: false })
  assert.equal(parseReferenceMove({ directoryGrantId: directory, relativePath: 'input.txt', saveGrantId: save, replace: true }).replace, true)
  assert.equal(parseReferenceRemove({ directoryGrantId: directory, relativePath: 'input.txt', isDirectory: false }).isDirectory, false)
})
test('legacy paths, caller identity and forged rights cannot cross the reference contract', () => {
  for (const value of ['E:\\user\\file', '/private/file', 'ztools://file/token/name', '', file + 'x', { grantId: file }]) assert.throws(() => grantId(value))
  for (const extra of [{ path: '/private/file' }, { sourcePath: '/private/source' }, { owner: 99 }, { operations: ['write'] }, { kind: 'save' }, { displayName: 'foreign' }]) {
    assert.throws(() => parseReferenceRead({ grantId: file, ...extra }), { code: 'INVALID_REQUEST' })
    assert.throws(() => parseReferenceWrite({ saveGrantId: save, content: 'data', ...extra }), { code: 'INVALID_REQUEST' })
  }
  assert.throws(() => parseReferenceCopy({ sourcePath: '/source', destPath: '/target' }))
  assert.throws(() => parseReferenceRead(Object.assign(Object.create({ inherited: true }) as object, { grantId: file })))
})
test('all directory mutations reject empty roots, traversal, repeated separators, null bytes and deep paths', () => {
  for (const relativePath of ['', '/child', '..', 'a/../b', 'a//b', 'a\0b', '.ztools-save-secret', 'nested/.ZTOOLS-SAVE-secret', 'x/'.repeat(65) + 'file']) {
    assert.throws(() => parseReferenceDirectory({ directoryGrantId: directory, relativePath }))
    assert.throws(() => parseReferenceRemove({ directoryGrantId: directory, relativePath, isDirectory: true }))
    assert.throws(() => parseReferenceMove({ directoryGrantId: directory, relativePath, saveGrantId: save }))
  }
  assert.equal(parseReferenceDirectory({ directoryGrantId: directory }, true).relativePath, '')
  assert.equal(parseReferenceDirectory({ directoryGrantId: directory, relativePath: '目录/冒号:反斜线\\换行\n.txt' }).relativePath, '目录/冒号:反斜线\\换行\n.txt')
})
test('byte limits, encoding and booleans are strict and malformed inputs are not echoed', () => {
  for (const encoding of ['ascii', null, 1]) assert.throws(() => parseReferenceRead({ grantId: file, encoding }))
  for (const replace of ['true', 1, null]) assert.throws(() => parseReferenceWrite({ saveGrantId: save, content: 'x', replace }))
  assert.throws(() => parseReferenceDirectory({ directoryGrantId: directory, relativePath: '字'.repeat(1400) }))
  assert.throws(() => parseReferenceWrite({ saveGrantId: save, content: Buffer.from('binary') }))
  try { parseReferenceRead({ grantId: '/secret/example' }) } catch (error) { assert.ok(!(error as Error).message.includes('/secret/example')) }
})
