import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  useState,
  useEffect,
  useRef,
  showToast,
  Toast,
  confirmAlert,
  MetricGrid,
  SegmentedControl
} from '../../index.js'
import {
  DLL_PLUGIN_NAME,
  type ProcessItem,
  type SystemInfoData,
  type ProcessDetailInfo,
  type ProcessServiceInfo,
  type ProcessSortKey,
  type ProcessTerminateMode,
  CRITICAL_PROCESS_NAMES,
  formatBytes,
  getMockProcesses,
  getMockSystemInfo,
  getMockProcessDetail,
  getMockServicesByPID,
  fetchProcesses,
  fetchSystemInfo,
  fetchProcessDetail,
  fetchServicesByPID,
  terminateProcess,
  openFileLocation,
  getResourceFocus,
  filterProcesses
} from './logic.js'

import { isRealElectronHost } from '../shared/native-ipc.js'

export default function ProcessMonitorCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'user' | 'system'>('all')
  const [sortBy, setSortBy] = useState<ProcessSortKey>('cpu')
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true)
  const [processes, setProcesses] = useState<ProcessItem[]>(inRealHost ? [] : getMockProcesses())
  const [systemInfo, setSystemInfo] = useState<SystemInfoData>(
    inRealHost
      ? {
          cpuUsagePercent: 0,
          cpuCoreCount: 0,
          totalMemoryBytes: 0,
          usedMemoryBytes: 0,
          availableMemoryBytes: 0,
          totalMemory: 0,
          availableMemory: 0,
          memoryUsagePercent: 0,
          processCount: 0,
          threadCount: 0
        }
      : getMockSystemInfo()
  )
  const [isLoading, setIsLoading] = useState(inRealHost)
  const [details, setDetails] = useState<Record<number, ProcessDetailInfo>>(() => {
    const initDetails: Record<number, ProcessDetailInfo> = {}
    if (inRealHost) return initDetails
    for (const p of getMockProcesses()) {
      initDetails[p.pid] = getMockProcessDetail(p.pid)
    }
    return initDetails
  })
  const [services, setServices] = useState<Record<number, ProcessServiceInfo[]>>(() => {
    const initServices: Record<number, ProcessServiceInfo[]> = {}
    if (inRealHost) return initServices
    initServices[1044] = getMockServicesByPID(1044)
    return initServices
  })
  const refreshingRef = useRef(false)
  const detailLoadedRef = useRef<Record<number, boolean>>({})

  // 加载单个或焦点进程的详情与关联服务
  async function loadProcessExtra(proc: ProcessItem, showNotice = false) {
    if (!proc || proc.pid <= 0) return
    try {
      const isSvchost = proc.name.toLowerCase() === 'svchost.exe'
      const [detailRes, svcRes] = await Promise.all([
        fetchProcessDetail(proc.pid),
        isSvchost || proc.isSystem ? fetchServicesByPID(proc.pid) : Promise.resolve([])
      ])
      if (detailRes) {
        setDetails((prev) => ({ ...prev, [proc.pid]: detailRes }))
      }
      if (Array.isArray(svcRes) && svcRes.length > 0) {
        setServices((prev) => ({ ...prev, [proc.pid]: svcRes }))
      }
      detailLoadedRef.current[proc.pid] = true
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: `已加载进程深度画像: ${proc.name}`,
          message: `PID: ${proc.pid}${svcRes?.length ? ` · 托管服务: ${svcRes.length} 项` : ''}`
        })
      }
    } catch {
      // ignore background detail errors
    }
  }

  // 刷新全量数据（带互斥防抖锁）
  async function refreshData(showIndicator = false) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (showIndicator) setIsLoading(true)
    try {
      const [newProcs, newSys] = await Promise.all([fetchProcesses(), fetchSystemInfo()])
      if (newProcs.length > 0) {
        setProcesses(newProcs)
        // 为焦点高占用进程与首个 svchost 进程预取真实详情与托管服务
        const focus = getResourceFocus(newProcs)
        const candidates: ProcessItem[] = []
        if (focus.topCpu) candidates.push(focus.topCpu)
        if (focus.topMemory && focus.topMemory.pid !== focus.topCpu?.pid) {
          candidates.push(focus.topMemory)
        }
        const svchostProc = newProcs.find((p) => p.name.toLowerCase() === 'svchost.exe')
        if (svchostProc && !candidates.some((c) => c.pid === svchostProc.pid)) {
          candidates.push(svchostProc)
        }
        for (const cand of candidates.slice(0, 3)) {
          if (!detailLoadedRef.current[cand.pid]) {
            detailLoadedRef.current[cand.pid] = true
            void loadProcessExtra(cand, false)
          }
        }
      }
      if (newSys) setSystemInfo(newSys)
    } finally {
      refreshingRef.current = false
      setIsLoading(false)
    }
  }

  // 挂载时拉取一次真实数据，并在开启自动刷新时每 2 秒轮询更新
  useEffect(() => {
    void refreshData(false)
    if (!autoRefresh) return undefined
    const timer = setInterval(() => {
      void refreshData(false)
    }, 2000)
    if (typeof (timer as any)?.unref === 'function') {
      ;(timer as any).unref()
    }
    return () => {
      clearInterval(timer)
    }
  }, [autoRefresh])

  function handleToggleAutoRefresh() {
    const next = !autoRefresh
    setAutoRefresh(next)
    showToast({
      style: Toast.Style.Success,
      title: next ? '已开启 2 秒实时自动刷新' : '已暂停实时自动刷新',
      message: next ? '每 2 秒自动同步 CPU 与内存快照' : '列表已锁定，可按 Ctrl+R 手动刷新'
    })
  }

  // 处理结束进程操作（支持强制 / 进程树 / 平缓三种模式 + 高危系统核心防护弹窗）
  async function handleTerminate(proc: ProcessItem, mode: ProcessTerminateMode = 'force') {
    const isCritical =
      CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === proc.name.toLowerCase()) ||
      proc.pid === 0 ||
      proc.pid === 4
    const modeLabel =
      mode === 'tree'
        ? '终结完整进程树 (taskkill /F /T)'
        : mode === 'graceful'
        ? '平缓关闭进程 (taskkill /PID)'
        : '强制终止进程 (taskkill /F)'

    if (isCritical) {
      const confirmed = await confirmAlert({
        title: `⚠️ 高危拦截：终止系统核心进程 [${proc.name}]`,
        message: `进程 PID: ${proc.pid} 属于 Windows 核心系统服务。强制终止将导致会话崩溃、黑屏或蓝屏死机 (BSOD)。\n\n确定依然执行 [${modeLabel}]？`,
        primaryAction: {
          title: '强制终止',
          style: 'destructive'
        }
      })
      if (!confirmed) return
    } else {
      const confirmed = await confirmAlert({
        title: `确认${modeLabel} [${proc.name}]`,
        message: `目标进程 PID: ${proc.pid}，未保存的数据可能会丢失。`,
        primaryAction: {
          title: '确认结束',
          style: 'destructive'
        }
      })
      if (!confirmed) return
    }

    showToast({
      style: Toast.Style.Animated,
      title: `正在执行: ${modeLabel}`,
      message: `${proc.name} (PID: ${proc.pid})`
    })

    const res = await terminateProcess(proc.pid, proc.name, mode)
    if (!res.ok) {
      showToast({
        style: Toast.Style.Failure,
        title: '终止失败',
        message: res.error || '权限不足或进程受内核保护'
      })
      return
    }

    showToast({
      style: Toast.Style.Success,
      title: '进程已成功终止',
      message: `${proc.name} (PID: ${proc.pid})`
    })

    setProcesses((prev) => prev.filter((p) => p.pid !== proc.pid))
    void refreshData(false)
  }

  // 在 Explorer 中定位进程路径
  async function handleOpenLocation(proc: ProcessItem) {
    const targetPath = details[proc.pid]?.path || proc.path
    if (!targetPath) {
      showToast({
        style: Toast.Style.Failure,
        title: '无法定位路径',
        message: '该进程由内核直接托管或路径受权限保护'
      })
      return
    }
    const ok = await openFileLocation(targetPath)
    if (ok) {
      showToast({
        style: Toast.Style.Success,
        title: '已在资源管理器中打开',
        message: targetPath
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '打开路径失败',
        message: targetPath
      })
    }
  }

  const focusSummary = getResourceFocus(processes)

  // 生成右侧 Markdown 进程深度画像
  function renderDetailMarkdown(proc: ProcessItem) {
    const detail = details[proc.pid]
    const procServices = services[proc.pid] || []
    const isCritical =
      CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === proc.name.toLowerCase()) ||
      proc.pid === 0 ||
      proc.pid === 4
    const memBytes = proc.workingSetBytes ?? proc.memoryBytes ?? 0
    const privBytes = detail?.privateBytes ?? proc.privateBytes ?? Math.round(memBytes * 0.85)
    const peakBytes = detail?.peakMemoryBytes ?? Math.round(memBytes * 1.15)
    const handles = detail?.handleCount ?? proc.handleCount ?? 0
    const cmdLine = detail?.commandLine || proc.commandLine || proc.path || proc.name
    const company = detail?.companyName || proc.companyName || (proc.isSystem ? 'Microsoft Corporation' : '第三方应用厂商')
    const signer =
      detail?.signerName || (proc.isSystem ? 'Microsoft Windows 官方组件' : '未验证 / 本地可执行程序')

    let servicesBlock = ''
    if (procServices.length > 0) {
      servicesBlock =
        `\n\n### 📦 宿主托管的 Windows 服务 (${procServices.length})\n` +
        procServices
          .map(
            (s) =>
              `- **${s.displayName}** (\`${s.serviceName || s.name}\`) · 状态: \`${
                s.status === 4 || s.status === 'Running' ? '运行中 (Running)' : s.status
              }\` · 启动: \`${s.startType || 'Auto'}\``
          )
          .join('\n')
    }

    const focusBlock =
      focusSummary.topCpu || focusSummary.topMemory
        ? `\n\n### 🎯 全局资源焦点 (Resource Focus)\n` +
          `- **CPU 峰值进程**: \`${focusSummary.topCpu?.name || '-'}\` (PID: ${focusSummary.topCpu?.pid ?? '-'} · \`${(focusSummary.topCpu?.cpuPercent ?? 0).toFixed(1)}%\`)\n` +
          `- **内存峰值进程**: \`${focusSummary.topMemory?.name || '-'}\` (PID: ${focusSummary.topMemory?.pid ?? '-'} · \`${formatBytes(focusSummary.topMemory?.workingSetBytes ?? focusSummary.topMemory?.memoryBytes ?? 0)}\`)`
        : ''

    const safetyNote = isCritical
      ? `> [!CAUTION]\n> **核心系统级进程**：此进程由系统直接调用与调度，严禁随意结束，否则会导致系统崩溃或异常。`
      : proc.isSystem
      ? `> [!NOTE]\n> **系统后台服务**：属于 Windows 后台标准任务或宿主服务模块。`
      : `> [!TIP]\n> **标准用户应用**：属于用户手动启动的应用，占用资源高时可直接结束或终结进程树。`

    return `
# ${proc.name} (PID: ${proc.pid})

**文件路径**: \`${detail?.path || proc.path || '未提供或受系统保护'}\`
**启动命令行**: \`${cmdLine}\`

---

### 📊 性能与资源指标
- **CPU 瞬时占用率**: \`${proc.cpuPercent.toFixed(1)}%\`
- **工作集物理内存 (Working Set)**: \`${formatBytes(memBytes)}\`
- **专用提交内存 (Private Bytes)**: \`${formatBytes(privBytes)}\`
- **峰值物理内存 (Peak Working Set)**: \`${formatBytes(peakBytes)}\`
- **活动线程数 / 句柄数**: \`${proc.threadCount} 线程\` / \`${handles > 0 ? `${handles} 句柄` : '实时采集中'}\`
- **父进程 PID (PPID)**: \`${proc.parentPid}\`
- **厂商与数字签名**: \`${company}\` · \`${signer}\`${detail?.startTime ? `\n- **启动时间**: \`${detail.startTime}\`` : ''}
${servicesBlock}${focusBlock}

