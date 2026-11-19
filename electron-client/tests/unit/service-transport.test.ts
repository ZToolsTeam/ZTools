import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ServiceClient } from '../../src/main/service/service-client.js'
import { ServiceBridgeTransport } from '../../src/main/service/service-transport.js'

function fixture(script: string, deferControl = false): {
  transport: ServiceBridgeTransport
  child: ChildProcessWithoutNullStreams
  close(): Promise<void>
} {
  let child!: ChildProcessWithoutNullStreams
  const transport = new ServiceBridgeTransport(process.execPath, 'fixture-pipe', 1000, (executable, args) => {
    assert.equal(executable, process.execPath)
    assert.deepEqual(args, ['--client-bridge', 'fixture-pipe', '1000'])
    child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    if (deferControl) {
      child.stderr.pause()
      const resume = setTimeout(() => child.stderr.resume(), 100)
      child.once('close', () => clearTimeout(resume))
    }
    return child
  })
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  return {
    transport,
    child,
    async close() {
      transport.destroy()
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([closed, new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (child.pid && child.exitCode === null && child.signalCode === null) {
              if (process.platform === 'win32') {
                spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
              } else child.kill('SIGKILL')
            }
            reject(new Error('service bridge fixture did not exit after cleanup'))
          }, 2500)
        })])
      } finally {
        if (timer) clearTimeout(timer)
      }
      assert(child.exitCode !== null || child.signalCode !== null)
    }
  }
}

const echoBridge = `
const ready = JSON.stringify({status:'ready',clientPid:process.pid})+'\\n';
process.stderr.write(ready.slice(0,8));
setTimeout(() => { process.stderr.write(ready.slice(8)); process.stdin.pipe(process.stdout); }, 5);
`

test('service bridge parses split readiness and carries binary data without changing bytes', { timeout: 5000 }, async () => {
  const bridge = fixture(echoBridge)
  const errors: Error[] = []
  bridge.transport.on('error', (error: Error) => errors.push(error))
  try {
    await once(bridge.transport, 'connect')
    assert.equal(bridge.transport.connecting, false)
    assert.equal(bridge.transport.clientProcessId, bridge.child.pid)
    const bytes = Buffer.from([0, 255, 13, 10, 0, 128, 7])
    const response = once(bridge.transport, 'data')
    bridge.transport.write(bytes)
    assert.deepEqual((await response)[0], bytes)
  } finally {
    await bridge.close()
  }
  assert.deepEqual(errors, [])
})

const invalidControls = [
  ['malformed JSON', `process.stderr.write('{broken}\\n')`],
  ['wrong PID', `process.stderr.write(JSON.stringify({status:'ready',clientPid:process.pid+1})+'\\n')`],
  ['negative Win32 error', `process.stderr.write(JSON.stringify({status:'error',code:'${errorCodes.serviceAuthentication}',win32:-1})+'\\n')`],
  ['unknown error code', `process.stderr.write(JSON.stringify({status:'error',code:'OK',win32:5})+'\\n')`],
  ['duplicate control lines', `process.stderr.write(JSON.stringify({status:'ready',clientPid:process.pid})+'\\n{}\\n')`],
  ['oversized control', `process.stderr.write('x'.repeat(4097))`],
  ['data before verification', `process.stdout.write('premature frame')`]
] as const

for (const [name, script] of invalidControls) {
  test(`service bridge rejects ${name} and cleans the child`, { timeout: 5000 }, async () => {
    const bridge = fixture(`${script}; setTimeout(() => {}, 100)`)
    try {
      const [failure] = await once(bridge.transport, 'error')
      assert(failure instanceof ZToolsError)
      assert.equal(failure.code, errorCodes.serviceProtocol)
      assert.equal(bridge.transport.destroyed, true)
    } finally {
      await bridge.close()
    }
  })
}

for (const code of [errorCodes.serviceAuthentication, errorCodes.serviceUnavailable] as const) {
  test(`ServiceClient preserves bridge ${code} without attempting a handshake`, { timeout: 5000 }, async () => {
    const bridge = fixture(`process.stderr.write(JSON.stringify({status:'error',code:'${code}',win32:5})+'\\n'); setTimeout(() => {}, 1500)`)
    let sentBytes = 0
    const write = bridge.child.stdin.write.bind(bridge.child.stdin)
    const client = new ServiceClient({ createTransport: () => bridge.transport })
    bridge.child.stdin.write = ((...args: Parameters<typeof write>): ReturnType<typeof write> => {
      sentBytes += Buffer.byteLength(args[0])
      return write(...args)
    }) as typeof write
    try {
      if (code === errorCodes.serviceAuthentication) {
        await assert.rejects(client.start(500), (error: unknown) =>
          error instanceof ZToolsError && error.code === code && error.details?.hostCode === 'WIN32_5')
      } else assert.equal(await client.start(2000), false)
      assert.equal(client.diagnostics.lastError, code)
      assert.equal(client.diagnostics.state, 'unavailable')
      assert.equal(sentBytes, 0)
    } finally {
      client.stop()
      await bridge.close()
    }
  })
}

for (const cancel of ['stop', 'abort', 'timeout'] as const) {
  test(`ServiceClient ${cancel} while bridge verification is pending leaves no child`, { timeout: 5000 }, async () => {
    const bridge = fixture('process.stdin.resume()')
    const controller = new AbortController()
    const client = new ServiceClient({ createTransport: () => bridge.transport })
    try {
      const starting = client.start(cancel === 'timeout' ? 20 : 2000, controller.signal)
      if (cancel === 'stop') client.stop()
      if (cancel === 'abort') controller.abort()
      assert.equal(await starting, false)
      assert.equal(client.diagnostics.state, cancel === 'timeout' ? 'unavailable' : 'closed')
    } finally {
      client.stop()
      await bridge.close()
    }
  })
}

test('service bridge rejects a relative helper executable', () => {
  assert.throws(() => new ServiceBridgeTransport('relative.exe', 'fixture', 1000), (error: unknown) =>
    error instanceof ZToolsError && error.code === errorCodes.serviceAuthentication)
})

for (const [name, control, expected] of [
  ['authentication error', `JSON.stringify({status:'error',code:'${errorCodes.serviceAuthentication}',win32:5})+'\\n'`, errorCodes.serviceAuthentication],
  ['malformed control', `'broken-json\\n'`, errorCodes.serviceProtocol],
  ['truncated control', `'{'`, errorCodes.serviceProtocol]
] as const) {
  test(`stdout EOF cannot hide delayed ${name}`, { timeout: 5000 }, async () => {
    const bridge = fixture(`process.stderr.write(${control})`, true)
    const client = new ServiceClient({ createTransport: () => bridge.transport })
    try {
      await assert.rejects(client.start(2000), (error: unknown) =>
        error instanceof ZToolsError && error.code === expected)
      assert.equal(client.diagnostics.lastError, expected)
    } finally {
      client.stop()
      await bridge.close()
    }
  })
}
