import {
  List,
  ActionPanel,
  Action,
  Icon,
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
  SoftwareItem,
  SoftwareSummaryData,
  AppDataResidualItem,
  SOFTWARE_SMART_CATEGORIES,
  getSmartCategoryMeta,
  PROTECTED_SYSTEM_SOFTWARE_PATTERN,
  FORBIDDEN_SOFTWARE_PATTERN,
  FORBIDDEN_UNINSTALL_REASON,
  formatBytes,
  getMockSoftwareList,
  getMockSoftwareSummary,
  fetchSoftwareList,
  fetchSoftwareSummary,
  probeSoftwareAppDataResiduals,
  cleanAppDataResiduals,
  uninstallSoftware,
  openSoftwareLocation,
  launchSoftware,
  filterSoftwareList
} from './logic.js'

import { isRealElectronHost, showRealItemInFolder } from '../shared/native-ipc.js'

export default function SoftwareManagerCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [viewMode, setViewMode] = useState<'all' | 'advisor' | 'residuals' | 'runtime'>('all')
  const [smartCatFilter, setSmartCatFilter] = useState<string>('all')
  const [driveFilter, setDriveFilter] = useState<string>('all')
  const [softwareList, setSoftwareList] = useState<SoftwareItem[]>(() =>
    inRealHost ? [] : getMockSoftwareList()
  )
  const [checkedSoftwareIds, setCheckedSoftwareIds] = useState<string[]>([])
  const [residuals, setResiduals] = useState<AppDataResidualItem[]>(() =>
    inRealHost
      ? []
      : [
          {
            id: 'init-res-1',
            folderName: 'OldAppCache_Orphaned',
            fullPath: 'C:\\Users\\Admin\\AppData\\Local\\OldAppCache_Orphaned',
            scope: 'AppData\\Local',
            sizeBytes: 185 * 1024 * 1024,
            fileCount: 340,
            isOrphaned: true,
            lastModifiedMs: 1710000000000
          }
        ]
  )
  const [checkedResidualIds, setCheckedResidualIds] = useState<string[]>(() =>
    inRealHost ? [] : ['init-res-1']
  )
  const [summary, setSummary] = useState<SoftwareSummaryData>(() =>
    inRealHost
      ? {
          totalCount: 0,
          totalSizeBytes: 0,
          recentInstalledCount: 0,
          silentSupportedCount: 0,
          idleLargeCount: 0,
          residualTotalBytes: 0
        }
      : getMockSoftwareSummary()
  )
  const [isLoading, setIsLoading] = useState(inRealHost)

  async function refreshData(showIndicator = false, forceRefresh = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const list = await fetchSoftwareList(undefined, forceRefresh)
      if (isRealElectronHost() || (list && list.length > 0)) {
        setSoftwareList(list || [])
      }
      const sum = await fetchSoftwareSummary(undefined, list)
      if (isRealElectronHost() || (sum && sum.totalCount > 0)) {
        setSummary(
          sum || {
            totalCount: 0,
            totalSizeBytes: 0,
            recentInstalledCount: 0,
            silentSupportedCount: 0,
            idleLargeCount: 0,
            residualTotalBytes: 0
          }
        )
      }

      const scannedResiduals = await probeSoftwareAppDataResiduals(list || [])
      if (isRealElectronHost() || scannedResiduals.length > 0) {
        setResiduals(scannedResiduals)
        setCheckedResidualIds(scannedResiduals.filter(r => r.isOrphaned).map(r => r.id))
      }
    } catch (err) {
      console.error('[SoftwareManager] refreshData error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshData(false, false)
  }, [])

  function toggleSoftwareCheck(id: string, checked: boolean) {
    setCheckedSoftwareIds(prev => {
      const set = new Set(prev)
      if (checked) set.add(id)
      else set.delete(id)
      return Array.from(set)
    })
  }

  function toggleResidualCheck(id: string, checked: boolean) {
    setCheckedResidualIds(prev => {
      const set = new Set(prev)
      if (checked) set.add(id)
      else set.delete(id)
      return Array.from(set)
    })
  }

  async function handleUninstall(item: SoftwareItem, isQuiet = false) {
    if (FORBIDDEN_SOFTWARE_PATTERN.test(item.name)) {
      await confirmAlert({
        title: '无法卸载核心系统组件',
        message: `${item.name}\n\n${FORBIDDEN_UNINSTALL_REASON}`,
        primaryAction: {
          title: '我知道了',
          style: 'default'
        }
      })
      return
    }

    const isProtected = PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(item.name) || item.isSystem
    const confirmed = await confirmAlert({
      title: isProtected ? `高危警示：卸载系统运行库 [${item.name}]` : `确认卸载 [${item.name}]`,
      message: isProtected
        ? `软件 [${item.name}] 是 Windows 基础运行环境。卸载可能导致依赖它的应用无法启动！\n\n确定依然执行卸载？`
        : `将调用原生卸载程序移除 [${item.name}] (版本: ${item.version})。`,
      primaryAction: {
        title: isQuiet ? '静默卸载' : '开始卸载',
        style: 'destructive'
      }
    })

    if (!confirmed) return

    showToast({
      style: Toast.Style.Animated,
      title: `正在启动卸载: ${item.name}`,
      message: isQuiet ? '静默后台执行中' : '请在弹出的系统卸载向导中确认'
    })

    const res = await uninstallSoftware(item, isQuiet)
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '卸载未完成',
        message: res.error || '用户取消或权限不足'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '卸载程序已启动',
      message: item.name
    })
  }

  async function handleCleanCheckedResiduals() {
    const selected = residuals.filter(r => checkedResidualIds.includes(r.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选需要清理的 AppData 残留或缓存目录' })
      return
    }
    const totalBytes = selected.reduce((s, r) => s + r.sizeBytes, 0)
    const ok = await confirmAlert({
      title: `确认清理 ${selected.length} 项 AppData 软件残留/缓存？`,
      message: `预计释放 ${formatBytes(totalBytes)} 空间，所有选中目录将安全移入 Windows 回收站。`,
      primaryAction: { title: '移入回收站', style: 'destructive' }
    })
    if (!ok) return

    const res = await cleanAppDataResiduals(selected)
    if (res.ok) {
      showToast({
        style: Toast.Style.Success,
        title: `成功清理 ${res.cleanedCount} 个残留目录`,
        message: `释放空间 ${formatBytes(res.freedBytes)}`
      })
      refreshData(false, false)
    } else {
      showToast({ style: Toast.Style.Failure, title: '清理失败', message: res.error || '权限受限' })
    }
  }

  function renderDetailMarkdown(item: SoftwareItem): string {
    const smartMeta = getSmartCategoryMeta(item.smartCategory)
    const cleanCatName = smartMeta.name.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim()
    return `# ${item.name}

**当前版本**: \`${item.version || '未知版本'}\` · **发布商**: \`${item.publisher || '未知开发商'}\` · **智能归类**: \`${cleanCatName}\`

---

### 空间占用与安装画像
- **估算磁盘占用**: \`${formatBytes(item.estimatedSize)}\`
- **所在安装盘符**: \`${item.installDrive || 'C:'}\`
- **安装绝对路径**: \`${item.installLocation || '系统注册表默认路径'}\`
- **安装日期与时长**: \`${item.installDate || '未知'}\` (已安装约 \`${item.daysSinceInstall ?? 0} 天\`)
`
  }

  const filtered = filterSoftwareList(
    softwareList,
    searchText,
    viewMode === 'residuals' ? 'all' : viewMode,
    smartCatFilter,
    driveFilter
  )
  const advisorCount = softwareList.filter(s => (s.estimatedSize || 0) >= 100 * 1024 * 1024).length
  const runtimeCount = softwareList.filter(s => s.category === 'runtime' || s.isSystem).length
  const residualTotalBytes = residuals.reduce((s, r) => s + r.sizeBytes, 0)

  const catSegments = SOFTWARE_SMART_CATEGORIES.map(cat => {
    const items = softwareList.filter(s => s.smartCategory === cat.id)
    const sizeBytes = items.reduce((sum, s) => sum + (s.estimatedSize || 15 * 1024 * 1024), 0)
    return {
      id: cat.id,
      label: `${cat.shortName} (${items.length}款)`,
      valueBytes: sizeBytes,
      formattedSize: `${items.length}款 · ${formatBytes(items.reduce((sum, s) => sum + (s.estimatedSize || 0), 0))}`,
      percentage: softwareList.length > 0 ? Math.max(2, (items.length / softwareList.length) * 100) : 0,
      color: cat.color,
      active: smartCatFilter === 'all' || smartCatFilter === cat.id
    }
  }).filter(seg => !seg.label.includes('(0款)'))

  const maxSwBytes = Math.max(1, filtered[0]?.estimatedSize || 1)
  const maxResBytes = Math.max(1, residuals[0]?.sizeBytes || 1)

  const rightSubListItems =
    viewMode === 'residuals'
      ? residuals.map(resItem => {
          const isChecked = checkedResidualIds.includes(resItem.id)
          const volRatio = Math.max(10, Math.min(100, Math.round((resItem.sizeBytes / maxResBytes) * 100)))
          return List.Item({
            id: resItem.id,
            title: resItem.folderName,
            subtitle: `${resItem.scope} · ${resItem.fileCount} 个文件 · ${resItem.fullPath}`,
            checkable: true,
            checked: isChecked,
            onCheckChange: (c: boolean) => toggleResidualCheck(resItem.id, c),
            onToggleCheck: (c: boolean) => toggleResidualCheck(resItem.id, c),
            icon: { source: Icon.Folder },
            accessories: [
              { progress: { value: volRatio } },
              { tag: { value: resItem.isOrphaned ? '卸载残留' : `关联: ${resItem.matchedSoftwareName || '应用'}` } },
              { text: formatBytes(resItem.sizeBytes) }
            ],
            actions: ActionPanel({
              title: resItem.folderName,
              children: [
                Action({
                  title: '清理已勾选残留目录至回收站',
                  icon: Icon.Trash,
                  style: Action.Style.Destructive,
                  onAction: handleCleanCheckedResiduals
                }),
                Action({
                  title: '在资源管理器定位',
                  icon: Icon.Folder,
                  onAction: () => {
                    showRealItemInFolder(resItem.fullPath)
                  }
                })
              ]
            })
          })
        })
      : filtered.map(item => {
          const isProtected =
            Boolean(item.isSystem) ||
            PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(item.name) ||
            FORBIDDEN_SOFTWARE_PATTERN.test(item.name)
          const isChecked = !isProtected && checkedSoftwareIds.includes(item.id)
          const volRatio = Math.max(10, Math.min(100, Math.round(((item.estimatedSize || 0) / maxSwBytes) * 100)))
          const cleanTag = (item.smartCategoryName || '桌面应用').replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim()

          return List.Item({
            id: item.id,
            title: item.name,
            subtitle: isProtected
              ? `${item.publisher || 'Microsoft'} · 系统核心运行库保护 · ${item.installDrive || 'C:'}`
              : `${item.publisher || '未知开发商'} · v${item.version || '1.0'} · ${item.installDrive || 'C:'}`,
            checkable: !isProtected,
            checked: isChecked,
            lockedReason: isProtected ? '系统核心运行库保护' : undefined,
            onCheckChange: (c: boolean) => toggleSoftwareCheck(item.id, c),
            onToggleCheck: (c: boolean) => toggleSoftwareCheck(item.id, c),
            icon: { source: isProtected ? Icon.Lock : Icon.AppWindow },
            accessories: [
              { progress: { value: volRatio } },
              { tag: { value: isProtected ? '系统核心运行库' : cleanTag } },
              { text: formatBytes(item.estimatedSize) }
            ],
            detail: List.Item.Detail({
              markdown: renderDetailMarkdown(item)
            }),
            actions: ActionPanel({
              title: item.name,
              children: [
                Action({
                  title: '执行标准卸载',
                  icon: Icon.Trash,
                  style: Action.Style.Destructive,
                  onAction: () => handleUninstall(item, false)
                }),
                Action({
                  title: '在资源管理器打开安装目录',
                  icon: Icon.Folder,
                  onAction: async () => {
                    await openSoftwareLocation(item.installLocation || 'C:\\Program Files')
                  }
                }),
                ...(item.quietUninstallString
                  ? [
                      Action({
                        title: '执行静默后台卸载',
                        icon: Icon.Bolt,
                        onAction: () => handleUninstall(item, true)
                      })
                    ]
                  : []),
                ...(item.launchPath
                  ? [
                      Action({
                        title: '启动该软件',
                        icon: Icon.Play,
                        onAction: async () => {
                          await launchSoftware(item.launchPath!)
                        }
                      })
                    ]
                  : []),
                Action.CopyToClipboard({
                  title: '复制卸载命令行',
                  content: item.quietUninstallString || item.uninstallString || item.name
                })
              ]
            })
          } as any)
        })

  const selectableSoftware = filtered.filter(
    s => !s.isSystem && !PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(s.name) && !FORBIDDEN_SOFTWARE_PATTERN.test(s.name)
  )
  const checkedSwInFilter = selectableSoftware.filter(s => checkedSoftwareIds.includes(s.id))
  const selectedSwBytes = checkedSwInFilter.reduce((acc, s) => acc + (s.estimatedSize || 0), 0)

  return List({
    searchBarPlaceholder: '搜索软件名称、发布商、版本、路径或 7 大分类 (支持卸载与 AppData 残留清理)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换安装盘符筛选',
      value: driveFilter,
      onChange: val => setDriveFilter(val),
      children: [
        List.Dropdown.Item({ title: `全部安装盘符 (${softwareList.length})`, value: 'all' }),
        List.Dropdown.Item({
          title: `C: 系统盘 (${softwareList.filter(s => s.installDrive === 'C:').length})`,
          value: 'C:'
        }),
        List.Dropdown.Item({
          title: `D: 数据盘 (${softwareList.filter(s => s.installDrive === 'D:').length})`,
          value: 'D:'
        }),
        List.Dropdown.Item({
          title: `其他盘符 (${softwareList.filter(s => s.installDrive !== 'C:' && s.installDrive !== 'D:').length})`,
          value: 'OTHER'
        })
      ]
    }),
    filterBar: FilterBar({
      summaryText:
        viewMode === 'residuals'
          ? `AppData 残留与缓存共 ${residuals.length} 项 (${formatBytes(residualTotalBytes)}) · 已勾选 ${checkedResidualIds.length} 项`
          : `已安装 ${softwareList.length} 款软件 (${formatBytes(summary.totalSizeBytes)}) · 当前分类 ${filtered.length} 款 · 已勾选 ${checkedSwInFilter.length} 款 (${formatBytes(selectedSwBytes)})`,
      actions: [
        {
          id: 'rescan-all',
          label: '重新扫描',
          title: '重新扫描',
          style: 'secondary',
          onAction: () => refreshData(true, true)
        }
      ]
    }),
    subList: {
      title:
        viewMode === 'residuals'
          ? 'AppData 软件残留与缓存目录明细 (按体积降序，直接勾选或按 ↵ 清理)'
          : '已安装软件明细 (按占用体积降序，直接勾选或按 ↵ 卸载)',
      subtitle:
        viewMode === 'residuals'
          ? `${residuals.length} 项 · 已选 ${checkedResidualIds.length} 项`
          : `${filtered.length} 款 · 已选 ${checkedSwInFilter.length} 款 (${formatBytes(selectedSwBytes)})`,
      checkable: viewMode === 'residuals' ? residuals.length > 0 : selectableSoftware.length > 0,
      checked:
        viewMode === 'residuals'
          ? residuals.length > 0 && checkedResidualIds.length === residuals.length
            ? true
            : checkedResidualIds.length > 0
            ? 'indeterminate'
            : false
          : selectableSoftware.length > 0 && checkedSwInFilter.length === selectableSoftware.length
          ? true
          : checkedSwInFilter.length > 0
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        if (viewMode === 'residuals') {
          setCheckedResidualIds(checked ? residuals.map(r => r.id) : [])
        } else {
          setCheckedSoftwareIds(checked ? selectableSoftware.map(s => s.id) : [])
        }
      },
      emptyText: '当前分类或盘符下暂无匹配的软件条目',
      items: rightSubListItems
    },
    children: [
      List.Section({
        title: '软件与残留总览',
        children: [
          List.Item({
            id: 'sw-nav-all',
            title: '全部已安装软件',
            subtitle: `${softwareList.length} 款 · 总占用 ${formatBytes(summary.totalSizeBytes)}`,
            icon: { source: Icon.AppWindow },
            accessories: [{ text: `${softwareList.length} 款` }],
            onSelect: () => {
              setViewMode('all')
              setSmartCatFilter('all')
            }
          }),
          List.Item({
            id: 'sw-nav-residuals',
            title: 'AppData 残留缓存目录',
            subtitle: `${residuals.length} 个目录 · 可清理卸载残留`,
            icon: { source: Icon.Folder },
            accessories: [{ text: formatBytes(residualTotalBytes) }],
            onSelect: () => {
              setViewMode('residuals')
            }
          })
        ]
      }),
      List.Section({
        title: `7 大智能软件分类 (${SOFTWARE_SMART_CATEGORIES.length})`,
        children: SOFTWARE_SMART_CATEGORIES.map(cat => {
          const catItems = softwareList.filter(s => s.smartCategory === cat.id)
          const catBytes = catItems.reduce((acc, s) => acc + (s.estimatedSize || 0), 0)
          const cleanName = cat.name.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim()
          return List.Item({
            id: `sw-nav-cat-${cat.id}`,
            title: cleanName || cat.shortName,
            subtitle: `${catItems.length} 款软件 · ${cat.shortName}`,
            icon: { source: cat.id === 'runtime_system' ? Icon.Lock : Icon.Folder },
            accessories: [{ text: formatBytes(catBytes) }],
            onSelect: () => {
              setViewMode('all')
              setSmartCatFilter(cat.id)
            }
          })
        })
      })
    ]
  })
}
