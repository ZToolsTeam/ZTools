import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import test from 'node:test'
import {
  createMacAvailableMemoryReader,
  parseVmStatAvailableBytes,
  readSystemAvailableMemoryBytes
} from '../../src/main/platform/macos/memory.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ProcessService } from '../../src/main/services/process-service.js'
import { SystemService, type SystemAdapter } from '../../src/main/services/system-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const GiB = 1024 ** 3

// Apple Silicon 真机样本（16K 页）：free 只有 3801 页（约 59 MB），inactive 约 2.6 GB 可回收
const VM_STAT_16K = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     3801.
Pages active:                                 250709.
Pages inactive:                               171953.
Pages speculative:                              5229.
Pages throttled:                                   0.
Pages wired down:                             170317.
Pages purgeable:                                1439.
"Translation faults":                     1440288612.
Pages copy-on-write:                        62203533.
File-backed pages:                            148160.
Anonymous pages:                              352483.
Pages stored in compressor:                   851767.
Pages occupied by compressor:                 319577.
`

// Intel 样本（4K 页）
const VM_STAT_4K = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               100000.
Pages active:                             900000.
Pages inactive:                           500000.
Pages speculative:                         20000.
Pages throttled:                               0.
Pages wired down:                         400000.
Pages purgeable:                           30000.
`

const registry = { onRemoved: () => () => undefined } as unknown as WindowRegistry

test('parseVmStatAvailableBytes 计入 free + inactive + speculative + purgeable 并按页大小换算', () => {
  assert.equal(parseVmStatAvailableBytes(VM_STAT_16K, 16 * GiB), (3801 + 171953 + 5229 + 1439) * 16384)
  assert.equal(parseVmStatAvailableBytes(VM_STAT_4K, 16 * GiB), (100000 + 500000 + 20000 + 30000) * 4096)
  // 远大于 os.freemem() 口径（只有 free 页）
  assert.ok(Number(parseVmStatAvailableBytes(VM_STAT_16K, 16 * GiB)) > 3801 * 16384 * 40)
})

test('parseVmStatAvailableBytes 结果夹在 [0, total]，缺少可选字段按 0 计', () => {
  assert.equal(parseVmStatAvailableBytes(VM_STAT_4K, 1 * GiB), 1 * GiB)
  const minimal = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\n'
  assert.equal(parseVmStatAvailableBytes(minimal, 16 * GiB), 30 * 16384)
  // total 非法时不夹上限，但仍返回非负值
  assert.equal(parseVmStatAvailableBytes(minimal, Number.NaN), 30 * 16384)
})

test('parseVmStatAvailableBytes 对畸形输出返回 null', () => {
  const cases = [
    '',
    'garbage',
    VM_STAT_16K.replace('(page size of 16384 bytes)', ''),
    VM_STAT_16K.replace('page size of 16384 bytes', 'page size of 0 bytes'),
    VM_STAT_16K.replace(/^Pages free:.*$/m, ''),
    VM_STAT_16K.replace(/^Pages inactive:.*$/m, 'Pages inactive: abc.'),
    VM_STAT_16K.replace(/^Pages free:.*$/m, 'Pages free: -5.'),
    VM_STAT_16K.replace(/^Pages free:.*$/m, `Pages free: ${'9'.repeat(40)}.`),
    // 半截报文：只有页大小
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)\n'
  ]
  for (const sample of cases) assert.equal(parseVmStatAvailableBytes(sample, 16 * GiB), null, sample.slice(0, 80))
  assert.equal(parseVmStatAvailableBytes(undefined as unknown as string, 16 * GiB), null)
})

test('vm_stat 失败、超时或输出畸形时回落 os.freemem 口径', async () => {
  const errors: Array<() => Promise<string>> = [
    () => Promise.reject(Object.assign(new Error('spawn /usr/bin/vm_stat ENOENT'), { code: 'ENOENT' })),
    () => Promise.reject(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })),
    () => Promise.resolve('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages fr'),
    () => { throw new Error('同步抛出') }
  ]
  for (const run of errors) {
    const reader = createMacAvailableMemoryReader({ run, totalBytes: () => 16 * GiB, fallback: () => 123 })
    assert.equal(await reader(), 123)
  }
})

test('读数在缓存期内复用，过期或 fresh 时重新读取，并发请求只起一个 vm_stat', async () => {
  let clock = 1_000
  let calls = 0
  let release: (() => void) | null = null
  const reader = createMacAvailableMemoryReader({
    run: () => {
      calls += 1
      return new Promise((resolve) => {
        release = () => resolve(VM_STAT_16K.replace('Pages free:                                     3801.', `Pages free: ${calls}.`))
      })
    },
    totalBytes: () => 16 * GiB,
    fallback: () => 0,
    now: () => clock,
    cacheMs: 1_500
  })
  const concurrent = Array.from({ length: 10 }, () => reader())
  assert.equal(calls, 1)
  release!()
  const values = await Promise.all(concurrent)
  assert.equal(new Set(values).size, 1)
  const first = Number(values[0])

  clock += 1_000
  assert.equal(await reader(), first)
  assert.equal(calls, 1)

  const fresh = reader({ fresh: true })
  assert.equal(calls, 2)
  release!()
  assert.equal(await fresh, first + 16384)

  clock += 2_000
  const expired = reader()
  assert.equal(calls, 3)
  release!()
  assert.equal(await expired, first + 2 * 16384)
})

test('非 macOS 平台沿用 os.freemem()', async () => {
  const value = await readSystemAvailableMemoryBytes('linux')
  assert.ok(value > 0 && value <= os.totalmem())
})

test('macOS 真机：SystemService 与 ProcessService 的可用内存使用 vm_stat 口径', { skip: process.platform !== 'darwin' }, async () => {
  const total = os.totalmem()
  const expected = parseVmStatAvailableBytes(execFileSync('/usr/bin/vm_stat', { encoding: 'utf8' }), total)
  assert.ok(expected !== null && expected > 0)

  const system = new SystemService({} as FileSystemService, registry, {} as SystemAdapter, 'darwin')
  const memory = (await system.getMemoryUsage()).data as { total: number; used: number; available: number; percent: number }
  assert.equal(memory.total, total)
  assert.equal(memory.used + memory.available, total)
  assert.ok(memory.available >= os.freemem() * 0.5, 'available 应包含可回收内存而不只是 free 页')
  // 两次采样之间系统内存会波动，允许 10% 误差
  assert.ok(Math.abs(memory.available - expected) < total * 0.1)
  assert.equal(memory.percent, Math.round(memory.used * 100 / total))

  const processService = new ProcessService(registry, {} as FileSystemService, Date.now, 'darwin')
  try {
    const info = (await processService.handleProcessMonitorCall('GetSystemInfo', {}, new AbortController().signal)).data as {
      totalMemoryBytes: number; availableMemoryBytes: number; usedMemoryBytes: number; memoryUsagePercent: number
    }
    assert.equal(info.totalMemoryBytes, total)
    assert.ok(Math.abs(info.availableMemoryBytes - expected) < total * 0.1)
    assert.equal(info.usedMemoryBytes + info.availableMemoryBytes, total)
  } finally {
    processService.stop()
  }
})
