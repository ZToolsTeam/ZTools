/**
 * ZTools 2.0 标杆原生插件: 本地 SQLite 数据库多表管理与导出工坊 (SQLite Plugin 2.0)
 * - 初始数据库与表结构为空，完全由用户显式导入（选择文件、选择文件夹、拖入或粘贴）维护
 * - 切换选中数据库仅读取目标库表结构，绝不触发任何目录扫描
 */

import {
  formatBytes,
  invokeHostCapability,
  invokePluginService,
  openRealPath,
  showRealItemInFolder,
  writeRealClipboardText,
  type NativeInvocationResult
} from '../shared/native-ipc.js'
import {
  type ExampleImportRules,
  type ExampleImportedFile,
  pickExampleFolderFiles
} from '../shared/file-import.js'

export { formatBytes }
export type { NativeInvocationResult }

export const DLL_PLUGIN_NAME = 'SqlitePlugin'
export const FORBIDDEN_TARGET_PATTERN = /(\.\.[\\/]|DROP\s+(?:DATABASE|TABLE)|xp_cmdshell)/i
export const FORBIDDEN_REASON = '禁止包含路径穿越或高危破坏性系统指令'

export const SQLITE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3', '.db3'] as const
export const SQLITE_SUPPORTED_TEXT = '.db / .sqlite / .sqlite3 / .db3'

export const SQLITE_IMPORT_RULES: ExampleImportRules = {
  extensions: SQLITE_EXTENSIONS,
  maxDepth: 5,
  maxFiles: 500
}

export type SqliteTableId =
  | 'all_tables'
  | 'clipboard_history'
  | 'snippets'
  | 'notes'
  | 'plugin_kv_cache'
  | 'audit_logs'
  | string

export interface SqliteDatabaseFile {
  id: string
  name: string
  path: string
  sizeBytes: number
  journalMode: 'WAL' | 'DELETE'
}

export interface SqliteTableMeta {
  id: SqliteTableId
  tableName: string
  displayName: string
  rowCount: number
  sizeBytes: number
  indexes: string[]
  schemaSummary: string
}

export interface SqliteRowRecord {
  id: string
  tableId: SqliteTableId
  tableName: string
  primaryKey: string
  summaryTitle: string
  rowJsonPreview: string
  columnSchema: string
  sizeBytes: number
  updatedAt: string
}

export interface SqliteWorkspaceSnapshot {
  databases: SqliteDatabaseFile[]
  activeDbPath: string
  tables: SqliteTableMeta[]
  rows: SqliteRowRecord[]
  totalSizeBytes: number
  updatedAt: string
  error?: string
}

export const SQLITE_TABLES: SqliteTableMeta[] = []

export function createEmptySqliteWorkspace(error?: string): SqliteWorkspaceSnapshot {
  return {
    databases: [],
    activeDbPath: '',
    tables: [],
    rows: [],
    totalSizeBytes: 0,
    updatedAt: '',
    ...(error ? { error } : {})
  }
}

