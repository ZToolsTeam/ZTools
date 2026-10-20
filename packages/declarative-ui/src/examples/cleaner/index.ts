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
  DistributionBar,
  FilterBar,
  SegmentedControl
} from '../../index.js'
import {
  CLEAN_CLASSES,
  CleanGroupItem,
  CleanSummaryData,
  formatBytes,
  getMockCleanGroups,
  getMockCleanSummary,
  fetchCleanRulesAndScan,
  executeCleanGroups,
  cleanSelectedSampleFiles,
  emptyRecycleBin,
  filterCleanGroups
} from './logic.js'
import { isRealElectronHost, showRealItemInFolder } from '../shared/native-ipc.js'

export default function CleanerCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [viewMode, setViewMode] = useState<'groups' | 'files' | 'system' | 'browser' | 'app'>('groups')
  const [classIdFilter, setClassIdFilter] = useState<number>(0)
  const [riskFilter, setRiskFilter] = useState<string>('all')
  const [groups, setGroups] = useState<CleanGroupItem[]>(() =>
    inRealHost ? [] : getMockCleanGroups()
  )
  const [checkedFilePaths, setCheckedFilePaths] = useState<string[]>([])
  const [summary, setSummary] = useState<CleanSummaryData>(() =>
    inRealHost
      ? {
          totalSizeBytes: 0,
          checkedSizeBytes: 0,
          totalFileCount: 0,
          checkedFileCount: 0,
          diskFreeSizeBytes: 0,
          diskTotalSizeBytes: 0,
          recycleBinSizeBytes: 0
        }
      : getMockCleanSummary()
  )
  const [isLoading, setIsLoading] = useState(inRealHost)

  function updateSummary(currentGroups: CleanGroupItem[], baseSummary = summary): CleanSummaryData {
    let checkedSizeBytes = 0
    let checkedFileCount = 0
    let totalSizeBytes = 0
    let totalFileCount = 0

    for (const g of currentGroups) {
      totalSizeBytes += g.totalSizeBytes
      totalFileCount += g.fileCount
      if (g.checked) {
        checkedSizeBytes += g.totalSizeBytes
        checkedFileCount += g.fileCount
      }
    }

    return {
      ...baseSummary,
      totalSizeBytes,
      totalFileCount,
      checkedSizeBytes,
      checkedFileCount
    }
  }

  async function refreshData(showIndicator = false) {
    if (showIndicator) {
      setIsLoading(true)
      showToast({
        style: Toast.Style.Animated,
        title: '正在深度穿透扫描 6 大类系统垃圾',
        message: '枚举 %TEMP%、浏览器缓存、IDE 缓存与崩溃转储...'
      })
    }

    try {
      const res = await fetchCleanRulesAndScan()
      if (isRealElectronHost() || res.groups.length > 0 || !inRealHost) {
        setGroups(res.groups)
        setSummary(res.summary)
        const defaultCheckedFiles: string[] = []
        for (const g of res.groups) {
          if (g.checked) {
            for (const f of g.sampleFiles) {
              defaultCheckedFiles.push(f.path)
            }
          }
        }
        setCheckedFilePaths(defaultCheckedFiles)
      }
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '系统垃圾扫描完成',
          message: `发现 ${res.groups.length} 项清理规则，共计 ${formatBytes(res.summary.totalSizeBytes)}`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshData(false)
  }, [])

  function toggleGroupCheck(id: string, nextChecked?: boolean) {
    setGroups(prev => {
      const next = prev.map(g => {
        if (g.id !== id) return g
        const checked = nextChecked !== undefined ? nextChecked : !g.checked
        return { ...g, checked }
      })
      setSummary(updateSummary(next))
      return next
    })
  }

  function toggleAllFilteredGroups(targetGroups: CleanGroupItem[], checked: boolean) {
    const targetIds = new Set(targetGroups.map(g => g.id))
    setGroups(prev => {
      const next = prev.map(g => (targetIds.has(g.id) ? { ...g, checked } : g))
      setSummary(updateSummary(next))
      return next
    })
  }

  async function handleCleanSelected() {
    if (viewMode === 'files' && checkedFilePaths.length > 0) {
      const ok = await confirmAlert({
        title: `确认清理已勾选的 ${checkedFilePaths.length} 个垃圾文件？`,
        message: '选中的缓存与临时文件将安全移入 Windows 回收站。',
        primaryAction: { title: '移入回收站', style: 'destructive' }
      })
      if (!ok) return
      const res = await cleanSelectedSampleFiles(checkedFilePaths)
      if (res.ok) {
        showToast({ style: Toast.Style.Success, title: `已清理 ${res.trashedCount} 个文件` })
        refreshData(false)
      } else {
        showToast({ style: Toast.Style.Failure, title: '清理失败', message: res.error })
      }
      return
    }

    const checkedGroups = groups.filter(g => g.checked && g.totalSizeBytes > 0)
    if (checkedGroups.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '未勾选任何清理项目',
        message: '请至少勾选一个有效体积的垃圾项'
      })
      return
    }

    const totalCleanSize = checkedGroups.reduce((acc, cur) => acc + cur.totalSizeBytes, 0)
    const hasCautionItem = checkedGroups.some(g => g.riskLevel === 'caution')

    const confirmed = await confirmAlert({
      title: hasCautionItem ? '确认清理所选项目 (包含谨慎核对项)' : '确认开始安全垃圾清理',
      message: `即将清理已勾选的 ${checkedGroups.length} 类垃圾项目，预计释放磁盘空间 ${formatBytes(totalCleanSize)}。\n\n是否立即开始？`,
      primaryAction: {
        title: '立即安全清理',
        style: 'destructive'
      }
    })

    if (!confirmed) return

    showToast({
      style: Toast.Style.Animated,
      title: '正在清理垃圾文件...',
      message: `处理 ${checkedGroups.length} 项垃圾数据`
    })

    const res = await executeCleanGroups(groups)
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '清理遇到异常',
        message: res.error || '部分文件由于被系统进程占用未能删除'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '垃圾清理完成',
      message: `成功释放磁盘空间 ${formatBytes(res.deletedSizeBytes || totalCleanSize)} (${res.deletedCount} 个文件)`
    })

    setGroups(prev => {
      const next = prev.map(g => (g.checked ? { ...g, totalSizeBytes: 0, fileCount: 0, sampleFiles: [] } : g))
      setSummary(s => ({
        ...s,
        diskFreeSizeBytes: s.diskFreeSizeBytes + totalCleanSize,
        checkedSizeBytes: 0,
        checkedFileCount: 0,
        totalSizeBytes: Math.max(0, s.totalSizeBytes - totalCleanSize),
        totalFileCount: Math.max(0, s.totalFileCount - res.deletedCount)
      }))
      return next
    })
  }

  async function handleEmptyRecycleBin() {
    const confirmed = await confirmAlert({
      title: '确认清空系统回收站？',
      message: `将永久销毁回收站中的全部待删文件 (${formatBytes(summary.recycleBinSizeBytes)})，此操作无法撤销。`,
      primaryAction: {
        title: '清空回收站',
        style: 'destructive'
      }
    })

    if (!confirmed) return

    const res = await emptyRecycleBin()
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '清空回收站失败',
        message: res.error || '权限不足或文件被占用'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '回收站已清空',
      message: `成功释放物理空间 ${formatBytes(res.freedBytes || summary.recycleBinSizeBytes)}`
    })

    setSummary(s => ({
      ...s,
      recycleBinSizeBytes: 0,
      diskFreeSizeBytes: s.diskFreeSizeBytes + (res.freedBytes || s.recycleBinSizeBytes)
    }))
  }

  function renderDetailMarkdown(item: CleanGroupItem): string {
    const alertBlock =
      item.riskLevel === 'safe'
        ? `> [!TIP]\n> **安全清理项**：此目录下的文件属于无害的系统运行时或浏览器缓存文件，系统自动跳过正被占用的活跃文件，可放心清理。`
        : item.riskLevel === 'caution'
        ? `> [!WARNING]\n> **谨慎核对项**：包含下载目录遗留的安装包与归档，建议确认不再需要重复安装后再清理。`
        : `> [!NOTE]\n> **推荐深度清理**：此项包含已安装补丁或包管理器构建的冗余副本，清理可获得显著磁盘空间释放。`

    const sampleTable =
      item.sampleFiles && item.sampleFiles.length > 0
        ? `\n### 真实扫描样本文件 Top 清单 (${item.sampleFiles.length})\n` +
          item.sampleFiles
            .slice(0, 12)
            .map(
              (f, i) =>
                `${i + 1}. \`${f.path.split('\\').pop() || f.path}\` · **${formatBytes(f.sizeBytes)}**\n   - \`${f.path}\``
            )
            .join('\n')
        : '\n> *当前目录干净或该项已被清理*'

    return `# ${item.name}

**所属大类**: \`Class #${item.classId} · ${item.className}\` · **清理状态**: \`${item.checked ? '已勾选纳入' : '未勾选 (已排除)'}\`

---

### 空间与规则画像
- **可释放空间**: \`${formatBytes(item.totalSizeBytes)}\`
- **扫描文件数**: \`${item.fileCount.toLocaleString()} 项\`
- **安全度评级**: \`${item.riskLevel === 'safe' ? '安全无害' : item.riskLevel === 'caution' ? '谨慎确认' : '推荐清理'}\`
- **磁盘扫描路径**: \`${item.pathHint}\`

---

### 清理影响与安全评估
${alertBlock}

---
${sampleTable}
`
  }

  const categoryTab = viewMode === 'system' || viewMode === 'browser' || viewMode === 'app' ? viewMode : 'all'
  const filtered = filterCleanGroups(groups, searchText, categoryTab, classIdFilter, riskFilter)
    .slice()
    .sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
  const checkedGroupsCount = groups.filter(g => g.checked && g.totalSizeBytes > 0).length

  const allSampleFiles = filtered.flatMap(g =>
    g.sampleFiles.map(f => ({
      ...f,
      groupId: g.id,
      groupName: g.name,
      className: g.className,
      riskLevel: g.riskLevel
    }))
  )

  const classSegments = CLEAN_CLASSES.map(cls => {
    const clsGroups = groups.filter(g => g.classId === cls.classId)
    const bytes = clsGroups.reduce((s, g) => s + g.totalSizeBytes, 0)
    return {
      id: String(cls.classId),
      label: cls.shortName,
      valueBytes: bytes,
      formattedSize: formatBytes(bytes),
      percentage: summary.totalSizeBytes > 0 ? Math.max(2, (bytes / summary.totalSizeBytes) * 100) : 0,
      color: cls.color,
      active: classIdFilter === 0 || classIdFilter === cls.classId
    }
  }).filter(s => s.valueBytes > 0)

  function toggleSampleFileCheck(filePath: string, nextChecked?: boolean) {
    setCheckedFilePaths(prev => {
      const set = new Set(prev)
      const shouldCheck = nextChecked !== undefined ? nextChecked : !set.has(filePath)
      if (shouldCheck) set.add(filePath)
      else set.delete(filePath)
      return Array.from(set)
    })
  }

  const maxGroupBytes = Math.max(1, filtered[0]?.totalSizeBytes || 1)
  const maxSampleFileBytes = Math.max(1, allSampleFiles[0]?.sizeBytes || 1)
  const checkedFileSet = new Set(checkedFilePaths)

  const rightSubListItems =
    viewMode === 'files'
      ? allSampleFiles.map((file, idx) => {
          const fileName = file.path.split(/[\\/]/).pop() || file.path
          const volRatio = Math.max(
            8,
            Math.min(100, Math.round((file.sizeBytes / maxSampleFileBytes) * 100))
          )
          const isChecked = checkedFileSet.has(file.path)
          return List.Item({
            id: `sample-file-${idx}-${file.path}`,
            title: fileName,
            subtitle: `${file.groupName} · ${file.path}`,
            checkable: true,
            checked: isChecked,
            onCheckChange: c => toggleSampleFileCheck(file.path, c),
            onToggleCheck: c => toggleSampleFileCheck(file.path, c),
            icon: { source: Icon.Document },
            accessories: [
              { progress: { value: volRatio } },
              { tag: { value: file.className } },
              { text: formatBytes(file.sizeBytes) }
            ],
            actions: ActionPanel({
              title: fileName,
              children: [
                Action({
                  title: `清理已勾选垃圾文件 (${checkedFilePaths.length} 项)`,
                  icon: Icon.Trash,
                  style: Action.Style.Destructive,
                  onAction: () => handleCleanSelected()
                }),
                Action({
                  title: '在资源管理器定位',
                  icon: Icon.Folder,
                  onAction: () => {
                    showRealItemInFolder(file.path)
                  }
                }),
                Action({
                  title: isChecked ? '取消勾选此文件' : '勾选纳入清理队列',
                  icon: Icon.Checkmark,
                  onAction: () => toggleSampleFileCheck(file.path, !isChecked)
                }),
                Action.CopyToClipboard({
                  title: '复制文件完整路径',
                  content: file.path
                })
              ]
            })
          })
        })
      : filtered.map(item => {
          const volRatio = Math.max(
            10,
            Math.min(100, Math.round((item.totalSizeBytes / maxGroupBytes) * 100))
          )
          const riskLabel =
            item.riskLevel === 'safe'
              ? '安全缓存'
              : item.riskLevel === 'caution'
              ? '谨慎核对'
              : '推荐清理'
          const firstPath =
            item.sampleFiles[0]?.path ||
            item.pathHint.split(/[;,]/)[0]?.trim() ||
            'C:\\Windows\\Temp'

          return List.Item({
            id: item.id,
            title: item.name,
            subtitle: `${item.className} · ${item.fileCount.toLocaleString()} 个文件 · ${item.pathHint}`,
            checkable: !item.isProtected,
            checked: item.checked,
            onCheckChange: c => toggleGroupCheck(item.id, c),
            onToggleCheck: c => toggleGroupCheck(item.id, c),
            icon: {
              source: item.isProtected ? Icon.Lock : Icon.Trash
            },
            accessories: [
              { progress: { value: volRatio } },
              { tag: { value: riskLabel } },
              { text: formatBytes(item.totalSizeBytes) }
            ],
            detail: List.Item.Detail({
              markdown: renderDetailMarkdown(item)
            }),
            actions: ActionPanel({
              title: item.name,
              children: [
                Action({
                  title: `清理已勾选垃圾 (${formatBytes(summary.checkedSizeBytes)})`,
                  icon: Icon.Trash,
                  style: Action.Style.Destructive,
                  onAction: () => handleCleanSelected()
                }),
                Action({
                  title: '在资源管理器定位',
                  icon: Icon.Folder,
                  onAction: () => {
                    showRealItemInFolder(firstPath)
                  }
                }),
                Action({
                  title: item.checked ? '取消勾选此项' : '勾选纳入清理队列',
                  icon: Icon.Checkmark,
                  onAction: () => toggleGroupCheck(item.id, !item.checked)
                }),
                Action({
                  title: '切换至样本大文件明细逐项勾选',
                  icon: Icon.Document,
                  onAction: () => setViewMode('files')
                }),
                Action({
                  title: '一键清空系统回收站',
                  icon: Icon.Trash,
                  onAction: () => handleEmptyRecycleBin()
                }),
                Action.CopyToClipboard({
                  title: '复制清理路径',
                  content: item.pathHint
                })
              ]
            })
          })
        })

  const activeClassMeta = CLEAN_CLASSES.find(c => c.classId === classIdFilter)
  const rightTitle =
    viewMode === 'files'
      ? '样本大文件明细 (按体积降序，直接勾选或按 ↵ 移入回收站)'
      : activeClassMeta
      ? `${activeClassMeta.name} 清理规则明细 (按体积降序，直接勾选或按 ↵ 执行)`
      : '全部系统垃圾清理规则与采样明细 (按体积降序，直接勾选或按 ↵ 执行)'

  const checkedInFiltered = filtered.filter(g => g.checked)
  const selectedFilteredBytes = checkedInFiltered.reduce((acc, g) => acc + g.totalSizeBytes, 0)
  const allFilteredChecked = filtered.length > 0 && checkedInFiltered.length === filtered.length
  const someFilteredChecked = checkedInFiltered.length > 0 && !allFilteredChecked

  const checkedSampleInScope = allSampleFiles.filter(f => checkedFileSet.has(f.path))
  const selectedSampleBytes = checkedSampleInScope.reduce((acc, f) => acc + f.sizeBytes, 0)
  const allSampleChecked =
    allSampleFiles.length > 0 && checkedSampleInScope.length === allSampleFiles.length
  const someSampleChecked = checkedSampleInScope.length > 0 && !allSampleChecked

  return List({
    searchBarPlaceholder: '搜索 6 大类垃圾清理规则、路径、浏览器缓存或样本文件...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '按安全等级筛选系统垃圾',
      value: riskFilter,
      onChange: val => setRiskFilter(val),
      children: [
        List.Dropdown.Item({ title: `全部安全等级 (${groups.length})`, value: 'all' }),
        List.Dropdown.Item({
          title: `安全无害缓存 (${groups.filter(g => g.riskLevel === 'safe').length})`,
          value: 'safe'
        }),
        List.Dropdown.Item({
          title: `推荐深度清理 (${groups.filter(g => g.riskLevel === 'recommended').length})`,
          value: 'recommended'
        }),
        List.Dropdown.Item({
          title: `谨慎核对项 (${groups.filter(g => g.riskLevel === 'caution').length})`,
          value: 'caution'
        })
      ]
    }),
    filterBar: FilterBar({
      summaryText: `共发现 ${formatBytes(summary.totalSizeBytes)} 系统垃圾 · 已勾选 ${checkedGroupsCount} 组规则 (${formatBytes(summary.checkedSizeBytes)}) · C盘可用 ${formatBytes(summary.diskFreeSizeBytes)}`,
      actions: [
        {
          id: 'rescan',
          label: '重新扫描',
          title: '重新扫描',
          style: 'secondary',
          onAction: () => refreshData(true)
        }
      ]
    }),
    subList: {
      title: rightTitle,
      subtitle:
        viewMode === 'files'
          ? `${allSampleFiles.length} 项 · 已选 ${checkedSampleInScope.length} 项 (${formatBytes(selectedSampleBytes)})`
          : `${filtered.length} 项 · 已选 ${checkedInFiltered.length} 项 (${formatBytes(selectedFilteredBytes)})`,
      checkable: viewMode === 'files' ? allSampleFiles.length > 0 : filtered.length > 0,
      checked:
        viewMode === 'files'
          ? allSampleChecked
            ? true
            : someSampleChecked
            ? 'indeterminate'
            : false
          : allFilteredChecked
          ? true
          : someFilteredChecked
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        if (viewMode === 'files') {
          setCheckedFilePaths(checked ? allSampleFiles.map(f => f.path) : [])
        } else {
          toggleAllFilteredGroups(filtered, checked)
        }
      },
      emptyText:
        viewMode === 'files'
          ? '当前分类下暂无可检视的样本大文件'
          : '当前分类下暂无匹配的系统垃圾规则',
      items: rightSubListItems
    },
    children: [
      List.Section({
        title: '系统垃圾汇总',
        children: [
          List.Item({
            id: 'nav-clean-all',
            title: '全部系统垃圾汇总',
            subtitle: `${groups.length} 项规则 · 共 ${formatBytes(summary.totalSizeBytes)}`,
            icon: { source: Icon.HardDrive },
            accessories: [{ text: formatBytes(summary.totalSizeBytes) }],
            onSelect: () => {
              setClassIdFilter(0)
              setViewMode('groups')
            }
          }),
          List.Item({
            id: 'nav-clean-files',
            title: '样本大文件明细',
            subtitle: `${allSampleFiles.length} 个采样大文件 · 支持逐项勾选移入回收站`,
            icon: { source: Icon.Document },
            accessories: [{ text: `${allSampleFiles.length} 项` }],
            onSelect: () => {
              setViewMode('files')
            }
          })
        ]
      }),
      List.Section({
        title: `6 大 CleanClass 专项分类 (${CLEAN_CLASSES.length})`,
        children: CLEAN_CLASSES.map(cls => {
          const clsGroups = groups.filter(g => g.classId === cls.classId)
          const clsBytes = clsGroups.reduce((s, g) => s + g.totalSizeBytes, 0)
          return List.Item({
            id: `nav-clean-class-${cls.classId}`,
            title: cls.name,
            subtitle: `${clsGroups.length} 项规则 · ${cls.shortName}`,
            icon: { source: Icon.Folder },
            accessories: [{ text: formatBytes(clsBytes) }],
            onSelect: () => {
              setClassIdFilter(cls.classId)
              setViewMode('groups')
            }
          })
        })
      })
    ]
  })
}
