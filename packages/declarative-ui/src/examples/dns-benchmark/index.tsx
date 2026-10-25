import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import {
  PUBLIC_DNS_PRESETS,
  applyAdapterDns,
  flushSystemDnsCache,
  getActiveNetworkAdapters,
  resetAdapterToDhcp,
  runDnsBenchmark,
  sortAndMarkDnsItems
} from './dns-service.js'
import type { ActiveNetworkAdapter, DnsBenchmarkItem } from './types.js'

export * from './types.js'
export * from './dns-service.js'

export interface DnsBenchmarkCommandProps {
  featureCode?: string
  hostOverride?: unknown
}

export function DnsBenchmarkCommand(props: DnsBenchmarkCommandProps = {}) {
  const [adapters, setAdapters] = useState<ActiveNetworkAdapter[]>([])
  const [selectedAdapter, setSelectedAdapter] = useState<string>('WLAN')
  const [searchText, setSearchText] = useState<string>('')
  const [dnsItems, setDnsItems] = useState<DnsBenchmarkItem[]>([])
  const [isTesting, setIsTesting] = useState<boolean>(true)

  const currentAdapterObj = useMemo(
    () => adapters.find((a) => a.name === selectedAdapter) ?? adapters[0],
    [adapters, selectedAdapter]
  )

  const currentDnsList = currentAdapterObj?.currentDns ?? []
  const currentDnsText =
    currentDnsList.length > 0 ? currentDnsList.join(', ') : 'DHCP 自动获取'

  const handleRunBenchmark = async (customActiveDns?: string[]) => {
    setIsTesting(true)
    try {
      const loadedAdapters = await getActiveNetworkAdapters(props.hostOverride)
      setAdapters(loadedAdapters)
      const activeAdapter =
        loadedAdapters.find((a) => a.name === selectedAdapter) ?? loadedAdapters[0]
      if (activeAdapter && activeAdapter.name !== selectedAdapter) {
        setSelectedAdapter(activeAdapter.name)
      }
      const dnsToMark = customActiveDns ?? activeAdapter?.currentDns ?? []
      const res = await runDnsBenchmark(dnsToMark, props.hostOverride, PUBLIC_DNS_PRESETS)
      setDnsItems(res.items)
    } finally {
      setIsTesting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (props.featureCode === 'dns-flush-cache') {
        const fRes = await flushSystemDnsCache(props.hostOverride)
        if (!cancelled && fRes.ok) {
          await showToast({
            style: Toast.Style.Success,
            title: '已刷新本机 DNS 解析缓存 (ipconfig /flushdns)'
          })
        }
      }
      if (!cancelled) {
        await handleRunBenchmark()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [props.featureCode])

  const filteredDnsList = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return dnsItems
    return dnsItems.filter((d) =>
      `${d.name} ${d.primary} ${d.secondary} ${d.categoryLabel} ${d.description}`
        .toLowerCase()
        .includes(q)
    )
  }, [dnsItems, searchText])

  const fastestDns = useMemo(
    () => dnsItems.find((item) => !item.timeout) ?? null,
    [dnsItems]
  )

  const allTimeout = useMemo(
    () => dnsItems.length > 0 && dnsItems.every((item) => item.timeout),
    [dnsItems]
  )

  const handleApplyDns = async (dns: DnsBenchmarkItem) => {
    if (dns.timeout) {
      await showToast({
        style: Toast.Style.Failure,
        title: `节点 ${dns.name} 当前响应超时，禁止切换至不可达 DNS`
      })
      return
    }
    const targetNic = currentAdapterObj?.name || selectedAdapter || 'WLAN'
    const res = await applyAdapterDns(targetNic, dns.primary, dns.secondary, props.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: res.error || '切换网卡 DNS 失败'
      })
      return
    }
    const nextActive = res.currentDns ?? [dns.primary, dns.secondary]
    setAdapters((prev) =>
      prev.map((nic) =>
        nic.name === targetNic ? { ...nic, currentDns: nextActive, isDhcp: false } : nic
      )
    )
    setDnsItems((prev) =>
      sortAndMarkDnsItems(
        PUBLIC_DNS_PRESETS,
        prev.map((p) => ({
          id: p.id,
          primary: p.primary,
          avgMs: p.avgMs,
          primaryMs: p.primaryMs,
          secondaryMs: p.secondaryMs,
          timeout: p.timeout
        })),
        nextActive
      )
    )
    await showToast({
      style: Toast.Style.Success,
      title: `已将 ${targetNic} DNS 切换为 ${dns.name} (${dns.primary}) 并刷新缓存`
    })
  }

  const handleResetDhcp = async () => {
    const targetNic = currentAdapterObj?.name || selectedAdapter || 'WLAN'
    const res = await resetAdapterToDhcp(targetNic, props.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: res.error || '恢复 DHCP 自动获取 DNS 失败'
      })
      return
    }
    setAdapters((prev) =>
      prev.map((nic) => (nic.name === targetNic ? { ...nic, currentDns: [], isDhcp: true } : nic))
    )
    setDnsItems((prev) => prev.map((item) => ({ ...item, isCurrentActive: false })))
    await showToast({
      style: Toast.Style.Success,
      title: `已将 ${targetNic} 恢复为路由器 DHCP 自动获取 DNS`
    })
  }

  const handleFlushDnsCache = async () => {
    const res = await flushSystemDnsCache(props.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: res.error || '刷新 DNS 缓存失败'
      })
      return
    }
    await showToast({
      style: Toast.Style.Success,
      title: '已清空并刷新本机 DNS 解析缓存'
    })
  }

  const summaryText = allTimeout
    ? `当前网卡: ${selectedAdapter} · 所有公共 DNS 节点响应超时，请检查本机网络连接`
    : fastestDns
      ? `当前网卡: ${selectedAdapter} (${currentDnsText}) · 本机实测最快: ${fastestDns.name} (${fastestDns.avgMs} ms)`
      : `当前网卡: ${selectedAdapter} · 正在并发实测 15 组公共 DNS 延迟...`

  return (
    <List
      navigationTitle="DNS 测速与一键切换"
      isLoading={isTesting}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索 DNS 名称、IP 地址（如 223.5.5.5）或适用场景..."
      searchBarAccessory={
        <List.Dropdown
          value={selectedAdapter}
          onChange={setSelectedAdapter}
          tooltip="选择要修改的活动网卡"
        >
          {adapters.map((nic) => (
            <List.Dropdown.Item
              key={nic.name}
              title={`${nic.name} (当前: ${nic.currentDns.join(', ') || 'DHCP自动'})`}
              value={nic.name}
              icon={Icon.Wifi}
            />
          ))}
        </List.Dropdown>
      }
      filterBar={{
        summaryText,
        actions: [
          {
            id: 'retest',
            title: '重新测速',
            onAction: () => {
              void handleRunBenchmark()
            }
          },
          {
            id: 'reset-dhcp',
            title: '恢复自动获取(DHCP)',
            onAction: () => {
              void handleResetDhcp()
            }
          }
        ]
      }}
    >
      <List.Section
        title="15 组国内外权威公共 DNS 实测排行"
        subtitle={`按本机真实解析延迟从快到慢排序 · 共 ${filteredDnsList.length} 组`}
      >
        {filteredDnsList.map((dns, index) => (
          <List.Item
            key={dns.id}
            id={dns.id}
            title={`${dns.name} (${dns.primary} / ${dns.secondary})`}
            subtitle={dns.description}
            icon={dns.isCurrentActive ? Icon.CheckCircle : Icon.Globe}
            accessories={
              [
                dns.timeout
                  ? { tag: { value: '响应超时', color: Color.Red } }
                  : { progress: Math.max(0.05, 1 - dns.avgMs / 300) },
                dns.isCurrentActive
                  ? { tag: '当前生效' }
                  : index === 0 && !dns.timeout
                    ? { tag: '实测最快' }
                    : { tag: dns.categoryLabel },
                { text: dns.timeout ? '超时' : `${dns.avgMs} ms` }
              ].filter(Boolean) as Array<Record<string, unknown>>
            }
            actions={
              <ActionPanel>
                <Action
                  title={`切换网卡 DNS 为 ${dns.name}`}
                  icon={Icon.CheckCircle}
                  onAction={() => handleApplyDns(dns)}
                />
                <Action
                  title="恢复网卡为 DHCP 自动获取 DNS"
                  icon={Icon.RotateAntiClockwise}
                  onAction={handleResetDhcp}
                />
                <Action
                  title="仅刷新本机 DNS 解析缓存 (Flush DNS)"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  onAction={handleFlushDnsCache}
                />
                <Action.CopyToClipboard
                  title="复制主备 DNS 地址"
                  content={`${dns.primary}, ${dns.secondary}`}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  )
}

export default DnsBenchmarkCommand
