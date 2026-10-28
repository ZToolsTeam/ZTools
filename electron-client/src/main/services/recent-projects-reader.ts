import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { validateRecentProjectsScan, type RecentProject, type ProjectEditor } from '../../contracts/recent-projects.js'
import { describeProject, isAbsent, parseJetBrainsHistory, parseVscHistory, projectError, readProjectText, type ProjectSource } from './recent-projects-parser.js'

export interface ProjectsEnvironment { home: string; support: string }
export const projectsEnvironment = (platform = process.platform): ProjectsEnvironment => ({
  home: os.homedir(),
  // 编辑器配置根目录：macOS 为 Application Support，Windows 为 %APPDATA%（Roaming），两者下的子目录结构相同
  support: platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')) : path.join(os.homedir(), 'Library', 'Application Support')
})
const vscEditors: Array<[ProjectEditor, string, string, string]> = [
  ['vscode', 'VS Code', 'Code', '.vscode-shared'], ['vscode-insiders', 'VS Code Insiders', 'Code - Insiders', '.vscode-insiders-shared'],
  ['cursor', 'Cursor', 'Cursor', '.cursor-shared'], ['trae', 'Trae', 'Trae', '.trae-shared'], ['trae-cn', 'Trae CN', 'Trae CN', '.trae-cn-shared'], ['windsurf', 'Windsurf', 'Windsurf', '.windsurf-shared']
]
const jetbrains: Array<[RegExp, ProjectEditor, string]> = [
  [/^IntelliJIdea|^IdeaIC/, 'idea', 'IntelliJ IDEA'], [/^WebStorm/, 'webstorm', 'WebStorm'], [/^PyCharm/, 'pycharm', 'PyCharm'],
  [/^GoLand/, 'goland', 'GoLand'], [/^CLion/, 'clion', 'CLion'], [/^Rider/, 'rider', 'Rider'], [/^DataGrip/, 'datagrip', 'DataGrip'], [/^RustRover/, 'rustrover', 'RustRover']
]
function exists(file: string) { try { return fs.statSync(file).isFile() } catch (e) { if (isAbsent(e)) return false; throw e } }
export function readRecentProjectsDatabase(file: string): string | null {
  if (fs.statSync(file).size > 512 * 1024 * 1024) throw new Error('编辑器数据库超过 512 MiB')
  const db = new DatabaseSync(file, { readOnly: true, timeout: 1500, allowExtension: false, enableDoubleQuotedStringLiterals: false })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; BEGIN')
    const table = db.prepare('SELECT type FROM pragma_table_list WHERE schema=? AND name=?').all('main', 'ItemTable')
    if (table.length !== 1 || table[0]!.type !== 'table') throw new Error('编辑器数据库结构无效')
    const columns = db.prepare('SELECT name, hidden FROM pragma_table_xinfo(?)').all('ItemTable')
    if (columns.some(c => c.hidden !== 0) || !['key', 'value'].every(name => columns.some(c => c.name === name))) throw new Error('编辑器数据库列结构无效')
    // 只取本地最近项目这一项，不查询账号、令牌或其他编辑器状态。
    const rows = db.prepare("SELECT typeof(value) AS type, length(CAST(value AS BLOB)) AS bytes, CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=4194304 THEN value END AS value FROM ItemTable WHERE key=? LIMIT 2").all('history.recentlyOpenedPathsList')
    if (!rows.length) return null
    if (rows.length !== 1 || typeof rows[0]!.value !== 'string') throw new Error('最近项目数据类型无效或超过 4 MiB')
    return rows[0]!.value
  } finally { db.close() }
}
export function scanRecentProjects(env: ProjectsEnvironment) {
  const warnings: string[] = [], results = new Map<string, RecentProject>(); let sourcesRead = 0, skippedRemote = 0
  const add = (source: ProjectSource, candidates: Parameters<typeof describeProject>[0][]) => {
    for (const candidate of candidates) {
      if (results.size >= 5000) throw new Error('最近项目总数超过 5000 条')
      const item = describeProject(candidate, source, warnings), previous = results.get(item.id)
      if (!previous || (item.lastOpenedMs ?? 0) > (previous.lastOpenedMs ?? 0)) results.set(item.id, item)
    }
    sourcesRead++
  }
  for (const [editor, label, dir, shared] of vscEditors) {
    try {
      const base = path.join(env.support, dir, 'User', 'globalStorage')
      // 新版共享历史优先；存在但为空仍是权威结果，不重新引入旧数据库里已移除的记录。
      const databases = [path.join(env.home, shared, 'sharedStorage', 'state.vscdb'), path.join(base, 'state.vscdb')]
      let found = false
      for (const file of databases) {
        if (!exists(file)) continue
        const raw = readRecentProjectsDatabase(file)
        if (raw === null) continue
        const parsed = parseVscHistory(raw, env.home); skippedRemote += parsed.skippedRemote
        add({ editor, label, family: 'vsc', file, format: 'sqlite' }, parsed.projects); found = true; break
      }
      const file = path.join(base, 'storage.json')
      if (!found && exists(file)) {
        const data = JSON.parse(readProjectText(file)) as Record<string, unknown>
        const history = data['history.recentlyOpenedPathsList'] ?? data.openedPathsList
        if (history !== undefined) {
          const parsed = parseVscHistory(typeof history === 'string' ? history : JSON.stringify(history), env.home)
          skippedRemote += parsed.skippedRemote; add({ editor, label, family: 'vsc', file, format: 'json' }, parsed.projects)
        }
      }
    } catch (error) { warnings.push(`${label}：${projectError(error)}`) }
  }
  const root = path.join(env.support, 'JetBrains')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(root); if (dirs.length > 256) throw new Error('JetBrains 配置目录超过 256 个') }
  catch (error) { if (!isAbsent(error)) warnings.push(`JetBrains：${projectError(error)}`); dirs = [] }
  for (const dir of dirs) {
    const editor = jetbrains.find(([prefix]) => prefix.test(dir))
    if (!editor) continue
    try {
      const file = path.join(root, dir, 'options', 'recentProjects.xml')
      if (!exists(file)) continue
      add({ editor: editor[1], label: editor[2], family: 'jetbrains', file, format: 'xml' }, parseJetBrainsHistory(readProjectText(file), env.home, path.dirname(path.dirname(file))))
    } catch (error) { warnings.push(`${dir}：${projectError(error)}`) }
  }
  // VS Code 未保存时间戳，保留其真实历史顺序；只按已有的 JetBrains 时间排序。
  const projects = [...results.values()].sort((a, b) => a.family === b.family && a.family === 'jetbrains' ? (b.lastOpenedMs ?? 0) - (a.lastOpenedMs ?? 0) : 0)
  if (warnings.length > 256) throw new Error('项目读取错误超过 256 项，请检查编辑器配置权限')
  return validateRecentProjectsScan({ success: true, projects, warnings, sourcesRead, skippedRemote })
}
