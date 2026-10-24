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
  type NetworkAdapterItem,
  type AdapterFilterMode,
  fetchNetworkAdapters,
  flushDnsCache,
  applyDnsPreset,
  copyAdapterInfo,
  filterNetworkAdapters
} from './logic.js'

export * from './logic.js'

export function NetworkAdapterCommand() {
  const [searchText, setSearchText] = useState('')
  const [filterMode, setFilterMode] = useState<AdapterFilterMode>('all')
  const [adapters, setAdapters] = useState<NetworkAdapterItem[]>([])
  const [primaryIpv4, setPrimaryIpv4] = useState('127.0.0.1')
  const [primaryGateway, setPrimaryGateway] = useState('10.0.0.1')
  const [primaryDns, setPrimaryDns] = useState('223.5.5.5')
  const [isLoading, setIsLoading] = useState(true)

  async function refreshAdapters(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await fetchNetworkAdapters()
      setAdapters(snap.adapters)
      setPrimaryIpv4(snap.primaryIpv4)
      setPrimaryGateway(snap.primaryGateway)
      setPrimaryDns(snap.primaryDns)
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: '本机网卡状态已刷新',
          message: `共 ${snap.adapters.length} 个接口 · 主 IPv4: ${snap.primaryIpv4}`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshAdapters(false)
  }, [])

  async function handleFlushDns() {
    const res = await flushDnsCache()
    showToast({
      style: res.ok ? Toast.Style.Success : Toast.Style.Failure,
      title: res.ok ? 'DNS 缓存已刷新' : 'DNS 刷新失败',
      message: res.message
    })
  }

  async function handleApplyDns(item: NetworkAdapterItem, primary: string, secondary?: string) {
    const res = await applyDnsPreset(item.name, primary, secondary)
    if (res.ok) {
      setAdapters((prev) =>
        prev.map((a) => (a.id === item.id ? { ...a, dnsServers: res.dnsServers } : a))
      )
    }
    showToast({
      style: res.ok ? Toast.Style.Success : Toast.Style.Failure,
      title: res.ok ? 'DNS 预设已应用' : '修改网卡 DNS 失败',
      message: res.message
    })
  }

  const filtered = filterNetworkAdapters(adapters, searchText, filterMode)
  const maxSpeed = Math.max(1000, ...adapters.map((a) => a.speedMbps || 1000))

  return List({
    navigationTitle: '网络接口与网卡配置',
    searchBarPlaceholder: '搜索网卡名称、IPv4/IPv6 地址、MAC 物理地址、DNS 或芯片型号...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '按网卡类型筛选',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as AdapterFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部网络接口 (All Interfaces)', value: 'all' }),
        List.Dropdown.Item({ title: '物理网卡 (Physical Ethernet & WLAN)', value: 'physical' }),
        List.Dropdown.Item({ title: '虚拟与隧道网卡 (WSL / TUN / VMware)', value: 'virtual' }),
        List.Dropdown.Item({ title: '仅已连接接口 (Connected Only)', value: 'connected' })
      ]
    }),
    filterBar: {
      summaryText: `活动接口 ${adapters.filter((a) => a.status === 'up').length}/${adapters.length} 个 · 主 IPv4: ${primaryIpv4} · 默认网关: ${primaryGateway} · 首选 DNS: ${primaryDns}`,
      actions: [
        {
          id: 'refresh-nic',
          label: '刷新网卡',
          title: '刷新网卡',
          style: 'secondary',
          onAction: () => void refreshAdapters(true)
        },
        {
          id: 'flush-dns',
          label: '刷新DNS缓存',
          title: '刷新DNS缓存',
          style: 'secondary',
          onAction: () => void handleFlushDns()
        }
      ]
    },
    children: [
      List.Section({
        title: `本机网络接口列表 (${filtered.length})`,
        children: filtered.map((item) => {
          const speedRatio = Math.min(100, Math.max(8, Math.round((item.speedMbps / maxSpeed) * 100)))
          const dnsText = item.dnsServers.length > 0 ? item.dnsServers.join(', ') : '自动'

          return List.Item({
            id: item.id,
            title: `${item.name} (${item.ipv4 || item.ipv6 || '未分配 IP'})`,
            subtitle: `MAC: ${item.mac} · 掩码: ${item.netmask} · 网关: ${item.gateway || '无'} · DNS: ${dnsText} · ${item.description}`,
            icon: item.category === 'physical' ? Icon.Wifi : Icon.Globe,
            accessories: [
              { progress: { value: speedRatio } },
              { tag: { value: item.typeLabel } },
              { text: `${item.speedMbps >= 1000 ? `${(item.speedMbps / 1000).toFixed(1)} Gbps` : `${item.speedMbps} Mbps`} · ${item.status === 'up' ? '已连接' : '已断开'}` }
            ],
            actions: ActionPanel({
              title: `${item.name} (${item.ipv4})`,
              children: [
                Action({
                  title: `复制 IPv4 地址 (${item.ipv4})`,
                  icon: Icon.Clipboard,
                  onAction: async () => {
                    const ip = copyAdapterInfo(item, 'ipv4')
                    await Clipboard.copy(ip)
                    showToast({ style: Toast.Style.Success, title: '已复制 IPv4 地址', message: ip })
                  }
                }),
                Action({
                  title: `复制 MAC 物理地址 (${item.mac})`,
                  icon: Icon.Key,
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: async () => {
                    const mac = copyAdapterInfo(item, 'mac')
                    await Clipboard.copy(mac)
                    showToast({ style: Toast.Style.Success, title: '已复制 MAC 地址', message: mac })
                  }
                }),
                Action({
                  title: '切换为阿里/腾讯公共 DNS (223.5.5.5 / 119.29.29.29)',
                  icon: Icon.Globe,
                  shortcut: { modifiers: ['ctrl'], key: 'p' },
                  onAction: () => handleApplyDns(item, '223.5.5.5', '119.29.29.29')
                }),
                Action({
                  title: '恢复 DHCP 自动获取 DNS',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl', 'shift'], key: 'd' },
                  onAction: () => handleApplyDns(item, 'dhcp')
                }),
                Action({
                  title: '刷新 DNS 解析缓存 (ipconfig /flushdns)',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'd' },
                  onAction: () => handleFlushDns()
                }),
                Action({
                  title: '复制完整网卡配置 JSON',
                  icon: Icon.Code,
                  shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                  onAction: async () => {
                    const json = copyAdapterInfo(item, 'json')
                    await Clipboard.copy(json)
                    showToast({ style: Toast.Style.Success, title: '已复制网卡 JSON 配置', message: item.name })
                  }
                }),
                Action({
                  title: '复制单行网络摘要',
                  icon: Icon.Document,
                  shortcut: { modifiers: ['ctrl'], key: 'c' },
                  onAction: async () => {
                    const summary = copyAdapterInfo(item, 'summary')
                    await Clipboard.copy(summary)
                    showToast({ style: Toast.Style.Success, title: '已复制网卡摘要', message: summary })
                  }
                }),
                Action({
                  title: '刷新网卡状态',
                  icon: Icon.Repeat,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshAdapters(true)
                })
              ]
            })
          })
        })
      })
    ]
  })
}

export default NetworkAdapterCommand
