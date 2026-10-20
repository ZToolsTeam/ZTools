import {
  List,
  ActionPanel,
  Action,
  Icon,
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

import { isRealElectronHost, trashRealItem } from '../shared/native-ipc.js'

const INIT_BOOST_SNAPSHOT: BoostSnapshot = {
  totalMemoryBytes: 32 * 1024 * 1024 * 1024,
  usedMemoryBytes: 22 * 1024 * 1024 * 1024,
  availableMemoryBytes: 10 * 1024 * 1024 * 1024,
  memoryUsagePercent: 68,
  cpuUsagePercent: 18,
  reclaimableEstimateBytes: 2.8 * 1024 * 1024 * 1024,
  startupItemCount: 3,
  candidates: [
    {
      id: 'boost-init-proc-1',
      type: 'process',
      pid: 14820,
      name: 'chrome.exe',
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      memoryOrSizeBytes: 1.4 * 1024 * 1024 * 1024,
      cpuPercent: 6.5,
      isProtected: false,
      impactLevel: '高耗时影响',
      recommendation: '高内存占用后台渲染进程，闲置时可释放工作集'
    },
    {
      id: 'boost-init-startup-1',
      type: 'startup_item',
      name: '[开机启动] SteamClientBootstrapper',
      path: 'C:\\Users\\Admin\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Steam.lnk',
      memoryOrSizeBytes: 320 * 1024 * 1024,
      cpuPercent: 1.2,
      isProtected: false,
      startupScope: '用户启动目录 (Startup)',
      impactLevel: '高耗时影响',
      recommendation: '随 Windows 登录自动拉起，可移出启动目录以缩短开机耗时'
    },
    {
      id: 'boost-init-temp-1',
      type: 'temp_cache',
      name: '[临时缓存] electron_crashpad_dump.dmp',
      path: 'C:\\Users\\Admin\\AppData\\Local\\Temp\\electron_crashpad_dump.dmp',
      memoryOrSizeBytes: 180 * 1024 * 1024,
      cpuPercent: 0,
      isProtected: false,
      impactLevel: '低影响',
      recommendation: '系统 %TEMP% 瞬时热点缓存残留，可安全移入回收站'
    },
    {
      id: 'boost-init-sys-1',
      type: 'process',
      pid: 4,
      name: 'System',
      path: 'C:\\Windows\\System32\\ntoskrnl.exe',
      memoryOrSizeBytes: 256 * 1024 * 1024,
      cpuPercent: 0.8,
      isProtected: true,
      impactLevel: '低影响',
      recommendation: 'Windows 系统内核进程 (安全锁定保护)'
    }
  ]
}

export default function BoostCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'process' | 'startup_item' | 'temp_cache'>('all')
  const [impactFilter, setImpactFilter] = useState<'all' | 'high' | 'cleanable'>('all')
  const [snapshot, setSnapshot] = useState<BoostSnapshot>(() =>
    isRealElectronHost()
      ? {
          totalMemoryBytes: 0,
          usedMemoryBytes: 0,
          availableMemoryBytes: 0,
          memoryUsagePercent: 0,
          cpuUsagePercent: 0,
          reclaimableEstimateBytes: 0,
          startupItemCount: 0,
          candidates: []
        }
      : INIT_BOOST_SNAPSHOT
  )
  const [checkedIds, setCheckedIds] = useState<string[]>(() =>
    isRealElectronHost() ? [] : INIT_BOOST_SNAPSHOT.candidates.filter(c => !c.isProtected).map(c => c.id)
  )
  const [isLoading, setIsLoading] = useState(true)

  async function refreshBoost(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const snap = await fetchBoostSnapshot()
      if (isRealElectronHost() || snap.candidates.length > 0) {
        setSnapshot(snap)
        setCheckedIds(
          snap.candidates
            .filter(c => (c.type === 'temp_cache' || c.impactLevel === '高耗时影响') && !c.isProtected)
            .map(c => c.id)
        )
      }
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
    const selectedItems = snapshot.candidates.filter(c => checkedIds.includes(c.id) && !c.isProtected)
    const tempItems =
      selectedItems.length > 0
        ? selectedItems
        : snapshot.candidates.filter(c => c.type === 'temp_cache' && !c.isProtected)

    const confirmed = await confirmAlert({
      title: `确认执行系统一键加速 (${tempItems.length} 项优化)？`,
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
        title: `核心进程受保护 [${item.name}]`,
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

  const candidates = snapshot.candidates || []
  const q = searchText.trim().toLowerCase()
  const filtered = candidates
    .filter(c => {
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
    .sort((a, b) => b.memoryOrSizeBytes - a.memoryOrSizeBytes)

  const memPct = snapshot.memoryUsagePercent || 0
  const cpuPct = snapshot.cpuUsagePercent || 0
  const totalMem = snapshot.totalMemoryBytes || 1
  const usedMem = snapshot.usedMemoryBytes || 0
  const availMem = snapshot.availableMemoryBytes || 0

  const procCandidates = candidates.filter(c => c.type === 'process')
  const top5ProcBytes = procCandidates.slice(0, 5).reduce((s, c) => s + c.memoryOrSizeBytes, 0)
  const otherUsedBytes = Math.max(0, usedMem - top5ProcBytes)

  const memSegments = [
    {
      id: 'top5',
      label: `Top 5 大户进程 (${formatBytes(top5ProcBytes)})`,
      valueBytes: top5ProcBytes,
      formattedSize: formatBytes(top5ProcBytes),
      percentage: Math.max(8, (top5ProcBytes / totalMem) * 100),
      color: '#64748b',
      active: true
    },
    {
      id: 'other-used',
      label: `系统与其他驻留 (${formatBytes(otherUsedBytes)})`,
      valueBytes: otherUsedBytes,
      formattedSize: formatBytes(otherUsedBytes),
      percentage: Math.max(10, (otherUsedBytes / totalMem) * 100),
      color: '#64748b',
      active: true
    },
    {
      id: 'free-ram',
      label: `空闲可用内存 (${formatBytes(availMem)})`,
      valueBytes: availMem,
      formattedSize: formatBytes(availMem),
      percentage: Math.max(8, (availMem / totalMem) * 100),
      color: '#64748b',
      active: true
    }
  ]

  function toggleSingleBoost(id: string, checked: boolean) {
    setCheckedIds(prev => {
      const set = new Set(prev)
      if (checked) set.add(id)
      else set.delete(id)
      return Array.from(set)
    })
  }

  const maxItemBytes = Math.max(1, filtered[0]?.memoryOrSizeBytes || 1)
  const rightSubListItems = filtered.map(item => {
    const isChecked = !item.isProtected && checkedIds.includes(item.id)
    const volRatio = Math.max(10, Math.min(100, Math.round((item.memoryOrSizeBytes / maxItemBytes) * 100)))
    const typeLabel =
      item.isProtected
        ? '系统保护锁定'
        : item.type === 'startup_item'
        ? item.startupScope || '开机启动项'
        : item.type === 'process'
        ? '内存工作集'
        : '瞬时缓存'

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
      lockedReason: item.isProtected ? '系统核心进程安全保护锁定' : undefined,
      onCheckChange: (c: boolean) => toggleSingleBoost(item.id, c),
      onToggleCheck: (c: boolean) => toggleSingleBoost(item.id, c),
      icon: {
        source: item.isProtected
          ? Icon.Lock
          : item.type === 'startup_item'
          ? Icon.Rocket
          : item.type === 'process'
          ? Icon.Bolt
          : Icon.Trash
      },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: typeLabel } },
        { text: formatBytes(item.memoryOrSizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: `# ${item.name}\n\n- **优化维度**: \`${item.type}\`\n- **物理路径**: \`${item.path}\`\n- **当前占用**: \`${formatBytes(item.memoryOrSizeBytes)}\`\n- **诊断建议**: ${item.recommendation}\n`
      }),
      actions: ActionPanel({
        title: item.name,
        children: [
          Action({
            title: '一键执行勾选加速',
            icon: Icon.Bolt,
            onAction: () => handleQuickBoost()
          }),
          ...(item.path
            ? [
                Action({
                  title: '在资源管理器定位',
                  icon: Icon.Folder,
                  onAction: () => {
                    openBoostItemLocation(item.path)
                  }
                })
              ]
            : []),
          ...(item.pid && !item.isProtected
            ? [
                Action({
                  title: '关闭该进程以释放内存',
                  icon: Icon.XMarkCircle,
                  style: Action.Style.Destructive,
                  onAction: () => handleTerminateCandidate(item)
                })
              ]
            : [])
        ]
      })
    } as any)
  })

  const selectableFiltered = filtered.filter(i => !i.isProtected)
  const checkedInFiltered = selectableFiltered.filter(i => checkedIds.includes(i.id))
  const selectedBytes = checkedInFiltered.reduce((acc, i) => acc + i.memoryOrSizeBytes, 0)
  const allChecked = selectableFiltered.length > 0 && checkedInFiltered.length === selectableFiltered.length
  const someChecked = checkedInFiltered.length > 0 && !allChecked

  return List({
    searchBarPlaceholder: '搜索高内存进程、开机启动项 (Startup/常驻)、PID 或 %TEMP% 缓存...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '按加速影响等级筛选',
      value: impactFilter,
      onChange: val => setImpactFilter(val as any),
      children: [
        List.Dropdown.Item({ title: `全部加速候选 (${candidates.length})`, value: 'all' }),
        List.Dropdown.Item({
          title: `高内存/高耗时影响 (${candidates.filter(c => c.impactLevel === '高耗时影响').length})`,
          value: 'high'
        }),
        List.Dropdown.Item({
          title: `可安全加速项 (${candidates.filter(c => !c.isProtected).length})`,
          value: 'cleanable'
        })
      ]
    }),
    filterBar: FilterBar({
      summaryText: `物理内存已用 ${memPct}% (${formatBytes(usedMem)}/${formatBytes(totalMem)}) · 已勾选 ${checkedInFiltered.length} 项待加速 (预计释放 ${formatBytes(selectedBytes)})`,
      actions: [
        {
          id: 'rescan-boost',
          label: '重新扫描',
          title: '重新扫描',
          style: 'secondary',
          onAction: () => refreshBoost(true)
        }
      ]
    }),
    subList: {
      title: '系统内存释放、启动项与临时缓存明细 (按占用降序，直接勾选或按 ↵ 加速)',
      subtitle: `${filtered.length} 项 · 已选 ${checkedInFiltered.length} 项 (${formatBytes(selectedBytes)})`,
      checkable: selectableFiltered.length > 0,
      checked: allChecked ? true : someChecked ? 'indeterminate' : false,
      onCheckChange: checked => {
        if (checked) {
          const cleanableIds = selectableFiltered.map(i => i.id)
          setCheckedIds(Array.from(new Set([...checkedIds, ...cleanableIds])))
        } else {
          const removeSet = new Set(selectableFiltered.map(i => i.id))
          setCheckedIds(checkedIds.filter(id => !removeSet.has(id)))
        }
      },
      emptyText: '当前分类下暂无可优化的进程或启动项',
      items: rightSubListItems
    },
    children: [
      List.Section({
        title: '系统加速导航树',
        children: [
          List.Item({
            id: 'boost-nav-all',
            title: '全部加速项汇总',
            subtitle: `共 ${candidates.length} 项候选 · 预计释放 ${formatBytes(snapshot.reclaimableEstimateBytes)}`,
            icon: { source: Icon.Bolt },
            accessories: [{ text: `${candidates.length} 项` }],
            onSelect: () => setTab('all')
          }),
          List.Item({
            id: 'boost-nav-process',
            title: '高内存后台进程治理',
            subtitle: '释放高占用后台驻留进程内存工作集',
            icon: { source: Icon.Cpu },
            accessories: [{ text: `${candidates.filter(c => c.type === 'process').length} 项` }],
            onSelect: () => setTab('process')
          }),
          List.Item({
            id: 'boost-nav-startup',
            title: 'Windows 开机启动项管理 (Startup)',
            subtitle: '用户与公共 Startup 目录及注册表自启常驻',
            icon: { source: Icon.Rocket },
            accessories: [{ text: `${candidates.filter(c => c.type === 'startup_item').length} 项` }],
            onSelect: () => setTab('startup_item')
          }),
          List.Item({
            id: 'boost-nav-temp',
            title: '%TEMP% 瞬时热点缓存清理',
            subtitle: '清理运行时遗留转储与临时交换文件',
            icon: { source: Icon.Trash },
            accessories: [{ text: `${candidates.filter(c => c.type === 'temp_cache').length} 项` }],
            onSelect: () => setTab('temp_cache')
          })
        ]
      })
    ]
  })
}
