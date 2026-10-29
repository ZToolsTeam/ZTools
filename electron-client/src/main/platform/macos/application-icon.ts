import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ICON_SCRIPT = `
ObjC.import('AppKit')
function run(argv) {
  const source = $.NSWorkspace.sharedWorkspace.iconForFile($(argv[0]))
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64))
  image.lockFocus
  try {
    source.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1)
  } finally {
    image.unlockFocus
  }
  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation)
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0))
}`

// 一次进程渲染多个图标（预取用）：逐个输出，单个失败输出空串，不影响同批其它程序
const BATCH_ICON_SCRIPT = `
ObjC.import('AppKit')
function render(appPath) {
  try {
    const source = $.NSWorkspace.sharedWorkspace.iconForFile($(appPath))
    const image = $.NSImage.alloc.initWithSize($.NSMakeSize(64, 64))
    image.lockFocus
    try {
      source.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 64, 64), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1)
    } finally {
      image.unlockFocus
    }
    const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation)
    const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}))
    return ObjC.unwrap(png.base64EncodedStringWithOptions(0))
  } catch (error) {
    return ''
  }
}
function run(argv) {
  return JSON.stringify(argv.map(render))
}`

const MAX_ICON_BASE64_LENGTH = 256 * 1024
const ICON_BATCH_SIZE = 16
const MAX_CACHED_ICONS = 512
const ICON_PREFETCH_DELAY_MS = 3000

type IconRunner = (executable: string, args: readonly string[]) => Promise<string>
const runIconScript: IconRunner = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, shell: false
  })
  return stdout
}
const runBatchIconScript: IconRunner = async (executable, args) => {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: 'utf8', timeout: 15_000, maxBuffer: ICON_BATCH_SIZE * MAX_ICON_BASE64_LENGTH + 4096, shell: false
  })
  return stdout
}

function assertApplicationPath(appPath: string): void {
  if (!path.posix.isAbsolute(appPath) || appPath.includes('\0') || !appPath.toLowerCase().endsWith('.app')) {
    throw new Error('无效的 macOS 应用路径')
  }
}

function toPngDataUrl(output: string): string {
  const base64 = output.trim()
  if (base64.length > MAX_ICON_BASE64_LENGTH || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('macOS 应用图标读取失败')
  }
  return `data:image/png;base64,${base64}`
}

/** NSWorkspace resolves the bundle's real icon; Electron's MIME icon can be generic for .app. */
export async function readMacosApplicationIcon(appPath: string, run: IconRunner = runIconScript): Promise<string> {
  assertApplicationPath(appPath)
  return toPngDataUrl(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ICON_SCRIPT, appPath]))
}

export interface MacosIconCacheOptions {
  run?: IconRunner
  runBatch?: IconRunner
  /** 程序包的修改时间；程序升级后包会被替换，时间变化即重新读取 */
  readMtime?: (appPath: string) => Promise<number>
  prefetchDelayMs?: number
}

/**
 * 程序图标缓存：按「路径 + 程序包修改时间」缓存，同一个程序同时只读一次；
 * 程序列表加载后可以在后台分批预取，之后搜索结果里的图标直接从缓存返回。
 */
export function createMacosApplicationIconCache(options: MacosIconCacheOptions = {}) {
  const run = options.run ?? runIconScript
  const runBatch = options.runBatch ?? runBatchIconScript
  const readMtime = options.readMtime ?? (async (appPath: string) => (await fs.promises.stat(appPath)).mtimeMs)
  const cache = new Map<string, { mtimeMs: number; dataUrl: string }>()
  const pending = new Map<string, Promise<string>>()
  const prefetchQueue: string[] = []
  const queued = new Set<string>()
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null
  let prefetching = false

  const store = (appPath: string, mtimeMs: number, dataUrl: string): void => {
    cache.delete(appPath)
    if (cache.size >= MAX_CACHED_ICONS) cache.delete(cache.keys().next().value!)
    cache.set(appPath, { mtimeMs, dataUrl })
  }

  const cached = (appPath: string, mtimeMs: number): string | null => {
    const hit = cache.get(appPath)
    if (!hit || hit.mtimeMs !== mtimeMs) return null
    cache.delete(appPath)
    cache.set(appPath, hit)
    return hit.dataUrl
  }

  async function read(appPath: string): Promise<string> {
    assertApplicationPath(appPath)
    const mtimeMs = await readMtime(appPath).catch(() => -1)
    const hit = cached(appPath, mtimeMs)
    if (hit) return hit
    const pendingKey = `${appPath}\0${mtimeMs}`
    let request = pending.get(pendingKey)
    if (!request) {
      request = readMacosApplicationIcon(appPath, run)
        .then(dataUrl => {
          store(appPath, mtimeMs, dataUrl)
          return dataUrl
        })
        .finally(() => pending.delete(pendingKey))
      pending.set(pendingKey, request)
    }
    return request
  }

  async function prefetchBatch(paths: string[]): Promise<void> {
    const entries = await Promise.all(paths.map(async appPath => ({
      appPath,
      mtimeMs: await readMtime(appPath).catch(() => -1)
    })))
    const missing = entries.filter(entry => !cached(entry.appPath, entry.mtimeMs))
    if (missing.length === 0) return
    let rendered: unknown
    try {
      const output = await runBatch('/usr/bin/osascript', ['-l', 'JavaScript', '-e', BATCH_ICON_SCRIPT, ...missing.map(entry => entry.appPath)])
      rendered = JSON.parse(output)
    } catch (error) {
      console.warn('[应用图标] 批量预取失败:', error instanceof Error ? error.message : String(error))
      return
    }
    if (!Array.isArray(rendered)) return
    missing.forEach((entry, index) => {
      try {
        store(entry.appPath, entry.mtimeMs, toPngDataUrl(String(rendered[index] ?? '')))
      } catch {
        // 单个程序没有可用图标：等界面需要时再单独读取
      }
    })
  }

  async function drainPrefetchQueue(): Promise<void> {
    if (prefetching) return
    prefetching = true
    try {
      while (prefetchQueue.length > 0) {
        const batch = prefetchQueue.splice(0, ICON_BATCH_SIZE)
        await prefetchBatch(batch)
      }
    } finally {
      prefetching = false
    }
  }

  /** 后台分批预取（延迟启动，避开开机与窗口首次加载）；已排队或已缓存的不重复取 */
  function prefetch(appPaths: readonly string[]): void {
    for (const appPath of appPaths) {
      try {
        assertApplicationPath(appPath)
      } catch {
        continue
      }
      if (queued.has(appPath)) continue
      queued.add(appPath)
      prefetchQueue.push(appPath)
    }
    if (prefetchQueue.length === 0 || prefetchTimer || prefetching) return
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null
      void drainPrefetchQueue()
    }, options.prefetchDelayMs ?? ICON_PREFETCH_DELAY_MS)
    prefetchTimer.unref?.()
  }

  return { read, prefetch }
}

const defaultIconCache = createMacosApplicationIconCache()

/** 宿主取程序图标的入口（带缓存） */
export function readMacosApplicationIconCached(appPath: string): Promise<string> {
  return defaultIconCache.read(appPath)
}

export function prefetchMacosApplicationIcons(appPaths: readonly string[]): void {
  defaultIconCache.prefetch(appPaths)
}