export function toSqliteDatabaseFile(file: ExampleImportedFile, index = 0): SqliteDatabaseFile {
  return {
    id: `db-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    sizeBytes: file.sizeBytes ?? 0,
    journalMode: 'WAL'
  }
}

export function validateInvocationPayload(
  method: string,
  params: Record<string, unknown>
): { valid: boolean; reason?: string } {
  if (!method || typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, reason: '调用方法名 (method) 不能为空' }
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, reason: '调用参数 (params) 必须是非空对象' }
  }
  const dbPath = String(params.dbPath || params.sql || params.target || '')
  if (dbPath && FORBIDDEN_TARGET_PATTERN.test(dbPath)) {
    return { valid: false, reason: FORBIDDEN_REASON }
  }
  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostOverride?: unknown
): Promise<NativeInvocationResult> {
  const validation = validateInvocationPayload(method, params)
  if (!validation.valid) {
    return {
      ok: false,
      code: -1,
      message: `VALIDATION_FAILED: ${validation.reason}`,
      error: `VALIDATION_FAILED: ${validation.reason}`
    }
  }
  return invokePluginService(DLL_PLUGIN_NAME, method.trim(), params, hostOverride)
}

/**
 * 仅查看指定 SQLite 数据库的表结构与采样记录（不扫描任何系统目录）
 */
export async function fetchSqliteWorkspace(
  activeDbPath?: string,
  hostBridge?: unknown
): Promise<SqliteWorkspaceSnapshot> {
  const targetDbPath = String(activeDbPath || '').trim()
  if (!targetDbPath) {
    return createEmptySqliteWorkspace()
  }
  if (FORBIDDEN_TARGET_PATTERN.test(targetDbPath)) {
    return createEmptySqliteWorkspace(FORBIDDEN_REASON)
  }

  try {
    const inspectRes = await invokeHostCapability<Record<string, unknown>>(
      'sqlite.inspectWorkspace',
      { dbPath: targetDbPath },
      hostBridge
    )

    if (!inspectRes.ok || !inspectRes.data) {
      return createEmptySqliteWorkspace(inspectRes.error || inspectRes.message || '未能读取 SQLite 数据库结构')
    }

    const rawTables = Array.isArray(inspectRes.data.tables) ? (inspectRes.data.tables as Array<Record<string, unknown>>) : []
    const rawRows = Array.isArray(inspectRes.data.rows) ? (inspectRes.data.rows as Array<Record<string, unknown>>) : []
    const tables: SqliteTableMeta[] = rawTables.map((t, idx) => {
      const tName = String(t.tableName || t.name || `table_${idx}`)
      return {
        id: String(t.id || tName),
        tableName: tName,
        displayName: String(t.displayName || `${tName} (${t.rowCount ?? 0} 行)`),
        rowCount: Number(t.rowCount ?? 0),
        sizeBytes: Number(t.sizeBytes ?? 4096),
        indexes: Array.isArray(t.indexes) ? t.indexes.map(String) : [],
        schemaSummary: String(t.schemaSummary || t.schema || 'id PRIMARY KEY')
      }
    })

    const rows: SqliteRowRecord[] = rawRows.map((r, idx) => {
      const tName = String(r.tableName || r.table || tables[0]?.tableName || 'sqlite_master')
      const pk = String(r.primaryKey ?? r.id ?? idx + 1)
      const preview = typeof r.rowJsonPreview === 'string' ? r.rowJsonPreview : JSON.stringify(r.data ?? r)
      return {
        id: String(r.id || `row_${tName}_${idx}`),
        tableId: String(r.tableId || tName),
        tableName: tName,
        primaryKey: pk,
        summaryTitle: String(r.summaryTitle || `[${tName} #${pk}] ${preview.slice(0, 64)}`),
        rowJsonPreview: preview,
        columnSchema: String(r.columnSchema || tables.find(t => t.tableName === tName)?.schemaSummary || ''),
        sizeBytes: Number(r.sizeBytes ?? Math.max(64, preview.length)),
        updatedAt: String(r.updatedAt || '实时查询')
      }
    })

    const dbName = targetDbPath.split(/[\\/]/).pop() || 'active.sqlite'
    const dbFile: SqliteDatabaseFile = {
      id: `db-${targetDbPath}`,
      name: dbName,
      path: targetDbPath,
      sizeBytes: tables.reduce((s, t) => s + t.sizeBytes, 0) || Number(inspectRes.data.sizeBytes ?? 0),
      journalMode: 'WAL'
    }

    return {
      databases: [dbFile],
      activeDbPath: targetDbPath,
      tables,
      rows,
      totalSizeBytes: tables.reduce((acc, t) => acc + t.sizeBytes, 0),
      updatedAt: new Date().toLocaleTimeString()
    }
  } catch (err) {
    return createEmptySqliteWorkspace(err instanceof Error ? err.message : String(err))
  }
}

/**
 * 通过用户显式选择文件夹导入其中的 SQLite 数据库文件列表
 */
export async function importSqliteDatabasesFromFolder(hostBridge?: unknown): Promise<SqliteDatabaseFile[]> {
  const res = await pickExampleFolderFiles(
    SQLITE_IMPORT_RULES,
    { title: '选择包含 SQLite 数据库的文件夹' },
    hostBridge
  )
  return res.files.map((f, idx) => toSqliteDatabaseFile(f, idx))
}

