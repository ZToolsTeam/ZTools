import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  createPlatformProcessDiscoveryAdapter
} from '../../src/main/platform/process-discovery.js'
import {
  createMacosProcessListRunner,
  MacosProcessDiscoveryAdapter
} from '../../src/main/platform/macos/process-discovery.js'
import { parseMacosProcessList } from '../../src/main/platform/macos/process-discovery.js'
import {
  parseWindowsTaskListOutput,
  WindowsProcessDiscoveryAdapter
} from '../../src/main/platform/windows/process-discovery.js'

function signal(): AbortSignal {
  return new AbortController().signal
}

test('Windows tasklist parsing preserves quoted names and marks unavailable fields', () => {
  const data = parseWindowsTaskListOutput([
    '"Image Name","PID","Session Name","Session#","Mem Usage"',
    '"a""b.exe","17","Console","1"," 1,234 K"',
    '"bad.exe","not-a-pid","Console","1"," 2 K"',
    '"overflow.exe","4294967296","Console","1"," 3 K"'
  ].join('\r\n'))

  assert.equal(data.length, 1)
  assert.deepEqual(data[0], {
    pid: 17,
    name: 'a"b.exe',
    path: '',
    cpuUsage: 0,
    memoryUsage: 1_234 * 1024,
    fieldAvailability: { path: false, cpuUsage: false, memoryUsage: true }
  })
})

test('Windows tasklist parsing stops at the documented process bound', () => {
  const lines = Array.from({ length: 10_005 }, (_, index) =>
    `"process.exe","${index + 1}","Console","1"," 1 K"`
  )
  assert.equal(parseWindowsTaskListOutput(lines.join('\n')).length, 10_000)
})

test('Windows tasklist parsing marks byte counts that would overflow as unavailable', () => {
  const [process] = parseWindowsTaskListOutput(
    '"large.exe","18","Console","1","9,007,199,254,740,991 K"'
  )
  assert.equal(process?.memoryUsage, 0)
  assert.equal(process?.fieldAvailability.memoryUsage, false)
})

test('macOS ps parsing reports truthful field availability and converts RSS KiB to bytes', () => {
  const data = parseMacosProcessList([
    '  1  0.0  4096 launchd',
    ' 42 12.5  1024 ZTools Agent',
    ' 43 - 9007199254740992 large-memory',
    '  0  0.1  512 zero-pid',
    'bad line without process fields'
  ].join('\n'))

  assert.equal(data.length, 3)
  assert.deepEqual(data[0], {
    pid: 1,
    name: 'launchd',
    path: '',
    cpuUsage: 0,
    memoryUsage: 4096 * 1024,
    fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true }
  })
  assert.deepEqual(data[1], {
    pid: 42,
    name: 'ZTools Agent',
    path: '',
    cpuUsage: 12.5,
    memoryUsage: 1024 * 1024,
    fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true }
  })
  assert.deepEqual(data[2], {
    pid: 43,
    name: 'large-memory',
    path: '',
    cpuUsage: 0,
    memoryUsage: 0,
    fieldAvailability: { path: false, cpuUsage: false, memoryUsage: false }
  })
})

test('macOS ps parsing takes the full name from the executable path instead of the 16-character kernel name', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)'
  const data = parseMacosProcessList([
    `2288 3.2 108128 ${chrome}`,
    '  1  0.1  22128 /sbin/launchd',
    ' 159 0.0   6704 Core Audio Driver (ParrotAudioPlugin.driver)',
    '1328 0.0    512 npm exec vite --host 127.0.0.1',
    '1400 0.0    512 /',
    '1401 0.0    512 /usr/local/bin/'
  ].join('\n'))

  assert.equal(data[0]?.name, 'Google Chrome Helper (Renderer)')
  assert.equal(data[0]?.path, chrome)
  assert.equal(data[0]?.fieldAvailability.path, true)
  assert.equal(data[1]?.name, 'launchd')
  assert.equal(data[1]?.path, '/sbin/launchd')
  assert.equal(data[2]?.name, 'Core Audio Driver (ParrotAudioPlugin.driver)')
  assert.equal(data[2]?.path, '', 'non-path names stay names, no invented path')
  assert.equal(data[2]?.fieldAvailability.path, false)
  assert.equal(data[3]?.name, 'npm exec vite --host 127.0.0.1')
  // A bare "/" or a trailing slash is not an executable path; keep it as a name instead of an empty basename
  assert.equal(data[4]?.name, '/')
  assert.equal(data[4]?.path, '')
  assert.equal(data[5]?.name, '/usr/local/bin/')
})

