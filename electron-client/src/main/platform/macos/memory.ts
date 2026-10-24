import { execFile } from 'node:child_process'
import os from 'node:os'

// macOS 上 os.freemem() 只返回 free_count × pagesize，不含可立即回收的 inactive / speculative / purgeable 页，
// 系统正常运行时长期只剩几十到几百 MB，会被误判为内存将满。这里改为解析 vm_stat 计算可用内存。

const VM_STAT_PATH = '/usr/bin/vm_stat'
const VM_STAT_TIMEOUT_MS = 1_000
const DEFAULT_CACHE_MS = 1_500

export type VmStatRunner = () => Promise<string>

export interface MacAvailableMemoryReaderOptions {
  run?: VmStatRunner
  totalBytes?: () => number
  fallback?: () => number
  now?: () => number
  cacheMs?: number
}

export interface MacAvailableMemoryReadOptions {
  /** 跳过缓存，强制重新读取（用于前后对比，如内存释放前后） */
  fresh?: boolean
}

export type MacAvailableMemoryReader = (options?: MacAvailableMemoryReadOptions) => Promise<number>

function readPageCount(output: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^${escaped}:\\s+(\\d+)\\.?\\s*$`, 'm'))
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 解析 vm_stat 输出，返回可用内存字节数：(free + inactive + speculative + purgeable) × pagesize，夹在 [0, totalBytes]。
 * 页大小、Pages free、Pages inactive 任一缺失或畸形时返回 null，由调用方回落。
 */
export function parseVmStatAvailableBytes(output: string, totalBytes: number): number | null {
  if (typeof output !== 'string' || output.length === 0) return null
  const pageSizeMatch = output.match(/page size of (\d+) bytes/)
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : NaN
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null
  const free = readPageCount(output, 'Pages free')
  const inactive = readPageCount(output, 'Pages inactive')
  if (free === null || inactive === null) return null
  const speculative = readPageCount(output, 'Pages speculative') ?? 0
  const purgeable = readPageCount(output, 'Pages purgeable') ?? 0
  const available = (free + inactive + speculative + purgeable) * pageSize
  if (!Number.isFinite(available)) return null
  const upper = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : available
  return Math.max(0, Math.min(upper, available))
}

const runVmStat: VmStatRunner = () => new Promise((resolve, reject) => {
  execFile(VM_STAT_PATH, [], { timeout: VM_STAT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(String(stdout))
  })
})

export function createMacAvailableMemoryReader(options: MacAvailableMemoryReaderOptions = {}): MacAvailableMemoryReader {
  const run = options.run ?? runVmStat
  const totalBytes = options.totalBytes ?? (() => os.totalmem())
  const fallback = options.fallback ?? (() => os.freemem())
  const now = options.now ?? Date.now
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  let cached: { value: number; at: number } | null = null
  let inflight: Promise<number> | null = null

  const load = async (): Promise<number> => {
    let value: number | null = null
    try {
      value = parseVmStatAvailableBytes(await run(), totalBytes())
    } catch {
      value = null
    }
    if (value === null) value = fallback()
    cached = { value, at: now() }
    return value
  }

  return (readOptions = {}) => {
    if (!readOptions.fresh && cached && now() - cached.at < cacheMs) return Promise.resolve(cached.value)
    if (inflight) return inflight
    inflight = load().finally(() => { inflight = null })
    return inflight
  }
}

const defaultMacReader = createMacAvailableMemoryReader()

/** 按平台读取系统可用内存：macOS 解析 vm_stat，其余平台沿用 os.freemem()（Windows / Linux 的 libuv 实现已含可回收内存）。 */
export function readSystemAvailableMemoryBytes(
  platform: NodeJS.Platform = process.platform,
  options?: MacAvailableMemoryReadOptions
): Promise<number> {
  if (platform === 'darwin') return defaultMacReader(options)
  return Promise.resolve(os.freemem())
}
