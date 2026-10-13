import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { NativePathAccessAdapter } from '../../src/main/platform/native-path-access.js'
import { PathWriteJournal } from '../../src/main/platform/path-write-journal.js'
import { createHash } from 'node:crypto'

function fixture({ hello = true, platform = 'win32', arch = 'x64', journal }: { hello?: boolean; platform?: NodeJS.Platform; arch?: string; journal?: PathWriteJournal } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const signals: string[] = [], calls: { exe: string; args: readonly string[] }[] = [], requests: Buffer[] = []
  let handler = (frame: Buffer) => {
    const result = frame[4] === 1 ? Buffer.from([1, 0, 0, 0]) : frame[4] === 2 ? Buffer.from('fixture') : Buffer.alloc(0)
    reply(frame.readUInt32LE(), result)
  }
  function reply(id: number, content: Buffer, success = true) {
    const data = Buffer.alloc(9 + content.length); data.writeUInt32LE(5 + content.length); data.writeUInt32LE(id, 4); data[8] = success ? 1 : 0; content.copy(data, 9)
    // Deliberately split both header and body, like real pipe delivery.
    child.stdout.write(data.subarray(0, 1)); child.stdout.write(data.subarray(1, 6)); child.stdout.write(data.subarray(6))
  }
  child.stdin.on('data', (data: Buffer) => { const frame = Buffer.from(data.subarray(4)); requests.push(frame); handler(frame) })
  Object.assign(child, { kill: (signal: string) => { signals.push(signal); child.emit('exit', null, signal); return true } })
  const injectedSpawn = ((exe: string, args: readonly string[], options: { shell: boolean; windowsHide: boolean }) => {
    calls.push({ exe, args }); assert.equal(options.shell, false); assert.equal(options.windowsHide, true)
    if (hello) queueMicrotask(() => { child.stdout.write('Z'); child.stdout.write('PA1') })
    return child
  }) as unknown as typeof spawn
  const adapter = new NativePathAccessAdapter(process.execPath, 100, { spawn: injectedSpawn, platform, processArch: arch, ...(journal ? { writeJournal: journal } : {}) })
  return { adapter, signals, calls, requests, child, setHandler: (next: typeof handler) => { handler = next }, reply }
}

test('native selection pins and classifies one object and preserves Mac literal display names', async () => {
  for (const kind of [0, 1]) {
    const f = fixture({ platform: 'darwin', arch: 'arm64' }), signal = new AbortController().signal
    const selected = '/private/colon:back\\slash\n.txt'
    f.setHandler(frame => f.reply(frame.readUInt32LE(), frame[4] === 21 ? Buffer.from([1, 0, 0, 0, kind]) : Buffer.alloc(0)))
    const object = await f.adapter.pinSelected(selected, signal)
    assert.equal(object.kind, kind === 1 ? 'directory' : 'file'); assert.equal(object.displayName, 'colon:back\\slash\n.txt')
    assert.equal(f.requests[0]![4], 21); assert.equal(f.requests[0]!.subarray(9).toString(), selected)
    await f.adapter.release(object); await f.adapter.stop()
  }
})

