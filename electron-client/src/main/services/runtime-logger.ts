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

let activeLogFile: string | undefined
let consoleHooked = false
let processHooked = false

const MAX_LOG_FILE_ATTEMPTS = 1000

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
  try {
    fs.appendFileSync(activeLogFile, `${prefix}${message}\n`, 'utf8')
  } catch {
    // Logging must never make the application fail to start or shut down.
  }
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
  })
}

export function initializeRuntimeLogging(logDirectory: string): string | undefined {
  try {
    if (typeof logDirectory !== 'string' || logDirectory.trim().length === 0) {
      originalConsole.error('Runtime file logging initialization failed: logDirectory is empty')
      return undefined
    }
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
