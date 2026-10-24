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
  Toast
} from '../../index.js'
import {
  type NetworkRescueItem,
  type RescueFilterMode,
  NETWORK_RESCUE_ITEMS,
  runNetworkDiagnostics,
  executeNetworkRepair,
  batchExecuteNetworkRepairs,
  filterNetworkRescueItems
} from './logic.js'

export * from './logic.js'

export function NetworkRescueCommand() {
  const [searchText, setSearchText] = useState('')
  const [filterMode, setFilterMode] = useState<RescueFilterMode>('all')
  const [items, setItems] = useState<NetworkRescueItem[]>(NETWORK_RESCUE_ITEMS)
  const [healthScore, setHealthScore] = useState(86)
  const [latencyMs, setLatencyMs] = useState(14)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshDiagnostics(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await runNetworkDiagnostics()
      setItems(snap.items)
      setHealthScore(snap.overallHealthScore)
      setLatencyMs(snap.latencyMs)
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: '全网连通性诊断已完成',
          message: `网络健康评分 ${snap.overallHealthScore} 分 · 待处理告警 ${snap.warningCount} 项`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshDiagnostics(false)
  }, [])

  async function handleRepairItem(item: NetworkRescueItem) {
    const res = await executeNetworkRepair(item.id)
    if (res.ok) {
      setItems((prev) =>
        prev.map((cur) =>
          cur.id === item.id
            ? { ...cur, status: 'repaired', statusText: '已执行修复', healthScore: 100 }
            : cur
        )
      )
      setHealthScore((prev) => Math.min(100, prev + 6))
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: item.command
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '修复执行失败',
        message: res.message
      })
    }
  }

  async function handleRepairAllWarnings() {
    const warningIds = items.filter((i) => i.status === 'warning' || i.status === 'error').map((i) => i.id)
    const res = await batchExecuteNetworkRepairs(warningIds)
    if (res.ok && res.repairedCount > 0) {
      setItems((prev) =>
        prev.map((cur) =>
          cur.status === 'warning' || cur.status === 'error'
            ? { ...cur, status: 'repaired', statusText: '已自动修复', healthScore: 100 }
            : cur
        )
      )
      setHealthScore(99)
      showToast({
        style: Toast.Style.Success,
        title: res.summary,
        message: '已清理残留代理与异常域名劫持'
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '批量修复未完成',
        message: res.summary
      })
    }
  }

  const filtered = filterNetworkRescueItems(items, searchText, filterMode)
  const warningCount = items.filter((i) => i.status === 'warning' || i.status === 'error').length

  return List({
    navigationTitle: '网络断网诊断与急救箱',
    searchBarPlaceholder: '搜索网络急救项 (如: DNS 缓存, 残留系统代理, Winsock 重置, Hosts 劫持, DHCP)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '筛选网络急救分类',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as RescueFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部急救项 (All Rescue Items)', value: 'all' }),
        List.Dropdown.Item({ title: '异常告警项 (Warnings Only)', value: 'warning' }),
        List.Dropdown.Item({ title: 'DNS与代理修复 (DNS & Proxy)', value: 'dns_proxy' }),
        List.Dropdown.Item({ title: '协议栈重置 (Winsock & Firewall)', value: 'stack_reset' })
      ]
    }),
    filterBar: {
      summaryText: `网络综合健康度 ${healthScore} 分 · 已巡检 ${items.length} 项 · 异常告警 ${warningCount} 项 · 外网 DNS 延迟 ${latencyMs} ms`,
      actions: [
        {
          id: 'rediagnose',
          label: '重新诊断全网',
          title: '重新诊断全网',
          style: 'secondary',
          onAction: () => void refreshDiagnostics(true)
        },
        ...(warningCount > 0
          ? [
              {
                id: 'repair-warnings',
                label: `一键修复异常 (${warningCount})`,
                title: `一键修复异常 (${warningCount})`,
                style: 'secondary' as const,
                onAction: () => void handleRepairAllWarnings()
              }
            ]
          : [])
      ]
    },
    children: [
      List.Section({
        title: `网络故障诊断与一键修复项 (${filtered.length})`,
        children: filtered.map((item) => {
          const isWarning = item.status === 'warning' || item.status === 'error'
          return List.Item({
            id: item.id,
            title: item.title,
            subtitle: `${item.subtitle}`,
            icon: isWarning ? Icon.ExclamationMark : Icon.Shield,
            accessories: [
              { progress: { value: item.healthScore } },
              {
                tag: {
                  value: isWarning ? '异常告警' : item.status === 'repaired' ? '已修复' : item.categoryLabel,
                  ...(isWarning ? { color: Color.Red } : {})
                }
              },
              { text: item.statusText }
            ],
            actions: ActionPanel({
              title: item.title,
              children: [
                Action({
                  title: `一键执行修复 (${item.categoryLabel})`,
                  icon: Icon.Bolt,
                  onAction: () => handleRepairItem(item)
                }),
                Action({
                  title: '复制底层修复命令',
                  icon: Icon.Clipboard,
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: async () => {
                    await Clipboard.copy(item.command)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制修复命令',
                      message: item.command
                    })
                  }
                }),
                Action({
                  title: '重新诊断全网连通性',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshDiagnostics(true)
                }),
                ...(warningCount > 0
                  ? [
                      Action({
                        title: `批量修复全部 ${warningCount} 项异常`,
                        icon: Icon.Checkmark,
                        onAction: () => handleRepairAllWarnings()
                      })
                    ]
                  : [])
              ]
            })
          })
        })
      })
    ]
  })
}

export default NetworkRescueCommand
