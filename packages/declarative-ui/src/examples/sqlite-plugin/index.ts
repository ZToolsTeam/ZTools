/**
 * ZTools 2.0 标杆原生插件视图: 本地 SQLite 数据库多表管理与导出工坊 (SQLite Plugin 2.0 - 布局二：左 32% 数据表与索引树 + 右 68% 行记录与 Schema 可勾选列表)
 *
 * 严格遵循 ZTools 效率工具箱 UI 与交互设计五大黄金法则：
 * 1. 布局二（Master-SubList Cleaner）：左 32% 5 大核心数据表与索引导航树 + 右 68% 数据行与 Schema 字段预览可勾选列表
 * 2. 顶部唯一筛选：searchBarAccessory Dropdown 切换本机 SQLite 数据库文件 (.sqlite / .db / .sqlite3)
 * 3. 单行极简状态条：filterBar.summaryText 融合当前数据库 WAL 模式、总记录数与已勾选待导出项，右侧仅保留 1 个重新扫描按钮
 * 4. 零彩色 Emoji 与去彩虹化：100% 单色 SVG 图标、单色中性灰进度条与标签
 */

import { Action, ActionPanel, Icon, List, useEffect, useState } from "../../index.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import {
  SQLITE_TABLES,
  createInitialSqliteWorkspace,
  executeSqliteQuery,
  exportTableRecords,
  fetchSqliteWorkspace,
  formatBytes,
  openSqliteDbLocation,
  type SqliteTableId,
  type SqliteWorkspaceSnapshot
} from "./logic.js";

