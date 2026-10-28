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
  const roots = ['/Applications', '/System/Applications', os.homedir()].filter(Boolean)
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
const APP_NAME_CACHE_TTL_MS = 600_000
const ZH_LPROJ_DIRS = ['zh-Hans.lproj', 'zh_CN.lproj', 'zh.lproj'] as const

function parseTextInfoPlistStrings(text: string): string | null {
  const displayMatch = text.match(/(?:"CFBundleDisplayName"|CFBundleDisplayName)\s*=\s*"([^"]+)"/)
  if (displayMatch?.[1]?.trim()) return displayMatch[1].trim()
  const nameMatch = text.match(/(?:"CFBundleName"|CFBundleName)\s*=\s*"([^"]+)"/)
  if (nameMatch?.[1]?.trim()) return nameMatch[1].trim()
  return null
}

async function readLocalizedBundleNameFromStrings(appPath: string): Promise<string | null> {
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  for (const lproj of ZH_LPROJ_DIRS) {
    const stringsPath = path.join(resourcesDir, lproj, 'InfoPlist.strings')
    let buf: Buffer
    try {
      buf = await fs.promises.readFile(stringsPath)
    } catch {
      continue
    }
    if (buf.length === 0) continue
    if (buf.subarray(0, 6).toString('ascii') === 'bplist') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', stringsPath], {
          encoding: 'utf8',
          timeout: 500,
          maxBuffer: 65536
        })
        const parsed = JSON.parse(stdout) as { CFBundleDisplayName?: unknown; CFBundleName?: unknown }
        const name = (typeof parsed.CFBundleDisplayName === 'string' && parsed.CFBundleDisplayName.trim()) ||
          (typeof parsed.CFBundleName === 'string' && parsed.CFBundleName.trim()) ||
          ''
        if (name) return name.replace(/\.app$/i, '')
      } catch (error) {
        console.warn('[Spotlight] 应用本地化名称解析失败:', stringsPath, error)
      }
      continue
    }
    const isUtf16LE = buf[0] === 0xff && buf[1] === 0xfe
    const isUtf16BE = buf[0] === 0xfe && buf[1] === 0xff
    if ((isUtf16LE || isUtf16BE) && buf.length % 2 !== 0) {
      console.warn('[Spotlight] 应用本地化名称包含残缺 UTF-16 字节:', stringsPath)
      continue
    }
    const text = isUtf16LE
      ? buf.subarray(2).toString('utf16le')
      : isUtf16BE ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le') : buf.toString('utf8')
    const parsed = parseTextInfoPlistStrings(text)
    if (parsed) return parsed.replace(/\.app$/i, '')
  }
  return null
}

function decodeMdlsQuotedString(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '(null)') return ''
  const unwrapped = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
  return unwrapped.replace(/\\U([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * 批量解析 macOS 应用本地化显示名称（单次批量 mdls + InfoPlist.strings 兜底，避免逐个进程 fork 与 Spotlight 未索引漏配）
 */
export async function batchMacosApplicationNames(appPaths: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (appPaths.length === 0) return result
  const now = Date.now()
  const pendingPaths: string[] = []

  for (const appPath of appPaths) {
    const cached = displayNames.get(appPath)
    if (cached && cached.expires > now) {
      result.set(appPath, await cached.value)
    } else {
      pendingPaths.push(appPath)
    }
  }
  if (pendingPaths.length === 0) return result

  // 1. 单次批量调用 mdls 获取 Spotlight 已知的本地化名称
  const mdlsByFsName = new Map<string, string>()
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/mdls',
        ['-name', 'kMDItemDisplayName', '-name', 'kMDItemFSName', ...pendingPaths],
        { encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024 }
      )
      let currentDisplay = ''
      for (const line of stdout.split('\n')) {
        const displayMatch = line.match(/^\s*kMDItemDisplayName\s*=\s*(.+)$/)
        if (displayMatch?.[1]) {
          currentDisplay = decodeMdlsQuotedString(displayMatch[1]).replace(/\.app$/i, '')
          continue
        }
        const fsMatch = line.match(/^\s*kMDItemFSName\s*=\s*(.+)$/)
        if (fsMatch?.[1]) {
          const fsName = decodeMdlsQuotedString(fsMatch[1])
          if (fsName && currentDisplay) {
            mdlsByFsName.set(fsName, currentDisplay)
          }
          currentDisplay = ''
        }
      }
    } catch {
      // Spotlight 不可用或超时时自动走 InfoPlist.strings 兜底
    }
  }

  // 2. 对每个应用合并 mdls 结果与包内 InfoPlist.strings 本地化名称
  await Promise.all(pendingPaths.map(async (appPath) => {
    const baseName = path.basename(appPath)
    const fallback = path.basename(appPath, path.extname(appPath))
    let resolved = mdlsByFsName.get(baseName) || ''
    if (!resolved || resolved.toLowerCase() === fallback.toLowerCase()) {
      const bundleLocalized = await readLocalizedBundleNameFromStrings(appPath)
      if (bundleLocalized) {
        resolved = bundleLocalized
      }
    }
    const finalName = resolved || fallback
    result.set(appPath, finalName)
    if (displayNames.size >= 512) displayNames.delete(displayNames.keys().next().value!)
    displayNames.set(appPath, { expires: Date.now() + APP_NAME_CACHE_TTL_MS, value: Promise.resolve(finalName) })
  }))

  return result
}

/** Spotlight already knows the localized Finder name; fallback to bundle InfoPlist.strings if Spotlight is unindexed. */
export async function macosApplicationName(appPath: string): Promise<string> {
  const cached = displayNames.get(appPath)
  if (cached && cached.expires > Date.now()) return cached.value
  const fallback = path.basename(appPath, path.extname(appPath))
  if (!fs.existsSync(path.join(appPath, 'Contents'))) {
    const immediate = Promise.resolve(fallback)
    displayNames.set(appPath, { expires: Date.now() + APP_NAME_CACHE_TTL_MS, value: immediate })
    return immediate
  }
  const value = (async () => {
    const bundleLocalized = await readLocalizedBundleNameFromStrings(appPath)
    if (bundleLocalized) return bundleLocalized
    try {
      const { stdout } = await execFileAsync('/usr/bin/mdls', ['-raw', '-name', 'kMDItemDisplayName', '-nullMarker', '', appPath], {
        encoding: 'utf8', timeout: 400, maxBuffer: 8192
      })
      const cleaned = stdout.trim().replace(/\.app$/i, '')
      if (cleaned && cleaned !== '(null)') return cleaned
    } catch (error) {
      displayNames.delete(appPath)
      console.warn('[Spotlight] 应用显示名称读取失败:', error instanceof Error ? error.message : String(error))
    }
    return fallback
  })()
  if (displayNames.size >= 512) displayNames.delete(displayNames.keys().next().value!)
  displayNames.set(appPath, { expires: Date.now() + APP_NAME_CACHE_TTL_MS, value })
  return value
}
