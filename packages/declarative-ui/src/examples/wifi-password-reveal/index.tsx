/**
 * Wi-Fi 密码查看器 (wifi-password-reveal) 声明式主视图
 *
 * 借鉴 Raycast 官方 `extensions/wifi-password-reveal/src/index.tsx` 改造：
 * - 支持一键查看本机保存的所有 Wi-Fi 名称与明文密码
 * - 支持生成 `WIFI:T:WPA;S:...;P:...;;` 标准手机扫码连网二维码
 * - 支持按加密类型过滤、拼音/关键词检索与一键复制明文密码
 */

import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useMemo, useEffect } from "../../runtime/hooks.js";
import { isRealElectronHost } from "../shared/native-ipc.js";
import { WifiProfileInfo, WifiSecurityFilter } from "./types.js";
import {
  SAMPLE_WIFI_PROFILES,
  fetchSavedWifiProfiles,
  revealWifiPasswordFromHost,
  filterAndSortWifiProfiles,
  generateWifiQrString,
  generateWifiQrSvgDataUrl
} from "./wifi-service.js";

export * from "./types.js";
export * from "./wifi-service.js";

/**
 * Wi-Fi 详情与扫码连网视图 (对应原版 DetailPassword 组件)
 */
export function WifiDetailView({ profile }: { profile: WifiProfileInfo }) {
  const [resolvedPassword, setResolvedPassword] = useState(profile.password);

  useEffect(() => {
    let active = true;
    setResolvedPassword(profile.password);
    if (!profile.password && !profile.isOpenNetwork && !profile.isEnterprise && isRealElectronHost()) {
      void revealWifiPasswordFromHost(profile.ssid).then((pwd) => {
        if (active && pwd) {
          setResolvedPassword(pwd);
        }
      });
    }
    return () => {
      active = false;
    };
  }, [profile.ssid, profile.password, profile.isOpenNetwork, profile.isEnterprise]);

  const effectiveProfile = useMemo(
    () => ({ ...profile, password: resolvedPassword }),
    [profile, resolvedPassword]
  );

  const qrString = useMemo(
    () => generateWifiQrString(effectiveProfile.ssid, effectiveProfile.password, effectiveProfile.authType),
    [effectiveProfile.ssid, effectiveProfile.password, effectiveProfile.authType]
  );
  const qrSvgUrl = useMemo(() => generateWifiQrSvgDataUrl(effectiveProfile), [effectiveProfile]);

  const displayPassword = effectiveProfile.isOpenNetwork
    ? "(开放网络 — 无需密码)"
    : effectiveProfile.isEnterprise
      ? "(802.1X 企业证书认证 — 无预共享明文密码)"
      : effectiveProfile.password || "(未读取到密码)";

  const markdown = `
# 📶 ${effectiveProfile.ssid}

${effectiveProfile.isConnected ? "> 🟢 **当前已连接此无线网络**\n" : ""}
${effectiveProfile.notes ? `> 💡 ${effectiveProfile.notes}\n` : ""}

---

### 🔑 明文密码 (Key Content)
\`\`\`text
${displayPassword}
\`\`\`

### 📱 手机扫码一键连网协议串
\`\`\`text
${qrString}
\`\`\`

![Wi-Fi QR Preview](${qrSvgUrl})
`;

  return (
    <Detail
      navigationTitle={`Wi-Fi 详情: ${effectiveProfile.ssid}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="网络名称 (SSID)" text={effectiveProfile.ssid} icon={Icon.Wifi} />
          <Detail.Metadata.TagList title="安全认证">
            <Detail.Metadata.TagList.Item
              text={effectiveProfile.authType}
              color={
                effectiveProfile.isOpenNetwork
                  ? Color.Yellow
                  : effectiveProfile.authType.includes("WPA3")
                    ? Color.Green
                    : Color.Blue
              }
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="加密算法 (Cipher)"
            text={effectiveProfile.cipher || "CCMP (AES)"}
            icon={Icon.Lock}
          />
          <Detail.Metadata.Label
            title="无线频段 (Band)"
            text={effectiveProfile.band || "Dual-Band"}
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
            text={effectiveProfile.lastConnected || "已保存"}
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
                let pwd = effectiveProfile.password;
                if (!pwd && isRealElectronHost()) {
                  pwd = await revealWifiPasswordFromHost(effectiveProfile.ssid);
                  if (pwd) setResolvedPassword(pwd);
                }
                if (pwd) {
                  await Clipboard.copy(pwd);
                  await showToast(Toast.Style.Success, `已复制 "${effectiveProfile.ssid}" 的密码`);
                } else {
                  await showToast(Toast.Style.Failure, `未能读取 "${effectiveProfile.ssid}" 的明文密码`);
                }
              }}
            />
          )}
          <Action
            title="复制扫码连网协议串 (WIFI:)"
            icon={Icon.QrCode}
            shortcut={{ modifiers: ["ctrl"], key: "q" }}
            onAction={async () => {
              await Clipboard.copy(qrString);
              await showToast(Toast.Style.Success, "已复制 WIFI: 标准二维码连网串");
            }}
          />
          <Action
            title="复制网络名称 (SSID)"
            icon={Icon.Text}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
            onAction={async () => {
              await Clipboard.copy(effectiveProfile.ssid);
              await showToast(Toast.Style.Success, `已复制 SSID: ${effectiveProfile.ssid}`);
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * Wi-Fi 密码查看器主命令组件
 */
export default function WifiPasswordRevealCommand() {
  const [allProfiles, setAllProfiles] = useState<readonly WifiProfileInfo[]>(() =>
    isRealElectronHost() ? [] : SAMPLE_WIFI_PROFILES
  );
  const [searchText, setSearchText] = useState("");
  const [securityFilter, setSecurityFilter] = useState<WifiSecurityFilter>("all");
  const [revealInList, setRevealInList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  const reloadWifiProfiles = async () => {
    const loaded = await fetchSavedWifiProfiles();
    if (loaded.length > 0 || isRealElectronHost()) {
      setAllProfiles(loaded);
    }
    await showToast(Toast.Style.Success, `已刷新无线网络配置 (${loaded.length} 个)`);
  };

  useEffect(() => {
    let active = true;
    void fetchSavedWifiProfiles().then((loaded) => {
      if (active && (loaded.length > 0 || isRealElectronHost())) {
        setAllProfiles(loaded);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const profiles = useMemo(
    () =>
      filterAndSortWifiProfiles(allProfiles, {
        query: searchText,
        securityFilter,
        sortBy: "connected"
      }),
    [allProfiles, searchText, securityFilter]
  );

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === selectedId) || profiles[0],
    [profiles, selectedId]
  );
  const connectedProfile = useMemo(
    () => profiles.find((p) => p.isConnected),
    [profiles]
  );

  return (
    <List
      navigationTitle="Wi-Fi 密码查看器 (WiFi Password Reveal)"
      searchBarPlaceholder="搜索已保存的 Wi-Fi 名称、拼音或频段..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `已识别网络配置 ${profiles.length} 个 • 当前连接状态: ${connectedProfile ? `🟢 已连接 ${connectedProfile.ssid}` : "未连接/已保存配置"}`,
        groups: [
          {
            id: "security",
            label: "安全认证",
            value: securityFilter,
            onChange: (val: string) => setSecurityFilter(val as WifiSecurityFilter),
            options: [
              { value: "all", label: "全部网络" },
              { value: "wpa3", label: "WPA3" },
              { value: "wpa2", label: "WPA2" },
              { value: "open", label: "开放无密" },
              { value: "enterprise", label: "802.1X 企业" }
            ]
          }
        ],
        actions: [
          {
            id: "copy-pwd",
            label: "📋 复制选中网络密码",
            title: "📋 复制选中网络密码",
            style: "primary",
            onAction: async () => {
              if (!activeProfile) return;
              let pwd = activeProfile.password;
              if (!pwd && !activeProfile.isOpenNetwork && !activeProfile.isEnterprise && isRealElectronHost()) {
                pwd = await revealWifiPasswordFromHost(activeProfile.ssid);
                if (pwd) {
                  setAllProfiles((prev) =>
                    prev.map((p) => (p.id === activeProfile.id ? { ...p, password: pwd } : p))
                  );
                }
              }
              if (pwd) {
                await Clipboard.copy(pwd);
                await showToast(Toast.Style.Success, `已复制 "${activeProfile.ssid}" 的密码`);
              } else {
                await showToast(Toast.Style.Failure, `未能读取 "${activeProfile.ssid}" 的明文密码`);
              }
            }
          },
          {
            id: "toggle-reveal",
            label: "👁️ 显示/隐藏明文密码",
            title: "👁️ 显示/隐藏明文密码",
            style: "secondary",
            onAction: () => {
              setRevealInList((prev) => !prev);
            }
          },
          {
            id: "view-qr",
            label: "📱 查看扫码连网二维码",
            title: "📱 查看扫码连网二维码",
            style: "secondary",
            onAction: () => {
              if (activeProfile) push(<WifiDetailView profile={activeProfile} />);
            }
          },
          {
            id: "refresh-wifi",
            label: "🔄 刷新网络配置",
            title: "🔄 刷新网络配置",
            style: "secondary",
            onAction: () => {
              void reloadWifiProfiles();
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
          <List.Dropdown.Item title="全部已保存网络 (All)" value="all" />
          <List.Dropdown.Item title="WPA3 个人加密 (WPA3)" value="wpa3" />
          <List.Dropdown.Item title="WPA2 个人加密 (WPA2)" value="wpa2" />
          <List.Dropdown.Item title="开放无密码网络 (Open)" value="open" />
          <List.Dropdown.Item title="802.1X 企业网络 (Enterprise)" value="enterprise" />
        </List.Dropdown>
      }
    >
      <List.Section title="已保存的无线网络配置文件" subtitle={`共 ${profiles.length} 个网络`}>
        {profiles.map((item) => {
          const maskedPwd = item.password
            ? revealInList
              ? item.password
              : "•".repeat(Math.min(12, item.password.length))
            : item.isOpenNetwork
              ? "无密码 (开放)"
              : item.isEnterprise
                ? "证书认证"
                : "回车查看或按 Ctrl+C 提取密码";

          return (
            <List.Item
              key={item.id}
              id={item.id}
              icon={{
                source: Icon.Wifi,
                tintColor: item.isConnected ? Color.Green : Color.Blue
              }}
              title={item.ssid}
              subtitle={`🔑 ${maskedPwd}`}
              accessories={[
                item.isConnected
                  ? { tag: { value: "已连接", color: Color.Green } }
                  : { text: item.lastConnected || "已保存" },
                {
                  tag: {
                    value: item.authType,
                    color: item.isOpenNetwork ? Color.Yellow : Color.SecondaryText
                  }
                },
                { text: `${item.signalPercent ?? 85}%` }
              ]}
              actions={
                <ActionPanel>
                  <Action.Push
                    title="查看密码详情与连网二维码"
                    icon={Icon.Eye}
                    target={<WifiDetailView profile={item} />}
                  />
                  {!item.isOpenNetwork && !item.isEnterprise && (
                    <Action
                      title="直接复制 Wi-Fi 密码"
                      icon={Icon.CopyClipboard}
                      shortcut={{ modifiers: ["ctrl"], key: "c" }}
                      onAction={async () => {
                        let pwd = item.password;
                        if (!pwd && isRealElectronHost()) {
                          pwd = await revealWifiPasswordFromHost(item.ssid);
                          if (pwd) {
                            setAllProfiles((prev) =>
                              prev.map((p) => (p.id === item.id ? { ...p, password: pwd } : p))
                            );
                          }
                        }
                        if (pwd) {
                          await Clipboard.copy(pwd);
                          await showToast(Toast.Style.Success, `已复制 "${item.ssid}" 的密码`);
                        } else {
                          await showToast(Toast.Style.Failure, `未能提取 "${item.ssid}" 的明文密码`);
                        }
                      }}
                    />
                  )}
                  <Action
                    title={revealInList ? "隐藏列表明文密码" : "显示列表明文密码"}
                    icon={revealInList ? Icon.EyeDisabled : Icon.Eye}
                    shortcut={{ modifiers: ["ctrl"], key: "h" }}
                    onAction={() => setRevealInList(!revealInList)}
                  />
                  <Action
                    title="复制连网二维码协议串"
                    icon={Icon.QrCode}
                    shortcut={{ modifiers: ["ctrl"], key: "q" }}
                    onAction={async () => {
                      let pwd = item.password;
                      if (!pwd && !item.isOpenNetwork && !item.isEnterprise && isRealElectronHost()) {
                        pwd = await revealWifiPasswordFromHost(item.ssid);
                      }
                      const qr = generateWifiQrString(item.ssid, pwd, item.authType);
                      await Clipboard.copy(qr);
                      await showToast(Toast.Style.Success, "已复制 WIFI: 连网协议串");
                    }}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}