for (const stream of [false, true]) for (const valid of [true, false]) test(`postcommit native ${stream ? 'stream' : 'save'} ACK validation survives cancellation only with exact count: ${valid}`, async () => {
  const f = fixture(), controller = new AbortController()
  const target = await f.adapter.pin('C:/private/output.txt', 'save', ['write'], controller.signal)
  f.setHandler(frame => {
    if (stream && frame[4] === 13) { f.reply(frame.readUInt32LE(), Buffer.from([2, 0, 0, 0])); return }
    if (stream && frame[4] === 14) { f.reply(frame.readUInt32LE(), Buffer.from([3, 0, 0, 0])); return }
    assert.equal(frame[4], stream ? 15 : 6)
    const ack = Buffer.alloc(5); ack[0] = 1; ack.writeUInt32LE(valid ? 3 : 2, 1)
    f.reply(frame.readUInt32LE(), ack)
    controller.abort()
  })
  async function* chunks() { yield Buffer.from('abc') }
  const saving = stream ? f.adapter.streamSave(target, 3, chunks(), false, controller.signal)
    : f.adapter.save(target, Buffer.from('abc'), false, controller.signal)
  if (valid) assert.deepEqual(await saving, { status: 'committed', bytesWritten: 3 })
  else await assert.rejects(saving, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(f.requests.filter(frame => frame[4] === (stream ? 15 : 6)).length, 1)
  await f.adapter.stop()
})

test('only a confirmed save can re-pin its exact target as a file object', async () => {
  const f = fixture(), signal = new AbortController().signal, targetPath = 'C:\\private\\committed.txt'
  const target = await f.adapter.pin(targetPath, 'save', ['write'], signal)
  const requestsBeforeAttempt = f.requests.length
  await assert.rejects(f.adapter.pinCommittedSave(target, signal), { code: 'FILE_ERROR' })
  assert.equal(f.requests.length, requestsBeforeAttempt)

  f.setHandler(frame => {
    if (frame[4] === 6) {
      assert.equal(frame.readUInt32LE(5), 1); assert.equal(frame[9], 0)
      const receipt = Buffer.alloc(5); receipt[0] = 1; receipt.writeUInt32LE(3, 1); f.reply(frame.readUInt32LE(), receipt); return
    }
    assert.equal(frame[4], 1); assert.equal(frame[5], 0)
    assert.equal(frame.readUInt32LE(6), Buffer.byteLength(targetPath)); assert.equal(frame.subarray(10).toString(), targetPath)
    const handle = Buffer.alloc(4); handle.writeUInt32LE(2); f.reply(frame.readUInt32LE(), handle)
  })
  assert.deepEqual(await f.adapter.save(target, Buffer.from('abc'), false, signal), { status: 'committed', bytesWritten: 3 })
  const artifact = await f.adapter.pinCommittedSave(target, signal)
  assert.equal(artifact.kind, 'file'); assert.equal(artifact.displayName, target.displayName)
  assert.deepEqual(f.requests.map(frame => frame[4]), [1, 6, 1])
  await f.adapter.stop()
})

test('ordinary Mac pin uses target POSIX name semantics and rejects Windows absolute selections before native dispatch', async () => {
  const f = fixture({ platform: 'darwin', arch: 'arm64' }), signal = new AbortController().signal
  await assert.rejects(f.adapter.pin('C:/unexpected/file', 'file', ['read'], signal), { code: 'FILE_ERROR' })
  await assert.rejects(f.adapter.pinSelected('C:/unexpected/file', signal), { code: 'FILE_ERROR' })
  assert.equal(f.calls.length, 0)
  const object = await f.adapter.pin('/private/colon:back\\slash\n.txt', 'file', ['read'], signal)
  assert.equal(object.displayName, 'colon:back\\slash\n.txt')
  await f.adapter.release(object); await f.adapter.stop()
})

test('malformed native selection responses invalidate the owned broker rather than guessing a path kind', async () => {
  for (const bytes of [Buffer.from([0, 0, 0, 0, 0]), Buffer.from([1, 0, 0, 0, 2]), Buffer.alloc(4)]) {
    const f = fixture(); f.setHandler(frame => f.reply(frame.readUInt32LE(), bytes))
    await assert.rejects(f.adapter.pinSelected(process.execPath, new AbortController().signal), { code: 'FILE_ERROR' })
    assert.deepEqual(f.signals, ['SIGKILL']); await f.adapter.stop()
  }
})

test('journal intents and receipts persist before native data/commit; completion removes only its own record', async () => {
  const events: string[] = []
  const journal = new PathWriteJournal({ read: async () => undefined,
    replace: async bytes => { const data = JSON.parse(bytes.toString()) as { records: { phase: string }[] }; events.push(`persist:${data.records[0]?.phase ?? 'empty'}`) } },
    { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() })
  const f = fixture({ journal }), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => {
    const op = frame[4]!, id = frame.readUInt32LE()
    if (op === 13) { events.push('begin'); f.reply(id, Buffer.from([1, 0, 0, 0])) }
    else if (op === 18) { events.push('proof'); f.reply(id, Buffer.from('ZPW1\x01\x01synthetic', 'binary')) }
    else if (op === 14) { events.push('append'); f.reply(id, Buffer.from([3, 0, 0, 0])) }
    else if (op === 15) { events.push('commit'); f.reply(id, Buffer.from([1, 3, 0, 0, 0])) }
    else f.reply(id, Buffer.alloc(0))
  })
  assert.deepEqual(await f.adapter.save(object, Buffer.from('sdk'), false, signal), { status: 'committed', bytesWritten: 3 })
  assert.deepEqual(events, ['persist:intent', 'begin', 'proof', 'persist:staging', 'append', 'persist:committing', 'commit', 'persist:empty'])
  assert.deepEqual(await journal.pending(), []); await f.adapter.stop()
})

