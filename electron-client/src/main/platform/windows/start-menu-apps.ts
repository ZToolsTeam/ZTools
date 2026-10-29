import fs from 'node:fs'
import path from 'node:path'
import type { FileRecord } from '../../services/sidecar-manager.js'

import { createApplicationListCache } from '../common/application-list-cache.js'

const START_MENU_CACHE_TTL_MS = 5 * 60_000
const MAX_START_MENU_DEPTH = 4
const MAX_START_MENU_ENTRIES = 5000
/** 卸载、帮助、官网之类的快捷方式不是用户要打开的程序 */
const NON_APPLICATION_SHORTCUT_RE = /uninstall|卸载|readme|帮助|\bhelp\b|website|官网|release notes/i

/** 当前用户与所有用户的开始菜单「程序」目录（当前用户在前，同名快捷方式以它为准） */
export function windowsStartMenuDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  if (env.APPDATA) dirs.push(path.win32.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  const programData = env.ProgramData || env.PROGRAMDATA || path.win32.join(env.SystemDrive || 'C:', 'ProgramData')
  dirs.push(path.win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  return dirs
}

/**
 * 扫描开始菜单里的程序快捷方式（.lnk）。显示名取快捷方式文件名（与开始菜单一致），
 * 同名的只保留先找到的一个。商店应用（UWP）不在这些目录里，不包含在内。
 */
export async function scanStartMenuApplications(roots: readonly string[]): Promise<FileRecord[]> {
  const apps: FileRecord[] = []
  const seenNames = new Set<string>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_START_MENU_DEPTH || apps.length >= MAX_START_MENU_ENTRIES) return
    let entries: fs.Dirent[] = []
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(fullPath, depth + 1)
        continue
      }
      if (!ent.isFile() || !/\.lnk$/i.test(ent.name)) continue
      const displayName = ent.name.replace(/\.lnk$/i, '').trim()
      const nameKey = displayName.toLowerCase()
      if (!displayName || NON_APPLICATION_SHORTCUT_RE.test(displayName) || seenNames.has(nameKey)) continue
      try {
        const stat = await fs.promises.stat(fullPath)
        seenNames.add(nameKey)
        apps.push({
          kind: 'application',
          display_name: displayName,
          name: ent.name,
          path: fullPath,
          is_dir: false,
          size: Number(stat.size || 0),
          mtime: Math.round(Number(stat.mtimeMs || 0)),
          acronym: '',
          pinyin: ''
        })
      } catch {
        // 快捷方式在扫描期间被删除或无权限
      }
      if (apps.length >= MAX_START_MENU_ENTRIES) return
    }
  }
  for (const root of roots) await walk(root, 0)
  return apps
}

const startMenuApplications = createApplicationListCache({
  build: () => scanStartMenuApplications(windowsStartMenuDirectories()),
  ttlMs: START_MENU_CACHE_TTL_MS,
  watchDirs: windowsStartMenuDirectories,
  recursiveWatch: true
})

export async function getCachedStartMenuApplications(): Promise<FileRecord[]> {
  if (process.platform !== 'win32') return []
  return startMenuApplications.get()
}
