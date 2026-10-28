import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import { MacPasteSession } from '../../src/main/platform/macos/paste-session.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

type Request = { version: number; mode: string; id: number; token?: number }
class FakeHelper extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  requests: Request[] = []
  kills: string[] = []
  autoClose = true
  constructor(readonly respond: (request: Request, helper: FakeHelper) => void) {
    super()
    this.stdin.on('data', data => { const request = JSON.parse(String(data)); this.requests.push(request); this.respond(request, this) })
  }
  kill(signal: string): boolean {
    this.kills.push(signal)
    if (this.autoClose && this.kills.length === 1) queueMicrotask(() => this.emit('close', null, signal))
    return true
  }
  reply(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n') }
}
const activeSignal = () => new AbortController().signal
function setup(respond: FakeHelper['respond'], ready = true) {
  const helper = new FakeHelper(respond)
  const session = new MacPasteSession('/fixture/ZToolsMacClipboard', () => helper as unknown as ChildProcessWithoutNullStreams, 30)
  if (ready) helper.reply({ version: 1, ready: true })
  return { helper, session }
}
function normalReply(request: Request, helper: FakeHelper): void {
  helper.reply({ version: 1, id: request.id, success: true, state: request.mode === 'prepare' ? 'prepared' : 'dispatched' })
}
const hostCode = (code: string) => (error: unknown) => error instanceof ZToolsError && error.details?.hostCode === code

test('目标许可绑定 prepare 请求，发送只带一次许可而不包含文本或进程路径', async () => {
  const { helper, session } = setup(normalReply)
  try {
    const token = await session.prepare(activeSignal())
    await session.paste(token, activeSignal())
    assert.deepEqual(helper.requests, [
      { version: 1, id: 1, mode: 'prepare' }, { version: 1, id: 2, mode: 'paste', token: 1 }
    ])
  } finally { await session.stop() }
  assert.deepEqual(helper.kills, ['SIGKILL'])
})

test('目标切换、权限拒绝、未知焦点与原生发送失败不变成成功，也不重试', async () => {
  for (const code of ['PASTE_TARGET_CHANGED', 'PASTE_TARGET_UNAVAILABLE', 'ACCESSIBILITY_PERMISSION_DENIED', 'PASTE_EVENT_FAILED',
    'PASTE_HOST_NOT_ACTIVE', 'PASTE_TARGET_APP_UNAVAILABLE', 'PASTE_TARGET_WINDOW_UNAVAILABLE',
    'PASTE_TARGET_ELEMENT_UNAVAILABLE', 'PASTE_FOCUS_OBSERVER_UNAVAILABLE', 'PASTE_EVENT_PERMISSION_DENIED']) {
    const { helper, session } = setup((request, peer) => peer.reply({ version: 1, id: request.id, success: false, error: code }))
    try {
      await assert.rejects(session.prepare(activeSignal()), hostCode(code))
      assert.equal(helper.requests.length, 1)
      assert.equal(helper.kills.length, 0)
    } finally { await session.stop() }
  }
})

test('错误代次、伪成功、重复回执、无效JSON和超长输出会关闭会话', async () => {
  for (const respond of [
    (request: Request, peer: FakeHelper) => peer.reply({ version: 1, id: request.id + 1, success: true, state: 'prepared' }),
    (request: Request, peer: FakeHelper) => peer.reply({ version: 1, id: request.id, success: true, state: 'pasted' }),
    (request: Request, peer: FakeHelper) => { normalReply(request, peer); normalReply(request, peer) },
    (_request: Request, peer: FakeHelper) => peer.stdout.write('not-json\n'),
    (_request: Request, peer: FakeHelper) => peer.stdout.write('x'.repeat(4097))
  ]) {
    const { session, helper } = setup(respond)
    await assert.rejects(session.prepare(activeSignal()), hostCode('PASTE_PROTOCOL_ERROR'))
    await session.stop()
    assert.deepEqual(helper.kills, ['SIGKILL'])
  }
})

