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

function logFileName(now: Date): string {
  return `electron-main-${now.toISOString().slice(0, 10)}.log`
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
  process.on('exit', (code) => {
    append('INFO', 'process', ['Process exiting', { code }])
  })
}

export function initializeRuntimeLogging(logDirectory: string): string | undefined {
  try {
    fs.mkdirSync(logDirectory, { recursive: true })
    activeLogFile = path.join(logDirectory, logFileName(new Date()))
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
