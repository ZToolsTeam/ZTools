import React, {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import {
  detectActiveInterfaces,
  scanSubnet,
  sendWakeOnLan
} from './lan-service.js'
import type { LanDevice, NetworkInterfaceInfo } from './types.js'

export * from './types.js'
export * from './lan-service.js'

export interface LanScannerCommandProps {
  featureCode?: string
  initialInterfaces?: NetworkInterfaceInfo[]
  initialDevices?: LanDevice[]
  hostOverride?: unknown
}

export function LanScannerCommand(props: LanScannerCommandProps = {}) {
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>(
    props.initialInterfaces ?? [
      {
        name: 'WLAN',
        ip: '192.168.1.105',
        subnetMask: '255.255.255.0',
        subnetDisplay: '192.168.1.0/24',
        broadcastIp: '192.168.1.255'
      }
    ]
  )
  const [selectedInterface, setSelectedInterface] = useState<string>(
    props.initialInterfaces?.[0]?.name || 'WLAN'
  )
  const [devices, setDevices] = useState<LanDevice[]>(props.initialDevices ?? [])
  const [searchText, setSearchText] = useState<string>('')
  const [isScanning, setIsScanning] = useState<boolean>(!props.initialDevices)
  const [scanDurationMs, setScanDurationMs] = useState<number>(340)

  const handleStartScan = async () => {
    setIsScanning(true)
    const t0 = Date.now()
    try {
      const ifaces = await detectActiveInterfaces(undefined, props.hostOverride)
      if (ifaces.length > 0) {
        setInterfaces(ifaces)
      }
      const targetIface = ifaces.find((i) => i.name === selectedInterface) || ifaces[0]
      const scanned = await scanSubnet(targetIface, undefined, props.hostOverride)
      if (scanned.length > 0 || !props.initialDevices) {
        setDevices(scanned)
      }
      setScanDurationMs(Math.max(12, Date.now() - t0))
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: '扫描局域网失败',
        message: err instanceof Error ? err.message : '未连接局域网'
      })
    } finally {
      setIsScanning(false)
    }
  }

  useEffect(() => {
    if (!props.initialDevices) {
      void handleStartScan()
    }
  }, [])

  const currentSubnet = useMemo(() => {
    const found = interfaces.find((i) => i.name === selectedInterface) || interfaces[0]
    return found?.subnetDisplay || '192.168.1.0/24'
  }, [interfaces, selectedInterface])

  const filteredDevices = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return devices
    return devices.filter(
      (d) =>
        d.ip.toLowerCase().includes(q) ||
        (d.mac && d.mac.toLowerCase().includes(q)) ||
        (d.vendor && d.vendor.toLowerCase().includes(q)) ||
        (d.hostname && d.hostname.toLowerCase().includes(q)) ||
        (d.customName && d.customName.toLowerCase().includes(q))
    )
  }, [devices, searchText])

  const handleWakeOnLan = async (mac: string) => {
    try {
      const activeIface = interfaces.find((i) => i.name === selectedInterface) || interfaces[0]
      await sendWakeOnLan(
        mac,
        activeIface?.broadcastIp || '255.255.255.255',
        { dryRun: false },
        props.hostOverride
      )
      await showToast({
        style: Toast.Style.Success,
        title: `已向 ${mac} 广播发送 102 字节 WOL 远程唤醒魔术包`
      })
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: '发送 WOL 魔术包失败',
        message: err instanceof Error ? err.message : 'MAC 地址无效'
      })
    }
  }

  const handleToggleFavorite = (target: LanDevice) => {
    setDevices((prev) =>
      prev.map((d) => (d.ip === target.ip ? { ...d, isFavorite: !d.isFavorite } : d))
    )
  }

  return (
    <List
      isLoading={isScanning}
      isShowingDetail={true}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索 IP、设备备注、MAC 地址或厂商 (如: 192.168.1.1、群晖、Apple) ..."
      searchBarAccessory={
        <List.Dropdown
          value={selectedInterface}
          onChange={setSelectedInterface}
          tooltip="选择扫描网卡"
        >
          {interfaces.map((iface) => (
            <List.Dropdown.Item
              key={iface.name}
              title={`${iface.name} (${iface.subnetDisplay})`}
              value={iface.name}
              icon={Icon.Globe}
            />
          ))}
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `网段: ${currentSubnet} · 发现 ${devices.length} 台在线设备 · 扫描耗时 ${scanDurationMs}ms`,
        actions: [{ id: 'rescan', title: '重新扫描', onAction: handleStartScan }]
      }}
    >
      {filteredDevices.map((d) => {
        const displayTitle = d.customName || d.hostname || d.ip
        return (
          <List.Item
            key={d.ip}
            id={d.ip}
            title={displayTitle}
            subtitle={d.ip !== displayTitle ? d.ip : d.vendor || '局域网主机'}
            icon={Icon.Desktop}
            accessories={[
              ...(d.isFavorite ? [{ tag: '已收藏' }] : []),
              { tag: d.vendor || '未知厂商' },
              { text: d.openPortsText }
            ]}
            detail={
              <List.Item.Detail
                markdown={`### 开放服务与端口\n${d.openPortsMarkdown || `已开放端口: ${d.openPorts.length > 0 ? d.openPorts.join(', ') : '未检测到常见开放端口'}`}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="IP 地址" text={d.ip} />
                    <List.Item.Detail.Metadata.Label title="MAC 地址" text={d.mac || '未知'} />
                    <List.Item.Detail.Metadata.Label
                      title="硬件制造商 (OUI)"
                      text={d.vendor || '未知厂商'}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="主机名 (mDNS)"
                      text={d.hostname || '未广播'}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label title="往返延迟 (RTT)" text={`${d.pingMs} ms`} />
                    <List.Item.Detail.Metadata.Label
                      title="设备备注"
                      text={d.customName || '未设置备注'}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                {d.primaryWebUrl ? (
                  <Action.OpenInBrowser
                    title={`在浏览器中打开 Web 服务 (${d.primaryWebUrl})`}
                    url={d.primaryWebUrl}
                    icon={Icon.Globe}
                  />
                ) : null}
                {d.mac ? (
                  <Action
                    title="发送 Wake-on-LAN 远程唤醒开机"
                    icon={Icon.Bolt}
                    shortcut={{ modifiers: ['cmd'], key: 'w' }}
                    onAction={() => handleWakeOnLan(d.mac!)}
                  />
                ) : null}
                <Action
                  title={d.isFavorite ? '取消收藏' : '设为常用收藏设备'}
                  icon={Icon.Pin}
                  shortcut={{ modifiers: ['cmd'], key: 'f' }}
                  onAction={() => handleToggleFavorite(d)}
                />
                <Action.CopyToClipboard
                  title="复制 IP 地址"
                  content={d.ip}
                  shortcut={{ modifiers: ['cmd'], key: 'c' }}
                />
                {d.mac ? (
                  <Action.CopyToClipboard
                    title="复制 MAC 地址"
                    content={d.mac}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                  />
                ) : null}
              </ActionPanel>
            }
          />
        )
      })}
    </List>
  )
}

export default LanScannerCommand
