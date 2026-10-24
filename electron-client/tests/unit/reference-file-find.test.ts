import assert from 'node:assert/strict'
import test from 'node:test'
import { parseReferenceFind } from '../../src/contracts/path-find.js'
import { referenceNameMatcher } from '../../src/main/services/reference-name-matcher.js'
import { AnchoredFileSystemService } from '../../src/main/services/anchored-file-system-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'

const id = 'a'.repeat(43), caller = { type: 'main' as const, webContentsId: 42 }

test('reference find rejects raw authority and unbounded patterns while preserving literal POSIX name bytes', () => {
  const valid = { directoryGrantId: id, pattern: 'literal:back\\slash\n?.txt' }
  assert.equal(parseReferenceFind(valid).pattern, valid.pattern); assert.equal(parseReferenceFind(valid).caseSensitive, true)
  for (const value of [{ ...valid, path: '/private/raw' }, { ...valid, owner: 99 }, { ...valid, caseSensitive: 1 },
    { ...valid, pattern: '../*' }, { ...valid, pattern: '\0' }, { ...valid, pattern: '' },
    { ...valid, pattern: 'x'.repeat(129) }, { ...valid, pattern: '中'.repeat(86) }, { ...valid, relativePath: '../outside' }]) {
    assert.throws(() => parseReferenceFind(value), { code: 'INVALID_REQUEST' })
  }
})

test('wildcards match Unicode code points and literal regex characters, with a shared finite work budget', () => {
  assert.equal(referenceNameMatcher('?.txt', true)('😀.txt'), true)
  assert.equal(referenceNameMatcher('[a]+.txt', true)('[a]+.txt'), true)
  assert.equal(referenceNameMatcher('*.txt', true)('UPPER.TXT'), false)
  assert.equal(referenceNameMatcher('*.txt', false)('UPPER.TXT'), true)
  assert.equal(referenceNameMatcher('*a*b', true)('aaaab'), true)
  assert.equal(referenceNameMatcher('*a*b', true)('aaaa'), false)
  const bounded = referenceNameMatcher('*', true), name = 'x'.repeat(4096)
  assert.throws(() => { for (let index = 0; index < 5000; index++) bounded(name) }, { code: 'FILE_TOO_LARGE' })
})

test('find uses anchored single-level enumeration and preserves relative metadata without opening new paths', async () => {
  let enumerations = 0, revalidations = 0
  const rows = [{ name: 'a.txt', isDirectory: false, size: 3 }, { name: 'B.TXT', isDirectory: false, size: 5 },
    { name: 'folder.txt', isDirectory: true, size: 0 }, { name: 'literal:back\\slash\n.txt', isDirectory: false, size: 1 }]
  const grants = { list: async (owner: number, token: string, relative: string) => {
    assert.equal(owner, 42); assert.equal(token, id); assert.equal(relative, 'nested'); enumerations++; return rows
  }, reference: () => { revalidations++; return {} } } as unknown as PathGrantService
  const files = new AnchoredFileSystemService(grants)
  const params = { directoryGrantId: id, relativePath: 'nested', pattern: '*.txt' }
  assert.deepEqual((await files.find(params, caller, false)).files.map(file => file.name), ['a.txt', 'literal:back\\slash\n.txt'])
  assert.deepEqual((await files.find({ ...params, caseSensitive: false }, caller, true)).files, [rows[2]])
  assert.equal(enumerations, 2); assert.equal(revalidations, 2)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(files.find(params, caller, false, cancelled.signal), { code: 'CALLER_DESTROYED' }); assert.equal(enumerations, 2)
})

test('owner expiration during matching cannot deliver a stale enumeration', async () => {
  const files = new AnchoredFileSystemService({ list: async () => [{ name: 'a', isDirectory: false, size: 0 }],
    reference: () => { const error = new Error('owner expired') as Error & { code: string }; error.code = 'PERMISSION_DENIED'; throw error }
  } as unknown as PathGrantService)
  await assert.rejects(files.find({ directoryGrantId: id, pattern: '*' }, caller, false), { code: 'PERMISSION_DENIED' })
})