test('macOS ps parsing rejects duplicate pids, sanitizes control characters and stops at the process bound', () => {
  assert.equal(
    parseMacosProcessList(' 10 1.0 10 first\n 10 2.0 20 duplicate').length,
    1
  )
  assert.equal(parseMacosProcessList(' 11 1.0 10 na\u0000me')[0]?.name, 'name')

  const output = Array.from({ length: 10_005 }, (_, index) =>
    ` ${index + 1} 0.1 10 process-${index}`
  ).join('\n')
  assert.equal(parseMacosProcessList(output).length, 10_000)
})

test('macOS ps parsing enforces signed pid_t and CPU/RSS numeric boundaries', () => {
  const data = parseMacosProcessList([
    '2147483647 100000 8796093022207 pid-max',
    '2147483648 100000.1 8796093022208 pid-overflow',
    '4294967295 NaN 9007199254740992 legacy-win32-max',
    '1 -Infinity 0 bad-cpu'
  ].join('\n'))

  assert.deepEqual(data, [
    {
      pid: 2_147_483_647,
      name: 'pid-max',
      path: '',
      cpuUsage: 100_000,
      memoryUsage: 9_007_199_254_739_968,
      fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true }
    },
    {
      pid: 1,
      name: 'bad-cpu',
      path: '',
      cpuUsage: 0,
      memoryUsage: 0,
      fieldAvailability: { path: false, cpuUsage: false, memoryUsage: true }
    }
  ])
})

test('macOS process runner calls the fixed ps command with bounded non-shell options', async () => {
  const controller = new AbortController()
  let invocation: {
    file: string
    args: string[]
    options: {
      encoding: string
      maxBuffer: number
      shell: boolean
      timeout: number
      signal: AbortSignal
    }
  } | undefined
  const run = createMacosProcessListRunner(async (file, args, options) => {
    invocation = { file, args, options }
    return { stdout: ' 17 0.5 256 sample process' }
  })

  assert.equal(await run(controller.signal), ' 17 0.5 256 sample process')
  assert.equal(invocation?.file, '/bin/ps')
  assert.deepEqual(invocation?.args, ['-axo', 'pid=,pcpu=,rss=,comm='])
  assert.deepEqual(Object.keys(invocation?.options ?? {}).sort(), [
    'encoding',
    'maxBuffer',
    'shell',
    'signal',
    'timeout'
  ])
  assert.equal(invocation?.options.encoding, 'utf8')
  assert.equal(invocation?.options.maxBuffer, 4 * 1024 * 1024)
  assert.equal(invocation?.options.shell, false)
  assert.equal(invocation?.options.timeout, 10_000)
  assert.equal(invocation?.options.signal, controller.signal)
})

test('macOS provider uses its injected runner, observes cancellation and rejects malformed provider output', async () => {
  const controller = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const adapter = new MacosProcessDiscoveryAdapter(async (signal) => {
    receivedSignal = signal
    return ' 17 0.5 256 sample process'
  })
  const listed = await adapter.list(controller.signal)
  assert.equal(receivedSignal, controller.signal)
  assert.equal(listed[0]?.name, 'sample process')

  const emptyAdapter = new MacosProcessDiscoveryAdapter(async () => 'not a ps record')
  await assert.rejects(
    emptyAdapter.list(signal()),
    (error) => error instanceof ZToolsError && error.code === errorCodes.processError
  )

  const aborted = new AbortController()
  const reason = new Error('cancelled')
  aborted.abort(reason)
  let invoked = false
  const cancelledAdapter = new MacosProcessDiscoveryAdapter(async () => {
    invoked = true
    return ' 18 0.1 10 should-not-run'
  })
  await assert.rejects(cancelledAdapter.list(aborted.signal), (error) => error === reason)
  assert.equal(invoked, false)

  const inFlight = new AbortController()
  const inFlightReason = new Error('cancelled while listing')
  const inFlightAdapter = new MacosProcessDiscoveryAdapter((signal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const listing = inFlightAdapter.list(inFlight.signal)
  inFlight.abort(inFlightReason)
  await assert.rejects(listing, (error) => error === inFlightReason)
})

test('process discovery factory selects Windows and macOS providers and rejects unknown OSes', async () => {
  assert.ok(createPlatformProcessDiscoveryAdapter('win32') instanceof WindowsProcessDiscoveryAdapter)
  const macAdapter = createPlatformProcessDiscoveryAdapter('darwin')
  assert.ok(macAdapter instanceof MacosProcessDiscoveryAdapter)
  assert.throws(
    () => createPlatformProcessDiscoveryAdapter('freebsd' as NodeJS.Platform),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})
