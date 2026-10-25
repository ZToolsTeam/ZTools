import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'

export interface SpotlightPaths {
  paths: string[]
  degraded: boolean
}

export interface CollectSpotlightOptions {
  timeoutMs?: number
  launch?: () => ChildProcessWithoutNullStreams
  signal?: AbortSignal
  cancelPrevious?: boolean
}

let activeDefaultSearchAbort: (() => void) | null = null

function buildMdfindArgs(query: string): string[] {
  const roots = [os.homedir(), '/Applications', '/System/Applications'].filter(Boolean)
  const onlyInArgs: string[] = []
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) {
        onlyInArgs.push('-onlyin', root)
      }
    } catch {
      // ignore inaccessible root
    }
  }
  return ['-0', ...onlyInArgs, '-name', query]
}

/** Cancel any currently running default mdfind subprocess. */
export function cancelActiveSpotlightSearch(): void {
  if (activeDefaultSearchAbort) {
    const abort = activeDefaultSearchAbort
    activeDefaultSearchAbort = null
    abort()
  }
}

/** Read a bounded NUL-delimited prefix, not the entire Spotlight index. */
export function collectSpotlightPaths(
  query: string,
  limit: number,
  options: CollectSpotlightOptions = {}
): Promise<SpotlightPaths> {
  const cap = Math.max(1, Math.min(2000, Math.trunc(limit) || 1))
  const isDefaultLaunch = !options.launch && options.cancelPrevious !== false
  if (isDefaultLaunch) {
    cancelActiveSpotlightSearch()
  }
  return new Promise(resolve => {
    const paths = new Set<string>()
    let buffer = ''
    let settled = false
    let stopping = false
    let degraded = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const child = options.launch?.() ?? spawn('/usr/bin/mdfind', buildMdfindArgs(query), { stdio: 'pipe' })
    child.stdin.end()
    const timer = setTimeout(() => stop(true), options.timeoutMs ?? 3000)
    const abortSelf = () => stop(true)
    if (isDefaultLaunch) {
      activeDefaultSearchAbort = abortSelf
    }
    if (options.signal) {
      if (options.signal.aborted) {
        stop(true)
      } else {
        options.signal.addEventListener('abort', abortSelf, { once: true })
      }
    }
    function finish(failed: boolean) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (isDefaultLaunch && activeDefaultSearchAbort === abortSelf) {
        activeDefaultSearchAbort = null
      }
      options.signal?.removeEventListener('abort', abortSelf)
      if (killTimer) clearTimeout(killTimer)
      child.stdout.removeListener('data', onData)
      resolve({ paths: [...paths], degraded: degraded || failed })
    }
    function stop(failed: boolean) {
      degraded ||= failed
      if (stopping || settled) return
      stopping = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 100)
    }
    function onData(chunk: string) {
      if (stopping) return
      buffer += chunk
      let end = buffer.indexOf('\0')
      while (end >= 0) {
        const candidate = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (candidate.length <= 32768 && path.posix.isAbsolute(candidate)) paths.add(candidate)
        if (paths.size >= cap) { stop(false); return }
        end = buffer.indexOf('\0')
      }
      if (buffer.length > 32768) stop(true)
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onData)
    child.stderr.resume()
    child.once('error', error => {
      console.warn('[Spotlight] 无法启动文件搜索:', error.message)
      finish(true)
    })
    child.once('close', code => finish(!stopping && code !== 0))
  })
}

const execFileAsync = promisify(execFile)
const displayNames = new Map<string, { expires: number; value: Promise<string> }>()

/** Spotlight already knows the localized Finder name; don't maintain an app-name translation table. */
export async function macosApplicationName(appPath: string): Promise<string> {
  const cached = displayNames.get(appPath)
  if (cached && cached.expires > Date.now()) return cached.value
  const fallback = path.basename(appPath, path.extname(appPath))
  if (!fs.existsSync(path.join(appPath, 'Contents'))) {
    const immediate = Promise.resolve(fallback)
    displayNames.set(appPath, { expires: Date.now() + 300_000, value: immediate })
    return immediate
  }
  const value = execFileAsync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemDisplayName', '-nullMarker', '', appPath], {
    encoding: 'utf8', timeout: 400, maxBuffer: 8192
  }).then(({ stdout }) => stdout.trim().replace(/\.app$/i, '') || fallback).catch(error => {
    displayNames.delete(appPath)
    console.warn('[Spotlight] 应用显示名称读取失败:', error instanceof Error ? error.message : String(error))
    return fallback
  })
  if (displayNames.size >= 512) displayNames.delete(displayNames.keys().next().value!)
  displayNames.set(appPath, { expires: Date.now() + 300_000, value })
  return value
}
