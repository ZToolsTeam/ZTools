import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { ProcessDiscoveryAdapter, ProcessSummary } from '../../services/process-service.js'

const execFileAsync = promisify(execFile)
const PROCESS_LIST_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const PROCESS_LIST_TIMEOUT_MS = 10_000
const MAX_PROCESS_COUNT = 10_000
const MAX_PROCESS_NAME_LENGTH = 512
const MAX_PROCESS_PATH_LENGTH = 4096

export type MacosProcessListRunner = (signal: AbortSignal) => Promise<string>

type MacosProcessListExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8'
    maxBuffer: number
    shell: false
    timeout: number
    signal: AbortSignal
  }
) => Promise<{ stdout: string }>

function isValidPositiveInteger(value: number): boolean {
  // Darwin pid_t is a signed 32-bit integer.
  return Number.isSafeInteger(value) && value > 0 && value <= 0x7fff_ffff
}

function parseCpuUsage(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : undefined
}

function parseMemoryUsageKiB(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined
  const memoryKiB = Number(value)
  const memoryBytes = memoryKiB * 1024
  return Number.isSafeInteger(memoryKiB) && Number.isSafeInteger(memoryBytes) ? memoryBytes : undefined
}

export function parseMacosProcessList(output: string): ProcessSummary[] {
  const result: ProcessSummary[] = []
  const seenPids = new Set<number>()

  for (const line of output.split(/\r?\n/)) {
    const fields = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!fields) continue

    const pid = Number(fields[1])
    if (!isValidPositiveInteger(pid) || seenPids.has(pid)) continue

    // comm 列是可执行文件完整路径（ucomm 会被内核截断成 16 个字符，例如「Google Chrome He」）；
    // 少数进程（内核驱动、改写了进程标题的进程）给的不是路径，原样作为名称
    const command = (fields[4] ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_PROCESS_PATH_LENGTH)
    const isPath = command.startsWith('/') && !command.endsWith('/')
    const name = (isPath ? command.slice(command.lastIndexOf('/') + 1) : command).slice(0, MAX_PROCESS_NAME_LENGTH)
    if (!name) continue
    const executablePath = isPath ? command : ''

    const cpuUsage = parseCpuUsage(fields[2] ?? '')
    const memoryUsage = parseMemoryUsageKiB(fields[3] ?? '')
    result.push({
      pid,
      name,
      path: executablePath,
      cpuUsage: cpuUsage ?? 0,
      memoryUsage: memoryUsage ?? 0,
      fieldAvailability: {
        path: executablePath !== '',
        cpuUsage: cpuUsage !== undefined,
        memoryUsage: memoryUsage !== undefined
      }
    })
    seenPids.add(pid)
    if (result.length >= MAX_PROCESS_COUNT) break
  }

  return result
}

export function createMacosProcessListRunner(
  execute: MacosProcessListExecFile = execFileAsync
): MacosProcessListRunner {
  return async (signal) => {
    // pcpu is ps's decaying average (up to one minute), not an instantaneous sample.
    const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,pcpu=,rss=,comm='], {
      encoding: 'utf8',
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
      shell: false,
      timeout: PROCESS_LIST_TIMEOUT_MS,
      signal
    })
    return stdout
  }
}

export class MacosProcessDiscoveryAdapter implements ProcessDiscoveryAdapter {
  constructor(private readonly run: MacosProcessListRunner = createMacosProcessListRunner()) {}

  async list(signal: AbortSignal): Promise<ProcessSummary[]> {
    try {
      if (signal.aborted) throw signal.reason ?? new Error('Process list cancelled')
      const output = await this.run(signal)
      if (signal.aborted) throw signal.reason ?? new Error('Process list cancelled')
      const processes = parseMacosProcessList(output)
      if (processes.length === 0) {
        throw new ZToolsError(errorCodes.processError, 'macOS 进程列表没有有效记录')
      }
      return processes
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.processError, '读取 macOS 进程列表失败')
    }
  }
}