test('staging journal failure aborts before data; valid commit ACK survives journal cleanup failure', async () => {
  for (const failurePhase of ['staging', 'empty']) {
    let lastDurable: { records: { phase: string }[] } | undefined
    const journal = new PathWriteJournal({ read: async () => undefined,
      replace: async bytes => { const data = JSON.parse(bytes.toString()) as { records: { phase: string }[] }
        if ((data.records[0]?.phase ?? 'empty') === failurePhase) throw new Error('storage unavailable')
        lastDurable = data } },
      { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() })
    const f = fixture({ journal }), signal = new AbortController().signal
    const object = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
    f.setHandler(frame => {
      const op = frame[4]!, id = frame.readUInt32LE()
      if (op === 13) f.reply(id, Buffer.from([1, 0, 0, 0]))
      else if (op === 18) f.reply(id, Buffer.from('ZPW1\x01\x01synthetic', 'binary'))
      else if (op === 14) f.reply(id, Buffer.from([3, 0, 0, 0]))
      else if (op === 15) f.reply(id, Buffer.from([1, 3, 0, 0, 0]))
      else f.reply(id, Buffer.alloc(0))
    })
    if (failurePhase === 'empty') {
      assert.deepEqual(await f.adapter.save(object, Buffer.from('sdk'), false, signal), {
        status: 'committed', bytesWritten: 3, cleanupIssues: [{ stage: 'release', code: 'FILE_ERROR' }]
      })
      assert.equal(lastDurable?.records[0]?.phase, 'committing', 'failed cleanup does not erase durable pending evidence')
    } else await assert.rejects(f.adapter.save(object, Buffer.from('sdk'), false, signal), { code: 'FILE_ERROR' })
    assert.deepEqual(f.requests.map(frame => frame[4]), failurePhase === 'staging' ? [1, 13, 18, 16] : [1, 13, 18, 14, 15])
    await f.adapter.stop()
  }
})

test('journal hash describes the private transmitted bytes even when producer memory changes during ACK', async () => {
  let committingHash: string | undefined
  const journal = new PathWriteJournal({ read: async () => undefined,
    replace: async bytes => { const data = JSON.parse(bytes.toString()) as { records: { phase: string; sha256?: string }[] }
      if (data.records[0]?.phase === 'committing') committingHash = data.records[0].sha256 } },
    { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() })
  const f = fixture({ journal }), signal = new AbortController().signal, producerBuffer = Buffer.from('sdk')
  const object = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => {
    const op = frame[4]!, id = frame.readUInt32LE()
    if (op === 13) f.reply(id, Buffer.from([1, 0, 0, 0]))
    else if (op === 18) f.reply(id, Buffer.from('ZPW1\x01\x01synthetic', 'binary'))
    else if (op === 14) { assert.equal(frame.subarray(13).toString(), 'sdk'); producerBuffer.write('new'); f.reply(id, Buffer.from([3, 0, 0, 0])) }
    else if (op === 15) f.reply(id, Buffer.from([1, 3, 0, 0, 0]))
    else f.reply(id, Buffer.alloc(0))
  })
  async function* chunks() { yield producerBuffer }
  await f.adapter.streamSave(object, 3, chunks(), false, signal)
  assert.equal(committingHash, createHash('sha256').update('sdk').digest('hex'))
  assert.equal(producerBuffer.toString(), 'new'); await f.adapter.stop()
})

