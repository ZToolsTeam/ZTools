import fs from 'node:fs'
import type { FileRecord } from '../../services/sidecar-manager.js'

export interface ApplicationListCacheOptions {
  /** 完整扫描一次程序列表 */
  build: () => Promise<FileRecord[]>
  ttlMs: number
  /** 这些目录有变化（安装、卸载程序）时提前刷新；目录不存在或无法监听时只靠过期时间 */
  watchDirs?: () => readonly string[]
  recursiveWatch?: boolean
  /** 目录变化后等这么久再重扫，合并安装过程中的连续变化 */
  refreshDelayMs?: number
  now?: () => number
}

export interface ApplicationListCache {
  get(): Promise<FileRecord[]>
  invalidate(): void
  dispose(): void
}

/**
 * 程序列表缓存：过期后先返回旧列表、后台重扫（不让按键等扫描），程序目录变化时提前重扫。
 * 同一时间只有一次扫描；扫描失败时保留旧列表。
 */
export function createApplicationListCache(options: ApplicationListCacheOptions): ApplicationListCache {
  const now = options.now ?? Date.now
  const refreshDelayMs = options.refreshDelayMs ?? 1000
  let cache: { expires: number; apps: FileRecord[] } | null = null
  let pending: Promise<FileRecord[]> | null = null
  let watchers: fs.FSWatcher[] | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  // 每次目录变化加一；扫描期间有变化时，这次扫描可能没看到它，结果不算新鲜，完成后再扫一次
  let changeCount = 0

  const refresh = (): Promise<FileRecord[]> => {
    if (!pending) {
      const changesAtStart = changeCount
      pending = options.build()
        .then(apps => {
          if (!disposed) cache = { expires: changesAtStart === changeCount ? now() + options.ttlMs : 0, apps }
          return apps
        })
        .finally(() => {
          pending = null
          if (!disposed && changesAtStart !== changeCount) scheduleRefresh()
        })
    }
    return pending
  }

  const refreshInBackground = (): void => {
    refresh().catch(error => console.warn('[应用列表] 后台刷新失败，继续使用旧列表:', error))
  }

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refreshInBackground()
    }, refreshDelayMs)
    refreshTimer.unref?.()
  }

  const invalidate = (): void => {
    changeCount += 1
    if (cache) cache.expires = 0
    if (!disposed) scheduleRefresh()
  }

  const ensureWatchers = (): void => {
    if (watchers || !options.watchDirs) return
    watchers = []
    for (const dir of options.watchDirs()) {
      try {
        const watcher = fs.watch(dir, { persistent: false, recursive: options.recursiveWatch === true }, invalidate)
        watcher.on('error', () => watcher.close())
        watchers.push(watcher)
      } catch {
        // 目录不存在或不支持监听：只靠过期时间刷新
      }
    }
  }

  return {
    async get() {
      if (disposed) return cache?.apps ?? []
      ensureWatchers()
      if (cache && cache.expires > now()) return cache.apps
      if (cache) {
        refreshInBackground()
        return cache.apps
      }
      return refresh()
    },
    invalidate,
    dispose() {
      disposed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = null
      for (const watcher of watchers ?? []) watcher.close()
      watchers = null
    }
  }
}
