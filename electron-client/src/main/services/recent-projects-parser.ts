import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DOMParser, type Element } from '@xmldom/xmldom'
import type { ProjectEditor, RecentProject } from '../../contracts/recent-projects.js'

export interface ProjectSource { editor: ProjectEditor; label: string; family: 'vsc' | 'jetbrains'; file: string; format: 'sqlite' | 'xml' | 'json' }
export interface ProjectCandidate { path: string; kind: 'folder' | 'workspace'; timestamp: number | null }
export const projectError = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1500)
export const isAbsent = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((e as NodeJS.ErrnoException)?.code))
export function readProjectText(file: string, limit = 4 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('History file is not a regular file or exceeds size limit')
    const bytes = Buffer.alloc(limit + 1); let n = 0, read = 0
    do { read = fs.readSync(fd, bytes, n, bytes.length - n, null); n += read } while (read && n < bytes.length)
    if (n > limit) throw new Error('History file exceeds size limit')
    return bytes.subarray(0, n).toString('utf8')
  } finally { fs.closeSync(fd) }
}
/** pathApi 默认为当前平台的 path；测试可传入 path.win32 在 macOS 上覆盖 Windows 盘符路径分支 */
function localPath(value: string, home: string, configDir?: string, pathApi: path.PlatformPath = path) {
  if (value.startsWith('file:')) {
    const uri = new URL(value)
    if (uri.hostname && uri.hostname !== 'localhost') return null
    if (uri.search || uri.hash) throw new Error('Local project URI contains disallowed query or fragment')
    value = fileURLToPath(uri, { windows: pathApi.sep === '\\' })
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // Windows 盘符路径（C:\ 或 C:/）形似 URI 协议，只在 Windows 上按本地路径处理，其余协议视为远程
    if (!(pathApi.sep === '\\' && /^[A-Za-z]:[\\/]/.test(value))) return null
  }
  value = value.replace(/^\$USER_HOME\$(?=\/|$)/, () => home)
  if (configDir) value = value.replace(/^\$APPLICATION_CONFIG_DIR\$(?=\/|$)/, () => configDir)
  // 按当前平台判断绝对路径：macOS 以 / 开头，Windows 为 C:\ 或 UNC 路径
  if (!pathApi.isAbsolute(value) || value.includes('\0') || value.length > 16384) throw new Error('Invalid project path')
  return pathApi.normalize(value)
}
export function parseVscHistory(raw: string, home: string, pathApi: path.PlatformPath = path) {
  const data = JSON.parse(raw) as { entries?: unknown }
  if (!data || !Array.isArray(data.entries) || data.entries.length > 10000) throw new Error('Invalid editor recent projects format')
  const projects: ProjectCandidate[] = []; let skippedRemote = 0
  for (const item of data.entries) {
    if (!item || typeof item !== 'object') throw new Error('Invalid editor history entry')
    // 最近文件不是工程，不能混入项目列表。
    if ('fileUri' in item && !('folderUri' in item) && !('workspace' in item)) continue
    const folder = 'folderUri' in item, value = folder ? item.folderUri : item.workspace?.configPath
    if (typeof value !== 'string') throw new Error('Missing editor project URI')
    const target = localPath(value, home, undefined, pathApi)
    if (!target || item.remoteAuthority) { skippedRemote++; continue }
    projects.push({ path: target, kind: folder ? 'folder' : 'workspace', timestamp: null })
  }
  return { projects, skippedRemote }
}
function children(element: Element, tag: string) { return Array.from(element.childNodes).filter((n): n is Element => n.nodeType === 1 && n.nodeName === tag) }
export function parseJetBrainsHistory(raw: string, home: string, configDir?: string, pathApi: path.PlatformPath = path) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('Project history XML must not contain DTD or entity declarations')
  const doc = new DOMParser({ onError: (_level, message) => { throw new Error(`Invalid project history XML: ${message}`) } }).parseFromString(raw, 'application/xml')
  if (doc.documentElement?.tagName !== 'application') throw new Error('Invalid project history XML root element')
  const component = children(doc.documentElement, 'component').find(e => e.getAttribute('name') === 'RecentProjectsManager')
  if (!component) throw new Error('JetBrains recent projects node not found')
  const options = children(component, 'option'), entries = options.filter(e => e.getAttribute('name') === 'additionalInfo').flatMap(e => children(e, 'map')).flatMap(e => children(e, 'entry'))
  if (entries.length > 5000) throw new Error('JetBrains recent projects exceed 5000 entries')
  const projects: ProjectCandidate[] = []
  for (const entry of entries) {
    const target = localPath(entry.getAttribute('key') || '', home, configDir, pathApi)
    if (!target) continue
    const times = Array.from(entry.getElementsByTagName('option')).filter(e => ['activationTimestamp', 'projectOpenTimestamp'].includes(e.getAttribute('name') || '')).map(e => Number(e.getAttribute('value'))).filter(n => Number.isSafeInteger(n) && n > 0 && n <= 8640000000000000)
    projects.push({ path: target, kind: 'folder', timestamp: times.length ? Math.max(...times) : null })
  }
  // 老版只有 lastOpenedProject；读取其真实路径，但不伪造打开时间。
  const last = options.find(e => e.getAttribute('name') === 'lastOpenedProject')?.getAttribute('value')
  if (last) {
    const target = localPath(last, home, configDir, pathApi)
    if (target && !projects.some(p => p.path === target)) projects.push({ path: target, kind: 'folder', timestamp: null })
  }
  return projects
}
function gitBranch(directory: string): string | null {
  let current = directory
  for (let depth = 0; depth < 50; depth++) {
    const marker = path.join(current, '.git')
    try {
      const stat = fs.statSync(marker)
      const gitDir = stat.isDirectory() ? marker : path.resolve(current, readProjectText(marker, 8192).replace(/^gitdir:\s*/, '').trim())
      if (!stat.isDirectory() && !readProjectText(marker, 8192).startsWith('gitdir: ')) throw new Error('Invalid Git worktree pointer')
      const head = readProjectText(path.join(gitDir, 'HEAD'), 8192).trim()
      if (head.startsWith('ref: refs/heads/')) return head.slice(16).slice(0, 1024)
      if (/^[a-f\d]{40,64}$/i.test(head)) return head.slice(0, 7)
      throw new Error('Invalid Git HEAD format')
    } catch (error) { if (!isAbsent(error)) throw error }
    const parent = path.dirname(current); if (parent === current) break; current = parent
  }
  return null
}
export function describeProject(candidate: ProjectCandidate, source: ProjectSource, warnings: string[]): RecentProject {
  const result: RecentProject = { id: createHash('sha256').update(`${source.editor}\0${candidate.path}`).digest('hex'), path: candidate.path, name: path.basename(candidate.path) || candidate.path, editor: source.editor, editorName: source.label, family: source.family, kind: candidate.kind, lastOpenedMs: candidate.timestamp, gitBranch: null, pathState: 'available', pathError: null }
  try {
    const stat = fs.statSync(candidate.path)
    if (candidate.kind === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error('Project path type changed')
    fs.accessSync(candidate.path, fs.constants.R_OK | (candidate.kind === 'folder' ? fs.constants.X_OK : 0))
  } catch (error) { result.pathState = isAbsent(error) ? 'missing' : 'unreadable'; result.pathError = projectError(error); return result }
  try { result.gitBranch = gitBranch(candidate.kind === 'folder' ? candidate.path : path.dirname(candidate.path)) }
  catch (error) { warnings.push(`${source.label} / ${result.name}: Failed to read Git branch: ${projectError(error)}`.slice(0, 2048)) }
  return result
}
