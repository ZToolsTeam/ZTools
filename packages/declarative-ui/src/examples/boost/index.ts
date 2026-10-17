import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
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
  BoostCandidateItem,
  BoostSnapshot,
  FORBIDDEN_REASON,
  formatBytes,
  fetchBoostSnapshot,
  terminateBoostProcess,
  executeQuickBoostCleanup,
  openBoostItemLocation
} from './logic.js'

import { trashRealItem } from '../shared/native-ipc.js'

export default function BoostCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'process' | 'startup_item' | 'temp_cache'>('all')
  const [impactFilter, setImpactFilter] = useState<'all' | 'high' | 'cleanable'>('all')
  const [snapshot, setSnapshot] = useState<BoostSnapshot | null>(null)
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  async function refreshBoost(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const snap = await fetchBoostSnapshot()
      setSnapshot(snap)
      setCheckedIds(
        snap.candidates
          .filter(c => c.type === 'temp_cache' && !c.isProtected)
          .map(c => c.id)
      )
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '系统负载与开机启动项巡检完成',
          message: `内存占用 ${snap.memoryUsagePercent}% · 启动项 ${snap.startupItemCount} 项 · 预计可释放 ${formatBytes(snap.reclaimableEstimateBytes)}`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshBoost(false)
  }, [])

  async function handleQuickBoost() {
    if (!snapshot) return
    const selectedItems = snapshot.candidates.filter(c => checkedIds.includes(c.id) && !c.isProtected)
    const tempItems =
      selectedItems.length > 0
        ? selectedItems
        : snapshot.candidates.filter(c => c.type === 'temp_cache' && !c.isProtected)

    const confirmed = await confirmAlert({
      title: `🚀 确认执行系统一键加速 (${tempItems.length} 项优化)？`,
      message: `将清理已勾选的临时缓存与闲置优化项，并整理物理内存工作集。\n\n核心系统服务与当前宿主受严格白名单保护。`,
      primaryAction: { title: '立即一键加速', style: 'default' }
    })
    if (!confirmed) return

    showToast({ style: Toast.Style.Animated, title: '正在执行系统加速与缓存回收...' })
    let cleanedCount = 0
    let freedBytes = 0
    for (const item of tempItems) {
      if (item.type === 'temp_cache' || (item.type === 'startup_item' && !item.pid)) {
        const res = await trashRealItem(item.path)
        if (res.ok) {
          cleanedCount += 1
          freedBytes += item.memoryOrSizeBytes
        }
      } else if (item.pid && !item.isProtected) {
        const res = await terminateBoostProcess(item.pid, item.name)
        if (res.ok) {
          cleanedCount += 1
          freedBytes += item.memoryOrSizeBytes
        }
      }
    }
    if (cleanedCount === 0) {
      const fallbackRes = await executeQuickBoostCleanup(snapshot.candidates)
      cleanedCount = fallbackRes.cleanedCount
      freedBytes = fallbackRes.freedBytes
    }
    await refreshBoost(false)
    showToast({
      style: Toast.Style.Success,
      title: '系统极速加速完成',
      message: `已处理 ${cleanedCount} 个优化项，释放 ${formatBytes(freedBytes)}`
    })
  }

  async function handleTerminateCandidate(item: BoostCandidateItem) {
    if (!item.pid) return
    if (item.isProtected) {
      await confirmAlert({
        title: `⚠️ 核心进程受保护 [${item.name}]`,
        message: FORBIDDEN_REASON,
        primaryAction: { title: '我知道了', style: 'default' }
      })
      return
    }

    const confirmed = await confirmAlert({
      title: `确认关闭 [${item.name}] 以释放内存？`,
      message: `PID: ${item.pid}\n当前占用物理内存: ${formatBytes(item.memoryOrSizeBytes)}\n\n关闭后将立即释放该进程占用的全部物理内存工作集。`,
      primaryAction: { title: '关闭并释放内存', style: 'destructive' }
    })
    if (!confirmed) return

    const res = await terminateBoostProcess(item.pid, item.name)
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '释放失败', message: res.error || '权限不足' })
      return
    }
    showToast({
      style: Toast.Style.Success,
      title: '已释放进程内存',
      message: `${item.name} (${formatBytes(item.memoryOrSizeBytes)})`
    })
    refreshBoost(false)
  }

  const candidates = snapshot?.candidates || []
  const q = searchText.trim().toLowerCase()
  const filtered = candidates.filter(c => {
    if (tab !== 'all' && c.type !== tab) return false
    if (impactFilter === 'high' && c.impactLevel !== '高耗时影响') return false
    if (impactFilter === 'cleanable' && c.isProtected) return false
    if (!q) return true
    return (
      c.name.toLowerCase().includes(q) ||
      c.path.toLowerCase().includes(q) ||
      String(c.pid || '').includes(q) ||
      (c.startupScope && c.startupScope.toLowerCase().includes(q))
    )
  })

  const memPct = snapshot?.memoryUsagePercent || 0
  const cpuPct = snapshot?.cpuUsagePercent || 0
  const totalMem = snapshot?.totalMemoryBytes || 1
  const usedMem = snapshot?.usedMemoryBytes || 0
  const availMem = snapshot?.availableMemoryBytes || 0

  const procCandidates = candidates.filter(c => c.type === 'process')
  const top5ProcBytes = procCandidates.slice(0, 5).reduce((s, c) => s + c.memoryOrSizeBytes, 0)
  const otherUsedBytes = Math.max(0, usedMem - top5ProcBytes)

  const memSegments = [
    {
      id: 'top5',
      label: `🔥 Top 5 大户进程 (${formatBytes(top5ProcBytes)})`,
      valueBytes: top5ProcBytes,
      formattedSize: formatBytes(top5ProcBytes),
      percentage: Math.max(8, (top5ProcBytes / totalMem) * 100),
      color: '#f59e0b',
      active: true
    },
    {
      id: 'other-used',
      label: `⚙️ 系统与其他驻留 (${formatBytes(otherUsedBytes)})`,
      valueBytes: otherUsedBytes,
      formattedSize: formatBytes(otherUsedBytes),
      percentage: Math.max(10, (otherUsedBytes / totalMem) * 100),
      color: '#3b82f6',
      active: true
    },
    {
      id: 'free-ram',
      label: `🟢 空闲可用内存 (${formatBytes(availMem)})`,
      valueBytes: availMem,
      formattedSize: formatBytes(availMem),
      percentage: Math.max(8, (availMem / totalMem) * 100),
      color: '#10b981',
      active: true
    }
  ]

  return List({
    searchBarPlaceholder: '搜索高内存进程、开机启动项 (Startup/常驻)、PID 或 %TEMP% 缓存...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'boost-mem',
          label: '物理内存负载',
          value: `${memPct}%`,
          subValue: `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`,
          progress: memPct,
          status: memPct > 85 ? 'danger' : memPct > 70 ? 'warning' : 'success'
        },
        {
          id: 'boost-reclaim',
          label: '预计可释放内存/缓存',
          value: formatBytes(snapshot?.reclaimableEstimateBytes || 0),
          subValue: `已勾选 ${checkedIds.length} 项待加速`,
          status: 'success'
        },
        {
          id: 'boost-startup',
          label: '开机启动与自启常驻',
          value: `${snapshot?.startupItemCount || 0} 项`,
          subValue: 'Startup 目录 + 自启服务',
          status: (snapshot?.startupItemCount || 0) > 10 ? 'warning' : 'normal'
        },
        {
          id: 'boost-cpu',
          label: 'CPU 瞬时负载',
          value: `${cpuPct}%`,
          subValue: `空闲内存 ${formatBytes(availMem)}`,
          progress: cpuPct,
          status: cpuPct > 80 ? 'danger' : 'normal'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机物理内存工作集构成分布 (Top 5 进程 vs 系统常驻 vs 空闲可用)',
      totalLabel: `总物理内存 ${formatBytes(totalMem)} · 已用 ${memPct}%`,
      segments: memSegments
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 内存与CPU压力采样', status: 'done' },
        { step: 2, label: '2. 开机启动项与大内存扫描', status: 'done' },
        { step: 3, label: '3. 三态勾选优化项', status: 'active' },
        { step: 4, label: '4. 一键极速加速', status: 'pending' }
      ],
      summaryText: `已勾选 ${checkedIds.length} 项 · 当前列表 ${filtered.length} 项`,
      groups: [
        {
          id: 'boost-impact',
          label: '优化筛选',
          value: impactFilter,
          onChange: (v) => setImpactFilter(v as any),
          options: [
            { value: 'all', label: '全部项目', badge: candidates.length },
            { value: 'high', label: '🔥 高内存/高耗时影响', badge: candidates.filter(c => c.impactLevel === '高耗时影响').length },
            { value: 'cleanable', label: '🟢 可安全加速项 (排除系统保护)', badge: candidates.filter(c => !c.isProtected).length }
          ]
        }
      ],
      actions: [
        {
          id: 'quick-boost-btn',
          title: `⚡ 一键极速加速 (${checkedIds.length})`,
          style: 'primary',
          onAction: handleQuickBoost
        },
        {
          id: 'rescan-boost',
          title: '🔄 刷新负载与启动项',
          style: 'secondary',
          onAction: () => refreshBoost(true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'all', label: '全部加速项', badge: candidates.length },
        { value: 'process', label: '内存大户进程', badge: candidates.filter(c => c.type === 'process').length },
        { value: 'startup_item', label: '开机启动与自启常驻', badge: candidates.filter(c => c.type === 'startup_item').length },
        { value: 'temp_cache', label: '%TEMP% 热点缓存', badge: candidates.filter(c => c.type === 'temp_cache').length }
      ]
    }),
    children: [
      List.Section({
        title: `本机真实内存、开机启动项与缓存优化清单 (${filtered.length})`,
        subtitle: '支持勾选非保护进程、启动项与临时缓存执行批量加速',
        checkable: true,
        checked:
          filtered.length > 0 && filtered.filter(i => !i.isProtected).every(i => checkedIds.includes(i.id))
            ? true
            : filtered.some(i => checkedIds.includes(i.id))
            ? 'indeterminate'
            : false,
        onCheckChange: (checked) => {
          if (checked) {
            const cleanableIds = filtered.filter(i => !i.isProtected).map(i => i.id)
            setCheckedIds(Array.from(new Set([...checkedIds, ...cleanableIds])))
          } else {
            const removeSet = new Set(filtered.map(i => i.id))
            setCheckedIds(checkedIds.filter(id => !removeSet.has(id)))
          }
        },
        children: filtered.map(item => {
          const isChecked = checkedIds.includes(item.id)
          return List.Item({
            id: item.id,
            title: item.name,
            subtitle:
              item.type === 'startup_item'
                ? `${item.startupScope || '开机自启'} · ${item.recommendation}`
                : item.type === 'process'
                ? `PID: ${item.pid} · ${item.recommendation}`
                : item.path,
            checkable: !item.isProtected,
            checked: isChecked,
            onCheckChange: (c) => {
              if (c) {
                setCheckedIds(Array.from(new Set([...checkedIds, item.id])))
              } else {
                setCheckedIds(checkedIds.filter(id => id !== item.id))
              }
            },
            icon: {
              source:
                item.type === 'startup_item'
                  ? Icon.Rocket
                  : item.type === 'process'
                  ? Icon.Bolt
                  : Icon.Trash,
              tintColor: item.isProtected
                ? Color.SecondaryText
                : item.impactLevel === '高耗时影响'
                ? Color.Orange
                : Color.Green
            },
            accessories: [
              {
                tag: {
                  value: item.isProtected
                    ? '🛡️ 系统保护'
                    : item.type === 'startup_item'
                    ? item.startupScope || '开机启动项'
                    : item.type === 'process'
                    ? '内存工作集'
                    : '临时残留',
                  color: item.isProtected
                    ? Color.SecondaryText
                    : item.type === 'startup_item'
                    ? Color.Purple
                    : Color.Blue
                }
              },
              { text: formatBytes(item.memoryOrSizeBytes) }
            ],
            detail: List.Item.Detail({
              markdown: `# ⚡ ${item.name}

**优化维度**: \`${item.type === 'startup_item' ? `开机启动/自启常驻 (${item.startupScope})` : item.type === 'process' ? `运行中进程 (PID: ${item.pid})` : '系统 %TEMP% 缓存文件'}\`  
**物理路径**: \`${item.path || '系统内核路径'}\`

---

### 📊 资源消耗与启动耗时评估 (BoostPlugin.h)
- **当前占用大小**: \`${formatBytes(item.memoryOrSizeBytes)}\`
- **CPU 瞬时负载**: \`${item.cpuPercent.toFixed(1)}%\`
- **影响评级**: \`${item.impactLevel || '普通'}\`
- **诊断建议**: ${item.recommendation}
`
            }),
            actions: ActionPanel({
              title: item.name,
              children: [
                Action({
                  title: '执行一键系统加速与清理',
                  icon: Icon.Bolt,
                  onAction: () => handleQuickBoost()
                }),
                ...(item.pid && !item.isProtected
                  ? [
                      Action({
                        title: '关闭该进程以释放内存',
                        icon: Icon.XMarkCircle,
                        onAction: () => handleTerminateCandidate(item)
                      })
                    ]
                  : []),
                ...(item.path
                  ? [
                      Action({
                        title: '在资源管理器中定位',
                        icon: Icon.Folder,
                        onAction: () => {
                          openBoostItemLocation(item.path)
                        }
                      })
                    ]
                  : []),
                Action({
                  title: '刷新系统负载与启动项快照',
                  icon: Icon.ArrowClockwise,
                  onAction: () => refreshBoost(true)
                })
              ]
            })
          })
        })
      })
    ]
  })
}