test('fragmented native pipe round trip; Mac explicitly selects the requested slice and releases objects', async () => {
  for (const [arch, flag] of [['arm64', '-arm64'], ['x64', '-x86_64']] as const) {
    const f = fixture({ platform: 'darwin', arch }), signal = new AbortController().signal
    const object = await f.adapter.pin('/private/synthetic/input.txt', 'file', ['read'], signal)
    assert.deepEqual(f.calls[0], { exe: '/usr/bin/arch', args: [flag, process.execPath] })
    assert.equal((await f.adapter.read(object, [], 16, signal)).toString(), 'fixture')
    await f.adapter.release(object); await f.adapter.stop()
    assert.deepEqual(f.signals, ['SIGKILL'])
    assert.deepEqual(f.requests.map(frame => frame[4]), [1, 2, 3])
  }
})

test('cancelling an active native request kills only this broker and invalidates the entire generation', async () => {
  const f = fixture(), controller = new AbortController()
  const object = await f.adapter.pin(process.execPath, 'file', ['read'], controller.signal)
  f.setHandler(() => {})
  const reading = f.adapter.read(object, [], 16, controller.signal), rejected = assert.rejects(reading)
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected
  await f.adapter.release(object)
  await assert.rejects(f.adapter.read(object, [], 16, new AbortController().signal))
  assert.deepEqual(f.signals, ['SIGKILL']); assert.equal(f.requests.length, 2)
})

test('ordinary native denial leaves the broker usable; foreign handles and unsupported writes never dispatch', async () => {
  const f = fixture(), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'file', ['read'], signal)
  f.setHandler(frame => f.reply(frame.readUInt32LE(), Buffer.from([1]), false))
  await assert.rejects(f.adapter.read(object, [], 16, signal))
  f.setHandler(frame => f.reply(frame.readUInt32LE(), Buffer.from('fixture')))
  assert.equal((await f.adapter.read(object, [], 16, signal)).toString(), 'fixture')
  const count = f.requests.length
  await assert.rejects(f.adapter.release({ ...object, handle: 'foreign:1' }))
  await assert.rejects(f.adapter.pin(process.execPath, 'save', ['read'], signal))
  assert.equal(f.requests.length, count); await f.adapter.stop()
})

test('save protocol is write-only, immutable and explicitly reports interrupted commit uncertainty', async () => {
  const f = fixture(), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => {
    assert.equal(frame[4], 6); assert.equal(frame[9], 0); assert.equal(frame.subarray(14).toString(), 'fixture')
    const reply = Buffer.alloc(5); reply[0] = 1; reply.writeUInt32LE(7, 1); f.reply(frame.readUInt32LE(), reply)
  })
  assert.deepEqual(await f.adapter.save(object, Buffer.from('fixture'), false, signal), { status: 'committed', bytesWritten: 7 })
  f.setHandler(() => {})
  const controller = new AbortController(), pending = f.adapter.save(object, Buffer.from('next'), true, controller.signal)
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected; await f.adapter.stop()
})

test('malformed IDs, oversized frames and bad greeting fail closed without accepting any result', async () => {
  for (const mode of ['id', 'size', 'greeting']) {
    const f = fixture({ hello: mode !== 'greeting' })
    if (mode === 'greeting') queueMicrotask(() => f.child.stdout.write('BAD!'))
    else f.setHandler(frame => {
      if (mode === 'id') f.reply(frame.readUInt32LE() + 1, Buffer.from([1, 0, 0, 0]))
      else { const header = Buffer.alloc(4); header.writeUInt32LE(17 * 1024 * 1024); f.child.stdout.write(header) }
    })
    await assert.rejects(f.adapter.pin(process.execPath, 'file', ['read'], new AbortController().signal))
    await f.adapter.stop(); assert.deepEqual(f.signals, ['SIGKILL'])
  }
})

test('silent startup is bounded and repeated stop shares process-exit confirmation', async () => {
  const f = fixture({ hello: false })
  await assert.rejects(f.adapter.pin(process.execPath, 'file', ['read'], new AbortController().signal))
  const first = f.adapter.stop(); assert.equal(first, f.adapter.stop()); await first
  assert.deepEqual(f.signals, ['SIGKILL'])
})

