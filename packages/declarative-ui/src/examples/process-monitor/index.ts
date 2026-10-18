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
  confirmAlert
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

export * from './logic.js'

type ProcessViewFilter = 'memory' | 'cpu' | 'high-load' | 'system' | 'user' | 'name' | 'pid'

export default function ProcessMonitorCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [viewFilter, setViewFilter] = useState<ProcessViewFilter>('memory')
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

  async function refreshData(showIndicator = false) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (showIndicator) setIsLoading(true)
    try {
      const [newProcs, newSys] = await Promise.all([fetchProcesses(), fetchSystemInfo()])
      if (newProcs.length > 0) {
        setProcesses(newProcs)
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

  async function handleTerminate(proc: ProcessItem, mode: ProcessTerminateMode = 'force') {
    const isCritical =
      CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === proc.name.toLowerCase()) ||
      proc.pid === 0 ||
      proc.pid === 4
    const modeLabel =
      mode === 'tree'
        ? '强制结束进程树 (taskkill /F /T)'
        : mode === 'graceful'
        ? '平缓关闭进程 (taskkill /PID)'
        : '结束进程 (taskkill /F)'

    if (isCritical) {
      const confirmed = await confirmAlert({
        title: `高危拦截：终止系统关键进程 [${proc.name}]`,
        message: `进程 PID: ${proc.pid} 属于系统核心服务。强制终止将导致会话异常或系统崩溃。\n\n确定依然执行 [${modeLabel}]？`,
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

  const tab: 'all' | 'user' | 'system' =
    viewFilter === 'system' ? 'system' : viewFilter === 'user' ? 'user' : 'all'
  const sortBy: ProcessSortKey =
    viewFilter === 'cpu' || viewFilter === 'high-load'
      ? 'cpu'
      : viewFilter === 'name'
      ? 'name'
      : viewFilter === 'pid'
      ? 'pid'
      : 'memory'

  const baseFiltered = filterProcesses(processes, searchText, tab, sortBy)
  const filtered =
    viewFilter === 'high-load'
      ? baseFiltered.filter(
          (p) => p.cpuPercent >= 5 || (p.workingSetBytes ?? p.memoryBytes ?? 0) >= 250 * 1024 * 1024
        )
      : baseFiltered

  const totalMem = systemInfo.totalMemoryBytes || systemInfo.totalMemory || 0
  const availMem = systemInfo.availableMemoryBytes || systemInfo.availableMemory || 0
  const usedMem = systemInfo.usedMemoryBytes || Math.max(0, totalMem - availMem)
  const memPercent =
    systemInfo.memoryUsagePercent || (totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0)
  const sumProcCpu = Number(processes.reduce((acc, p) => acc + p.cpuPercent, 0).toFixed(1))
  const totalCpuPercent = Math.min(
    100,
    Math.round(sumProcCpu > 0 ? sumProcCpu : systemInfo.cpuUsagePercent || 0)
  )

  const maxMemBytes = Math.max(
    1,
    ...processes.map((p) => p.workingSetBytes ?? p.memoryBytes ?? 0)
  )

  return List({
    navigationTitle: `进程监控 (${DLL_PLUGIN_NAME})`,
    searchBarPlaceholder: '搜索进程名称、PID、完整路径、厂商或服务描述...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换进程筛选与排序维度',
      value: viewFilter,
      onChange: (val: string) => setViewFilter(val as ProcessViewFilter),
      children: [
        List.Dropdown.Item({ title: '全部进程 · 按内存排序 (Memory)', value: 'memory' }),
        List.Dropdown.Item({ title: '全部进程 · 按 CPU 排序 (CPU)', value: 'cpu' }),
        List.Dropdown.Item({ title: '仅高负载进程 (High Load)', value: 'high-load' }),
        List.Dropdown.Item({ title: '系统关键服务 (System Services)', value: 'system' }),
        List.Dropdown.Item({ title: '用户应用程序 (User Apps)', value: 'user' }),
        List.Dropdown.Item({ title: '按进程名称排序 (Name A-Z)', value: 'name' }),
        List.Dropdown.Item({ title: '按进程 PID 升序 (PID)', value: 'pid' })
      ]
    }),
    filterBar: {
      summaryText: `CPU 负载 ${totalCpuPercent}% · 物理内存已用 ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}%) · 活动进程 ${filtered.length} 个`,
      actions: [
        {
          id: 'refresh-list',
          label: '刷新列表',
          title: '刷新列表',
          style: 'secondary',
          onAction: () => {
            void refreshData(true)
          }
        },
        {
          id: 'toggle-auto-refresh',
          label: autoRefresh ? '暂停自动刷新' : '开启自动刷新',
          title: autoRefresh ? '暂停自动刷新' : '开启自动刷新',
          style: 'secondary',
          onAction: () => {
            handleToggleAutoRefresh()
          }
        }
      ]
    },
    children: [
      List.Section({
        title: `活动进程列表 (${filtered.length})`,
        children: filtered.map((proc) => {
          const isCrit =
            CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === proc.name.toLowerCase()) ||
            proc.pid === 0 ||
            proc.pid === 4
          const memVal = proc.workingSetBytes ?? proc.memoryBytes ?? 0
          const memRatio = Math.min(100, Math.max(4, Math.round((memVal / maxMemBytes) * 100)))
          const isHighLoad = proc.cpuPercent >= 25 || memVal >= 1024 * 1024 * 1024
          const procServices = services[proc.pid] || []
          const svcHint = procServices.length > 0 ? ` · 托管服务 ${procServices.length} 项` : ''

          return List.Item({
            id: String(proc.pid),
            title: `${proc.name} [PID: ${proc.pid}]`,
            subtitle: `PID: ${proc.pid} · 线程 ${proc.threadCount}${svcHint} · ${proc.path || proc.commandLine || '系统内核进程'}`,
            icon: isCrit ? Icon.Shield : isHighLoad ? Icon.ExclamationMark : Icon.Terminal,
            accessories: [
              { progress: { value: memRatio } },
              ...(isCrit
                ? [{ tag: { value: '系统关键' } }]
                : isHighLoad
                ? [{ tag: { value: '高负载', color: Color.Red } }]
                : [{ tag: { value: proc.isSystem ? '系统服务' : '用户应用' } }]),
              { text: `CPU ${proc.cpuPercent.toFixed(1)}%` },
              { text: formatBytes(memVal) }
            ],
            actions: ActionPanel({
              title: `${proc.name} (PID: ${proc.pid})`,
              children: [
                Action({
                  title: '结束进程',
                  icon: Icon.XMarkCircle,
                  style: 'destructive',
                  onAction: () => handleTerminate(proc, 'force')
                }),
                Action({
                  title: '强制结束进程树',
                  icon: Icon.Trash,
                  style: 'destructive',
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: () => handleTerminate(proc, 'tree')
                }),
                Action({
                  title: '定位文件目录',
                  icon: Icon.Folder,
                  shortcut: { modifiers: ['ctrl'], key: 'o' },
                  onAction: () => handleOpenLocation(proc)
                }),
                Action({
                  title: '复制 PID',
                  icon: Icon.Key,
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
                  title: '平缓关闭进程 (Graceful)',
                  icon: Icon.Stop,
                  onAction: () => handleTerminate(proc, 'graceful')
                }),
                Action({
                  title: '读取数字签名与托管服务',
                  icon: Icon.MagnifyingGlass,
                  shortcut: { modifiers: ['ctrl'], key: 'i' },
                  onAction: () => loadProcessExtra(proc, true)
                }),
                Action({
                  title: '复制完整可执行路径',
                  icon: Icon.Document,
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
                    const cmdLine =
                      details[proc.pid]?.commandLine || proc.commandLine || proc.path || proc.name
                    Clipboard.copy(cmdLine)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制启动命令行',
                      message: cmdLine
                    })
                  }
                }),
                Action({
                  title: '刷新列表',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshData(true)
                })
              ]
            })
          })
        })
      })
    ]
  })
}
