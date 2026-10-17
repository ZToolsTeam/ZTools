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
} from "../../index.js"
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
  const [softwareList, setSoftwareList] = useState<SoftwareItem[]>(inRealHost ? [] : getMockSoftwareList())
  const [residuals, setResiduals] = useState<AppDataResidualItem[]>([])
  const [checkedResidualIds, setCheckedResidualIds] = useState<string[]>([])
  const [summary, setSummary] = useState<SoftwareSummaryData>(
    inRealHost
      ? { totalCount: 0, totalSizeBytes: 0, recentInstalledCount: 0, silentSupportedCount: 0, idleLargeCount: 0 }
      : getMockSoftwareSummary()
  )
  const [isLoading, setIsLoading] = useState(inRealHost)

  async function refreshData(showIndicator = false, forceRefresh = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const list = await fetchSoftwareList(undefined, forceRefresh)
      if (list && list.length > 0) {
        setSoftwareList(list)
      }
      const sum = await fetchSoftwareSummary(undefined, list)
      if (sum) setSummary(sum)

      const scannedResiduals = await probeSoftwareAppDataResiduals(list || [])
      setResiduals(scannedResiduals)
      setCheckedResidualIds(
        scannedResiduals.filter((r) => r.isOrphaned).map((r) => r.id)
      )
    } catch (err) {
      console.error('[SoftwareManager] refreshData error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshData(false, false)
  }, [])

  async function handleUninstall(item: SoftwareItem, isQuiet = false) {
    if (FORBIDDEN_SOFTWARE_PATTERN.test(item.name)) {
      await confirmAlert({
        title: '⚠️ 无法卸载核心系统组件',
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
      title: isProtected ? `⚠️ 高危警示：卸载系统运行库 [${item.name}]` : `确认卸载 [${item.name}]`,
      message: isProtected
        ? `软件 [${item.name}] 是 Windows 基础运行环境。许多桌面应用依赖其运行。卸载可能导致依赖它的应用无法启动或报错崩溃！\n\n确定依然执行卸载？`
        : `将调用原生卸载程序移除 [${item.name}] (版本: ${item.version})。\n${isQuiet ? '注意：将尝试使用静默无弹窗参数执行卸载。' : ''}`,
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

    setTimeout(() => {
      refreshData(false, true)
    }, 2000)
  }

  async function handleCleanCheckedResiduals() {
    const selected = residuals.filter((r) => checkedResidualIds.includes(r.id))
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

  function toggleResidualCheck(id: string, checked: boolean) {
    if (checked) {
      setCheckedResidualIds(Array.from(new Set([...checkedResidualIds, id])))
    } else {
      setCheckedResidualIds(checkedResidualIds.filter((x) => x !== id))
    }
  }

  function renderDetailMarkdown(item: SoftwareItem): string {
    const isProtected = PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(item.name) || item.isSystem
    const smartMeta = getSmartCategoryMeta(item.smartCategory)

    const safetyCard = isProtected
      ? `> [!CAUTION]\n> **底层运行库依赖**：该软件是系统关键运行时或图形框架，许多第三方软件强依赖此库，请谨慎卸载！`
      : item.category === 'store'
      ? `> [!NOTE]\n> **应用商店应用**：通过 Windows Store 沙箱打包部署，卸载将清理应用缓存目录。`
      : `> [!TIP]\n> **${smartMeta.name}**：${smartMeta.description}`

    const quietSupportText = item.quietUninstallString
      ? '✅ 原生支持静默无干扰卸载 (`' + item.quietUninstallString + '`)'
      : '⚠️ 仅支持标准交互式向导卸载'

    return `
# ${item.name}

**当前版本**: \`${item.version || '未知版本'}\` · **发布商**: \`${item.publisher || '未知开发商'}\` · **智能归类**: \`${smartMeta.name}\`

---

### 📊 空间占用与安装画像 (software_classifier.h / usage_analyzer.h)
- **估算磁盘占用**: \`${formatBytes(item.estimatedSize)}\`
- **所在安装盘符**: \`${item.installDrive || 'C:'}\`
- **安装绝对路径**: \`${item.installLocation || '系统注册表默认路径'}\`
- **安装日期与时长**: \`${item.installDate || '未知'}\` (已安装约 \`${item.daysSinceInstall ?? 0} 天\`)

---

### ⚙️ 双架构注册表卸载指令 (registry_helper.h)
- **标准卸载指令**: \`${item.uninstallString || '无可用卸载命令行'}\`
- **静默卸载支持**: ${quietSupportText}

---

### 🛡️ 安全合规与管控建议
${safetyCard}
`
  }

  const filtered = filterSoftwareList(softwareList, searchText, viewMode === 'residuals' ? 'all' : viewMode, smartCatFilter, driveFilter)
  const advisorCount = softwareList.filter(s => (s.estimatedSize || 0) >= 100 * 1024 * 1024).length
  const runtimeCount = softwareList.filter(s => s.category === 'runtime' || s.isSystem).length
  const residualTotalBytes = residuals.reduce((s, r) => s + r.sizeBytes, 0)

  // 构建 7 大智能分类占比条
  const catSegments = SOFTWARE_SMART_CATEGORIES.map((cat) => {
    const items = softwareList.filter((s) => s.smartCategory === cat.id)
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
  }).filter((seg) => !seg.label.includes('(0款)'))

  return List({
    searchBarPlaceholder: "搜索软件名称、发布商、版本、路径或 7 大分类 (支持卸载与 AppData 残留清理)...",
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'metric-total',
          label: '已安装软件总数',
          value: `${softwareList.length} 款`,
          subValue: `当前筛选 ${filtered.length} 款`,
          status: 'normal'
        },
        {
          id: 'metric-space',
          label: '注册表估算总占用',
          value: formatBytes(summary.totalSizeBytes),
          subValue: `大体积软件 ${advisorCount} 款`,
          progress: Math.min(100, Math.round((summary.totalSizeBytes / (120 * 1024 * 1024 * 1024)) * 100)),
          status: summary.totalSizeBytes > 80 * 1024 * 1024 * 1024 ? 'warning' : 'normal'
        },
        {
          id: 'metric-residual',
          label: 'AppData 关联缓存/残留',
          value: formatBytes(residualTotalBytes),
          subValue: `${residuals.length} 个应用数据目录`,
          status: residuals.some(r => r.isOrphaned) ? 'warning' : 'normal'
        },
        {
          id: 'metric-silent',
          label: '支持静默卸载',
          value: `${summary.silentSupportedCount} 款`,
          subValue: `近期新装 ${summary.recentInstalledCount} 款`,
          status: 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '7 大官方智能软件分类分布 (点击分类图例快速过滤)',
      totalLabel: `共 ${softwareList.length} 款 · ${formatBytes(summary.totalSizeBytes)}`,
      segments: catSegments,
      onSegmentClick: (catId) => {
        setSmartCatFilter(smartCatFilter === catId ? 'all' : catId)
      }
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 双架构注册表扫描', status: 'done' },
        { step: 2, label: '2. 7大智能分类画像', status: 'done' },
        { step: 3, label: '3. 多维筛选与残留检视', status: 'active' },
        { step: 4, label: '4. 静默卸载/清残留', status: 'pending' }
      ],
      summaryText:
        viewMode === 'residuals'
          ? `已勾选 ${checkedResidualIds.length}/${residuals.length} 项 AppData 目录`
          : `筛选结果 ${filtered.length} 款软件`,
      groups: [
        {
          id: 'smart-cat',
          label: '软件分类',
          value: smartCatFilter,
          onChange: (v) => setSmartCatFilter(v),
          options: [
            { value: 'all', label: '全部类别', badge: softwareList.length },
            ...SOFTWARE_SMART_CATEGORIES.map((c) => ({
              value: c.id,
              label: c.shortName,
              badge: softwareList.filter((s) => s.smartCategory === c.id).length
            })).filter((o) => (o.badge as number) > 0)
          ]
        },
        {
          id: 'drive-filter',
          label: '安装盘符',
          value: driveFilter,
          onChange: (v) => setDriveFilter(v),
          options: [
            { value: 'all', label: '全部盘符' },
            { value: 'C:', label: 'C: 系统盘', badge: softwareList.filter((s) => s.installDrive === 'C:').length },
            { value: 'D:', label: 'D: 数据盘', badge: softwareList.filter((s) => s.installDrive === 'D:').length },
            { value: 'OTHER', label: '其他盘符', badge: softwareList.filter((s) => s.installDrive !== 'C:' && s.installDrive !== 'D:').length }
          ]
        }
      ],
      actions: [
        ...(viewMode === 'residuals'
          ? [
              {
                id: 'clean-residuals',
                title: `🗑️ 清理勾选目录 (${checkedResidualIds.length})`,
                style: 'danger' as const,
                disabled: checkedResidualIds.length === 0,
                onAction: handleCleanCheckedResiduals
              }
            ]
          : []),
        {
          id: 'rescan-all',
          title: '🔄 深度重扫注册表',
          style: 'secondary' as const,
          onAction: () => refreshData(true, true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: viewMode,
      onChange: (v) => setViewMode(v as any),
      options: [
        { value: 'all', label: '已安装软件全集', badge: softwareList.length },
        { value: 'advisor', label: '大体积与瘦身建议', badge: advisorCount },
        { value: 'residuals', label: 'AppData 缓存与残留', badge: residuals.length },
        { value: 'runtime', label: '系统运行库组件', badge: runtimeCount }
      ]
    }),
    children:
      viewMode === 'residuals'
        ? [
            List.Section({
              title: `本机真实 AppData 软件数据与卸载残留目录 (${residuals.length})`,
              subtitle: `扫描自 Roaming / Local · 总计 ${formatBytes(residualTotalBytes)}`,
              checkable: true,
              checked:
                residuals.length > 0 && checkedResidualIds.length === residuals.length
                  ? true
                  : checkedResidualIds.length > 0
                  ? 'indeterminate'
                  : false,
              onCheckChange: (checked) => {
                setCheckedResidualIds(checked ? residuals.map((r) => r.id) : [])
              },
              children: residuals.map((resItem) =>
                List.Item({
                  id: resItem.id,
                  title: resItem.folderName,
                  subtitle: `${resItem.scope} · ${resItem.fileCount} 个文件`,
                  checkable: true,
                  checked: checkedResidualIds.includes(resItem.id),
                  onCheckChange: (c) => toggleResidualCheck(resItem.id, c),
                  icon: {
                    source: resItem.isOrphaned ? Icon.Trash : Icon.Folder,
                    tintColor: resItem.isOrphaned ? Color.Orange : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value: resItem.isOrphaned ? '疑似卸载残留' : `关联: ${resItem.matchedSoftwareName}`,
                        color: resItem.isOrphaned ? Color.Orange : Color.Green
                      }
                    },
                    { text: formatBytes(resItem.sizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 📁 ${resItem.folderName}\n\n- **物理路径**: \`${resItem.fullPath}\`\n- **所属位置**: \`${resItem.scope}\`\n- **占用空间**: \`${formatBytes(resItem.sizeBytes)}\` (${resItem.fileCount} 个文件)\n- **关联已装软件**: \`${resItem.matchedSoftwareName || '未匹配到当前已装软件（疑似已卸载软件遗留目录）'}\`\n`
                  }),
                  actions: ActionPanel({
                    title: resItem.folderName,
                    children: [
                      Action({
                        title: '在资源管理器中定位该目录',
                        icon: Icon.Folder,
                        onAction: () => {
                          showRealItemInFolder(resItem.fullPath)
                        }
                      }),
                      Action({
                        title: '清理选中残留目录至回收站',
                        icon: Icon.Trash,
                        onAction: handleCleanCheckedResiduals
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [
            List.Section({
              title: `已安装软件清单 (${filtered.length}/${softwareList.length})`,
              subtitle: smartCatFilter === 'all' ? '按占用空间从大到小排列' : `当前分类过滤: ${getSmartCategoryMeta(smartCatFilter as any).name}`,
              children: filtered.map(item =>
                List.Item({
                  id: item.id,
                  title: item.name,
                  subtitle: `${item.publisher || '未知开发商'} · v${item.version || '1.0'} · ${item.installDrive || 'C:'}`,
                  icon: {
                    source: item.isSystem ? Icon.Gear : item.category === 'store' ? Icon.Globe : Icon.Window,
                    tintColor: item.isSystem ? Color.SecondaryText : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value: item.smartCategoryName || '桌面应用',
                        color: item.isSystem ? Color.SecondaryText : item.category === 'store' ? Color.Purple : Color.Blue
                      }
                    },
                    {
                      text: formatBytes(item.estimatedSize)
                    }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderDetailMarkdown(item)
                  }),
                  actions: ActionPanel({
                    title: item.name,
                    children: [
                      ActionPanel.Section({
                        title: '当前软件操作',
                        children: [
                          Action({
                            title: '执行标准卸载',
                            icon: Icon.Trash,
                            shortcut: { modifiers: [], key: 'enter' },
                            onAction: () => handleUninstall(item, false)
                          }),
                          ...(item.quietUninstallString ? [
                            Action({
                              title: '执行静默后台卸载',
                              icon: Icon.Bolt,
                              shortcut: { modifiers: ['ctrl', 'shift'], key: 'u' },
                              onAction: () => handleUninstall(item, true)
                            })
                          ] : []),
                          ...(item.installLocation ? [
                            Action({
                              title: '在资源管理器中打开安装目录',
                              icon: Icon.Folder,
                              shortcut: { modifiers: ['ctrl'], key: 'o' },
                              onAction: async () => {
                                const ok = await openSoftwareLocation(item.installLocation)
                                if (!ok) {
                                  showToast({ style: Toast.Style.Failure, title: '打开失败', message: item.installLocation })
                                }
                              }
                            })
                          ] : []),
                          ...(item.launchPath ? [
                            Action({
                              title: '启动该软件',
                              icon: Icon.Play,
                              shortcut: { modifiers: ['ctrl'], key: 'p' },
                              onAction: async () => {
                                const ok = await launchSoftware(item.launchPath!)
                                if (!ok) {
                                  showToast({ style: Toast.Style.Failure, title: '启动失败', message: item.launchPath })
                                }
                              }
                            })
                          ] : []),
                          Action({
                            title: '复制软件名称与版本',
                            icon: Icon.Clipboard,
                            shortcut: { modifiers: ['ctrl'], key: 'c' },
                            onAction: () => {
                              Clipboard.copy(`${item.name} v${item.version}`)
                              showToast({ style: Toast.Style.Success, title: '已复制到剪贴板' })
                            }
                          }),
                          Action({
                            title: '复制完整卸载命令行',
                            icon: Icon.Terminal,
                            shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                            onAction: () => {
                              Clipboard.copy(item.quietUninstallString || item.uninstallString || '')
                              showToast({ style: Toast.Style.Success, title: '卸载命令已复制' })
                            }
                          })
                        ]
                      }),
                      ActionPanel.Section({
                        title: '全局管理操作',
                        children: [
                          Action({
                            title: '重新扫描已安装软件',
                            icon: Icon.ArrowClockwise,
                            shortcut: { modifiers: ['ctrl'], key: 'r' },
                            onAction: () => refreshData(true, true)
                          })
                        ]
                      })
                    ]
                  })
                })
              )
            })
          ]
  })
}
