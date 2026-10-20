/**
 * ZTools 2.0 标杆原生插件: 本地 SQLite 数据库多表管理与导出工坊 (SQLite Plugin 2.0)
 *
 * 核心能力：
 * 1. 自动扫描本机 AppData 与用户目录下的 `.db` / `.sqlite` / `.sqlite3` 数据库文件
 * 2. 解析并展示 ZTools 本地核心数据表与索引树：`clipboard_history`、`snippets`、`notes`、`plugin_kv_cache`、`audit_logs`
 * 3. 支持右侧查看与勾选表内记录及字段 Schema，一键导出为 JSON / CSV / SQL INSERT 语句或执行 SQLite `VACUUM` 空间压缩
 */

import {
  formatBytes,
  invokeHostCapability,
  invokePluginService,
  isRealElectronHost,
  openRealPath,
  resolveRealSpecialPaths,
  scanRealDirectoryTree,
  showRealItemInFolder,
  writeRealClipboardText,
  type NativeInvocationResult
} from "../shared/native-ipc.js";

export { formatBytes };
export type { NativeInvocationResult };

export const DLL_PLUGIN_NAME = "SqlitePlugin";
export const FORBIDDEN_TARGET_PATTERN = /(\.\.[\\/]|DROP\s+(?:DATABASE|TABLE)|xp_cmdshell)/i;
export const FORBIDDEN_REASON = "禁止包含路径穿越或高危破坏性系统指令";

export type SqliteTableId =
  | "all_tables"
  | "clipboard_history"
  | "snippets"
  | "notes"
  | "plugin_kv_cache"
  | "audit_logs"
  | string;

export interface SqliteDatabaseFile {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  journalMode: "WAL" | "DELETE";
}

export interface SqliteTableMeta {
  id: SqliteTableId;
  tableName: string;
  displayName: string;
  rowCount: number;
  sizeBytes: number;
  indexes: string[];
  schemaSummary: string;
}