export function SqlitePluginCommand() {
  const [workspace, setWorkspace] = useState<SqliteWorkspaceSnapshot>(() => {
    const init = createInitialSqliteWorkspace();
    if (isRealElectronHost()) {
      return {
        ...init,
        databases: [],
        activeDbPath: "",
        tables: [],
        rows: [],
        totalSizeBytes: 0,
        updatedAt: "正在扫描本机 SQLite 数据库..."
      };
    }
    return init;
  });
  const [selectedTableId, setSelectedTableId] = useState<SqliteTableId>("all_tables");
  const [activeDbPath, setActiveDbPath] = useState<string>(() =>
    isRealElectronHost() ? "" : "C:\\Users\\Default\\AppData\\Roaming\\ZTools\\ztools_core.sqlite"
  );
  const [checkedRowIds, setCheckedRowIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : ["row_clip_01", "row_snip_01", "row_note_01", "row_kv_01"]
  );
  const [searchText, setSearchText] = useState<string>("");
  const [statusBanner, setStatusBanner] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const reloadSqliteWorkspace = async (dbPath = activeDbPath) => {
    setIsLoading(true);
    try {
      const data = await fetchSqliteWorkspace(dbPath);
      setWorkspace(data);
      if (isRealElectronHost()) {
        setCheckedRowIds(data.rows.slice(0, 5).map((r) => r.id));
      }
      setStatusBanner(
        `已连接 SQLite (WAL) · 共 ${data.tables.length} 张表 / ${data.rows.length} 条采样记录 (${formatBytes(data.totalSizeBytes)})`
      );
    } catch (err) {
      setStatusBanner(`读取 SQLite 数据库失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void reloadSqliteWorkspace(activeDbPath);
  }, [activeDbPath]);

  const keyword = searchText.trim().toLowerCase();
  const visibleRows = workspace.rows.filter((row) => {
    if (selectedTableId !== "all_tables" && row.tableId !== selectedTableId) return false;
    if (keyword) {
      const hay = `${row.summaryTitle} ${row.rowJsonPreview} ${row.columnSchema} ${row.tableName}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });

  const checkedSet = new Set(checkedRowIds);
  const selectedRows = workspace.rows.filter((r) => checkedSet.has(r.id));
  const selectedBytes = selectedRows.reduce((acc, item) => acc + item.sizeBytes, 0);

  const toggleRowCheck = (id: string) => {
    setCheckedRowIds((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  };

  const toggleAllVisible = () => {
    const visibleIds = visibleRows.map((r) => r.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checkedSet.has(id));
    if (allChecked) {
      const removeSet = new Set(visibleIds);
      setCheckedRowIds((prev) => prev.filter((id) => !removeSet.has(id)));
    } else {
      setCheckedRowIds((prev) => Array.from(new Set([...prev, ...visibleIds])));
    }
  };

  const handleExport = async (format: "json" | "csv" | "sql_insert") => {
    const targets = selectedRows.length > 0 ? selectedRows : visibleRows;
    const res = await exportTableRecords(targets, format);
    setStatusBanner(res.message);
  };

  const handleVacuumOptimize = async () => {
    setIsLoading(true);
    try {
      const res = await executeSqliteQuery(
        activeDbPath,
        "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"
      );
      setStatusBanner(res.message);
    } finally {
      setIsLoading(false);
    }
  };

  const totalRowCount = workspace.tables.reduce((acc, t) => acc + t.rowCount, 0);
  const maxTableBytes = Math.max(1, ...workspace.tables.map((t) => t.sizeBytes));
  const maxRowBytes = Math.max(1, ...visibleRows.map((r) => r.sizeBytes));

  const summaryText =
    statusBanner ||
    `WAL 引擎就绪 · 共 ${workspace.tables.length} 张数据表 (${totalRowCount} 行 / ${formatBytes(workspace.totalSizeBytes)}) · 已勾选 ${selectedRows.length} 条记录`;

  const leftNavNodes = [
    List.Item({
      id: "nav-sql-all",
      title: "全部数据表与索引汇总",
      subtitle: `${workspace.tables.length} 张核心表 · 共 ${totalRowCount} 行记录`,
      icon: Icon.List,
      onSelect: () => setSelectedTableId("all_tables"),
      accessories: [
        { progress: 1 },
        { tag: { value: `${workspace.tables.length} 张表` } },
        { text: formatBytes(workspace.totalSizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `导出已选记录为 JSON (${selectedRows.length} 条) (Enter)`,
            icon: Icon.Clipboard,
            onAction: () => handleExport("json")
          }),
          Action({
            title: "执行 WAL Checkpoint 与 VACUUM 压缩 (Ctrl+Enter)",
            icon: Icon.CheckCircle,
            onAction: handleVacuumOptimize
          }),
          Action({
            title: `导出已选记录为 SQL INSERT 语句 (${selectedRows.length} 条)`,
            icon: Icon.Code,
            onAction: () => handleExport("sql_insert")
          })
        ]
      })
    }),
    ...workspace.tables.map((table) => {
      const ratio = Math.min(1, table.sizeBytes / maxTableBytes);

      return List.Item({
        id: `nav-sql-${table.id}`,
        title: table.displayName,
        subtitle: `Schema: ${table.schemaSummary} · 索引: ${table.indexes.join(", ")}`,
        icon: Icon.Document,
        onSelect: () => setSelectedTableId(table.id),
        accessories: [
          { progress: ratio },
          { tag: { value: `${table.rowCount} 行` } },
          { text: formatBytes(table.sizeBytes) }
        ],
        actions: ActionPanel({
          children: [
            Action({
              title: `查看表「${table.tableName}」记录明细 (Enter)`,
              icon: Icon.Filter,
              onAction: () => setSelectedTableId(table.id)
            }),
            Action({
              title: "导出当前已勾选记录为 JSON (Ctrl+Enter)",
              icon: Icon.Clipboard,
              onAction: () => handleExport("json")
            }),
            Action({
              title: "导出当前已勾选记录为 CSV",
              icon: Icon.Document,
              onAction: () => handleExport("csv")
            })
          ]
        })
      });
    })
  ];

  const subListItems = visibleRows.map((row) => {
    const isChecked = checkedSet.has(row.id);
    const ratio = Math.min(1, row.sizeBytes / maxRowBytes);

    return List.Item({
      id: `sql-row-${row.id}`,
      title: row.summaryTitle,
      subtitle: `${row.rowJsonPreview} · 字段: ${row.columnSchema}`,
      icon: Icon.Code,
      checkable: true,
      checked: isChecked,
      onCheckChange: () => toggleRowCheck(row.id),
      onToggleCheck: () => toggleRowCheck(row.id),
      accessories: [
        { progress: ratio },
        { tag: { value: row.tableName } },
        { text: formatBytes(row.sizeBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `导出已选记录为 JSON 到剪贴板 (${selectedRows.length} 条) (Enter)`,
            icon: Icon.Clipboard,
            onAction: () => handleExport("json")
          }),
          Action({
            title: `导出已选记录为 SQL INSERT 语句 (${selectedRows.length} 条) (Ctrl+Enter)`,
            icon: Icon.Code,
            onAction: () => handleExport("sql_insert")
          }),
          Action({
            title: `导出已选记录为 CSV 表格 (${selectedRows.length} 条)`,
            icon: Icon.Document,
            onAction: () => handleExport("csv")
          }),
          Action({
            title: "执行 SQLite VACUUM 整理碎片释放空间",
            icon: Icon.CheckCircle,
            onAction: handleVacuumOptimize
          }),
          Action({
            title: "在资源管理器中定位 SQLite 数据库文件",
            icon: Icon.Folder,
            onAction: async () => {
              await openSqliteDbLocation(activeDbPath);
            }
          })
        ]
      })
    });
  });

  const allChecked = visibleRows.length > 0 && visibleRows.every((r) => checkedSet.has(r.id));
  const someChecked = visibleRows.some((r) => checkedSet.has(r.id));

  return List({
    isLoading,
    searchBarPlaceholder: "搜索表名、主键值、JSON 字段内容或输入 SQL 关键字过滤...",
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: "切换本机 SQLite 数据库文件",
      value: activeDbPath,
      onChange: (val) => setActiveDbPath(val),
      children: workspace.databases.map((db) =>
        List.Dropdown.Item({
          title: `${db.name} (${formatBytes(db.sizeBytes)})`,
          value: db.path
        })
      )
    }),
    filterBar: {
      summaryText,
      actions: [
        {
          id: "rescan",
          title: "重新扫描",
          style: "secondary",
          onAction: () => {
            void reloadSqliteWorkspace(activeDbPath);
          }
        }
      ]
    },
    subList: {
      title: `数据表记录与 Schema 明细 (${visibleRows.length} 条 · 已选 ${selectedRows.length} 条 · ${formatBytes(selectedBytes)})`,
      subtitle: activeDbPath,
      emptyText: "当前数据表下暂无匹配的记录",
      checkable: visibleRows.length > 0,
      checked: allChecked ? true : someChecked ? "indeterminate" : false,
      onCheckChange: () => toggleAllVisible(),
      items: subListItems
    },
    children: [
      List.Section({
        title: "SQLite 数据表与索引树 (32%)",
        subtitle: "点击过滤右侧记录",
        children: leftNavNodes
      })
    ]
  });
}

export default SqlitePluginCommand;
