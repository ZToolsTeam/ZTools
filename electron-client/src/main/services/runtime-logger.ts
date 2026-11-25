import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const originalConsole = {
  debug: console.debug.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
}

interface PendingLogEntry {
  file: string
  text: string
}

let activeLogFile: string | undefined
let consoleHooked = false
let processHooked = false
const pendingEntries: PendingLogEntry[] = []
let flushScheduled = false
let activeFlush: Promise<void> | undefined
let inFlightBatch: PendingLogEntry | undefined

const MAX_LOG_FILE_ATTEMPTS = 1000

function takeNextBatch(): { file: string; text: string } | undefined {
  const first = pendingEntries[0]
  if (!first) return undefined
  const targetFile = first.file
  const parts: string[] = []
  let count = 0
  while (count < pendingEntries.length && pendingEntries[count]!.file === targetFile) {
    parts.push(pendingEntries[count]!.text)
    count += 1
  }
  pendingEntries.splice(0, count)
  return { file: targetFile, text: parts.join('') }
}

function scheduleFlush(): void {
  if (flushScheduled || activeFlush) return
  flushScheduled = true
  queueMicrotask(() => {
    flushScheduled = false
    startAsyncDrain()
  })
}

function startAsyncDrain(): Promise<void> {
  if (activeFlush) return activeFlush
  if (pendingEntries.length === 0) return Promise.resolve()
  const run = (async () => {
    try {
      while (pendingEntries.length > 0) {
        const batch = takeNextBatch()
        if (!batch) break
        inFlightBatch = batch
        try {
          await fs.promises.appendFile(batch.file, batch.text, 'utf8')
        } catch (err) {
          // Logging must never make the application fail to start or shut down.
          void err
        } finally {
          if (inFlightBatch === batch) inFlightBatch = undefined
        }
      }
    } finally {
      activeFlush = undefined
      if (pendingEntries.length > 0) {
        scheduleFlush()
      }
    }
  })()
  activeFlush = run
  return run
}

export function flushRuntimeLogSync(options?: { includeInFlight?: boolean }): void {
  if (options?.includeInFlight && inFlightBatch) {
    const batch = inFlightBatch
    inFlightBatch = undefined
    try {
      fs.appendFileSync(batch.file, batch.text, 'utf8')
    } catch (err) {
      // Logging must never make the application fail to start or shut down.
      void err
    }
  }
  while (pendingEntries.length > 0) {
    const batch = takeNextBatch()
    if (!batch) break
    try {
      fs.appendFileSync(batch.file, batch.text, 'utf8')
    } catch (err) {
      // Logging must never make the application fail to start or shut down.
      void err
    }
  }
}

export async function flushRuntimeLog(): Promise<void> {
  while (activeFlush || pendingEntries.length > 0) {
    if (activeFlush) {
      await activeFlush
    } else {
      await startAsyncDrain()
    }
  }
}

function formatLogTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

function logFileName(now: Date, pid: number, sequence = 0): string {
  const suffix = sequence > 0 ? `-${sequence}` : ''
  return `electron-main-${formatLogTimestamp(now)}-pid${pid}${suffix}.log`
}

function createUniqueLogFile(logDirectory: string, now: Date, pid: number): string {
  for (let sequence = 0; sequence < MAX_LOG_FILE_ATTEMPTS; sequence += 1) {
    const candidate = path.join(logDirectory, logFileName(now, pid, sequence))
    try {
      // 使用原子排他创建确保每次启动（含同毫秒重复初始化）拥有独立日志文件
      const fd = fs.openSync(candidate, 'wx')
      fs.closeSync(fd)
      return candidate
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EEXIST') continue
      throw error
    }
  }
  throw new Error(`Unable to allocate unique runtime log file in ${logDirectory}`)
}

function formatMessage(values: unknown[]): string {
  return format(...values).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}

function append(level: RuntimeLogLevel, scope: string, values: unknown[]): void {
  if (!activeLogFile) return
  const prefix = `${new Date().toISOString()} [pid:${process.pid}] [${level}] [${scope}] `
  const message = formatMessage(values).replaceAll('\n', `\n${prefix}`)
  pendingEntries.push({
    file: activeLogFile,
    text: `${prefix}${message}\n`
  })
  scheduleFlush()
}

function hookConsole(): void {
  if (consoleHooked) return
  consoleHooked = true
  console.debug = (...values: unknown[]) => {
    append('DEBUG', 'main', values)
    originalConsole.debug(...values)
  }
  console.log = (...values: unknown[]) => {
    append('INFO', 'main', values)
    originalConsole.log(...values)
  }
  console.info = (...values: unknown[]) => {
    append('INFO', 'main', values)
    originalConsole.info(...values)
  }
  console.warn = (...values: unknown[]) => {
    append('WARN', 'main', values)
    originalConsole.warn(...values)
  }
  console.error = (...values: unknown[]) => {
    append('ERROR', 'main', values)
    originalConsole.error(...values)
  }
}

function hookProcessErrors(): void {
  if (processHooked) return
  processHooked = true
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    append('ERROR', 'process', [`Uncaught exception (${origin})`, error])
    flushRuntimeLogSync({ includeInFlight: true })
  })
  // 移除 Node 默认的 onWarning（其内部走 console.error 导致 DeprecationWarning 在日志中被误记为 [ERROR]），
  // 改为统一路由到 [WARN] 日志并通过 originalConsole.warn 保留终端可见性
  for (const listener of process.listeners('warning')) {
    if (listener.name === 'onWarning') {
      process.removeListener('warning', listener)
    }
  }
  process.on('warning', (warning) => {
    const codeSuffix = 'code' in warning && typeof warning.code === 'string' && warning.code
      ? ` [${warning.code}]`
      : ''
    const formatted = `${warning.name}${codeSuffix}: ${warning.message}`
    append('WARN', 'node-warning', [formatted])
    originalConsole.warn(formatted)
  })
  process.on('exit', (code) => {
    append('INFO', 'process', ['Process exiting', { code }])
    flushRuntimeLogSync({ includeInFlight: true })
  })
}

export function initializeRuntimeLogging(logDirectory: string): string | undefined {
  try {
    if (typeof logDirectory !== 'string' || logDirectory.trim().length === 0) {
      originalConsole.error('Runtime file logging initialization failed: logDirectory is empty')
      return undefined
    }
    flushRuntimeLogSync()
    fs.mkdirSync(logDirectory, { recursive: true })
    activeLogFile = createUniqueLogFile(logDirectory, new Date(), process.pid)
    hookConsole()
    hookProcessErrors()
    append('INFO', 'logger', ['Runtime file logging initialized', { logFile: activeLogFile }])
    return activeLogFile
  } catch (error) {
    originalConsole.error('Runtime file logging initialization failed', error)
    return undefined
  }
}

export function writeRuntimeLog(
  level: RuntimeLogLevel,
  scope: string,
  ...values: unknown[]
): void {
  append(level, scope, values)
}
