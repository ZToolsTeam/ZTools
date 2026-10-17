import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  confirmAlert,
  MetricGrid,
  SegmentedControl
} from '../../index.js'
import {
  DiskDriveItem,
  DiskFileEntry,
  DiskGroupStat,
  OFFICIAL_FILE_TYPE_GROUPS,
  FORBIDDEN_REASON,
  FORBIDDEN_TARGET_PATTERN,
  formatBytes,
  formatDateTime,
  computeExtStats,
  computeGroupStats,
  fetchDiskAnalysisSnapshot,
  deleteDiskFileItem,
  batchDeleteDiskFileItems,
  openDiskItemLocation,
  openDiskFileDefault
} from './logic.js'

export default function DiskAnalyzerCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'files' | 'drives' | 'ext'>('all')
  const [selectedDrive, setSelectedDrive] = useState<string>('ALL')
  const [selectedGroupId, setSelectedGroupId] = useState<string>('ALL')
  const [selectedExt, setSelectedExt] = useState<string>('ALL')
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [pageSize, setPageSize] = useState<number>(60)

  const [drives, setDrives] = useState<DiskDriveItem[]>([])
  const [files, setFiles] = useState<DiskFileEntry[]>([])
  const [totalCapacity, setTotalCapacity] = useState(0)
  const [totalUsed, setTotalUsed] = useState(0)
  const [totalAvailable, setTotalAvailable] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshAnalysis(showIndicator = false) {
    if (showIndicator) {
      setIsLoading(true)
      showToast({
        style: Toast.Style.Animated,
        title: '正在执行 MFT + 真实目录 10 大分类深度扫描...',
        message: '采集全盘物理分区、10 大官方分类占比与二级后缀分布'
      })
    }
    try {
      const snap = await fetchDiskAnalysisSnapshot()
      setDrives(snap.drives)
      setFiles(snap.files)
      setTotalCapacity(snap.totalCapacityBytes)
      setTotalUsed(snap.totalUsedBytes)
      setTotalAvailable(snap.totalAvailableBytes)
      setSelectedPaths([])
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '磁盘空间 10 大分类透视完成',
          message: `已识别 ${snap.drives.length} 个分区，归类 ${snap.files.length} 个真实文件 (${snap.extStats.length} 种后缀)`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshAnalysis(false)
  }, [])

  // 1. 按当前选中的目标盘符过滤文件
  const driveScopedFiles =
    selectedDrive === 'ALL'
      ? files
      : files.filter(f => f.drive.toUpperCase() === selectedDrive.toUpperCase())

  // 2. 基于当前盘符作用域实时计算 10 大官方分类统计 & 扩展名统计
  const scopedGroupStats: DiskGroupStat[] = computeGroupStats(driveScopedFiles)
  const scopedExtStats = computeExtStats(driveScopedFiles)
  const scopedTotalBytes = driveScopedFiles.reduce((acc, f) => acc + f.sizeBytes, 0)

  // 3. 按当前选中的 10 大分类过滤，以动态计算该分类下的二级后缀列表
  const groupScopedFiles =
    selectedGroupId === 'ALL'
      ? driveScopedFiles
      : driveScopedFiles.filter(f => String(f.groupId) === selectedGroupId)

  const activeGroupExtensions = computeExtStats(groupScopedFiles).slice(0, 10)

  // 4. 按二级后缀 + 搜索关键字最终过滤文件列表
  const q = searchText.trim().toLowerCase()
  const finalFilteredFiles = groupScopedFiles.filter(f => {
    if (selectedExt !== 'ALL' && f.extension.toLowerCase() !== selectedExt.toLowerCase()) {
      return false
    }
    if (!q) return true
    return (
      f.name.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q) ||
      f.extension.toLowerCase().includes(q) ||
      f.groupName.toLowerCase().includes(q)
    )
  })

  const visibleFiles = finalFilteredFiles.slice(0, pageSize)

  // 勾选状态统计
  const selectedSet = new Set(selectedPaths)
  const selectedEntries = files.filter(f => selectedSet.has(f.path))
  const selectedBytes = selectedEntries.reduce((acc, f) => acc + f.sizeBytes, 0)
  const selectableInFilter = finalFilteredFiles.filter(f => !f.isProtected)
  const allFilteredChecked =
    selectableInFilter.length > 0 && selectableInFilter.every(f => selectedSet.has(f.path))

  function toggleSingleFile(filePath: string, checked: boolean) {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (checked) next.add(filePath)
      else next.delete(filePath)
      return Array.from(next)
    })
  }

  function toggleGroupCheck(groupFiles: DiskFileEntry[], checked: boolean) {
    const selectable = groupFiles.filter(f => !f.isProtected).map(f => f.path)
    if (selectable.length === 0) return
    setSelectedPaths(prev => {
      const next = new Set(prev)
      for (const p of selectable) {
        if (checked) next.add(p)
        else next.delete(p)
      }
      return Array.from(next)
    })
  }

  function toggleSelectAllFiltered() {
    if (selectableInFilter.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '当前筛选下无可清理文件',
        message: '系统保护区文件已自动锁定防误删'
      })
      return
    }
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (allFilteredChecked) {
        for (const f of selectableInFilter) next.delete(f.path)
      } else {
        for (const f of selectableInFilter) next.add(f.path)
      }
      return Array.from(next)
    })
  }

  async function handleTrashFile(entry: DiskFileEntry) {
    if (entry.isProtected || FORBIDDEN_TARGET_PATTERN.test(entry.path)) {
      await confirmAlert({
        title: '⚠️ 系统保护目录拦截',
        message: `${entry.path}\n\n${FORBIDDEN_REASON}`,
        primaryAction: { title: '我知道了', style: 'default' }
      })
      return
    }

    const confirmed = await confirmAlert({
      title: `确认将文件移入回收站？`,
      message: `文件名: ${entry.name}\n所属分类: ${entry.groupName} (${entry.extension})\n实际大小: ${formatBytes(entry.sizeBytes)}\n完整路径: ${entry.path}\n\n文件将被安全移入 Windows 回收站，可随时还原。`,
      primaryAction: { title: '移入回收站', style: 'destructive' }
    })
    if (!confirmed) return

    const res = await deleteDiskFileItem(entry.path)
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '移除失败',
        message: res.error || '文件可能正被其他进程占用'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '已移入回收站并实时重算空间占比',
      message: `${entry.name} (${formatBytes(entry.sizeBytes)})`
    })
    setFiles(prev => prev.filter(f => f.path !== entry.path))
    setSelectedPaths(prev => prev.filter(p => p !== entry.path))
  }

  async function handleBatchTrashSelected() {
    if (selectedEntries.length === 0) return
    const previewLines = selectedEntries
      .slice(0, 8)
      .map(f => `• [${f.groupName}] ${f.name} (${formatBytes(f.sizeBytes)})`)
      .join('\n')
    const moreLine =
      selectedEntries.length > 8 ? `\n...以及另外 ${selectedEntries.length - 8} 个文件` : ''

    const confirmed = await confirmAlert({
      title: `🗑️ 确认批量清理已勾选的 ${selectedEntries.length} 个文件？`,
      message: `预计释放总空间: ${formatBytes(selectedBytes)}\n\n清理清单预览:\n${previewLines}${moreLine}\n\n所有文件均安全移入 Windows 系统回收站，原目录与分类占比将立即实时重算。`,
      primaryAction: { title: `确认移入回收站 (${formatBytes(selectedBytes)})`, style: 'destructive' }
    })
    if (!confirmed) return

    showToast({
      style: Toast.Style.Animated,
      title: `正在批量移入回收站 (${selectedEntries.length} 项)...`,
      message: `预计释放 ${formatBytes(selectedBytes)}`
    })

    const { succeeded, failed } = await batchDeleteDiskFileItems(selectedEntries.map(f => f.path))
    if (succeeded.length > 0) {
      const removedSet = new Set(succeeded)
      const freedBytes = selectedEntries
        .filter(f => removedSet.has(f.path))
        .reduce((acc, f) => acc + f.sizeBytes, 0)
      setFiles(prev => prev.filter(f => !removedSet.has(f.path)))
      setSelectedPaths(prev => prev.filter(p => !removedSet.has(p)))
      showToast({
        style: Toast.Style.Success,
        title: `批量清理完成：成功移除 ${succeeded.length} 项`,
        message: `已释放 ${formatBytes(freedBytes)}${failed.length > 0 ? `，${failed.length} 项被占用跳过` : ''}`
      })
    } else if (failed.length > 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '批量移除未成功',
        message: failed[0]?.error || '目标文件受保护或被进程占用'
      })
    }
  }

  // 当前作用域容量指标计算
  const activeDriveObj =
    selectedDrive === 'ALL'
      ? null
      : drives.find(d => d.drive.toUpperCase() === selectedDrive.toUpperCase()) || null

  const metricCap = activeDriveObj ? activeDriveObj.totalBytes : totalCapacity
  const metricUsed = activeDriveObj ? activeDriveObj.usedBytes : totalUsed
  const metricAvail = activeDriveObj ? activeDriveObj.availableBytes : totalAvailable
  const overallPercent = metricCap > 0 ? Math.round((metricUsed / metricCap) * 100) : 0

  function renderDriveMarkdown(d: DiskDriveItem): string {
    const driveFiles = files.filter(f => f.drive.toUpperCase() === d.drive.toUpperCase())
    const driveGroups = computeGroupStats(driveFiles).filter(g => g.fileCount > 0)
    const filledBlocks = Math.min(20, Math.max(1, Math.round((d.usagePercent / 100) * 20)))
    const bar = '█'.repeat(filledBlocks) + '░'.repeat(20 - filledBlocks)
    const alert =
      d.usagePercent >= 90
        ? `> [!CAUTION]\n> **磁盘空间告急 (${d.usagePercent}%)**：剩余空间仅 \`${formatBytes(d.availableBytes)}\`，建议立即点击上方盘符切换器聚焦 \`${d.drive}\` 清理冗余安装包与缓存！`
        : d.usagePercent >= 75
        ? `> [!WARNING]\n> **磁盘负载偏高 (${d.usagePercent}%)**：建议检查大体积视频或开发缓存目录。`
        : `> [!TIP]\n> **分区状态健康 (${d.usagePercent}%)**：空间充裕，读写性能良好。`

    const groupTable =
      driveGroups.length > 0
        ? driveGroups
            .map(
              g =>
                `| ${g.name} | \`${g.fileCount} 项\` | \`${formatBytes(g.totalSizeBytes)}\` | \`${g.sharePercent}%\` |`
            )
            .join('\n')
        : '| 暂无采样文件 | - | - | - |'

    return `# 💽 ${d.label}

**挂载盘符**: \`${d.drive}\\ \` · **文件系统**: \`${d.fileSystem}\`

---

### 📊 容量热力分布
\`[${bar}] ${d.usagePercent}%\`

- **分区总容量**: \`${formatBytes(d.totalBytes)}\`
- **已用物理空间**: \`${formatBytes(d.usedBytes)}\`
- **剩余可用空间**: \`${formatBytes(d.availableBytes)}\`

---

### 🗂️ 本分区 10 大官方分类采样分布 (${driveFiles.length} 项 · ${formatBytes(driveFiles.reduce((a, b) => a + b.sizeBytes, 0))})

| 官方分类 | 命中文件数 | 采样总大小 | 占比 |
| :--- | :--- | :--- | :--- |
${groupTable}

---

${alert}
`
  }

  function renderGroupMarkdown(g: DiskGroupStat): string {
    const extRows =
      g.topExtensions.length > 0
        ? g.topExtensions
            .map(
              e =>
                `| \`${e.extension}\` | ${e.fileCount} 个文件 | \`${formatBytes(e.totalSizeBytes)}\` | \`${e.sharePercent}%\` |`
            )
            .join('\n')
        : '| 暂无文件 | 0 | 0 B | 0% |'

    return `# ${g.name} (Group #${g.groupId})

${g.description}

---

### 📊 分类空间画像 (${selectedDrive === 'ALL' ? '全盘汇总' : `${selectedDrive} 分区`})
- **分类总占用**: \`${formatBytes(g.totalSizeBytes)}\` (占采样总量 \`${g.sharePercent}%\`)
- **包含文件数**: \`${g.fileCount} 个真实文件\`
- **二级扩展名种类**: \`${g.topExtensions.length} 种后缀\`

---

### 🏷️ 分类内二级扩展名排行榜 (点击顶部二级筛选条可单独过滤后缀)

| 扩展名后缀 | 文件数量 | 累计占用体积 | 分类内占比 |
| :--- | :--- | :--- | :--- |
${extRows}
`
  }

  function renderFileMarkdown(f: DiskFileEntry): string {
    const isChecked = selectedSet.has(f.path)
    return `# 📄 ${f.name}

**完整路径**: \`${f.path}\`

---

### 📊 文件空间与分类画像
- **实际占用大小**: \`${formatBytes(f.sizeBytes)}\` (\`${f.sizeBytes.toLocaleString()} Bytes\`)
- **官方 10 大分类**: **${f.groupName}** (\`Group #${f.groupId}\`)
- **文件扩展名**: \`${f.extension}\`
- **所在物理分区**: \`${f.drive}\\ \`
- **所属父目录**: \`${f.parentDir}\`
- **最后修改时间**: \`${formatDateTime(f.mtime)}\`
- **清理勾选状态**: ${f.isProtected ? '🔒 系统保护目录文件 (禁止清理)' : isChecked ? '☑️ 已加入待清理队列' : '⬜ 未勾选'}

---

> [!NOTE]
> - 点击列表左侧复选框可将文件加入批量清理队列；
> - 按 \`Enter\` 可直接在 Windows 资源管理器中高亮定位该文件。
`
  }

  // 构建 10 大分类彩色分段条
  const nonEmptyGroups = scopedGroupStats.filter(g => g.totalSizeBytes > 0)
  const distributionSegments = (nonEmptyGroups.length > 0 ? nonEmptyGroups : scopedGroupStats.slice(0, 5)).map(
    g => ({
      id: String(g.groupId),
      label: g.name,
      color: g.color,
      sizeBytes: g.totalSizeBytes,
      formattedSize: formatBytes(g.totalSizeBytes),
      percent: g.sharePercent,
      count: g.fileCount
    })
  )

  const filteredDrives = drives.filter(
    d => !q || d.drive.toLowerCase().includes(q) || d.label.toLowerCase().includes(q)
  )
  const filteredExts = scopedExtStats.filter(
    e => !q || e.extension.toLowerCase().includes(q) || e.categoryLabel.toLowerCase().includes(q)
  )

  // 按分组聚合可见文件，支持分类级三态复选框
  const filesByGroupSection = OFFICIAL_FILE_TYPE_GROUPS.map(meta => {
    const gStat = scopedGroupStats.find(s => s.groupId === meta.groupId)
    const groupAllFiles = finalFilteredFiles.filter(f => f.groupId === meta.groupId)
    const groupVisibleFiles = visibleFiles.filter(f => f.groupId === meta.groupId)
    const selectable = groupAllFiles.filter(f => !f.isProtected)
    const checkedCount = selectable.filter(f => selectedSet.has(f.path)).length
    const checkState: boolean | 'indeterminate' =
      selectable.length === 0
        ? false
        : checkedCount === selectable.length
        ? true
        : checkedCount > 0
        ? 'indeterminate'
        : false

    return {
      meta,
      gStat,
      groupAllFiles,
      groupVisibleFiles,
      selectable,
      checkedCount,
      checkState
    }
  }).filter(sec => sec.groupVisibleFiles.length > 0)

  return List({
    searchBarPlaceholder: '搜索磁盘分区、10大分类名称、后缀名 (.mp4/.dll/.exe) 或文件路径...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'metric-total-cap',
          label: selectedDrive === 'ALL' ? '本机挂载总容量' : `${selectedDrive} 分区总容量`,
          value: formatBytes(metricCap),
          subValue:
            selectedDrive === 'ALL'
              ? `${drives.length} 个物理分区汇总`
              : activeDriveObj?.label || `${selectedDrive} 本地卷`,
          status: 'normal'
        },
        {
          id: 'metric-used-cap',
          label: '已用物理空间',
          value: formatBytes(metricUsed),
          subValue: `空间占用率 ${overallPercent}%`,
          progress: overallPercent,
          status: overallPercent >= 88 ? 'danger' : overallPercent >= 75 ? 'warning' : 'normal'
        },
        {
          id: 'metric-avail-cap',
          label: '剩余可用空间',
          value: formatBytes(metricAvail),
          subValue: `已分类采样 ${ formatBytes(scopedTotalBytes) }`,
          status: 'success'
        },
        {
          id: 'metric-scanned-files',
          label: selectedEntries.length > 0 ? '已勾选待清理' : '已归类热点文件',
          value:
            selectedEntries.length > 0
              ? `${formatBytes(selectedBytes)}`
              : `${driveScopedFiles.length} 项`,
          subValue:
            selectedEntries.length > 0
              ? `已选 ${selectedEntries.length} 个文件 · 可一键移入回收站`
              : `覆盖 10 大官方分类 · ${scopedExtStats.length} 种后缀`,
          status: selectedEntries.length > 0 ? 'warning' : 'normal'
        }
      ]
    }),
    distributionBar: {
      title:
        selectedDrive === 'ALL'
          ? '📊 全盘 10 大官方文件类型空间占比分布 (点击色块或图例可穿透筛选该分类)'
          : `📊 ${selectedDrive} 分区 10 大官方文件类型空间占比分布 (点击色块或图例穿透筛选)`,
      totalLabel: `已采样 ${driveScopedFiles.length} 个大文件 · 共 ${formatBytes(scopedTotalBytes)}`,
      activeSegmentId: selectedGroupId === 'ALL' ? undefined : selectedGroupId,
      onSelectSegment: segId => {
        setSelectedGroupId(segId || 'ALL')
        setSelectedExt('ALL')
      },
      segments: distributionSegments
    },
    filterBar: {
      summaryText: `当前作用域: ${selectedDrive === 'ALL' ? '全盘' : selectedDrive} · 匹配 ${finalFilteredFiles.length} 个文件 (展示前 ${ visibleFiles.length } 项) · 已勾选 ${selectedEntries.length} 项 (${formatBytes(selectedBytes)})`,
      groups: [
        {
          id: 'drive-filter',
          label: '目标盘符',
          value: selectedDrive,
          onChange: val => {
            setSelectedDrive(val)
            setSelectedExt('ALL')
          },
          options: [
            { value: 'ALL', label: '🌐 全盘汇总', badge: files.length },
            ...drives.map(d => ({
              value: d.drive,
              label: `💽 ${d.drive} (${d.usagePercent}%)`,
              badge: files.filter(f => f.drive.toUpperCase() === d.drive.toUpperCase()).length
            }))
          ]
        },
        {
          id: 'group-filter',
          label: '10大类型',
          value: selectedGroupId,
          onChange: val => {
            setSelectedGroupId(val)
            setSelectedExt('ALL')
          },
          options: [
            { value: 'ALL', label: '🗂️ 全部 10 大分类', badge: driveScopedFiles.length },
            ...scopedGroupStats
              .filter(g => g.fileCount > 0)
              .map(g => ({
                value: String(g.groupId),
                label: g.name,
                badge: `${g.fileCount} · ${formatBytes(g.totalSizeBytes)}`
              }))
          ]
        },
        {
          id: 'ext-filter',
          label: '二级后缀',
          value: selectedExt,
          onChange: val => setSelectedExt(val),
          options: [
            { value: 'ALL', label: '🏷️ 全部后缀', badge: groupScopedFiles.length },
            ...activeGroupExtensions.map(ext => ({
              value: ext.extension,
              label: `${ext.extension}`,
              badge: `${ext.fileCount} · ${formatBytes(ext.totalSizeBytes)}`
            }))
          ]
        }
      ],
      actions: [
        {
          id: 'act-toggle-all',
          label: allFilteredChecked
            ? `🔲 取消全选 (${selectableInFilter.length}项)`
            : `☑️ 全选当前筛选 (${selectableInFilter.length}项)`,
          style: 'secondary',
          onAction: () => toggleSelectAllFiltered()
        },
        ...(selectedEntries.length > 0
          ? [
              {
                id: 'act-batch-trash',
                label: `🗑️ 批量移入回收站 (${selectedEntries.length}项 · ${formatBytes(selectedBytes)})`,
                style: 'danger' as const,
                onAction: () => {
                  handleBatchTrashSelected()
                }
              }
            ]
          : []),
        ...(finalFilteredFiles.length > pageSize
          ? [
              {
                id: 'act-load-more',
                label: `➕ 加载更多 (${visibleFiles.length}/${finalFilteredFiles.length})`,
                style: 'primary' as const,
                onAction: () => setPageSize(prev => prev + 60)
              }
            ]
          : []),
        {
          id: 'act-rescan',
          label: '🔄 重新深度扫描',
          style: 'secondary',
          onAction: () => refreshAnalysis(true)
        }
      ]
    },
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'all', label: '全景 10 大分类与文件', badge: finalFilteredFiles.length },
        { value: 'files', label: '分类文件明细 (可勾选清理)', badge: finalFilteredFiles.length },
        { value: 'drives', label: '物理挂载分区', badge: drives.length },
        { value: 'ext', label: '二级扩展名排行榜', badge: scopedExtStats.length }
      ]
    }),
    children: [
      ...(tab === 'all' || tab === 'drives'
        ? [
            List.Section({
              title: `本机物理挂载分区 (${filteredDrives.length})`,
              subtitle: '点击回车可在资源管理器打开对应盘符，或点击顶部盘符胶囊单盘穿透分析',
              children: filteredDrives.map(d =>
                List.Item({
                  id: `drive-${d.drive}`,
                  title: `${d.label} (${d.drive})`,
                  subtitle: `已用 ${formatBytes(d.usedBytes)} / 总计 ${formatBytes(d.totalBytes)}`,
                  icon: {
                    source: Icon.HardDrive,
                    tintColor:
                      d.status === 'danger'
                        ? Color.Red
                        : d.status === 'warning'
                        ? Color.Orange
                        : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value: `已用 ${d.usagePercent}%`,
                        color:
                          d.status === 'danger'
                            ? Color.Red
                            : d.status === 'warning'
                            ? Color.Orange
                            : Color.Green
                      }
                    },
                    { text: `剩余 ${formatBytes(d.availableBytes)}` }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderDriveMarkdown(d)
                  }),
                  actions: ActionPanel({
                    title: d.label,
                    children: [
                      Action({
                        title: `仅聚焦分析 ${d.drive} 分区文件`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedDrive(d.drive)
                          setSelectedExt('ALL')
                        }
                      }),
                      Action({
                        title: '在资源管理器中打开此分区',
                        icon: Icon.Folder,
                        onAction: () => {
                          openDiskItemLocation(`${d.drive}\\`)
                        }
                      }),
                      Action({
                        title: '重新扫描全盘空间',
                        icon: Icon.ArrowClockwise,
                        onAction: () => refreshAnalysis(true)
                      })
                    ]
                  })
                })
              )
            })
          ]
        : []),
      ...(tab === 'all' || tab === 'files'
        ? filesByGroupSection.map(sec =>
            List.Section({
              title: `${sec.meta.name} (${sec.groupAllFiles.length} 项 · ${formatBytes(sec.gStat?.totalSizeBytes || 0)})`,
              subtitle:
                sec.selectable.length > 0
                  ? `已选 ${sec.checkedCount}/${sec.selectable.length} 项 · 常见后缀: ${
                      sec.gStat?.topExtensions
                        .slice(0, 4)
                        .map(e => `${e.extension}(${e.fileCount})`)
                        .join(' ') || '-'
                    }`
                  : '系统保护目录文件只读展示',
              checkable: sec.selectable.length > 0,
              checked: sec.checkState,
              onCheckChange: nextChecked => toggleGroupCheck(sec.groupAllFiles, nextChecked),
              children: sec.groupVisibleFiles.map(f => {
                const isChecked = selectedSet.has(f.path)
                return List.Item({
                  id: f.id,
                  title: f.name,
                  subtitle: `${f.parentDir} · ${formatDateTime(f.mtime)}`,
                  checkable: !f.isProtected,
                  checked: isChecked,
                  onCheckChange: nextChecked => toggleSingleFile(f.path, nextChecked),
                  icon: {
                    source: Icon.Document,
                    tintColor:
                      f.groupId === 1 || f.groupId === 2
                        ? Color.Purple
                        : f.groupId === 6
                        ? Color.Orange
                        : f.groupId === 8
                        ? Color.Red
                        : f.groupId === 3
                        ? Color.Green
                        : Color.Blue
                  },
                  accessories: [
                    ...(f.isProtected
                      ? [{ tag: { value: '🔒 系统保护', color: Color.Orange } }]
                      : []),
                    { tag: { value: `${f.drive} ${f.extension}`, color: Color.SecondaryText } },
                    { text: formatBytes(f.sizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderFileMarkdown(f)
                  }),
                  actions: ActionPanel({
                    title: f.name,
                    children: [
                      Action({
                        title: '在资源管理器中定位文件',
                        icon: Icon.Folder,
                        onAction: () => {
                          openDiskItemLocation(f.path)
                        }
                      }),
                      Action({
                        title: isChecked ? '取消勾选此文件' : '勾选加入批量清理队列',
                        icon: Icon.Checkmark,
                        onAction: () => toggleSingleFile(f.path, !isChecked)
                      }),
                      Action({
                        title: '使用默认程序打开文件',
                        icon: Icon.AppWindow,
                        onAction: () => {
                          openDiskFileDefault(f.path)
                        }
                      }),
                      Action({
                        title: `仅筛选 ${f.extension} 后缀文件`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedGroupId(String(f.groupId))
                          setSelectedExt(f.extension)
                        }
                      }),
                      Action({
                        title: '安全移入系统回收站',
                        icon: Icon.Trash,
                        style: Action.Style.Destructive,
                        onAction: () => handleTrashFile(f)
                      }),
                      ...(selectedEntries.length > 0
                        ? [
                            Action({
                              title: `批量清理已勾选的 ${selectedEntries.length} 项 (${formatBytes(selectedBytes)})`,
                              icon: Icon.Trash,
                              style: Action.Style.Destructive,
                              onAction: () => handleBatchTrashSelected()
                            })
                          ]
                        : []),
                      Action.CopyToClipboard({
                        title: '复制文件完整路径',
                        content: f.path
                      })
                    ]
                  })
                })
              })
            })
          )
        : []),
      ...(tab === 'all' || tab === 'ext'
        ? [
            List.Section({
              title: `二级扩展名空间占用排行 (${filteredExts.length})`,
              subtitle: '点击任意后缀项可立即穿透筛选该后缀下的全部真实文件',
              children: filteredExts.map(e => {
                const gMeta = OFFICIAL_FILE_TYPE_GROUPS.find(g => g.groupId === e.groupId)
                return List.Item({
                  id: `ext-${e.extension}`,
                  title: `${e.extension} (${e.categoryLabel})`,
                  subtitle: `归属分类: ${gMeta?.name || e.categoryLabel} · 共 ${e.fileCount} 个文件`,
                  icon: { source: Icon.Tag, tintColor: Color.Green },
                  accessories: [
                    { tag: { value: `占比 ${e.sharePercent}%`, color: Color.Blue } },
                    { text: formatBytes(e.totalSizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: gMeta ? renderGroupMarkdown(scopedGroupStats.find(s => s.groupId === gMeta.groupId) || scopedGroupStats[0]) : `# ${e.extension}`
                  }),
                  actions: ActionPanel({
                    title: e.extension,
                    children: [
                      Action({
                        title: `穿透查看所有 ${e.extension} 文件 (${e.fileCount} 项)`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedGroupId(String(e.groupId))
                          setSelectedExt(e.extension)
                          setTab('files')
                        }
                      }),
                      Action.CopyToClipboard({
                        title: '复制类型汇总信息',
                        content: `${e.extension} (${e.categoryLabel}): ${e.fileCount} 个文件, 共 ${formatBytes(e.totalSizeBytes)}`
                      })
                    ]
                  })
                })
              })
            })
          ]
        : [])
    ]
  })
}
