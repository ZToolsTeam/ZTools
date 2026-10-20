import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast
} from '../../index.js'
import {
  type WechatInstanceItem,
  type WechatFilterMode,
  formatBytes,
  fetchWechatInstances,
  launchNewWechatInstance,
  terminateWechatInstance,
  openWechatInstallLocation,
  filterWechatInstances
} from './logic.js'

export * from './logic.js'

export function WechatMultiCommand() {
  const [searchText, setSearchText] = useState('')
  const [filterMode, setFilterMode] = useState<WechatFilterMode>('all')
  const [items, setItems] = useState<WechatInstanceItem[]>([])
  const [mainCount, setMainCount] = useState(2)
  const [appletCount, setAppletCount] = useState(2)
  const [totalMemBytes, setTotalMemBytes] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshInstances(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await fetchWechatInstances()
      setItems(snap.items)
      setMainCount(snap.mainInstanceCount)
      setAppletCount(snap.appletCount)
      setTotalMemBytes(snap.totalMemoryBytes)
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: '微信运行实例已刷新',
          message: `主进程 ${snap.mainInstanceCount} 个 · 小程序容器 ${snap.appletCount} 个`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshInstances(false)
  }, [])

  async function handleLaunchNew() {
    const res = await launchNewWechatInstance(1)
    if (res.ok) {
      await refreshInstances(false)
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: res.pid ? `新实例 PID: ${res.pid}` : res.executablePath
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '启动微信实例失败',
        message: res.message
      })
    }
  }

  async function handleTerminate(item: WechatInstanceItem) {
    if (item.isActionRow) {
      await handleLaunchNew()
      return
    }
    const res = await terminateWechatInstance(item.pid)
    if (res.ok) {
      setItems((prev) => prev.filter((cur) => cur.pid !== item.pid))
      if (item.role === 'main') setMainCount((c) => Math.max(0, c - 1))
      else setAppletCount((c) => Math.max(0, c - 1))
      setTotalMemBytes((m) => Math.max(0, m - item.memoryBytes))
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: item.name
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '结束微信实例失败',
        message: res.message
      })
    }
  }

  const filtered = filterWechatInstances(items, searchText, filterMode)
  const maxMem = Math.max(500 * 1024 * 1024, ...items.map((i) => i.memoryBytes || 0))

  return List({
    navigationTitle: '微信多开与实例管理',
    searchBarPlaceholder: '搜索微信实例 PID、路径、小程序容器或回车直接启动新微信实例...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '筛选微信进程类型',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as WechatFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部实例与操作 (All Instances)', value: 'all' }),
        List.Dropdown.Item({ title: '正在运行的微信主进程 (WeChat Main)', value: 'main' }),
        List.Dropdown.Item({ title: '小程序容器进程 (WeChatAppEx)', value: 'applet' })
      ]
    }),
    filterBar: {
      summaryText: `运行中微信主实例 ${mainCount} 个 · 小程序/媒体容器 ${appletCount} 个 · 物理内存合计 ${formatBytes(totalMemBytes)}`,
      actions: [
        {
          id: 'launch-wx',
          label: '一键多开新微信',
          title: '一键多开新微信',
          style: 'secondary',
          onAction: () => void handleLaunchNew()
        },
        {
          id: 'refresh-wx',
          label: '刷新实例状态',
          title: '刷新实例状态',
          style: 'secondary',
          onAction: () => void refreshInstances(true)
        }
      ]
    },
    children: [
      List.Section({
        title: `微信多开与活动进程列表 (${filtered.length})`,
        children: filtered.map((item) => {
          if (item.isActionRow) {
            return List.Item({
              id: item.id,
              title: item.name,
              subtitle: `${item.executablePath} · ${item.mutexStatus}`,
              icon: Icon.Plus,
              accessories: [
                { tag: { value: item.roleLabel } },
                { text: '回车立即启动' }
              ],
              actions: ActionPanel({
                title: item.name,
                children: [
                  Action({
                    title: '立即启动新微信实例 (突破单实例锁)',
                    icon: Icon.Plus,
                    onAction: () => handleLaunchNew()
                  }),
                  Action({
                    title: '定位微信安装目录',
                    icon: Icon.Folder,
                    shortcut: { modifiers: ['ctrl'], key: 'return' },
                    onAction: () => {
                      void openWechatInstallLocation(item.executablePath)
                    }
                  }),
                  Action({
                    title: '刷新实例状态',
                    icon: Icon.ArrowClockwise,
                    shortcut: { modifiers: ['ctrl'], key: 'r' },
                    onAction: () => refreshInstances(true)
                  })
                ]
              })
            })
          }

          const memRatio = Math.min(100, Math.max(6, Math.round((item.memoryBytes / maxMem) * 100)))

          return List.Item({
            id: item.id,
            title: `${item.name} [PID: ${item.pid}]`,
            subtitle: `${item.uptimeText} · ${item.mutexStatus} · ${item.executablePath}`,
            icon: item.role === 'main' ? Icon.AppWindow : Icon.Terminal,
            accessories: [
              { progress: { value: memRatio } },
              { tag: { value: item.roleLabel } },
              { text: `CPU ${item.cpuPercent.toFixed(1)}%` },
              { text: formatBytes(item.memoryBytes) }
            ],
            actions: ActionPanel({
              title: `${item.name} (PID: ${item.pid})`,
              children: [
                Action({
                  title: '一键多开新微信实例',
                  icon: Icon.Plus,
                  onAction: () => handleLaunchNew()
                }),
                Action({
                  title: `结束该${item.roleLabel} (PID: ${item.pid})`,
                  icon: Icon.XMarkCircle,
                  style: 'destructive',
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: () => handleTerminate(item)
                }),
                Action({
                  title: '在资源管理器中定位安装路径',
                  icon: Icon.Folder,
                  shortcut: { modifiers: ['ctrl'], key: 'o' },
                  onAction: () => {
                    void openWechatInstallLocation(item.executablePath)
                  }
                }),
                Action({
                  title: '复制进程 PID',
                  icon: Icon.Key,
                  shortcut: { modifiers: ['ctrl'], key: 'c' },
                  onAction: async () => {
                    await Clipboard.copy(String(item.pid))
                    showToast({ style: Toast.Style.Success, title: '已复制 PID', message: String(item.pid) })
                  }
                }),
                Action({
                  title: '刷新实例状态',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshInstances(true)
                })
              ]
            })
          })
        })
      })
    ]
  })
}

export default WechatMultiCommand