test('native range request encodes 64-bit offsets, enforces bounds and refuses oversized responses', async () => {
  const f = fixture(), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'file', ['read'], signal)
  f.setHandler(frame => {
    assert.equal(frame[4], 5); assert.equal(frame.readBigUInt64LE(9), 4294967301n)
    assert.equal(frame.readUInt32LE(17), 3); f.reply(frame.readUInt32LE(), Buffer.from('abc'))
  })
  assert.equal((await f.adapter.readRange(object, [], 4294967301, 3, signal)).toString(), 'abc')
  const count = f.requests.length
  await assert.rejects(f.adapter.readRange(object, [], Number.MAX_SAFE_INTEGER, 1, signal))
  assert.equal(f.requests.length, count)
  f.setHandler(frame => f.reply(frame.readUInt32LE(), Buffer.from('too long')))
  await assert.rejects(f.adapter.readRange(object, [], 0, 1, signal))
  assert.deepEqual(f.signals, ['SIGKILL']); await f.adapter.stop()
})

test('private native request queue refuses excess calls and releases reservations after settlement', async () => {
  const f = fixture(), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'file', ['read'], signal)
  const pending = Array.from({ length: 64 }, () => f.adapter.read(object, [], 16, signal))
  await assert.rejects(f.adapter.read(object, [], 16, signal))
  await Promise.all(pending)
  assert.equal((await f.adapter.read(object, [], 16, signal)).toString(), 'fixture')
  await f.adapter.stop()
})

test('cancelling a queued request immediately invalidates the broker instead of waiting for its slot', async () => {
  const f = fixture(), signal = new AbortController().signal
  const object = await f.adapter.pin(process.execPath, 'file', ['read'], signal)
  f.setHandler(() => {})
  const first = f.adapter.read(object, [], 16, signal), firstRejected = assert.rejects(first)
  await new Promise(resolve => setImmediate(resolve))
  const controller = new AbortController(), second = f.adapter.read(object, [], 16, controller.signal)
  const secondRejected = assert.rejects(second)
  controller.abort(); assert.deepEqual(f.signals, ['SIGKILL'])
  await firstRejected; await secondRejected; await f.adapter.stop()
  assert.equal(f.requests.length, 2)
})

test('directory response decoder accepts relative Unicode metadata and rejects traversal/duplicates/unsafe sizes', async () => {
  const record = (name: string, size = 7n) => {
    const bytes = Buffer.from(name), output = Buffer.alloc(4 + bytes.length + 9)
    output.writeUInt32LE(bytes.length); bytes.copy(output, 4); output.writeBigUInt64LE(size, 5 + bytes.length)
    return output
  }
  for (const mode of ['valid', 'parent', 'duplicate', 'size', 'trailing']) {
    const f = fixture(), signal = new AbortController().signal
    const object = await f.adapter.pin(process.execPath, 'directory', ['list'], signal)
    f.setHandler(frame => {
      const count = Buffer.alloc(4); count.writeUInt32LE(mode === 'duplicate' ? 2 : 1)
      const value = record(mode === 'parent' ? '../outside' : '空 格.txt', mode === 'size' ? 9007199254740992n : 7n)
      f.reply(frame.readUInt32LE(), Buffer.concat([count, value, ...(mode === 'duplicate' ? [value] : mode === 'trailing' ? [Buffer.from([1])] : [])]))
    })
    if (mode === 'valid') assert.deepEqual(await f.adapter.list(object, [], signal), [{ name: '空 格.txt', size: 7, isDirectory: false }])
    else await assert.rejects(f.adapter.list(object, [], signal))
    await f.adapter.stop()
  }
})

test('Mac directory records preserve colon, backslash and newline in literal filenames', async () => {
  const f = fixture({ platform: 'darwin', arch: 'arm64' }), signal = new AbortController().signal
  const object = await f.adapter.pin('/private/synthetic/directory', 'directory', ['list'], signal)
  const name = 'colon:back\\slash\nname', bytes = Buffer.from(name), output = Buffer.alloc(8 + bytes.length + 9)
  output.writeUInt32LE(1); output.writeUInt32LE(bytes.length, 4); bytes.copy(output, 8)
  output.writeBigUInt64LE(7n, 9 + bytes.length)
  f.setHandler(frame => f.reply(frame.readUInt32LE(), output))
  assert.deepEqual(await f.adapter.list(object, [], signal), [{ name, size: 7, isDirectory: false }])
  await f.adapter.stop()
})

