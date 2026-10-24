import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { ProcessDiscoveryAdapter, ProcessSummary } from '../../services/process-service.js'

const execFileAsync = promisify(execFile)
const MAX_PROCESS_COUNT = 10_000
const PROCESS_LIST_BUFFER_BYTES = 4 * 1024 * 1024

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      fields.push(field)
      field = ''
    } else {
      field += character
    }
  }
  fields.push(field)
  return fields
}

export function parseWindowsTaskListOutput(output: string): ProcessSummary[] {
  const result: ProcessSummary[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('"')) continue
    const fields = parseCsvLine(line)
    const pid = Number(fields[1])
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffff_ffff) continue
    const memoryText = fields[4] ?? ''
    const memoryKiB = Number(memoryText.replace(/\D/g, ''))
    const memoryBytes = memoryKiB * 1024
    const memoryUsageAvailable = /\d/.test(memoryText) &&
      Number.isSafeInteger(memoryKiB) && Number.isSafeInteger(memoryBytes)
    result.push({
      pid,
      name: fields[0] ?? '',
      path: '',
      cpuUsage: 0,
      memoryUsage: memoryUsageAvailable ? memoryBytes : 0,
      fieldAvailability: {
        path: false,
        cpuUsage: false,
        memoryUsage: memoryUsageAvailable
      }
    })
    if (result.length >= MAX_PROCESS_COUNT) break
  }
  return result
}

export class WindowsProcessDiscoveryAdapter implements ProcessDiscoveryAdapter {
  async list(signal: AbortSignal): Promise<ProcessSummary[]> {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const taskList = path.join(systemRoot, 'System32', 'tasklist.exe')
    try {
      const { stdout } = await execFileAsync(taskList, ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        maxBuffer: PROCESS_LIST_BUFFER_BYTES,
        windowsHide: true,
        timeout: 10_000,
        signal
      })
      return parseWindowsTaskListOutput(stdout)
    } catch (error) {
      if (signal.aborted) throw error
      throw new ZToolsError(errorCodes.processError, '读取进程列表失败')
    }
  }
}
