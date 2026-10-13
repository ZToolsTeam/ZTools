import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const fullSource = fs.readFileSync('src/preload/main.ts', 'utf8')
const source = fullSource.slice(fullSource.indexOf('const regionToken ='), fullSource.indexOf('// Old plugin packages'))
// Compile just the exact maintained private branch; no arbitrary Electron IPC surface is added.
import ts from 'typescript'
function fixture(argv: string[]) {
  const exposed: Record<string, { submit(value: unknown): void; cancel(): void }> = {}, sent: unknown[][] = []
  const code = ts.transpile(source, { target: ts.ScriptTarget.ES2022 })
  vm.runInNewContext(code, { process: { argv }, contextBridge: { exposeInMainWorld: (name: string, value: typeof exposed[string]) => { exposed[name] = value } }, ipcRenderer: { send: (...args: unknown[]) => { sent.push(args) } } })
  return { exposed, sent }
}
test('private region bridge exists only for a Main supplied well-formed selector token', () => {
  for (const args of [[], ['--ztools-region-selection=bad'], ['--ztools-region-selection=']]) assert.deepEqual(Object.keys(fixture(args).exposed), [])
})
test('private selector exposes only bounded submit/cancel methods and injects its own token', () => {
  const nonce = '12345678-abcd-1234-abcd-123456789abc', f = fixture(['--ztools-region-selection=' + nonce]), api = f.exposed.__ztoolsRegionSelection!
  assert.deepEqual(Object.keys(api), ['submit', 'cancel']); assert.ok(Object.isFrozen(api))
  for (const value of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: Infinity, height: 10 }, { x: 0, y: 0, width: 10, height: 10, nonce: 'foreign' }, '/private', null]) api.submit(value)
  assert.equal(f.sent.length, 0)
  api.submit({ x: 1, y: 2, width: 10, height: 20 }); api.cancel()
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent)), [['ztools:region-selection', { nonce, rect: { x: 1, y: 2, width: 10, height: 20 } }], ['ztools:region-selection', { nonce, cancel: true }]])
})