test('derived read handles and metadata preserve 64-bit sizes and reject invalid kinds/dates', async () => {
  for (const mode of ['valid', 'kind', 'size', 'date']) {
    const f = fixture(), signal = new AbortController().signal
    const root = await f.adapter.pin(process.execPath, 'directory', ['read'], signal)
    f.setHandler(frame => {
      if (frame[4] === 8) { f.reply(frame.readUInt32LE(), Buffer.from([2, 0, 0, 0])); return }
      assert.equal(frame[4], 9)
      const output = Buffer.alloc(17); output[0] = mode === 'kind' ? 1 : 0
      output.writeBigUInt64LE(mode === 'size' ? 9007199254740992n : 4294967301n, 1)
      output.writeBigInt64LE(mode === 'date' ? 8640000000000001n : -1000n, 9)
      f.reply(frame.readUInt32LE(), output)
    })
    const child = await f.adapter.deriveRead(root, ['nested', 'input.bin'], signal)
    assert.equal(child.kind, 'file'); assert.equal(child.displayName, 'input.bin')
    if (mode === 'valid') assert.deepEqual(await f.adapter.describe(child, signal), { isDirectory: false, size: 4294967301, lastModifiedMs: -1000 })
    else await assert.rejects(f.adapter.describe(child, signal))
    await f.adapter.stop()
  }
})

test('copy uses only source/destination native handles and validates committed byte counts', async () => {
  const f = fixture(), signal = new AbortController().signal
  const source = await f.adapter.pin(process.execPath, 'file', ['read'], signal)
  f.setHandler(frame => f.reply(frame.readUInt32LE(), Buffer.from([2, 0, 0, 0])))
  const destination = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => {
    assert.equal(frame[4], 10); assert.equal(frame.readUInt32LE(5), 1); assert.equal(frame.readUInt32LE(9), 2); assert.equal(frame[13], 0)
    const result = Buffer.alloc(5); result[0] = 1; result.writeUInt32LE(14, 1); f.reply(frame.readUInt32LE(), result)
  })
  assert.deepEqual(await f.adapter.copy(source, destination, false, signal), { status: 'committed', bytesWritten: 14 })
  const count = f.requests.length
  await assert.rejects(f.adapter.copy(destination, source, false, signal)); assert.equal(f.requests.length, count)
  f.setHandler(frame => { const result = Buffer.alloc(5); result[0] = 1; result.writeUInt32LE(2147483649, 1); f.reply(frame.readUInt32LE(), result) })
  await assert.rejects(f.adapter.copy(source, destination, false, signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await f.adapter.stop()
})

test('stream save stages bounded chunks, verifies total count and commits only after producer completion', async () => {
  const f = fixture(), signal = new AbortController().signal
  const target = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  let received = 0, committed = false
  f.setHandler(frame => {
    if (frame[4] === 13) { assert.equal(frame.readBigUInt64LE(9), 65537n); f.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0])); return }
    if (frame[4] === 14) { const count = frame.readUInt32LE(9); assert.ok(count <= 65536); received += count; const result = Buffer.alloc(4); result.writeUInt32LE(count); f.reply(frame.readUInt32LE(), result); return }
    assert.equal(frame[4], 15); assert.equal(received, 65537); committed = true
    const result = Buffer.alloc(5); result[0] = 1; result.writeUInt32LE(received, 1); f.reply(frame.readUInt32LE(), result)
  })
  async function* chunks() { yield Buffer.alloc(65537, 3); assert.equal(committed, false) }
  assert.deepEqual(await f.adapter.streamSave(target, 65537, chunks(), false, signal), { status: 'committed', bytesWritten: 65537 })
  assert.equal(committed, true); await f.adapter.stop()
})

