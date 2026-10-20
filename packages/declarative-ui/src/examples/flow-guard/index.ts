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
  ProcessNetworkGroup,
  FORBIDDEN_REASON,
  fetchFlowGuardSnapshot,
  terminateNetworkProcess,
  openNetworkProcessLocation
} from './logic.js'

export * from './logic.js'

type FlowDropdownFilter = 'all' | 'public' | 'lan' | 'listening' | 'processes' | 'tcp' | 'udp'

export default function FlowGuardCommand() {
  const [searchText, setSearchText] = useState('')
  const [dropdownFilter, setDropdownFilter] = useState<FlowDropdownFilter>('all')
  const [focusPid, setFocusPid] = useState<number>(0)
  const [groups, setGroups] = useState<ProcessNetworkGroup[]>([])
  const [totalEndpoints, setTotalEndpoints] = useState(0)
  const [totalEstablished, setTotalEstablished] = useState(0)
  const [totalListening, setTotalListening] = useState(0)
  const [totalUdp, setTotalUdp] = useState(0)
  const [totalPublic, setTotalPublic] = useState(0)
  const [totalLan, setTotalLan] = useState(0)
  const [totalLoopback, setTotalLoopback] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshConnections(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const snap = await fetchFlowGuardSnapshot()
      setGroups(snap.groups)
      setTotalEndpoints(snap.totalEndpoints)
      setTotalEstablished(snap.totalEstablished)
      setTotalListening(snap.totalListening)
      setTotalUdp(snap.totalUdp)
      setTotalPublic(snap.totalPublic)
      setTotalLan(snap.totalLan)
      setTotalLoopback(snap.totalLoopback)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '实时网络连接已刷新',
          message: `${snap.groups.length} 个联网进程 · ${snap.totalPublic} 条公网外联 · ${snap.totalEndpoints} 个套接字`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshConnections(false)
  }, [])

  async function handleKillProcess(group: ProcessNetworkGroup) {
    if (group.isProtected) {
      await confirmAlert({
        title: `核心网络服务保护 [${group.processName}]`,
        message: `PID: ${group.pid}\n\n${FORBIDDEN_REASON}`,
        primaryAction: { title: '我知道了', style: 'default' }
      })
      return
    }

    const confirmed = await confirmAlert({
      title: `确认阻断并结束联网进程 [${group.processName}]？`,
      message: `进程 PID: ${group.pid}\n活跃连接数: ${group.publicCount} 个公网外联 / ${group.establishedCount} 个 ESTABLISHED / ${group.listeningCount} 个 LISTENING`,
      primaryAction: { title: '立即阻断结束', style: 'destructive' }
    })
    if (!confirmed) return

    const res = await terminateNetworkProcess(group.pid, group.processName)
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '阻断失败',
        message: res.error || '权限不足'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '已终止联网进程',
      message: `${group.processName} (PID: ${group.pid})`
    })
    void refreshConnections(false)
  }

  const q = searchText.trim().toLowerCase()
  const protoFilter = dropdownFilter === 'tcp' ? 'TCP' : dropdownFilter === 'udp' ? 'UDP' : 'ALL'
  const scopeFilter =
    dropdownFilter === 'public' || dropdownFilter === 'lan' || dropdownFilter === 'listening'
      ? dropdownFilter
      : 'all'

  const filteredGroups = groups.filter((g) => {
    if (focusPid > 0 && g.pid !== focusPid) return false
    if (protoFilter === 'TCP' && g.tcpCount === 0) return false
    if (protoFilter === 'UDP' && g.udpCount === 0) return false
    if (scopeFilter === 'public' && g.publicCount === 0) return false
    if (scopeFilter === 'lan' && g.lanCount === 0) return false
    if (scopeFilter === 'listening' && g.listeningCount === 0) return false
    if (!q) return true
    if (
      g.processName.toLowerCase().includes(q) ||
      String(g.pid).includes(q) ||
      g.processPath.toLowerCase().includes(q)
    ) {
      return true
    }
    return g.endpoints.some(
      (ep) =>
        String(ep.localPort).includes(q) ||
        String(ep.remotePort).includes(q) ||
        ep.remoteAddress.toLowerCase().includes(q) ||
        ep.localAddress.toLowerCase().includes(q)
    )
  })

  const allEndpoints = filteredGroups.flatMap((g) =>
    g.endpoints
      .filter((ep) => {
        if (protoFilter !== 'ALL' && ep.protocol !== protoFilter) return false
        if (scopeFilter !== 'all' && ep.remoteScope !== scopeFilter) return false
        return true
      })
      .map((ep) => ({
        ...ep,
        processPath: g.processPath,
        isProtected: g.isProtected,
        groupCount: g.endpoints.length,
        groupRef: g
      }))
  )

  const maxGroupEndpoints = Math.max(1, ...groups.map((g) => g.endpoints.length))

  return List({
    searchBarPlaceholder: '搜索联网进程名称、PID、本地端口或远端服务器 IP...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择网络连接筛选视图',
      value: dropdownFilter,
      onChange: (val: string) => setDropdownFilter(val as FlowDropdownFilter),
      children: [
        List.Dropdown.Item({ title: '全部活动连接 (All Connections)', value: 'all' }),
        List.Dropdown.Item({ title: '仅看公网外联 (Public)', value: 'public' }),
        List.Dropdown.Item({ title: '局域网连接 (LAN)', value: 'lan' }),
        List.Dropdown.Item({ title: '本机监听端口 (LISTEN)', value: 'listening' }),
        List.Dropdown.Item({ title: '仅看 TCP 协议连接 (TCP Only)', value: 'tcp' }),
        List.Dropdown.Item({ title: '仅看 UDP 协议端点 (UDP Only)', value: 'udp' }),
        List.Dropdown.Item({ title: '按进程聚合视图 (By Process)', value: 'processes' })
      ]
    }),
    filterBar: {
      summaryText: `活跃套接字 ${totalEndpoints} 个 (TCP ${totalEndpoints - totalUdp} / UDP ${totalUdp}) · 公网外联 ${totalPublic} 条 (已建立 ${totalEstablished}) · 监听端口 ${totalListening} 个 · 局域网 ${totalLan} / 回环 ${totalLoopback} · 联网进程 ${groups.length} 个`,
      actions: [
        ...(focusPid > 0
          ? [
              {
                id: 'clear-focus-pid',
                label: `退出进程过滤 (PID:${focusPid})`,
                title: `退出进程过滤 (PID:${focusPid})`,
                style: 'secondary' as const,
                onAction: () => {
                  setFocusPid(0)
                }
              }
            ]
          : []),
        {
          id: 'refresh-net',
          label: '刷新连接',
          title: '刷新连接',
          style: 'secondary',
          onAction: () => void refreshConnections(true)
        }
      ]
    },
    children:
      dropdownFilter === 'processes'
        ? [
            List.Section({
              title: `联网进程聚合视图 (${filteredGroups.length})`,
              children: filteredGroups.map((g) => {
                const firstEp = g.endpoints[0]
                const epSummary = firstEp
                  ? `${firstEp.protocol} ${firstEp.localAddress}:${firstEp.localPort} -> ${firstEp.remoteAddress}:${firstEp.remotePort}`
                  : g.processPath || '本机网络服务'
                const ratio = Math.min(100, Math.max(5, Math.round((g.endpoints.length / maxGroupEndpoints) * 100)))
                const scopeTag =
                  g.publicCount > 0 ? '公网外联' : g.listeningCount > 0 ? '监听端口' : '局域网'

                return List.Item({
                  id: `net-proc-${g.pid}`,
                  title: `${g.processName} (PID: ${g.pid})`,
                  subtitle: `${epSummary} · 公网 ${g.publicCount} / 局域网 ${g.lanCount} / 监听 ${g.listeningCount}`,
                  icon: g.isProtected ? Icon.Shield : Icon.Globe,
                  accessories: [
                    { progress: { value: ratio } },
                    {
                      tag: {
                        value: scopeTag,
                        ...(g.publicCount > 25 ? { color: Color.Red } : {})
                      }
                    },
                    { text: `ESTABLISHED ${g.establishedCount} / LISTEN ${g.listeningCount}` }
                  ],
                  actions: ActionPanel({
                    title: `${g.processName} (PID: ${g.pid})`,
                    children: [
                      Action({
                        title: `查看该进程全部连接 (${g.endpoints.length})`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setFocusPid(g.pid)
                          setDropdownFilter('all')
                        }
                      }),
                      Action({
                        title: '阻断并结束该联网进程',
                        icon: Icon.XMarkCircle,
                        style: 'destructive',
                        shortcut: { modifiers: ['ctrl'], key: 'return' },
                        onAction: () => handleKillProcess(g)
                      }),
                      ...(g.processPath
                        ? [
                            Action({
                              title: '在资源管理器中定位程序',
                              icon: Icon.Folder,
                              shortcut: { modifiers: ['ctrl'], key: 'o' },
                              onAction: () => {
                                void openNetworkProcessLocation(g.processPath)
                              }
                            })
                          ]
                        : []),
                      Action({
                        title: '复制连接审计明细',
                        icon: Icon.Clipboard,
                        shortcut: { modifiers: ['ctrl'], key: 'c' },
                        onAction: async () => {
                          const text = g.endpoints
                            .map(
                              (e) =>
                                `${e.protocol} ${e.localAddress}:${e.localPort} -> ${e.remoteAddress}:${e.remotePort} (${e.state})`
                            )
                            .join('\n')
                          await Clipboard.copy(text)
                          showToast({
                            style: Toast.Style.Success,
                            title: '已复制连接明细',
                            message: `${g.endpoints.length} 条记录`
                          })
                        }
                      }),
                      Action({
                        title: '刷新连接',
                        icon: Icon.ArrowClockwise,
                        shortcut: { modifiers: ['ctrl'], key: 'r' },
                        onAction: () => refreshConnections(true)
                      })
                    ]
                  })
                })
              })
            })
          ]
        : [
            List.Section({
              title: `活动套接字连接明细 (${allEndpoints.length})`,
              children: allEndpoints.slice(0, 120).map((ep, idx) => {
                const scopeLabel =
                  ep.remoteScope === 'public'
                    ? '公网外联'
                    : ep.remoteScope === 'lan'
                    ? '局域网'
                    : ep.remoteScope === 'loopback'
                    ? '本机回环'
                    : '监听端口'
                const ratio = Math.min(100, Math.max(6, Math.round((ep.groupCount / maxGroupEndpoints) * 100)))

                return List.Item({
                  id: `ep-${idx}-${ep.pid}-${ep.localPort}-${ep.remotePort}`,
                  title: `${ep.processName} (PID: ${ep.pid})`,
                  subtitle: `${ep.protocol} ${ep.localAddress}:${ep.localPort} -> ${ep.remoteAddress}:${ep.remotePort} (${scopeLabel})`,
                  icon: ep.isProtected ? Icon.Shield : Icon.Globe,
                  accessories: [
                    { progress: { value: ratio } },
                    { tag: { value: scopeLabel } },
                    { text: ep.state === 'LISTENING' ? 'LISTEN' : ep.state }
                  ],
                  actions: ActionPanel({
                    title: `${ep.processName} (${ep.localPort})`,
                    children: [
                      Action({
                        title: '阻断并结束该联网进程',
                        icon: Icon.XMarkCircle,
                        style: 'destructive',
                        onAction: () => handleKillProcess(ep.groupRef)
                      }),
                      Action({
                        title: '复制五元组连接信息',
                        icon: Icon.Clipboard,
                        shortcut: { modifiers: ['ctrl'], key: 'c' },
                        onAction: async () => {
                          await Clipboard.copy(
                            `${ep.processName} (PID:${ep.pid}) ${ep.protocol} ${ep.localAddress}:${ep.localPort} -> ${ep.remoteAddress}:${ep.remotePort} [${ep.state}]`
                          )
                          showToast({ style: Toast.Style.Success, title: '已复制五元组信息' })
                        }
                      }),
                      Action({
                        title: '仅筛选该进程连接',
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setFocusPid(ep.pid)
                        }
                      }),
                      ...(ep.processPath
                        ? [
                            Action({
                              title: '在资源管理器中定位程序',
                              icon: Icon.Folder,
                              shortcut: { modifiers: ['ctrl'], key: 'o' },
                              onAction: () => {
                                void openNetworkProcessLocation(ep.processPath)
                              }
                            })
                          ]
                        : []),
                      Action({
                        title: '刷新连接',
                        icon: Icon.ArrowClockwise,
                        shortcut: { modifiers: ['ctrl'], key: 'r' },
                        onAction: () => refreshConnections(true)
                      })
                    ]
                  })
                })
              })
            })
          ]
  })
}
