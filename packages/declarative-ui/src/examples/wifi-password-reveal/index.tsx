import React, {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import { isRealElectronHost } from '../shared/native-ipc.js'
import type { WifiProfileInfo, WifiSecurityFilter } from './types.js'
import {
  SAMPLE_WIFI_PROFILES,
  fetchSavedWifiProfiles,
  filterAndSortWifiProfiles,
  generateWifiQrString,
  generateWifiQrSvgDataUrl,
  revealWifiPasswordFromHost
} from './wifi-service.js'

export * from './types.js'
export * from './wifi-service.js'

export function WifiDetailView({
  profile,
  hostOverride
}: {
  profile: WifiProfileInfo
  hostOverride?: unknown
}) {
  const [resolvedPassword, setResolvedPassword] = useState(profile.password)

  useEffect(() => {
    let active = true
    setResolvedPassword(profile.password)
    if (
      !profile.password &&
      !profile.isOpenNetwork &&
      !profile.isEnterprise &&
      (hostOverride || isRealElectronHost())
    ) {
      void revealWifiPasswordFromHost(profile.ssid, hostOverride).then((pwd) => {
        if (active && pwd) {
          setResolvedPassword(pwd)
        }
      })
    }
    return () => {
      active = false
    }
  }, [profile.ssid, profile.password, profile.isOpenNetwork, profile.isEnterprise, hostOverride])

  const effectiveProfile = useMemo(
    () => ({ ...profile, password: resolvedPassword }),
    [profile, resolvedPassword]
  )

  const qrString = useMemo(
    () =>
      generateWifiQrString(
        effectiveProfile.ssid,
        effectiveProfile.password,
        effectiveProfile.authType
      ),
    [effectiveProfile.ssid, effectiveProfile.password, effectiveProfile.authType]
  )
  const qrSvgUrl = useMemo(() => generateWifiQrSvgDataUrl(effectiveProfile), [effectiveProfile])

  const displayPassword = effectiveProfile.isOpenNetwork
    ? '(开放网络 — 无需密码)'
    : effectiveProfile.isEnterprise
      ? '(802.1X 企业证书认证 — 无预共享明文密码)'
      : effectiveProfile.password || '(未读取到密码)'

  const markdown = `
# ${effectiveProfile.ssid}

${effectiveProfile.isConnected ? '> **当前已连接此无线网络**\n' : ''}
${effectiveProfile.notes ? `> ${effectiveProfile.notes}\n` : ''}

---

### 明文密码 (Key Content)
\`\`\`text
${displayPassword}
\`\`\`

### 手机扫码一键连网协议串
\`\`\`text
${qrString}
\`\`\`

![Wi-Fi QR Preview](${qrSvgUrl})
`

  return (
    <Detail
      navigationTitle={`Wi-Fi 详情: ${effectiveProfile.ssid}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label
            title="加密算法 (Cipher)"
            text={effectiveProfile.cipher || 'CCMP (AES)'}
            icon={Icon.Lock}
          />
          <Detail.Metadata.Label
            title="无线频段 (Band)"
            text={effectiveProfile.band || 'Dual-Band'}
            icon={Icon.Signal3}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="信号强度"
            text={`${effectiveProfile.signalPercent ?? 85}%`}
            icon={Icon.BarChart}
          />
          <Detail.Metadata.Label
            title="最近连接"
            text={effectiveProfile.lastConnected || '已保存'}
            icon={Icon.Clock}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {!effectiveProfile.isOpenNetwork && !effectiveProfile.isEnterprise && (
            <Action
              title="复制 Wi-Fi 密码"
              icon={Icon.CopyClipboard}
              onAction={async () => {
                let pwd = effectiveProfile.password
                if (!pwd && (hostOverride || isRealElectronHost())) {
                  pwd = await revealWifiPasswordFromHost(effectiveProfile.ssid, hostOverride)
                  if (pwd) setResolvedPassword(pwd)
                }
                if (pwd) {
                  await Clipboard.copy(pwd)
                  await showToast(Toast.Style.Success, `已复制 "${effectiveProfile.ssid}" 的密码`)
                } else {
                  await showToast(Toast.Style.Failure, `未能读取 "${effectiveProfile.ssid}" 的明文密码`)
                }
              }}
            />
          )}
          <Action
            title="复制扫码连网协议串 (WIFI:)"
            icon={Icon.QrCode}
            shortcut={{ modifiers: ['ctrl'], key: 'q' }}
            onAction={async () => {
              await Clipboard.copy(qrString)
              await showToast(Toast.Style.Success, '已复制 WIFI: 标准二维码连网串')
            }}
          />
          <Action
            title="复制网络名称 (SSID)"
            icon={Icon.Text}
            shortcut={{ modifiers: ['ctrl', 'shift'], key: 'c' }}
            onAction={async () => {
              await Clipboard.copy(effectiveProfile.ssid)
              await showToast(Toast.Style.Success, `已复制 SSID: ${effectiveProfile.ssid}`)
            }}
          />
        </ActionPanel>
      }
    />
  )
}

export function WifiPasswordRevealCommand(props?: {
  featureCode?: string
  hostOverride?: unknown
}) {
  const [allProfiles, setAllProfiles] = useState<readonly WifiProfileInfo[]>(() =>
    props?.hostOverride || isRealElectronHost() ? [] : SAMPLE_WIFI_PROFILES
  )
  const [searchText, setSearchText] = useState('')
  const [securityFilter, setSecurityFilter] = useState<WifiSecurityFilter>('all')
  const [revealInList, setRevealInList] = useState(false)
  const [isLoading, setIsLoading] = useState(() => Boolean(props?.hostOverride) || isRealElectronHost())

  const reloadWifiProfiles = async () => {
    setIsLoading(true)
    try {
      const loaded = await fetchSavedWifiProfiles({ hostOverride: props?.hostOverride })
      setAllProfiles(loaded)
      await showToast(Toast.Style.Success, `已刷新无线网络配置 (${loaded.length} 个)`)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    setIsLoading(true)
    void fetchSavedWifiProfiles({ hostOverride: props?.hostOverride })
      .then((loaded) => {
        if (active && (loaded.length > 0 || props?.hostOverride || isRealElectronHost())) {
          setAllProfiles(loaded)
        }
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [props?.hostOverride])

  const profiles = useMemo(
    () =>
      filterAndSortWifiProfiles(allProfiles, {
        query: searchText,
        securityFilter,
        sortBy: 'connected'
      }),
    [allProfiles, searchText, securityFilter]
  )

  const connectedProfile = useMemo(() => profiles.find((p) => p.isConnected), [profiles])

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      navigationTitle="Wi-Fi 密码查看"
      searchBarPlaceholder="搜索已保存的 Wi-Fi 名称、拼音或频段..."
      onSearchTextChange={setSearchText}
      filterBar={{
        summaryText: `已保存 ${profiles.length} 个 Wi-Fi 网络 | 当前连接：${connectedProfile ? connectedProfile.ssid : '未连接'}`,
        actions: [
          {
            id: 'toggle-reveal',
            title: revealInList ? '隐藏列表明文密码' : '显示列表明文密码',
            style: 'primary',
            onAction: () => {
              setRevealInList((prev) => !prev)
            }
          },
          {
            id: 'refresh-wifi',
            title: '刷新网络配置',
            style: 'secondary',
            onAction: () => {
              void reloadWifiProfiles()
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按加密类型过滤"
          value={securityFilter}
          onChange={(val) => setSecurityFilter(val as WifiSecurityFilter)}
        >
          <List.Dropdown.Item title="全部已保存网络" value="all" />
          <List.Dropdown.Item title="仅当前连接" value="connected" />
          <List.Dropdown.Item title="WPA3 个人加密" value="wpa3" />
          <List.Dropdown.Item title="WPA2 个人加密" value="wpa2" />
          <List.Dropdown.Item title="开放无密码网络" value="open" />
          <List.Dropdown.Item title="802.1X 企业网络" value="enterprise" />
        </List.Dropdown>
      }
    >
      {profiles.length === 0 ? (
        <List.Section title="检测结果">
          <List.Item
            id="empty-wifi"
            icon={Icon.Wifi}
            title="未检测到已保存的无线网络配置"
            subtitle="请确认当前设备已启用无线网卡（WLAN），或切换右上角筛选条件重试"
          />
        </List.Section>
      ) : (
        <List.Section title="已保存的无线网络配置文件" subtitle={`共 ${profiles.length} 个网络`}>
          {profiles.map((item) => {
            const maskedPwd = item.password
              ? revealInList
                ? item.password
                : '••••••••'
              : item.isOpenNetwork
                ? '开放网络（无密码）'
                : item.isEnterprise
                  ? '802.1X 证书认证'
                  : '回车复制或查看明文密码'

            const qrString = generateWifiQrString(item.ssid, item.password, item.authType)
            const qrSvgUrl = generateWifiQrSvgDataUrl(item)

            const detailMarkdown = `### 手机扫码一键连网\n\n![Wi-Fi QR Code](${qrSvgUrl})\n\n### 明文密码\n\`\`\`text\n${item.isOpenNetwork ? '(开放网络 — 无需密码)' : item.isEnterprise ? '(802.1X 企业认证 — 无预共享密码)' : item.password || '(按回车提取密码)'}\n\`\`\`\n\n### 二维码连网协议串\n\`${qrString}\``

            return (
              <List.Item
                key={item.id}
                id={item.id}
                icon={Icon.Wifi}
                title={item.ssid}
                subtitle={`${item.authType} · ${maskedPwd}`}
                accessories={[
                  item.isConnected ? { tag: '已连接' } : { text: item.lastConnected || '已保存' }
                ]}
                detail={
                  <List.Item.Detail
                    markdown={detailMarkdown}
                    metadata={
                      <List.Item.Detail.Metadata>
                        <List.Item.Detail.Metadata.Label
                          title="加密算法 (Cipher)"
                          text={item.cipher || 'CCMP (AES)'}
                        />
                        <List.Item.Detail.Metadata.Label
                          title="无线频段 (Band)"
                          text={item.band || 'Dual-Band'}
                        />
                        <List.Item.Detail.Metadata.Label
                          title="网卡接口"
                          text={item.interfaceName || 'WLAN'}
                        />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    {!item.isOpenNetwork && !item.isEnterprise && (
                      <Action
                        title="复制 Wi-Fi 密码"
                        icon={Icon.CopyClipboard}
                        onAction={async () => {
                          let pwd = item.password
                          if (!pwd && (props?.hostOverride || isRealElectronHost())) {
                            pwd = await revealWifiPasswordFromHost(item.ssid, props?.hostOverride)
                            if (pwd) {
                              setAllProfiles((prev) =>
                                prev.map((p) => (p.id === item.id ? { ...p, password: pwd } : p))
                              )
                            }
                          }
                          if (pwd) {
                            await Clipboard.copy(pwd)
                            await showToast(Toast.Style.Success, `已复制 "${item.ssid}" 的密码`)
                          } else {
                            await showToast(
                              Toast.Style.Failure,
                              `未能提取 "${item.ssid}" 的明文密码`
                            )
                          }
                        }}
                      />
                    )}
                    <Action.Push
                      title="全屏查看密码与连网二维码"
                      icon={Icon.Eye}
                      shortcut={{ modifiers: ['ctrl'], key: 'enter' }}
                      target={<WifiDetailView profile={item} hostOverride={props?.hostOverride} />}
                    />
                    <Action
                      title={revealInList ? '隐藏列表明文密码' : '显示列表明文密码'}
                      icon={revealInList ? Icon.EyeDisabled : Icon.Eye}
                      shortcut={{ modifiers: ['ctrl'], key: 'h' }}
                      onAction={() => setRevealInList(!revealInList)}
                    />
                    <Action
                      title="复制扫码连网协议串 (WIFI:)"
                      icon={Icon.QrCode}
                      shortcut={{ modifiers: ['ctrl'], key: 'q' }}
                      onAction={async () => {
                        await Clipboard.copy(qrString)
                        await showToast(Toast.Style.Success, '已复制 WIFI: 标准二维码连网串')
                      }}
                    />
                    <Action
                      title="复制网络名称 (SSID)"
                      icon={Icon.Text}
                      shortcut={{ modifiers: ['ctrl', 'shift'], key: 'c' }}
                      onAction={async () => {
                        await Clipboard.copy(item.ssid)
                        await showToast(Toast.Style.Success, `已复制 SSID: ${item.ssid}`)
                      }}
                    />
                  </ActionPanel>
                }
              />
            )
          })}
        </List.Section>
      )}
    </List>
  )
}

export default WifiPasswordRevealCommand
