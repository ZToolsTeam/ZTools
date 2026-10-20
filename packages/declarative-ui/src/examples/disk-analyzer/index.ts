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
  confirmAlert
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
  openDiskFileDefault,
  isRealElectronHost
} from './logic.js'

export default function DiskAnalyzerCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'files' | 'drives' | 'ext'>('all')
  const [selectedDrive, setSelectedDrive] = useState<string>('ALL')
  const [selectedGroupId, setSelectedGroupId] = useState<string>('ALL')
  const [selectedDirPath, setSelectedDirPath] = useState<string>('ALL')
  const [selectedExt, setSelectedExt] = useState<string>('ALL')
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [pageSize, setPageSize] = useState<number>(60)

  const [drives, setDrives] = useState<DiskDriveItem[]>([])
  const [files, setFiles] = useState<DiskFileEntry[]>(() =>
    isRealElectronHost()
      ? []
      : [
          {
            id: 'init-disk-sample-1',
            name: 'Windows11_x64_zh-cn.iso',
            path: 'D:\\Downloads\\Windows11_x64_zh-cn.iso',
            parentDir: 'D:\\Downloads',
            drive: 'D:',
            extension: '.iso',
            category: 'archive',
            groupId: 5,
            groupName: '压缩包与镜像',
            groupColor: '#f59e0b',
            sizeBytes: 5.4 * 1024 ** 3,
            mtime: 1710000000,
            isProtected: false
          }
        ]
  )
  const [topDirectories, setTopDirectories] = useState<
    Array<{ name: string; path: string; drive: string; sizeBytes: number; fileCount: number }>
  >([])
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
      setTopDirectories(Array.isArray(snap.topDirectories) ? snap.topDirectories : [])
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

  // 4. 按目录 + 二级后缀 + 搜索关键字最终过滤文件列表，并按体积从大到小排序
  const q = searchText.trim().toLowerCase()
  const finalFilteredFiles = groupScopedFiles
    .filter(f => {
      if (selectedDirPath !== 'ALL') {
        const normDir = selectedDirPath.toLowerCase()
        if (
          !f.path.toLowerCase().startsWith(normDir) &&
          !f.parentDir.toLowerCase().startsWith(normDir)
        ) {
          return false
        }
      }
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
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

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
        title: '系统保护目录拦截',
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
      title: `确认批量清理已勾选的 ${selectedEntries.length} 个文件？`,
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

    const groupLines =
      driveGroups.length > 0
        ? driveGroups
            .map(
              g =>
                `- **${g.name}**: \`${formatBytes(g.totalSizeBytes)}\` (\`${g.sharePercent}%\` · ${g.fileCount} 项)`
            )
            .join('\n')
        : '- 暂无采样文件'

    return `# ${d.label}

**挂载盘符**: \`${d.drive}\\ \` · **文件系统**: \`${d.fileSystem}\`

---

### 容量热力分布
\`[${bar}] ${d.usagePercent}%\`

- **分区总容量**: \`${formatBytes(d.totalBytes)}\`
- **已用物理空间**: \`${formatBytes(d.usedBytes)}\`
- **剩余可用空间**: \`${formatBytes(d.availableBytes)}\`

---

### 本分区 10 大分类空间采样 (${driveFiles.length} 项 · ${formatBytes(driveFiles.reduce((a, b) => a + b.sizeBytes, 0))})

${groupLines}

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
                `- **\`${e.extension}\`**: \`${formatBytes(e.totalSizeBytes)}\` (\`${e.sharePercent}%\` · ${e.fileCount} 个文件)`
            )
            .join('\n')
        : '- 暂无文件'

    return `# ${g.name} (Group #${g.groupId})

${g.description}

---

### 分类空间画像 (${selectedDrive === 'ALL' ? '全盘汇总' : `${selectedDrive} 分区`})
- **分类总占用**: \`${formatBytes(g.totalSizeBytes)}\` (占采样总量 \`${g.sharePercent}%\`)
- **包含文件数**: \`${g.fileCount} 个真实文件\`
- **二级扩展名种类**: \`${g.topExtensions.length} 种后缀\`

---

### 分类内二级扩展名排行榜

${extRows}
`
  }

  function renderFileMarkdown(f: DiskFileEntry): string {
    const isChecked = selectedSet.has(f.path)
    return `# ${f.name}

**完整路径**: \`${f.path}\`

---

### 文件空间与分类画像
- **实际占用大小**: \`${formatBytes(f.sizeBytes)}\` (\`${f.sizeBytes.toLocaleString()} Bytes\`)
- **官方 10 大分类**: **${f.groupName}** (\`Group #${f.groupId}\`)
- **文件扩展名**: \`${f.extension}\`
- **所在物理分区**: \`${f.drive}\\ \`
- **所属父目录**: \`${f.parentDir}\`
- **最后修改时间**: \`${formatDateTime(f.mtime)}\`
- **清理勾选状态**: ${f.isProtected ? '系统保护目录文件 (禁止清理)' : isChecked ? '已加入待清理队列' : '未勾选'}

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

  // 构建右侧可交互大文件列表 (带复选框、体积占比条、分类标签与一键清理动作)
  const maxFileBytes = Math.max(1, visibleFiles[0]?.sizeBytes || 1)
  const rightFileItems = visibleFiles.map(f => {
    const isChecked = selectedSet.has(f.path)
    const volRatio = Math.max(8, Math.min(100, Math.round((f.sizeBytes / maxFileBytes) * 100)))
    const catMeta = OFFICIAL_FILE_TYPE_GROUPS.find(g => g.groupId === f.groupId)
    const shortCat = (catMeta?.name || f.groupName).replace(/^[^\s]+\s*/, '')

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: f.isProtected
        ? `${f.parentDir} (系统核心文件，保护中)`
        : `${f.parentDir} · ${formatDateTime(f.mtime)}`,
      checkable: !f.isProtected,
      checked: isChecked,
      onCheckChange: nextChecked => toggleSingleFile(f.path, nextChecked),
      onToggleCheck: nextChecked => toggleSingleFile(f.path, nextChecked),
      icon: {
        source: f.isProtected ? Icon.Lock : Icon.Document
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: f.isProtected ? '系统保护' : shortCat,
            color: Color.SecondaryText
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: renderFileMarkdown(f)
      }),
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: '移入回收站清理',
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            onAction: () => handleTrashFile(f)
          }),
          Action({
            title: '在资源管理器定位',
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

  const rightScopeTitle =
    selectedDirPath !== 'ALL'
      ? `目录「${selectedDirPath}」下的大文件`
      : selectedGroupId !== 'ALL'
      ? `「${(scopedGroupStats.find(g => String(g.groupId) === selectedGroupId)?.name || '当前分类').replace(/^[^\s]+\s*/, '')}」下的大文件`
      : selectedDrive !== 'ALL'
      ? `${selectedDrive} 分区下的可清理大文件 (按体积从大到小)`
      : `全盘可清理大文件明细 (按体积降序，直接勾选或按 ↵ 移入回收站)`

  return List({
    searchBarPlaceholder: '搜索大文件、后缀 (.mp4/.iso/.zip/.dll) 或路径...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换目标磁盘分区',
      value: selectedDrive,
      onChange: val => {
        setSelectedDrive(val)
        setSelectedDirPath('ALL')
        setSelectedExt('ALL')
      },
      children: [
        List.Dropdown.Item({
          title: `全盘汇总 (${files.length})`,
          value: 'ALL'
        }),
        ...drives.map(d =>
          List.Dropdown.Item({
            title: `${d.drive} (${d.usagePercent}%)`,
            value: d.drive
          })
        )
      ]
    }),
    filterBar: {
      summaryText: `全盘总容量 ${formatBytes(metricCap)} / 已用 ${formatBytes(metricUsed)} (${overallPercent}%) / 剩余 ${formatBytes(metricAvail)} · 右侧共 ${finalFilteredFiles.length} 个大文件${selectedEntries.length > 0 ? ` · 已勾选 ${selectedEntries.length} 项 (${formatBytes(selectedBytes)})` : ''}`,
      actions: [
        {
          id: 'act-rescan',
          label: '重新扫描',
          style: 'secondary',
          onAction: () => refreshAnalysis(true)
        }
      ]
    },
    subList: {
      title: rightScopeTitle,
      subtitle: `${finalFilteredFiles.length} 项 · ${formatBytes(finalFilteredFiles.reduce((a, b) => a + b.sizeBytes, 0))}`,
      checkable: selectableInFilter.length > 0,
      checked:
        selectableInFilter.length === 0
          ? false
          : allFilteredChecked
          ? true
          : selectedEntries.length > 0
          ? 'indeterminate'
          : false,
      onCheckChange: () => toggleSelectAllFiltered(),
      emptyText: '当前选中的分区/分类/目录下没有匹配的大文件',
      items: rightFileItems
    },
    children: [
      List.Section({
        title: `物理挂载分区 (${filteredDrives.length})`,
        children: [
          List.Item({
            id: 'drive-ALL',
            title: '全盘所有大文件',
            subtitle: `已用 ${formatBytes(totalUsed)} / 总计 ${formatBytes(totalCapacity)}`,
            icon: { source: Icon.Globe },
            accessories: [{ text: `${files.length} 项` }],
            onSelect: () => {
              setSelectedDrive('ALL')
              setSelectedGroupId('ALL')
              setSelectedDirPath('ALL')
              setSelectedExt('ALL')
            }
          }),
          ...filteredDrives.map(d => {
            const isDanger = d.usagePercent >= 90
            return List.Item({
              id: `drive-${d.drive}`,
              title: d.label.includes(d.drive) ? d.label : `${d.drive} ${d.label}`,
              subtitle: `已用 ${formatBytes(d.usedBytes)} · 剩 ${formatBytes(d.availableBytes)}`,
              icon: {
                source: Icon.HardDrive
              },
              accessories: [
                {
                  tag: {
                    value: `${d.usagePercent}%`,
                    ...(isDanger ? { color: 'red' } : {})
                  }
                }
              ],
              onSelect: () => {
                setSelectedDrive(d.drive)
                setSelectedGroupId('ALL')
                setSelectedDirPath('ALL')
                setSelectedExt('ALL')
              },
              detail: List.Item.Detail({
                markdown: renderDriveMarkdown(d)
              }),
              actions: ActionPanel({
                title: d.label,
                children: [
                  Action({
                    title: `聚焦查看 ${d.drive} 分区大文件`,
                    icon: Icon.MagnifyingGlass,
                    onAction: () => {
                      setSelectedDrive(d.drive)
                      setSelectedGroupId('ALL')
                      setSelectedDirPath('ALL')
                      setSelectedExt('ALL')
                    }
                  }),
                  Action({
                    title: '在资源管理器中打开此分区',
                    icon: Icon.Folder,
                    onAction: () => {
                      openDiskItemLocation(`${d.drive}\\`)
                    }
                  })
                ]
              })
            })
          })
        ]
      }),
      List.Section({
        title: `10 大文件分类 (${scopedGroupStats.filter(g => g.fileCount > 0).length})`,
        children: scopedGroupStats
          .filter(g => g.fileCount > 0)
          .map(g => {
            const cleanGroupName = g.name.replace(/^[^\s]+\s*/, '')
            return List.Item({
              id: `group-${g.groupId}`,
              title: cleanGroupName,
              subtitle: `${g.fileCount} 个文件 · 占比 ${g.sharePercent}%`,
              icon: { source: Icon.Folder },
              accessories: [{ text: formatBytes(g.totalSizeBytes) }],
              onSelect: () => {
                setSelectedGroupId(String(g.groupId))
                setSelectedDirPath('ALL')
                setSelectedExt('ALL')
              },
              actions: ActionPanel({
                title: cleanGroupName,
                children: [
                  Action({
                    title: `查看「${cleanGroupName}」下的 ${g.fileCount} 个文件`,
                    icon: Icon.MagnifyingGlass,
                    onAction: () => {
                      setSelectedGroupId(String(g.groupId))
                      setSelectedDirPath('ALL')
                      setSelectedExt('ALL')
                    }
                  }),
                  Action({
                    title: `全选「${cleanGroupName}」下所有可清理文件`,
                    icon: Icon.Checkmark,
                    onAction: () => {
                      const groupFiles = driveScopedFiles.filter(f => f.groupId === g.groupId)
                      toggleGroupCheck(groupFiles, true)
                    }
                  })
                ]
              })
            })
          })
      }),
      ...(topDirectories.length > 0
        ? [
            List.Section({
              title: `热点大目录 (${Math.min(12, topDirectories.length)})`,
              children: topDirectories.slice(0, 12).map((dir, idx) =>
                List.Item({
                  id: `topdir-${idx}-${dir.path}`,
                  title: `${dir.name} (${dir.drive})`,
                  subtitle: dir.path,
                  icon: { source: Icon.Folder },
                  accessories: [{ text: formatBytes(dir.sizeBytes) }],
                  onSelect: () => {
                    setSelectedDrive(dir.drive)
                    setSelectedGroupId('ALL')
                    setSelectedDirPath(dir.path)
                    setSelectedExt('ALL')
                  },
                  actions: ActionPanel({
                    title: dir.name,
                    children: [
                      Action({
                        title: `穿透查看「${dir.name}」内部大文件`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedDrive(dir.drive)
                          setSelectedGroupId('ALL')
                          setSelectedDirPath(dir.path)
                          setSelectedExt('ALL')
                        }
                      }),
                      Action({
                        title: '在资源管理器中打开此目录',
                        icon: Icon.Folder,
                        onAction: () => {
                          openDiskItemLocation(dir.path)
                        }
                      }),
                      Action.CopyToClipboard({
                        title: '复制目录路径',
                        content: dir.path
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [])
    ]
  })
}
