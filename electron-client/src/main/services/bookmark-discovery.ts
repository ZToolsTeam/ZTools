import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BookmarkSource } from './bookmark-parser.js'

export interface BookmarkEnvironment { platform: string; home: string; localAppData: string; appData: string }
export function bookmarkEnvironment(): BookmarkEnvironment {
  const home = os.homedir()
  return { platform: process.platform, home, localAppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), appData: process.env.APPDATA || path.join(home, 'AppData', 'Roaming') }
}
export function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
export function readBookmarkFile(file: string, limit = 16 * 1024 * 1024): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.size > limit) throw new Error(`File is not a regular file or exceeds ${limit / 1024 / 1024} MiB`)
    const bytes = Buffer.alloc(before.size + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd)
    if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error('Browser is updating bookmarks, please refresh later')
    return bytes.subarray(0, count)
  } finally { fs.closeSync(fd) }
}
export function discoverBookmarks(env: BookmarkEnvironment) {
  if (!['darwin', 'win32'].includes(env.platform)) throw new Error('Automatic browser bookmark reading is not supported on this platform')
  const sources: BookmarkSource[] = [], warnings: string[] = [], seen = new Set<string>()
  const add = (source: BookmarkSource) => {
    if (sources.length >= 256) throw new Error('More than 256 browser profiles found, cannot complete scan')
    try {
      const stats = fs.statSync(source.file)
      if (!stats.isFile()) throw new Error('Bookmark source is not a regular file')
      const key = fs.realpathSync(source.file)
      if (!seen.has(key)) { seen.add(key); sources.push({ ...source, file: key }) }
    } catch (error) { if (!missing(error)) warnings.push(`${source.browserLabel} / ${source.profile}: ${errorMessage(error, source.browser)}`) }
  }
  const entries = (dir: string, label: string) => {
    try {
      const names = fs.readdirSync(dir, { withFileTypes: true })
      if (names.length > 4096) throw new Error('Too many entries in browser profile directory')
      return names.filter(entry => {
        if (!entry.isSymbolicLink()) return entry.isDirectory()
        try { return fs.statSync(path.join(dir, entry.name)).isDirectory() }
        catch (error) { if (!missing(error)) warnings.push(`${label} / ${entry.name}: ${errorMessage(error)}`); return false }
      }).map(entry => entry.name).sort()
    } catch (error) { if (!missing(error)) warnings.push(`${label}: ${errorMessage(error)}`); return [] }
  }
  const support = path.join(env.home, 'Library', 'Application Support')
  const roots: Array<[BookmarkSource['browser'], string, string]> = env.platform === 'darwin' ? [
    ['chrome', 'Chrome', path.join(support, 'Google', 'Chrome')],
    ['edge', 'Edge', path.join(support, 'Microsoft Edge')],
    ['brave', 'Brave', path.join(support, 'BraveSoftware', 'Brave-Browser')],
    ['qqbrowser', 'QQ Browser', path.join(support, 'QQBrowser')],
    ['360chrome', '360 Extreme', path.join(support, '360Chrome')]
  ] : [
    ['chrome', 'Chrome', path.join(env.localAppData, 'Google', 'Chrome', 'User Data')],
    ['edge', 'Edge', path.join(env.localAppData, 'Microsoft', 'Edge', 'User Data')],
    ['brave', 'Brave', path.join(env.localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['qqbrowser', 'QQ Browser', path.join(env.localAppData, 'Tencent', 'QQBrowser', 'User Data')],
    ['qqbrowser', 'QQ Browser', path.join(env.localAppData, 'Tencent', 'QQBrowser')],
    ['360chrome', '360 Extreme', path.join(env.localAppData, '360ChromeX', 'Chrome', 'User Data')],
    ['360chrome', '360 Extreme', path.join(env.localAppData, '360Chrome', 'Chrome', 'User Data')],
    ['360se', '360 Secure', path.join(env.appData, '360se6', 'User Data')]
  ]
  for (const [browser, browserLabel, root] of roots) {
    for (const profile of entries(root, browserLabel)) add({ browser, browserLabel, profile, file: path.join(root, profile, 'Bookmarks'), format: 'chromium' })
    add({ browser, browserLabel, profile: 'Default', file: path.join(root, 'Bookmarks'), format: 'chromium' })
  }
  const firefoxRoot = env.platform === 'darwin' ? path.join(support, 'Firefox') : path.join(env.appData, 'Mozilla', 'Firefox')
  const firefox = (folder: string, profile: string) => add({ browser: 'firefox', browserLabel: 'Firefox', profile, file: path.join(folder, 'places.sqlite'), format: 'firefox' })
  for (const profile of entries(path.join(firefoxRoot, 'Profiles'), 'Firefox')) firefox(path.join(firefoxRoot, 'Profiles', profile), profile)
  try {
    const ini = readBookmarkFile(path.join(firefoxRoot, 'profiles.ini'), 1024 * 1024).toString('utf8')
    for (const section of ini.split(/^\[/m).slice(1)) {
      if (!/^Profile\d+\]/.test(section)) continue
      const field = (key: string) => section.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1).trim()
      const file = field('Path')
      if (file) firefox(field('IsRelative') === '0' ? path.resolve(file) : path.resolve(firefoxRoot, file), field('Name') || path.basename(file))
    }
  } catch (error) { if (!missing(error)) warnings.push(`Firefox profiles: ${errorMessage(error)}`) }
  if (env.platform === 'darwin') add({ browser: 'safari', browserLabel: 'Safari', profile: 'Default', file: path.join(env.home, 'Library', 'Safari', 'Bookmarks.plist'), format: 'safari' })
  return { sources, warnings }
}
export function errorMessage(error: unknown, browser?: string): string {
  const code = (error as NodeJS.ErrnoException)?.code
  // Safari 书签在 ~/Library/Safari 下，macOS 只对拥有“完全磁盘访问”的应用开放
  if ((code === 'EACCES' || code === 'EPERM') && browser === 'safari') return 'Permission denied; grant Full Disk Access to ZTools in System Settings > Privacy & Security, then reopen ZTools'
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied; check file access permissions for ZTools in system privacy settings'
  if (code === 'EBUSY' || code === 'SQLITE_BUSY') return 'Browser is currently using the bookmark database, please refresh later'
  return error instanceof Error ? error.message.slice(0, 1000) : 'Failed to read bookmarks'
}
