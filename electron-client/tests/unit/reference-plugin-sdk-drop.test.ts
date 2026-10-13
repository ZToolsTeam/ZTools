import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

interface PluginSDK { onFileDrop(callback: (files: unknown, errors: unknown) => void): () => void }
const source = fs.readFileSync(path.resolve('../frontend/src/sdk/plugin-sdk.js'), 'utf8')
const file = { grantId: 'a'.repeat(43), displayName: 'literal:back\\slash\n.txt', kind: 'file', operations: ['read'],
  fileUrl: 'ztools://file/' + 'a'.repeat(43) + '/' + encodeURIComponent('literal:back\\slash\n.txt') }
function fixture(version = 2) {
  const documentHandlers = new Map<string, () => void>(), eventHandlers = new Map<string, (value: unknown) => void>()
  const errors: unknown[] = []
  const window = { location: { href: 'ztools://plugins/example/index.html' }, __ztoolsElectron: { contractVersion: version },
    ztools: { events: { on: (name: string, callback: (value: unknown) => void) => eventHandlers.set(name, callback),
      off: () => { throw new Error('foreign event handler removal') } } }, ztoolsPlugin: undefined as unknown as PluginSDK }
  vm.runInNewContext(source, { window, document: { readyState: 'loading', documentElement: { classList: { toggle() {} } },
    addEventListener: (name: string, callback: () => void) => documentHandlers.set(name, callback) },
    TextEncoder, console: { log() {}, error: (...values: unknown[]) => errors.push(values) }, setTimeout, clearTimeout })
  documentHandlers.get('DOMContentLoaded')!()
  return { sdk: window.ztoolsPlugin, errors, emit: (value: unknown) => eventHandlers.get('plugin_files_dropped')!(value) }
}

test('plugin SDK2 dispatches frozen native FileRefs/errors and unsubscribes only each owned registration', () => {
  const f = fixture(), calls: { files: unknown; errors: unknown }[] = []
  const handler = (files: unknown, errors: unknown) => { calls.push({ files, errors }) }
  const first = f.sdk.onFileDrop(handler), second = f.sdk.onFileDrop(handler)
  f.emit({ payload: { contractVersion: 2, files: [file], errors: [{ index: 1, code: 'FILE_ERROR', message: 'synthetic failure' }] } })
  assert.equal(calls.length, 2); assert.deepEqual(JSON.parse(JSON.stringify(calls[0]!.files)), [file])
  const files = calls[0]!.files as typeof file[]
  assert.ok(Object.isFrozen(files)); assert.ok(Object.isFrozen(files[0])); assert.ok(Object.isFrozen(files[0]!.operations))
  assert.ok(Object.isFrozen(calls[0]!.errors))
  first(); first(); f.emit({ data: { contractVersion: 2, files: [], errors: [] } }); assert.equal(calls.length, 3)
  second(); f.emit({ payload: { contractVersion: 2, files: [file], errors: [] } }); assert.equal(calls.length, 3)
  assert.equal(f.errors.length, 0)
})

test('plugin SDK2 rejects legacy paths, forged references and unbounded/native fields before dispatch', () => {
  const f = fixture(); let calls = 0
  f.sdk.onFileDrop(() => { calls++ })
  for (const data of [{ files: ['E:/private/raw'] }, { contractVersion: 2, files: ['E:/private/raw'], errors: [] },
    { contractVersion: 2, files: [{ ...file, path: '/private' }], errors: [] },
    { contractVersion: 2, files: [{ ...file, operations: ['read', 'write'] }], errors: [] },
    { contractVersion: 2, files: [{ ...file, fileUrl: 'file:///private' }], errors: [] },
    { contractVersion: 2, files: [file, file], errors: [] },
    { contractVersion: 2, files: Array(101).fill(file), errors: [] },
    { contractVersion: 2, files: [], errors: [{ index: 100, code: 'FILE_ERROR', message: 'out of range' }] },
    { contractVersion: 2, files: [], errors: [], owner: 99 }]) f.emit({ payload: data })
  assert.equal(calls, 0); assert.equal(f.errors.length, 9)
})

test('plugin SDK1 cannot consume a reference-contract event and SDK2 dispatch skips removed subscriptions', () => {
  const old = fixture(1); let oldCalls = 0
  old.sdk.onFileDrop(() => { oldCalls++ })
  old.emit({ payload: { contractVersion: 2, files: [file], errors: [] } }); assert.equal(oldCalls, 0)
  const f = fixture(); let laterCalls = 0, remove = () => {}
  f.sdk.onFileDrop(() => remove()); remove = f.sdk.onFileDrop(() => { laterCalls++ })
  f.emit({ payload: { contractVersion: 2, files: [file], errors: [] } }); assert.equal(laterCalls, 0)
})


test('plugin SDK2 bounds drop subscriptions and released registrations restore admission', () => {
  const f = fixture(), remove: (() => void)[] = []
  for (let index = 0; index < 256; index++) remove.push(f.sdk.onFileDrop(() => {}))
  assert.throws(() => f.sdk.onFileDrop(() => {}), { code: 'FILE_TOO_LARGE' })
  remove[0]!(); const restored = f.sdk.onFileDrop(() => {}); restored()
  for (const cleanup of remove) cleanup()
  const later = f.sdk.onFileDrop(() => {}); later()
})