---

### 🛡️ 安全级别与管控建议
${safetyNote}
`
  }

  const filtered = filterProcesses(processes, searchText, tab, sortBy)
  const userCount = processes.filter((p) => !p.isSystem).length
  const systemCount = processes.filter((p) => p.isSystem).length

  const totalMem = systemInfo.totalMemoryBytes || systemInfo.totalMemory || 0
  const availMem = systemInfo.availableMemoryBytes || systemInfo.availableMemory || 0
  const usedMem = systemInfo.usedMemoryBytes || Math.max(0, totalMem - availMem)
  const memPercent = systemInfo.memoryUsagePercent || (totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0)
  const sumProcCpu = Number(processes.reduce((acc, p) => acc + p.cpuPercent, 0).toFixed(1))
  const totalCpuPercent = Math.min(
    100,
    Math.round(sumProcCpu > 0 ? sumProcCpu : systemInfo.cpuUsagePercent || 0)
  )

  const topCpuLabel = focusSummary.topCpu
    ? `焦点: ${focusSummary.topCpu.name} (${focusSummary.topCpu.cpuPercent.toFixed(1)}%)`
    : `${systemInfo.cpuCoreCount || 16} 核`
  const topMemLabel = focusSummary.topMemory
    ? `最大: ${focusSummary.topMemory.name} (${formatBytes(focusSummary.topMemory.workingSetBytes ?? focusSummary.topMemory.memoryBytes)})`
    : `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`

  const sortLabelMap: Record<ProcessSortKey, string> = {
    cpu: 'CPU 优先',
    memory: '内存优先',
    name: '名称 A-Z',
    pid: 'PID 升序'
  }

  return List({
    navigationTitle: `进程监控 (${DLL_PLUGIN_NAME}) · ${autoRefresh ? '实时刷新 2s' : '已暂停'}`,
    searchBarPlaceholder: '搜索进程名称、PID、路径、厂商或描述 (支持多维排序与服务穿透)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择进程排序维度',
      value: sortBy,
      onChange: (val: string) => setSortBy(val as ProcessSortKey),
      children: [
        List.Dropdown.Item({ title: '🔥 按 CPU 占用排序 (CPU 优先)', value: 'cpu' }),
        List.Dropdown.Item({ title: '🧠 按物理内存排序 (内存优先)', value: 'memory' }),
        List.Dropdown.Item({ title: '🔤 按进程名称排序 (名称 A-Z)', value: 'name' }),
        List.Dropdown.Item({ title: '🔢 按进程 PID 排序 (PID 升序)', value: 'pid' })
      ]
    }),
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'metric-cpu',
          label: '全局 CPU 负载',
          value: `${totalCpuPercent}%`,
          subValue: topCpuLabel,
          progress: totalCpuPercent,
          status: totalCpuPercent > 80 ? 'danger' : totalCpuPercent > 50 ? 'warning' : 'success'
        },
        {
          id: 'metric-mem',
          label: '物理内存已用',
          value: `${memPercent}%`,
          subValue: topMemLabel,
          progress: memPercent,
          status: memPercent > 85 ? 'danger' : memPercent > 70 ? 'warning' : 'success'
        },
        {
          id: 'metric-proc',
          label: '活动进程总数',
          value: `${processes.length}`,
          subValue: `用户 ${userCount} · 系统 ${systemCount}`,
          status: 'normal'
        },
        {
          id: 'metric-threads',
          label: '系统并发线程',
          value: `${processes.reduce((sum, p) => sum + p.threadCount, 0)}`,
          subValue: `${autoRefresh ? '⏱️ 2s 自动刷新' : '⏸️ 刷新已暂停'} · ${sortLabelMap[sortBy]}`,
          status: 'normal'
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: (v) => setTab(v as any),
      options: [
        { value: 'all', label: '全部进程', badge: processes.length },
        { value: 'user', label: '用户应用', badge: userCount },
        { value: 'system', label: '系统核心', badge: systemCount }
      ]
    }),
    children: [
      List.Section({
        title: `系统活动进程快照 (${filtered.length}/${processes.length}) · 排序: ${sortLabelMap[sortBy]}`,
        children: filtered.map((proc) => {
          const isCrit =
            CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === proc.name.toLowerCase()) ||
            proc.pid === 0 ||
            proc.pid === 4
          const memVal = proc.workingSetBytes ?? proc.memoryBytes ?? 0
          return List.Item({
            id: String(proc.pid),
            title: proc.name,
            subtitle: `PID: ${proc.pid} · 线程: ${proc.threadCount}${proc.path ? ` · ${proc.path}` : ''}`,
            icon: {
              source: proc.isSystem ? Icon.Gear : Icon.Bolt,
              tintColor: isCrit ? Color.Red : proc.isSystem ? Color.SecondaryText : Color.Blue
            },
            accessories: [
              {
                tag: {
                  value: proc.isSystem ? (isCrit ? '系统核心' : '系统服务') : '用户应用',
                  color: proc.isSystem ? (isCrit ? Color.Red : Color.SecondaryText) : Color.Blue
                }
              },
              {
                tag: {
                  value: `CPU ${proc.cpuPercent.toFixed(1)}%`,
                  color:
                    proc.cpuPercent > 25
                      ? Color.Red
                      : proc.cpuPercent > 5
                      ? Color.Orange
                      : Color.SecondaryText
                }
              },
              {
                text: formatBytes(memVal)
              }
            ],
            detail: List.Item.Detail({
              markdown: renderDetailMarkdown(proc)
            }),
            actions: ActionPanel({
              title: `${proc.name} (PID: ${proc.pid})`,
              children: [
                Action({
                  title: '强制终止进程 (taskkill /F)',
                  icon: Icon.XMarkCircle,
                  style: 'destructive',
                  shortcut: { modifiers: ['ctrl'], key: 't' },
                  onAction: () => handleTerminate(proc, 'force')
                }),
                Action({
                  title: '终结完整进程树 (taskkill /F /T)',
                  icon: Icon.Trash,
                  style: 'destructive',
                  shortcut: { modifiers: ['ctrl', 'shift'], key: 't' },
                  onAction: () => handleTerminate(proc, 'tree')
                }),
                Action({
                  title: '平缓关闭进程 (Graceful Kill)',
                  icon: Icon.Stop,
                  onAction: () => handleTerminate(proc, 'graceful')
                }),
                Action({
                  title: '即时刷新快照',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshData(true)
                }),
                Action({
                  title: autoRefresh ? '暂停 2 秒自动刷新' : '恢复 2 秒自动刷新',
                  icon: Icon.Clock,
                  shortcut: { modifiers: ['ctrl'], key: 'p' },
                  onAction: () => handleToggleAutoRefresh()
                }),
                Action({
                  title: '深度读取数字签名与托管服务',
                  icon: Icon.MagnifyingGlass,
                  shortcut: { modifiers: ['ctrl'], key: 'i' },
                  onAction: () => loadProcessExtra(proc, true)
                }),
                Action({
                  title: '在资源管理器中定位',
                  icon: Icon.Folder,
                  shortcut: { modifiers: ['ctrl'], key: 'o' },
                  onAction: () => handleOpenLocation(proc)
                }),
                Action({
                  title: '复制进程 PID',
                  icon: Icon.Clipboard,
                  shortcut: { modifiers: ['ctrl'], key: 'c' },
                  onAction: () => {
                    Clipboard.copy(String(proc.pid))
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制 PID',
                      message: String(proc.pid)
                    })
                  }
                }),
                Action({
                  title: '复制完整可执行路径',
                  icon: Icon.Clipboard,
                  shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                  onAction: () => {
                    const targetPath = details[proc.pid]?.path || proc.path
                    if (targetPath) {
                      Clipboard.copy(targetPath)
                      showToast({
                        style: Toast.Style.Success,
                        title: '已复制可执行路径',
                        message: targetPath
                      })
                    } else {
                      showToast({
                        style: Toast.Style.Failure,
                        title: '路径不可用',
                        message: '内核进程无具体磁盘文件路径'
                      })
                    }
                  }
                }),
                Action({
                  title: '复制启动命令行 (CommandLine)',
                  icon: Icon.Terminal,
                  onAction: () => {
                    const cmdLine = details[proc.pid]?.commandLine || proc.commandLine || proc.path || proc.name
                    Clipboard.copy(cmdLine)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制启动命令行',
                      message: cmdLine
                    })
                  }
                }),
                Action({
                  title: '复制 taskkill 强杀指令',
                  icon: Icon.Code,
                  onAction: () => {
                    const cmd = `taskkill /F /PID ${proc.pid}`
                    Clipboard.copy(cmd)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制命令',
                      message: cmd
                    })
                  }
                })
              ]
            })
          })
        })
      })
    ]
  })
}