export interface SqliteRowRecord {
  id: string;
  tableId: SqliteTableId;
  tableName: string;
  primaryKey: string;
  summaryTitle: string;
  rowJsonPreview: string;
  columnSchema: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface SqliteWorkspaceSnapshot {
  databases: SqliteDatabaseFile[];
  activeDbPath: string;
  tables: SqliteTableMeta[];
  rows: SqliteRowRecord[];
  totalSizeBytes: number;
  updatedAt: string;
}

export const SQLITE_TABLES: SqliteTableMeta[] = [
  {
    id: "clipboard_history",
    tableName: "clipboard_history",
    displayName: "clipboard_history (剪贴板历史表)",
    rowCount: 1280,
    sizeBytes: 18 * 1024 * 1024,
    indexes: ["idx_clip_created_at", "idx_clip_hash_unique"],
    schemaSummary: "id TEXT PK, content_type TEXT, plain_text TEXT, sha256 TEXT, created_at INTEGER"
  },
  {
    id: "snippets",
    tableName: "snippets",
    displayName: "snippets (快捷指令与代码片段表)",
    rowCount: 164,
    sizeBytes: 2.4 * 1024 * 1024,
    indexes: ["idx_snippets_keyword", "idx_snippets_category"],
    schemaSummary: "id TEXT PK, keyword TEXT, title TEXT, body TEXT, use_count INTEGER"
  },
  {
    id: "notes",
    tableName: "notes",
    displayName: "notes (本地加密随手记表)",
    rowCount: 86,
    sizeBytes: 5.6 * 1024 * 1024,
    indexes: ["idx_notes_updated_at", "fts_notes_markdown"],
    schemaSummary: "id TEXT PK, title TEXT, markdown_cipher BLOB, iv TEXT, updated_at INTEGER"
  },
  {
    id: "plugin_kv_cache",
    tableName: "plugin_kv_cache",
    displayName: "plugin_kv_cache (扩展强缓存 WAL 表)",
    rowCount: 540,
    sizeBytes: 9.2 * 1024 * 1024,
    indexes: ["idx_kv_plugin_ns", "idx_kv_expire_at"],
    schemaSummary: "plugin_id TEXT, cache_key TEXT, payload_json TEXT, expire_at INTEGER"
  },
  {
    id: "audit_logs",
    tableName: "audit_logs",
    displayName: "audit_logs (合规与安全审计日志表)",
    rowCount: 3120,
    sizeBytes: 6.8 * 1024 * 1024,
    indexes: ["idx_audit_timestamp", "idx_audit_action"],
    schemaSummary: "log_id INTEGER PK, plugin_id TEXT, capability TEXT, status TEXT, ts INTEGER"
  }
];

export function validateInvocationPayload(
  method: string,
  params: Record<string, unknown>
): { valid: boolean; reason?: string } {
  if (!method || typeof method !== "string" || method.trim().length === 0) {
    return { valid: false, reason: "调用方法名 (method) 不能为空" };
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { valid: false, reason: "调用参数 (params) 必须是非空对象" };
  }
  const dbPath = String(params.dbPath || params.sql || params.target || "");
  if (dbPath && FORBIDDEN_TARGET_PATTERN.test(dbPath)) {
    return { valid: false, reason: FORBIDDEN_REASON };
  }
  return { valid: true };
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostOverride?: any
): Promise<NativeInvocationResult> {
  const validation = validateInvocationPayload(method, params);
  if (!validation.valid) {
    return {
      ok: false,
      code: -1,
      message: `VALIDATION_FAILED: ${validation.reason}`,
      error: `VALIDATION_FAILED: ${validation.reason}`
    };
  }
  return invokePluginService(DLL_PLUGIN_NAME, method.trim(), params, hostOverride);
}

export function createInitialSqliteWorkspace(): SqliteWorkspaceSnapshot {
  const databases: SqliteDatabaseFile[] = [
    {
      id: "db_ztools_core",
      name: "ztools_core.sqlite (WAL 主库)",
      path: "C:\\Users\\Default\\AppData\\Roaming\\ZTools\\ztools_core.sqlite",
      sizeBytes: 42 * 1024 * 1024,
      journalMode: "WAL"
    },
    {
      id: "db_clipboard_vault",
      name: "clipboard_vault.db (剪贴板本地库)",
      path: "C:\\Users\\Default\\AppData\\Roaming\\ZTools\\clipboard_vault.db",
      sizeBytes: 18 * 1024 * 1024,
      journalMode: "WAL"
    },
    {
      id: "db_plugin_cache",
      name: "plugin_cache.sqlite3 (扩展离线缓存库)",
      path: "C:\\Users\\Default\\AppData\\Local\\ZTools\\plugin_cache.sqlite3",
      sizeBytes: 9.2 * 1024 * 1024,
      journalMode: "WAL"
    }
  ];

  const rows: SqliteRowRecord[] = [
    {
      id: "row_clip_01",
      tableId: "clipboard_history",
      tableName: "clipboard_history",
      primaryKey: "clip_9021",
      summaryTitle: "[clipboard_history #clip_9021] text/plain · git commit -m \"feat: 升级声明式 UI\"",
      rowJsonPreview: "{\"id\":\"clip_9021\",\"content_type\":\"text/plain\",\"sha256\":\"8f2a...91c\"}",
      columnSchema: "id TEXT PK | content_type TEXT | plain_text TEXT | created_at INT",
      sizeBytes: 16 * 1024,
      updatedAt: "2 分钟前"
    },
    {
      id: "row_clip_02",
      tableId: "clipboard_history",
      tableName: "clipboard_history",
      primaryKey: "clip_9020",
      summaryTitle: "[clipboard_history #clip_9020] image/png · 1920x1080 屏幕区域截图缩略索引",
      rowJsonPreview: "{\"id\":\"clip_9020\",\"content_type\":\"image/png\",\"bytes\":842100}",
      columnSchema: "id TEXT PK | content_type TEXT | blob_ref TEXT | created_at INT",
      sizeBytes: 820 * 1024,
      updatedAt: "15 分钟前"
    },
    {
      id: "row_snip_01",
      tableId: "snippets",
      tableName: "snippets",
      primaryKey: "snip_sql_vacuum",
      summaryTitle: "[snippets #snip_sql_vacuum] 触发词 !vac · PRAGMA wal_checkpoint(TRUNCATE); VACUUM;",
      rowJsonPreview: "{\"id\":\"snip_sql_vacuum\",\"keyword\":\"!vac\",\"use_count\":48}",
      columnSchema: "id TEXT PK | keyword TEXT | title TEXT | body TEXT | use_count INT",
      sizeBytes: 8 * 1024,
      updatedAt: "今日高频"
    },
    {
      id: "row_note_01",
      tableId: "notes",
      tableName: "notes",
      primaryKey: "note_e2ee_01",
      summaryTitle: "[notes #note_e2ee_01] ZTools 2.0 架构设计备忘 (AES-256-GCM 密文块)",
      rowJsonPreview: "{\"id\":\"note_e2ee_01\",\"cipher_alg\":\"AES-256-GCM\",\"kdf\":\"Argon2id\"}",
      columnSchema: "id TEXT PK | title TEXT | markdown_cipher BLOB | iv TEXT",
      sizeBytes: 64 * 1024,
      updatedAt: "1 小时前"
    },
    {
      id: "row_kv_01",
      tableId: "plugin_kv_cache",
      tableName: "plugin_kv_cache",
      primaryKey: "disk-analyzer:last_scan",
      summaryTitle: "[plugin_kv_cache #disk-analyzer:last_scan] 磁盘大文件索引强缓存快照",
      rowJsonPreview: "{\"plugin_id\":\"disk-analyzer\",\"cache_key\":\"last_scan\",\"ttl\":86400}",
      columnSchema: "plugin_id TEXT | cache_key TEXT | payload_json TEXT | expire_at INT",
      sizeBytes: 256 * 1024,
      updatedAt: "5 分钟前"
    },
    {
      id: "row_audit_01",
      tableId: "audit_logs",
      tableName: "audit_logs",
      primaryKey: "log_10492",
      summaryTitle: "[audit_logs #10492] capability=filesystem.moveToTrash · status=ALLOWED",
      rowJsonPreview: "{\"log_id\":10492,\"plugin_id\":\"cleaner\",\"capability\":\"filesystem.moveToTrash\"}",
      columnSchema: "log_id INT PK | plugin_id TEXT | capability TEXT | status TEXT",
      sizeBytes: 4 * 1024,
      updatedAt: "刚刚"
    }
  ];

  const totalSizeBytes = SQLITE_TABLES.reduce((acc, t) => acc + t.sizeBytes, 0);

  return {
    databases,
    activeDbPath: databases[0].path,
    tables: SQLITE_TABLES,
    rows,
    totalSizeBytes,
    updatedAt: "初始化就绪"
  };
}

export async function fetchSqliteWorkspace(
  activeDbPath?: string,
  hostBridge?: any
): Promise<SqliteWorkspaceSnapshot> {
  const initial = createInitialSqliteWorkspace();
  const isRealHost = Boolean(hostBridge) || isRealElectronHost(hostBridge) || isRealElectronHost();
  try {
    const paths = await resolveRealSpecialPaths(hostBridge);
    const appData = paths.appData || "C:\\Users\\Default\\AppData\\Roaming";
    const localAppData = paths.localAppData || "C:\\Users\\Default\\AppData\\Local";

    const [roamingScan, localScan] = await Promise.all([
      scanRealDirectoryTree(
        appData,
        { maxDepth: 2, maxFiles: 20, filterExt: /\.(?:db|sqlite|sqlite3)$/i },
        hostBridge
      ),
      scanRealDirectoryTree(
        localAppData,
        { maxDepth: 2, maxFiles: 20, filterExt: /\.(?:db|sqlite|sqlite3)$/i },
        hostBridge
      )
    ]);

    const realDbs: SqliteDatabaseFile[] = [...roamingScan.files, ...localScan.files]
      .filter((entry) => !entry.isDirectory && entry.sizeBytes > 0)
      .slice(0, 12)
      .map((entry, idx) => ({
        id: `db_real_${idx}`,
        name: `${entry.name} (WAL)`,
        path: entry.path,
        sizeBytes: entry.sizeBytes,
        journalMode: "WAL" as const
      }));

    const targetDbPath =
      activeDbPath ||
      realDbs[0]?.path ||
      `${appData}\\ZTools\\ztools_core.sqlite`;

    const inspectRes = await invokeHostCapability<any>(
      "sqlite.inspectWorkspace",
      { dbPath: targetDbPath },
      hostBridge
    );

    if (inspectRes.ok && inspectRes.data) {
      const rawTables = Array.isArray(inspectRes.data.tables) ? inspectRes.data.tables : [];
      const rawRows = Array.isArray(inspectRes.data.rows) ? inspectRes.data.rows : [];
      const tables: SqliteTableMeta[] = rawTables.map((t: any, idx: number) => {
        const tName = String(t.tableName || t.name || `table_${idx}`);
        return {
          id: String(t.id || tName),
          tableName: tName,
          displayName: String(t.displayName || `${tName} (${t.rowCount ?? 0} 行)`),
          rowCount: Number(t.rowCount ?? 0),
          sizeBytes: Number(t.sizeBytes ?? 4096),
          indexes: Array.isArray(t.indexes) ? t.indexes.map(String) : [],
          schemaSummary: String(t.schemaSummary || t.schema || "id PRIMARY KEY")
        };
      });

      const rows: SqliteRowRecord[] = rawRows.map((r: any, idx: number) => {
        const tName = String(r.tableName || r.table || tables[0]?.tableName || "sqlite_master");
        const pk = String(r.primaryKey ?? r.id ?? idx + 1);
        const preview =
          typeof r.rowJsonPreview === "string"
            ? r.rowJsonPreview
            : JSON.stringify(r.data ?? r);
        return {
          id: String(r.id || `row_${tName}_${idx}`),
          tableId: String(r.tableId || tName),
          tableName: tName,
          primaryKey: pk,
          summaryTitle: String(r.summaryTitle || `[${tName} #${pk}] ${preview.slice(0, 64)}`),
          rowJsonPreview: preview,
          columnSchema: String(r.columnSchema || tables.find((t) => t.tableName === tName)?.schemaSummary || ""),
          sizeBytes: Number(r.sizeBytes ?? Math.max(64, preview.length)),
          updatedAt: String(r.updatedAt || "实时查询")
        };
      });

      const databases =
        realDbs.length > 0
          ? realDbs
          : [
              {
                id: "db_active_host",
                name: targetDbPath.split(/[\\/]/).pop() || "active.sqlite",
                path: targetDbPath,
                sizeBytes: tables.reduce((s, t) => s + t.sizeBytes, 0) || 4096,
                journalMode: "WAL" as const
              }
            ];

      return {
        databases,
        activeDbPath: targetDbPath,
        tables,
        rows,
        totalSizeBytes:
          tables.reduce((acc, t) => acc + t.sizeBytes, 0) ||
          databases.reduce((acc, d) => acc + d.sizeBytes, 0),
        updatedAt: new Date().toLocaleTimeString()
      };
    }

    if (isRealHost) {
      return {
        databases: realDbs,
        activeDbPath: activeDbPath || realDbs[0]?.path || "",
        tables: [],
        rows: [],
        totalSizeBytes: realDbs.reduce((acc, d) => acc + d.sizeBytes, 0),
        updatedAt: new Date().toLocaleTimeString()
      };
    }

    const databases = realDbs.length > 0 ? [...initial.databases, ...realDbs] : initial.databases;
    return {
      ...initial,
      databases,
      activeDbPath: activeDbPath || databases[0].path,
      updatedAt: new Date().toLocaleTimeString()
    };
  } catch {
    if (isRealHost) {
      return {
        databases: [],
        activeDbPath: activeDbPath || "",
        tables: [],
        rows: [],
        totalSizeBytes: 0,
        updatedAt: new Date().toLocaleTimeString()
      };
    }
    return initial;
  }
}

export type SqlExportFormat = "json" | "csv" | "sql_insert";

export async function exportTableRecords(
  records: SqliteRowRecord[],
  format: SqlExportFormat,
  hostBridge?: any
): Promise<{ ok: boolean; exportedText: string; message: string }> {
  if (!records || records.length === 0) {
    return { ok: false, exportedText: "", message: "请先勾选至少一条待导出的数据表记录" };
  }

  let exportedText = "";
  if (format === "json") {
    exportedText = JSON.stringify(
      records.map((r) => ({
        table: r.tableName,
        pk: r.primaryKey,
        preview: r.rowJsonPreview
      })),
      null,
      2
    );
  } else if (format === "csv") {
    const header = "table_name,primary_key,updated_at,size_bytes";
    const lines = records.map(
      (r) => `"${r.tableName}","${r.primaryKey}","${r.updatedAt}",${r.sizeBytes}`
    );
    exportedText = [header, ...lines].join("\n");
  } else {
    exportedText = records
      .map(
        (r) =>
          `INSERT INTO "${r.tableName}" (pk, payload_json) VALUES ('${r.primaryKey}', '${r.rowJsonPreview.replace(/'/g, "''")}');`
      )
      .join("\n");
  }

  await writeRealClipboardText(exportedText, hostBridge);
  return {
    ok: true,
    exportedText,
    message: `已将 ${records.length} 条记录导出为 ${format.toUpperCase()} 格式并复制到剪贴板`
  };
}

export async function executeSqliteQuery(
  dbPathOrTarget: string | { dbPath?: string; activeDbPath?: string },
  sql: string,
  hostOverride?: any
): Promise<{
  ok: boolean;
  rows?: unknown[];
  affectedRows?: number;
  data?: unknown;
  error?: string;
  message: string;
}> {
  const dbPath =
    typeof dbPathOrTarget === "string"
      ? dbPathOrTarget
      : String(dbPathOrTarget?.dbPath || dbPathOrTarget?.activeDbPath || "");
  const trimmedSql = String(sql || "").trim();
  if (!trimmedSql || FORBIDDEN_TARGET_PATTERN.test(trimmedSql) || FORBIDDEN_TARGET_PATTERN.test(dbPath)) {
    return { ok: false, rows: [], affectedRows: 0, error: FORBIDDEN_REASON, message: FORBIDDEN_REASON };
  }

  const primaryCap =
    typeof hostOverride?.sqlite_execute === "function" ? "sqlite.execute" : "sqlite.query";
  const fallbackCap = primaryCap === "sqlite.query" ? "sqlite.execute" : "sqlite.query";
  let res = await invokeHostCapability<any>(
    primaryCap,
    { dbPath, sql: trimmedSql },
    hostOverride
  );
  if (!res.ok && !hostOverride?.dllplugin_call) {
    res = await invokeHostCapability<any>(
      fallbackCap,
      { dbPath, sql: trimmedSql },
      hostOverride
    );
  }
  if (!res.ok) {
    const errMsg = res.error || res.message || "SQL 指令执行失败";
    return {
      ok: false,
      rows: [],
      affectedRows: 0,
      error: errMsg,
      message: errMsg
    };
  }

  const rows = Array.isArray(res.data?.rows)
    ? res.data.rows
    : Array.isArray(res.data)
      ? res.data
      : [];
  const affectedRows = Number(res.data?.affectedRows ?? res.data?.changes ?? rows.length);

  return {
    ok: true,
    rows,
    affectedRows,
    data: res.data,
    message: `已在数据库 ${dbPath} 上成功执行指令: ${trimmedSql} (返回 ${rows.length} 行 / 影响 ${affectedRows} 行)`
  };
}

export async function openSqliteDbLocation(dbPath: string, hostBridge?: any): Promise<boolean> {
  if (!dbPath) return false;
  const shown = await showRealItemInFolder(dbPath, hostBridge);
  if (shown) return true;
  return openRealPath(dbPath, hostBridge);
}