test('unknown-size stream uses an explicit sentinel and commits the observed bounded byte count', async () => {
  const f = fixture(), signal = new AbortController().signal
  const target = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => {
    if (frame[4] === 13) { assert.equal(frame.readBigUInt64LE(9), 0xffffffffffffffffn); f.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0])); return }
    const result = Buffer.alloc(frame[4] === 14 ? 4 : 5)
    if (frame[4] === 14) result.writeUInt32LE(3)
    else { assert.equal(frame[4], 15); result[0] = 1; result.writeUInt32LE(3, 1) }
    f.reply(frame.readUInt32LE(), result)
  })
  async function* chunks() { yield Buffer.from('sdk') }
  assert.deepEqual(await f.adapter.streamSave(target, undefined, chunks(), false, signal), { status: 'committed', bytesWritten: 3 })
  await f.adapter.stop()
})

test('stream save rejects short/excess producers and aborts owned staging without committing', async () => {
  for (const length of [0, 1, 3]) {
    const f = fixture(), signal = new AbortController().signal
    const target = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
    let aborted = false
    f.setHandler(frame => {
      if (frame[4] === 13) { f.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0])); return }
      if (frame[4] === 14) { const result = Buffer.alloc(4); result.writeUInt32LE(frame.readUInt32LE(9)); f.reply(frame.readUInt32LE(), result); return }
      assert.equal(frame[4], 16); aborted = true; f.reply(frame.readUInt32LE(), Buffer.alloc(0))
    })
    async function* chunks() { yield Buffer.alloc(length) }
    await assert.rejects(f.adapter.streamSave(target, 2, chunks(), false, signal)); assert.equal(aborted, true)
    await f.adapter.stop()
  }
})

test('stream producer wait is cancellable and bounded and interrupted commit is never reported as rollback', async () => {
  const f = fixture(), controller = new AbortController()
  const target = await f.adapter.pin(process.execPath, 'save', ['write'], controller.signal)
  let aborted = false
  f.setHandler(frame => {
    if (frame[4] === 13) f.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0]))
    else { assert.equal(frame[4], 16); aborted = true; f.reply(frame.readUInt32LE(), Buffer.alloc(0)) }
  })
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  const stalled: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}) } }) }
  const pending = f.adapter.streamSave(target, 1, stalled, false, controller.signal), rejected = assert.rejects(pending)
  await started; controller.abort(); await rejected; assert.equal(aborted, true); await f.adapter.stop()
  const g = fixture(), signal = new AbortController().signal
  const output = await g.adapter.pin(process.execPath, 'save', ['write'], signal)
  g.setHandler(frame => { if (frame[4] === 13) g.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0])); else assert.equal(frame[4], 15) })
  async function* empty() {}
  await assert.rejects(g.adapter.streamSave(output, 0, empty(), false, signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await g.adapter.stop()
})

test('a local full queue during stream commit confirms broker exit instead of leaking an owned staging entry', async () => {
  const f = fixture(), signal = new AbortController().signal
  const target = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  f.setHandler(frame => { if (frame[4] === 13) f.reply(frame.readUInt32LE(), Buffer.from([1, 0, 0, 0])) })
  const waiting: Promise<unknown>[] = []
  async function* chunks() {
    for (let index = 0; index < 64; index++) waiting.push(assert.rejects(f.adapter.read(target, [], 1, signal)))
  }
  await assert.rejects(f.adapter.streamSave(target, 0, chunks(), false, signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await Promise.all(waiting); assert.deepEqual(f.signals, ['SIGKILL']); await f.adapter.stop()
})

test('native typed save failures distinguish existing output, size limit and unconfirmed commit without killing a healthy broker', async () => {
  const f = fixture(), signal = new AbortController().signal
  const target = await f.adapter.pin(process.execPath, 'save', ['write'], signal)
  for (const [status, code] of [[1, 'FILE_ERROR'], [2, 'FILE_WRITE_OUTCOME_UNKNOWN'], [3, 'FILE_ALREADY_EXISTS'], [4, 'FILE_TOO_LARGE'], [5, 'FILE_CROSS_DEVICE'], [6, 'FILE_STAGING_RETAINED']] as const) {
    f.setHandler(frame => f.reply(frame.readUInt32LE(), Buffer.from([status]), false))
    await assert.rejects(f.adapter.save(target, Buffer.from('data'), false, signal), { code })
    assert.equal(f.signals.length, 0)
  }
  await f.adapter.stop()
})
