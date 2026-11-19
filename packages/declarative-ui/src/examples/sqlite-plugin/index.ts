/**
 * ZTools 2.0 标杆原生插件视图: 本地 SQLite 数据库多表管理与导出工坊 (SQLite Plugin 2.0 - 布局二)
 * - 初始数据库列表、表结构与行记录全为空 []，不自动扫描 AppData
 * - 切换数据库只 inspect 目标库，不再重新扫描目录
 */

import { Action, ActionPanel, Icon, List, Toast, showToast, useEffect, useRef, useState } from '../../index.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  SQLITE_IMPORT_RULES,
  SQLITE_SUPPORTED_TEXT,
  executeSqliteQuery,
  exportTableRecords,
  fetchSqliteWorkspace,
  formatBytes,
  openSqliteDbLocation,
  toSqliteDatabaseFile,
  type SqliteDatabaseFile,
  type SqliteRowRecord,
  type SqliteTableId,
  type SqliteTableMeta
} from './logic.js'

export function SqlitePluginCommand() {
  const [activeDbPath, setActiveDbPath] = useState<string>('')
  const [selectedTableId, setSelectedTableId] = useState<SqliteTableId>('all_tables')
  const [tables, setTables] = useState<SqliteTableMeta[]>([])
  const [rows, setRows] = useState<SqliteRowRecord[]>([])
  const [checkedRowIds, setCheckedRowIds] = useState<string[]>([])
  const [searchText, setSearchText] = useState<string>('')
  const [statusBanner, setStatusBanner] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const runningRef = useRef(false)
  const inspectSeqRef = useRef(0)

  const queue = useExampleImportQueue<SqliteDatabaseFile>({
    rules: SQLITE_IMPORT_RULES,
    toItem: (file, idx) => toSqliteDatabaseFile(file, idx),
    pathOf: db => db.path,
    idOf: db => db.path,
    fileTitle: '选择 SQLite 数据库文件',
    folderTitle: '选择包含 SQLite 数据库的文件夹',
    filterName: 'SQLite 数据库',
    supportedText: SQLITE_SUPPORTED_TEXT,
    defaultChecked: false,
    isBusy: () => runningRef.current,
    dropTitle: '拖入 SQLite 数据库文件或文件夹',
    dropSubtitle: `支持 ${SQLITE_SUPPORTED_TEXT}`,
    onImported: added => {
      if (!activeDbPath && added[0]?.path) {
        setActiveDbPath(added[0].path)
      }
    },
    onCleared: () => {
      inspectSeqRef.current += 1
      setActiveDbPath('')
      setTables([])
      setRows([])
      setCheckedRowIds([])
      setSelectedTableId('all_tables')
      setStatusBanner('')
    }
  })

  const inspectActiveDb = async (dbPath: string) => {
    const seq = ++inspectSeqRef.current
    if (!dbPath) {
      setTables([])
      setRows([])
      setCheckedRowIds([])
      return
    }
    runningRef.current = true
    setIsLoading(true)
    try {
      const data = await fetchSqliteWorkspace(dbPath)
      if (seq !== inspectSeqRef.current) return
      setTables(data.tables)
      setRows(data.rows)
      setSelectedTableId('all_tables')
      setCheckedRowIds(data.rows.slice(0, 5).map(r => r.id))
      if (data.error) {
        setStatusBanner(data.error)
      } else {
        setStatusBanner(
          `已连接 ${dbPath.split(/[\\/]/).pop()} · ${data.tables.length} 张表 / ${data.rows.length} 条采样记录`
        )
      }
    } finally {
      if (seq === inspectSeqRef.current) {
        runningRef.current = false
        setIsLoading(false)
      }
    }
  }

  useEffect(() => {
    if (activeDbPath) {
      void inspectActiveDb(activeDbPath)
    }
  }, [activeDbPath])

  const keyword = searchText.trim().toLowerCase()
  const visibleRows = rows.filter(row => {
    if (selectedTableId !== 'all_tables' && row.tableId !== selectedTableId) return false
    if (keyword) {
      const hay = `${row.summaryTitle} ${row.rowJsonPreview} ${row.columnSchema} ${row.tableName}`.toLowerCase()
      if (!hay.includes(keyword)) return false
    }
    return true
  })

  const checkedSet = new Set(checkedRowIds)
  const selectedRows = rows.filter(r => checkedSet.has(r.id))
  const selectedBytes = selectedRows.reduce((acc, item) => acc + item.sizeBytes, 0)
  const allRowChecked = visibleRows.length > 0 && visibleRows.every(r => checkedSet.has(r.id))
  const someRowChecked = visibleRows.some(r => checkedSet.has(r.id))

  const toggleRowCheck = (id: string) => {
    setCheckedRowIds(prev => (prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]))
  }

  const toggleAllVisibleRows = () => {
    const visibleIds = visibleRows.map(r => r.id)
    if (allRowChecked) {
      const rm = new Set(visibleIds)
      setCheckedRowIds(prev => prev.filter(id => !rm.has(id)))
    } else {
      setCheckedRowIds(prev => Array.from(new Set([...prev, ...visibleIds])))
    }
  }

  const handleExport = async (format: 'json' | 'csv' | 'sql_insert') => {
    const targets = selectedRows.length > 0 ? selectedRows : visibleRows
    const res = await exportTableRecords(targets, format)
    setStatusBanner(res.message)
    await showToast({ style: res.ok ? Toast.Style.Success : Toast.Style.Failure, title: res.message })
  }

  const handleVacuumOptimize = async () => {
    if (!activeDbPath) return
    runningRef.current = true
    setIsLoading(true)
    try {
      const res = await executeSqliteQuery(activeDbPath, 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM;')
      setStatusBanner(res.message)
      await showToast({ style: res.ok ? Toast.Style.Success : Toast.Style.Failure, title: res.message })
    } finally {
      runningRef.current = false
      setIsLoading(false)
    }
  }

  const handleRemoveCurrentDb = () => {
    if (!activeDbPath || runningRef.current) return
    const nextDbs = queue.items.filter(db => db.path !== activeDbPath)
    queue.removeItem(activeDbPath)
    setActiveDbPath(nextDbs[0]?.path || '')
    if (nextDbs.length === 0) {
      setTables([])
      setRows([])
      setCheckedRowIds([])
      setStatusBanner('')
    }
  }

  const totalSizeBytes = tables.reduce((acc, t) => acc + t.sizeBytes, 0)
  const totalRowCount = tables.reduce((acc, t) => acc + t.rowCount, 0)
  const maxTableBytes = Math.max(1, ...tables.map(t => t.sizeBytes))
  const maxRowBytes = Math.max(1, ...visibleRows.map(r => r.sizeBytes))

  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加数据库 · 可选择文件、文件夹，或直接拖入 .db / .sqlite'
      : statusBanner ||
        `已加载 ${queue.items.length} 个数据库 · ${tables.length} 张表 (${totalRowCount} 行 / ${formatBytes(totalSizeBytes)}) · 清空列表 Ctrl+Shift+Backspace`

  const leftNavNodes =
    tables.length === 0
      ? []
      : [
          List.Item({
            id: 'nav-sql-all',
            title: '全部数据表与索引汇总',
            subtitle: `${tables.length} 张表 · 共 ${totalRowCount} 行记录`,
            icon: Icon.List,
            onSelect: () => setSelectedTableId('all_tables'),
            accessories: [{ progress: 1 }, { tag: { value: `${tables.length} 张表` } }, { text: formatBytes(totalSizeBytes) }],
            actions: ActionPanel({
              children: [
                Action({ title: `导出已选记录为 JSON (${selectedRows.length} 条)`, icon: Icon.Clipboard, onAction: () => handleExport('json') }),
                Action({
                  title: '执行 WAL Checkpoint 与 VACUUM 压缩',
                  icon: Icon.CheckCircle,
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: handleVacuumOptimize
                }),
                buildListManagementSection({
                  canRemove: !isLoading && Boolean(activeDbPath),
                  onRemove: handleRemoveCurrentDb,
                  onPickFiles: queue.handlePickFiles,
                  onPickFolder: queue.handlePickFolder,
                  onToggleAll: toggleAllVisibleRows,
                  allSelected: allRowChecked,
                  onClear: queue.clearQueue
                })
              ]
            })
          }),
          ...tables.map(table => {
            const ratio = Math.min(1, table.sizeBytes / maxTableBytes)
            return List.Item({
              id: `nav-sql-${table.id}`,
              title: table.displayName,
              subtitle: `Schema: ${table.schemaSummary}`,
              icon: Icon.Document,
              onSelect: () => setSelectedTableId(table.id),
              accessories: [{ progress: ratio }, { tag: { value: `${table.rowCount} 行` } }, { text: formatBytes(table.sizeBytes) }],
              actions: ActionPanel({
                children: [
                  Action({ title: `查看表「${table.tableName}」记录明细`, icon: Icon.Filter, onAction: () => setSelectedTableId(table.id) }),
                  Action({
                    title: '导出当前已勾选记录为 JSON',
                    icon: Icon.Clipboard,
                    shortcut: { modifiers: ['ctrl'], key: 'return' },
                    onAction: () => handleExport('json')
                  }),
                  buildListManagementSection({
                    canRemove: !isLoading && Boolean(activeDbPath),
                    onRemove: handleRemoveCurrentDb,
                    onPickFiles: queue.handlePickFiles,
                    onPickFolder: queue.handlePickFolder,
                    onClear: queue.clearQueue
                  })
                ]
              })
            })
          })
        ]

  const subListItems = visibleRows.map(row => {
    const isChecked = checkedSet.has(row.id)
    const ratio = Math.min(1, row.sizeBytes / maxRowBytes)
    return List.Item({
      id: `sql-row-${row.id}`,
      title: row.summaryTitle,
      subtitle: `${row.rowJsonPreview} · 字段: ${row.columnSchema}`,
      icon: Icon.Code,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleRowCheck(row.id),
      onToggleCheck: () => toggleRowCheck(row.id),
      accessories: [{ progress: ratio }, { tag: { value: row.tableName } }, { text: formatBytes(row.sizeBytes) }],
      actions: ActionPanel({
        children: [
          Action({ title: `导出已选记录为 JSON (${selectedRows.length} 条)`, icon: Icon.Clipboard, onAction: () => handleExport('json') }),
          Action({
            title: `导出已选记录为 SQL INSERT (${selectedRows.length} 条)`,
            icon: Icon.Code,
            shortcut: { modifiers: ['ctrl'], key: 'return' },
            onAction: () => handleExport('sql_insert')
          }),
          Action({ title: `导出已选记录为 CSV (${selectedRows.length} 条)`, icon: Icon.Document, onAction: () => handleExport('csv') }),
          Action({ title: '在资源管理器中定位数据库文件', icon: Icon.Folder, onAction: () => { void openSqliteDbLocation(activeDbPath) } }),
          buildListManagementSection({
            canRemove: !isLoading && Boolean(activeDbPath),
            onRemove: handleRemoveCurrentDb,
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: toggleAllVisibleRows,
            allSelected: allRowChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  return List({
    ...queue.fileInputProps,
    isLoading: isLoading || queue.isImporting,
    searchBarPlaceholder: '搜索表名、主键值、JSON 字段内容或关键字过滤...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换已导入的 SQLite 数据库文件',
      value: activeDbPath,
      onChange: val => setActiveDbPath(val),
      children:
        queue.items.length === 0
          ? [List.Dropdown.Item({ title: '尚未导入数据库文件', value: '' })]
          : queue.items.map(db =>
              List.Dropdown.Item({
                title: `${db.name}${db.sizeBytes > 0 ? ` (${formatBytes(db.sizeBytes)})` : ''}`,
                value: db.path
              })
            )
    }),
    filterBar: { summaryText, actions: queue.topBarActions },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    subList: {
      title: `数据表记录与 Schema 明细 (${visibleRows.length} 条 · 已选 ${selectedRows.length} 条 · ${formatBytes(selectedBytes)})`,
      subtitle: activeDbPath || '请先导入数据库文件',
      emptyText: queue.items.length === 0 ? '尚未添加数据库，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹' : '当前数据表下暂无记录',
      checkable: visibleRows.length > 0,
      checked: allRowChecked ? true : someRowChecked ? 'indeterminate' : false,
      onCheckChange: toggleAllVisibleRows,
      items: subListItems
    },
    children: leftNavNodes.length > 0 ? [List.Section({ title: 'SQLite 数据表与索引树 (32%)', subtitle: '点击过滤右侧记录', children: leftNavNodes })] : []
  })
}

export default SqlitePluginCommand