export type SqlExportFormat = 'json' | 'csv' | 'sql_insert'

export async function exportTableRecords(
  records: SqliteRowRecord[],
  format: SqlExportFormat,
  hostBridge?: unknown
): Promise<{ ok: boolean; exportedText: string; message: string }> {
  if (!records || records.length === 0) {
    return { ok: false, exportedText: '', message: '请先勾选至少一条待导出的数据表记录' }
  }

  let exportedText = ''
  if (format === 'json') {
    exportedText = JSON.stringify(
      records.map(r => ({ table: r.tableName, pk: r.primaryKey, preview: r.rowJsonPreview })),
      null,
      2
    )
  } else if (format === 'csv') {
    const header = 'table_name,primary_key,updated_at,size_bytes'
    const lines = records.map(r => `"${r.tableName}","${r.primaryKey}","${r.updatedAt}",${r.sizeBytes}`)
    exportedText = [header, ...lines].join('\n')
  } else {
    exportedText = records
      .map(r => `INSERT INTO "${r.tableName}" (pk, payload_json) VALUES ('${r.primaryKey}', '${r.rowJsonPreview.replace(/'/g, "''")}');`)
      .join('\n')
  }

  await writeRealClipboardText(exportedText, hostBridge)
  return {
    ok: true,
    exportedText,
    message: `已将 ${records.length} 条记录导出为 ${format.toUpperCase()} 格式并复制到剪贴板`
  }
}

export async function executeSqliteQuery(
  dbPathOrTarget: string | { dbPath?: string; activeDbPath?: string },
  sql: string,
  hostOverride?: unknown
): Promise<{
  ok: boolean
  rows?: unknown[]
  affectedRows?: number
  data?: unknown
  error?: string
  message: string
}> {
  const dbPath =
    typeof dbPathOrTarget === 'string'
      ? dbPathOrTarget
      : String(dbPathOrTarget?.dbPath || dbPathOrTarget?.activeDbPath || '')
  const trimmedSql = String(sql || '').trim()
  if (!trimmedSql || FORBIDDEN_TARGET_PATTERN.test(trimmedSql) || FORBIDDEN_TARGET_PATTERN.test(dbPath)) {
    return { ok: false, rows: [], affectedRows: 0, error: FORBIDDEN_REASON, message: FORBIDDEN_REASON }
  }

  const hostRec = hostOverride as { sqlite_execute?: unknown; dllplugin_call?: unknown } | undefined
  const primaryCap = typeof hostRec?.sqlite_execute === 'function' ? 'sqlite.execute' : 'sqlite.query'
  const fallbackCap = primaryCap === 'sqlite.query' ? 'sqlite.execute' : 'sqlite.query'
  let res = await invokeHostCapability<Record<string, unknown>>(primaryCap, { dbPath, sql: trimmedSql }, hostOverride)
  if (!res.ok && !hostRec?.dllplugin_call) {
    res = await invokeHostCapability<Record<string, unknown>>(fallbackCap, { dbPath, sql: trimmedSql }, hostOverride)
  }
  if (!res.ok) {
    const errMsg = res.error || res.message || 'SQL 指令执行失败'
    return { ok: false, rows: [], affectedRows: 0, error: errMsg, message: errMsg }
  }

  const rows = Array.isArray(res.data?.rows) ? res.data.rows : Array.isArray(res.data) ? res.data : []
  const affectedRows = Number(res.data?.affectedRows ?? res.data?.changes ?? rows.length)

  return {
    ok: true,
    rows,
    affectedRows,
    data: res.data,
    message: `已在数据库 ${dbPath} 上成功执行指令: ${trimmedSql} (返回 ${rows.length} 行 / 影响 ${affectedRows} 行)`
  }
}

export async function openSqliteDbLocation(dbPath: string, hostBridge?: unknown): Promise<boolean> {
  if (!dbPath) return false
  const shown = await showRealItemInFolder(dbPath, hostBridge)
  if (shown) return true
  return openRealPath(dbPath, hostBridge)
}
