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
  ProcessNetworkGroup,
  FORBIDDEN_REASON,
  formatBytes,
  fetchFlowGuardSnapshot,
  terminateNetworkProcess,
  openNetworkProcessLocation
} from './logic.js'

export default function FlowGuardCommand() {
  const [searchText, setSearchText] = useState('')
  const [viewMode, setViewMode] = useState<'processes' | 'endpoints' | 'listening'>('processes')
  const [protoFilter, setProtoFilter] = useState<'ALL' | 'TCP' | 'UDP'>('ALL')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'public' | 'lan' | 'loopback' | 'listening'>('all')
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
    refreshConnections(false)
  }, [])

  async function handleKillProcess(group: ProcessNetworkGroup) {
    if (group.isProtected) {
      await confirmAlert({
        title: `⚠️ 核心网络服务保护 [${group.processName}]`,
        message: `PID: ${group.pid}\n\n${FORBIDDEN_REASON}`,
        primaryAction: { title: '我知道了', style: 'default' }
      })
      return
    }

    const confirmed = await confirmAlert({
      title: `确认阻断并结束联网进程 [${group.processName}]？`,
      message: `进程 PID: ${group.pid}\n活跃连接数: ${group.publicCount} 个公网外联 / ${group.establishedCount} 个 ESTABLISHED / ${group.listeningCount} 个 LISTENING\n\n结束进程将立即释放其占用的全部端口与远端连接。`,
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
    refreshConnections(false)
  }

  function renderDetailMarkdown(g: ProcessNetworkGroup): string {
    const endpointRows = g.endpoints
      .slice(0, 22)
      .map(
        (ep, idx) =>
          `${idx + 1}. \`[${ep.protocol}]\` \`${ep.localAddress}:${ep.localPort}\` → \`${ep.remoteAddress}:${ep.remotePort}\` · **${ep.state}** (\`${ep.remoteScope === 'public' ? '🌐公网' : ep.remoteScope === 'lan' ? '🏠内网' : ep.remoteScope === 'loopback' ? '🔁回环' : '📡监听'}\`)`
      )
      .join('\n')

    const guardBanner = g.isProtected
      ? `> [!CAUTION]\n> **核心系统网络服务**：${FORBIDDEN_REASON}`
      : `> [!TIP]\n> **第三方/用户态联网应用**：若发现异常公网外联连接或后台偷跑流量，可一键终止并释放端口。`

    return `# 🌐 ${g.processName} (PID: ${g.pid})

**可执行路径**: \`${g.processPath || '系统内核/受保护服务路径'}\`

---

### 📊 网络五元组与连接域指标 (FlowGuardPlugin.h)
- **活动套接字总数**: \`${g.endpoints.length} 个\` (TCP: \`${g.tcpCount}\` / UDP: \`${g.udpCount}\`)
- **🌐 公网外联会话**: \`${g.publicCount} 个\` · **🏠 局域网会话**: \`${g.lanCount} 个\` · **🔁 本机回环 IPC**: \`${g.loopbackCount} 个\`
- **已建立连接 (ESTABLISHED)**: \`${g.establishedCount} 个\` · **本地监听端口 (LISTENING)**: \`${g.listeningCount} 个\`
- **物理内存占用**: \`${formatBytes(g.memoryBytes)}\` · **CPU 占用**: \`${g.cpuPercent.toFixed(1)}%\`

---

### 🔌 实时五元组端口与远端 IP 明细 (前 ${Math.min(22, g.endpoints.length)} 条)
${endpointRows || '_无活动端口_'}

---

${guardBanner}
`
  }

  const q = searchText.trim().toLowerCase()

  const filteredGroups = groups.filter(g => {
    if (focusPid > 0 && g.pid !== focusPid) return false
    if (protoFilter === 'TCP' && g.tcpCount === 0) return false
    if (protoFilter === 'UDP' && g.udpCount === 0) return false
    if (scopeFilter === 'public' && g.publicCount === 0) return false
    if (scopeFilter === 'lan' && g.lanCount === 0) return false
    if (scopeFilter === 'loopback' && g.loopbackCount === 0) return false
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
      ep =>
        String(ep.localPort).includes(q) ||
        String(ep.remotePort).includes(q) ||
        ep.remoteAddress.toLowerCase().includes(q) ||
        ep.localAddress.toLowerCase().includes(q)
    )
  })

  const allEndpoints = filteredGroups.flatMap(g =>
    g.endpoints
      .filter(ep => {
        if (protoFilter !== 'ALL' && ep.protocol !== protoFilter) return false
        if (scopeFilter !== 'all' && ep.remoteScope !== scopeFilter) return false
        if (viewMode === 'listening' && ep.state !== 'LISTENING' && ep.remoteScope !== 'listening') return false
        return true
      })
      .map(ep => ({
        ...ep,
        processPath: g.processPath,
        isProtected: g.isProtected,
        groupRef: g
      }))
  )

  const distSegments = [
    {
      id: 'public',
      label: `🌐 公网外联 (${totalPublic})`,
      valueBytes: totalPublic,
      formattedSize: `${totalPublic} 条`,
      percentage: totalEndpoints > 0 ? Math.max(4, (totalPublic / totalEndpoints) * 100) : 20,
      color: '#10b981',
      active: scopeFilter === 'all' || scopeFilter === 'public'
    },
    {
      id: 'lan',
      label: `🏠 局域网通信 (${totalLan})`,
      valueBytes: totalLan,
      formattedSize: `${totalLan} 条`,
      percentage: totalEndpoints > 0 ? Math.max(4, (totalLan / totalEndpoints) * 100) : 20,
      color: '#3b82f6',
      active: scopeFilter === 'all' || scopeFilter === 'lan'
    },
    {
      id: 'loopback',
      label: `🔁 本机回环 IPC (${totalLoopback})`,
      valueBytes: totalLoopback,
      formattedSize: `${totalLoopback} 条`,
      percentage: totalEndpoints > 0 ? Math.max(4, (totalLoopback / totalEndpoints) * 100) : 20,
      color: '#a855f7',
      active: scopeFilter === 'all' || scopeFilter === 'loopback'
    },
    {
      id: 'listening',
      label: `📡 端口监听 (${totalListening})`,
      valueBytes: totalListening,
      formattedSize: `${totalListening} 个`,
      percentage: totalEndpoints > 0 ? Math.max(4, (totalListening / totalEndpoints) * 100) : 20,
      color: '#f59e0b',
      active: scopeFilter === 'all' || scopeFilter === 'listening'
    }
  ]

  return List({
    searchBarPlaceholder: '搜索联网进程名称、PID、本地端口或远端公网服务器 IP...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'fg-procs',
          label: '活跃联网进程',
          value: `${groups.length} 个`,
          subValue: `总计 ${totalEndpoints} 个活动套接字`,
          status: 'normal'
        },
        {
          id: 'fg-public',
          label: '🌐 公网外联连接',
          value: `${totalPublic} 条`,
          subValue: `ESTABLISHED 总数 ${totalEstablished}`,
          status: totalPublic > 60 ? 'warning' : 'success'
        },
        {
          id: 'fg-listen',
          label: '📡 本机监听端口',
          value: `${totalListening} 个`,
          subValue: `本机回环 IPC ${totalLoopback} 条`,
          status: 'normal'
        },
        {
          id: 'fg-udp',
          label: 'UDP / 局域网端点',
          value: `${totalUdp} 个 UDP`,
          subValue: `局域网会话 ${totalLan} 条`,
          status: 'normal'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机实时网络套接字五元组域分布 (点击图例筛选对应网络域)',
      totalLabel: `共 ${totalEndpoints} 个活动端点`,
      segments: distSegments,
      onSegmentClick: (segId) => {
        setScopeFilter(scopeFilter === segId ? 'all' : (segId as any))
      }
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 内核 TCP/UDP 套接字枚举', status: 'done' },
        { step: 2, label: '2. 进程 PID 与公网 IP 归属映射', status: 'done' },
        { step: 3, label: '3. 协议/连接域多维过滤', status: 'active' },
        { step: 4, label: '4. 异常外联阻断管控', status: 'pending' }
      ],
      summaryText:
        focusPid > 0
          ? `当前下钻进程 PID: ${focusPid} · 共 ${allEndpoints.length} 条连接`
          : `筛选出 ${filteredGroups.length} 个进程 · ${allEndpoints.length} 条连接`,
      groups: [
        {
          id: 'proto-filter',
          label: '传输协议',
          value: protoFilter,
          onChange: (v) => setProtoFilter(v as any),
          options: [
            { value: 'ALL', label: '全部协议', badge: totalEndpoints },
            { value: 'TCP', label: 'TCP 协议', badge: totalEndpoints - totalUdp },
            { value: 'UDP', label: 'UDP 协议', badge: totalUdp }
          ]
        },
        {
          id: 'scope-filter',
          label: '网络域范围',
          value: scopeFilter,
          onChange: (v) => setScopeFilter(v as any),
          options: [
            { value: 'all', label: '全部地址域' },
            { value: 'public', label: '🌐 仅公网外联', badge: totalPublic },
            { value: 'lan', label: '🏠 局域网通信', badge: totalLan },
            { value: 'loopback', label: '🔁 本机回环 IPC', badge: totalLoopback },
            { value: 'listening', label: '📡 监听服务端口', badge: totalListening }
          ]
        }
      ],
      actions: [
        ...(focusPid > 0
          ? [
              {
                id: 'clear-focus-pid',
                title: `🔙 退出单进程下钻 (PID:${focusPid})`,
                style: 'primary' as const,
                onAction: () => {
                  setFocusPid(0)
                  setViewMode('processes')
                }
              }
            ]
          : []),
        {
          id: 'refresh-net',
          title: '🔄 刷新实时连接',
          style: 'secondary',
          onAction: () => refreshConnections(true)
        },
        {
          id: 'copy-audit',
          title: '📋 复制连接审计表',
          style: 'secondary',
          onAction: async () => {
            const lines = allEndpoints
              .slice(0, 200)
              .map(e => `${e.processName}(PID:${e.pid})\t${e.protocol}\t${e.localAddress}:${e.localPort} -> ${e.remoteAddress}:${e.remotePort}\t[${e.state}]`)
              .join('\n')
            await Clipboard.copy(lines)
            showToast({ style: Toast.Style.Success, title: '已复制五元组连接审计表' })
          }
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: viewMode,
      onChange: v => setViewMode(v as any),
      options: [
        { value: 'processes', label: '按进程聚合监控', badge: filteredGroups.length },
        { value: 'endpoints', label: '五元组连接明细表', badge: allEndpoints.length },
        { value: 'listening', label: '本机监听端口审计', badge: totalListening }
      ]
    }),
    children:
      viewMode === 'endpoints' || viewMode === 'listening'
        ? [
            List.Section({
              title:
                viewMode === 'listening'
                  ? `本机监听端口审计清单 (${allEndpoints.length})`
                  : `实时五元组套接字明细表 (显示前 ${Math.min(120, allEndpoints.length)}/${allEndpoints.length} 条)`,
              children: allEndpoints.slice(0, 120).map((ep, idx) =>
                List.Item({
                  id: `ep-${idx}-${ep.pid}-${ep.localPort}-${ep.remotePort}`,
                  title: `${ep.localAddress}:${ep.localPort} → ${ep.remoteAddress}:${ep.remotePort}`,
                  subtitle: `${ep.processName} (PID: ${ep.pid}) · ${ep.protocol}`,
                  icon: {
                    source: Icon.Globe,
                    tintColor:
                      ep.remoteScope === 'public'
                        ? Color.Green
                        : ep.remoteScope === 'listening'
                        ? Color.Orange
                        : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value:
                          ep.remoteScope === 'public'
                            ? '🌐 公网外联'
                            : ep.remoteScope === 'lan'
                            ? '🏠 局域网'
                            : ep.remoteScope === 'loopback'
                            ? '🔁 本机回环'
                            : '📡 端口监听',
                        color:
                          ep.remoteScope === 'public'
                            ? Color.Green
                            : ep.remoteScope === 'listening'
                            ? Color.Orange
                            : Color.Blue
                      }
                    },
                    { text: ep.state }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderDetailMarkdown(ep.groupRef)
                  }),
                  actions: ActionPanel({
                    title: `${ep.processName} (${ep.localPort})`,
                    children: [
                      Action({
                        title: '仅查看该进程的全部连接',
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setFocusPid(ep.pid)
                          setViewMode('endpoints')
                        }
                      }),
                      Action({
                        title: '阻断并结束该联网进程',
                        icon: Icon.XMarkCircle,
                        onAction: () => handleKillProcess(ep.groupRef)
                      }),
                      Action({
                        title: '复制该五元组连接信息',
                        icon: Icon.Clipboard,
                        onAction: async () => {
                          await Clipboard.copy(
                            `${ep.processName} (PID:${ep.pid}) ${ep.protocol} ${ep.localAddress}:${ep.localPort} -> ${ep.remoteAddress}:${ep.remotePort} [${ep.state}]`
                          )
                          showToast({ style: Toast.Style.Success, title: '已复制五元组信息' })
                        }
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [
            List.Section({
              title: `本机实时网络连接与端口监控 (${filteredGroups.length})`,
              subtitle: '支持点击或回车下钻查看进程全部五元组套接字',
              children: filteredGroups.map(g =>
                List.Item({
                  id: `net-proc-${g.pid}`,
                  title: g.processName,
                  subtitle: `PID: ${g.pid} · 🌐公网: ${g.publicCount} / 🏠内网: ${g.lanCount} / 📡监听: ${g.listeningCount} / UDP: ${g.udpCount}`,
                  icon: {
                    source: Icon.Globe,
                    tintColor: g.isProtected ? Color.SecondaryText : g.publicCount > 0 ? Color.Green : Color.Blue
                  },
                  accessories: [
                    {
                      tag: {
                        value:
                          g.publicCount > 0
                            ? `🌐 ${g.publicCount} 公网连接`
                            : g.establishedCount > 0
                            ? `${g.establishedCount} 活动连接`
                            : `📡 ${g.listeningCount} 监听`,
                        color: g.publicCount > 0 ? Color.Green : Color.Blue
                      }
                    },
                    { text: `${g.endpoints.length} 套接字` }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderDetailMarkdown(g)
                  }),
                  actions: ActionPanel({
                    title: g.processName,
                    children: [
                      Action({
                        title: `下钻查看 [${g.processName}] 的全部连接 (${g.endpoints.length})`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setFocusPid(g.pid)
                          setViewMode('endpoints')
                        }
                      }),
                      Action({
                        title: '刷新实时网络连接快照',
                        icon: Icon.ArrowClockwise,
                        onAction: () => refreshConnections(true)
                      }),
                      Action({
                        title: '阻断并结束该联网进程',
                        icon: Icon.XMarkCircle,
                        onAction: () => handleKillProcess(g)
                      }),
                      ...(g.processPath
                        ? [
                            Action({
                              title: '在资源管理器中定位程序',
                              icon: Icon.Folder,
                              onAction: () => {
                                openNetworkProcessLocation(g.processPath)
                              }
                            })
                          ]
                        : []),
                      Action({
                        title: '复制连接审计明细',
                        icon: Icon.Clipboard,
                        onAction: async () => {
                          const summaryText = g.endpoints
                            .map(e => `${e.protocol} ${e.localAddress}:${e.localPort} -> ${e.remoteAddress}:${e.remotePort} (${e.state})`)
                            .join('\n')
                          await Clipboard.copy(summaryText)
                          showToast({ style: Toast.Style.Success, title: '已复制连接明细', message: `${g.endpoints.length} 条记录` })
                        }
                      })
                    ]
                  })
                })
              )
            })
          ]
  })
}
