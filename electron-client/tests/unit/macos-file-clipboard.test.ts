import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { MacosFileClipboardAdapter, clipboardBridgeFailure, macClipboardExecutable } from '../../src/main/platform/macos/file-clipboard.js'

const hasCode = (code: string) => (error: unknown) => error instanceof ZToolsError && error.code === code

test('Mac clipboard uses bounded versioned stdin and preserves Unicode/space paths', async () => {
  const calls: unknown[] = []
  const paths = ['/tmp/空 格%#é.txt', '/tmp/e\u0301.txt']
  const adapter = new MacosFileClipboardAdapter('/bundle/native/ZToolsMacClipboard', async (exe, payload) => {
    const value = JSON.parse(payload)
    calls.push([exe, value])
    return JSON.stringify({ version: 1, success: true, ...(value.mode === 'read' ? { paths } : {}) })
  }, 'darwin')
  assert.deepEqual(await adapter.readFiles(), paths)
  await adapter.writeFiles(paths)
  assert.deepEqual(calls, [
    ['/bundle/native/ZToolsMacClipboard', { version: 1, mode: 'read' }],
    ['/bundle/native/ZToolsMacClipboard', { version: 1, mode: 'write', paths }]
  ])
})

test('invalid/remote/NUL/oversized paths never invoke native clipboard writes', async () => {
  let calls = 0
  const adapter = new MacosFileClipboardAdapter('/helper', async () => { calls++; return '' }, 'darwin')
  for (const paths of [[], ['relative'], ['file:///tmp/x'], ['//server/x'], ['/tmp/\0x'], ['/'.repeat(4097)], Array(1025).fill('/x'), Array(1024).fill('/' + 'x'.repeat(200))]) {
    await assert.rejects(adapter.writeFiles(paths), hasCode(errorCodes.invalidRequest))
  }
  assert.equal(calls, 0)
})

test('native output is untrusted and bounded; empty read list is valid', async () => {
  for (const output of ['invalid', 'null', '{"version":2,"success":true}', '{"version":1,"success":false}', '{"version":1,"success":true,"paths":["https://server"]}']) {
    const adapter = new MacosFileClipboardAdapter('/helper', async () => output, 'darwin')
    await assert.rejects(adapter.readFiles(), hasCode(errorCodes.clipboardError))
  }
  const oversized = new MacosFileClipboardAdapter('/helper', async () => 'x'.repeat(128 * 1024 + 1), 'darwin')
  await assert.rejects(oversized.readFiles(), hasCode(errorCodes.responseTooLarge))
  const empty = new MacosFileClipboardAdapter('/helper', async () => '{"version":1,"success":true,"paths":[]}', 'darwin')
  assert.deepEqual(await empty.readFiles(), [])
})

test('platform gate and pre/mid-operation cancellation reject without leaked data', async () => {
  let calls = 0
  const abort = new AbortController()
  const adapter = new MacosFileClipboardAdapter('/helper', async () => { calls++; abort.abort(); return '{"version":1,"success":true,"paths":[]}' }, 'darwin')
  await assert.rejects(adapter.readFiles(abort.signal), hasCode(errorCodes.callerDestroyed))
  await assert.rejects(adapter.readFiles(abort.signal), hasCode(errorCodes.callerDestroyed))
  assert.equal(calls, 1)
  const windows = new MacosFileClipboardAdapter('/helper', async () => { throw new Error('must not run') }, 'win32')
  await assert.rejects(windows.readFiles(), hasCode(errorCodes.notSupported))
  assert.equal(windows.isAvailable(), false)
})

test('native failures preserve stable codes and redact stderr/executable/file paths', () => {
  for (const [error, code] of [
    [{ code: 'ABORT_ERR' }, errorCodes.callerDestroyed],
    [{ code: 'ENOENT' }, errorCodes.nativeHostUnavailable],
    [{ code: 'EACCES' }, errorCodes.nativeHostUnavailable],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, errorCodes.responseTooLarge],
    [{ killed: true }, errorCodes.requestTimeout],
    [new Error('private /Users/alice/vault.txt'), errorCodes.clipboardError]
  ] as const) {
    const result = clipboardBridgeFailure(error)
    assert.equal(result.code, code)
    assert.equal(result.message.includes('/Users'), false)
  }
  assert.equal(macClipboardExecutable(true, '/app/Resources'), path.join('/app/Resources', 'native', 'ZToolsMacClipboard'))
  assert.match(macClipboardExecutable(false, ''), /native[\\/]ZToolsMacClipboard$/)
})