test('取消准备中的请求终止进程，迟到成功不会触发后续发送', async () => {
  const { helper, session } = setup(() => {})
  const abort = new AbortController()
  const pending = session.prepare(abort.signal)
  await Promise.resolve()
  abort.abort()
  await assert.rejects(pending, { code: errorCodes.callerDestroyed })
  normalReply(helper.requests[0]!, helper)
  await assert.rejects(session.paste(1, activeSignal()), { code: errorCodes.callerDestroyed })
  await session.stop()
  assert.equal(helper.requests.length, 1)
})

test('原生超时、启动失败和停止均拒绝等待者并回收进程', async () => {
  const timed = setup(() => {})
  await assert.rejects(timed.session.prepare(activeSignal()), hostCode('PASTE_HELPER_TIMEOUT'))
  await timed.session.stop()
  const startup = setup(normalReply, false)
  const pending = startup.session.prepare(activeSignal())
  startup.helper.emit('error', new Error('private helper path'))
  await assert.rejects(pending, hostCode('PASTE_HELPER_UNAVAILABLE'))
  await startup.session.stop()
  assert.equal(startup.helper.requests.length, 0)
  const stopped = setup(() => {})
  const waiting = stopped.session.prepare(activeSignal())
  const rejection = assert.rejects(waiting, { code: errorCodes.callerDestroyed })
  await stopped.session.stop(); await rejection
})

test('发送中取消会终止会话；预取消、非法许可与并发请求不写入管道', async () => {
  const { session, helper } = setup((request, peer) => { if (request.mode === 'prepare') normalReply(request, peer) })
  const abort = new AbortController()
  try {
    const token = await session.prepare(activeSignal())
    await assert.rejects(session.paste(0, activeSignal()), hostCode('PASTE_TARGET_UNAVAILABLE'))
    const pending = session.paste(token, abort.signal)
    await Promise.resolve()
    await assert.rejects(session.prepare(activeSignal()), { code: errorCodes.clipboardError })
    abort.abort()
    await assert.rejects(pending, hostCode('PASTE_RESULT_UNCONFIRMED'))
    await assert.rejects(session.prepare(abort.signal), { code: errorCodes.callerDestroyed })
    assert.equal(helper.requests.length, 2)
  } finally { await session.stop() }
})

test('取消后必须等子进程真正关闭才释放调用方，不能仅凭kill返回结算', async () => {
  const { helper, session } = setup(() => {})
  helper.autoClose = false
  const abort = new AbortController()
  let settled = false
  const pending = session.prepare(abort.signal).finally(() => { settled = true })
  const rejection = assert.rejects(pending, { code: errorCodes.callerDestroyed })
  await Promise.resolve(); abort.abort(); await Promise.resolve(); await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(helper.kills, ['SIGKILL'])
  helper.emit('close', null, 'SIGKILL')
  await rejection; await session.stop()
  assert.equal(settled, true)
})

test('paste畸形回执、未知失败与合法回执后同轮取消都只能报告结果未确认', async () => {
  for (const kind of ['invalid-state', 'unknown-error', 'abort-after-dispatch']) {
    const abort = new AbortController()
    const { session, helper } = setup((request, peer) => {
      if (request.mode === 'prepare') return normalReply(request, peer)
      if (kind === 'invalid-state') peer.reply({ version: 1, id: request.id, success: true, state: 'pasted' })
      if (kind === 'unknown-error') peer.reply({ version: 1, id: request.id, success: false, error: 'UNKNOWN_AFTER_SEND' })
      if (kind === 'abort-after-dispatch') { normalReply(request, peer); abort.abort() }
    })
    const token = await session.prepare(activeSignal())
    await assert.rejects(session.paste(token, abort.signal), hostCode('PASTE_RESULT_UNCONFIRMED'))
    await session.stop(); assert.deepEqual(helper.kills, ['SIGKILL'])
  }
})
