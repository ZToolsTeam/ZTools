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
  Toast
} from "../../index.js";
import { useState, useMemo } from "../../runtime/hooks.js";
import { WifiProfileInfo, WifiSecurityFilter } from "./types.js";
import {
  SAMPLE_WIFI_PROFILES,
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
  const qrString = useMemo(
    () => generateWifiQrString(profile.ssid, profile.password, profile.authType),
    [profile.ssid, profile.password, profile.authType]
  );
  const qrSvgUrl = useMemo(() => generateWifiQrSvgDataUrl(profile), [profile]);

  const displayPassword = profile.isOpenNetwork
    ? "(开放网络 — 无需密码)"
    : profile.isEnterprise
      ? "(802.1X 企业证书认证 — 无预共享明文密码)"
      : profile.password || "(未读取到密码)";

  const markdown = `
# 📶 ${profile.ssid}

${profile.isConnected ? "> 🟢 **当前已连接此无线网络**\n" : ""}
${profile.notes ? `> 💡 ${profile.notes}\n` : ""}

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
      navigationTitle={`Wi-Fi 详情: ${profile.ssid}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="网络名称 (SSID)" text={profile.ssid} icon={Icon.Wifi} />
          <Detail.Metadata.TagList title="安全认证">
            <Detail.Metadata.TagList.Item
              text={profile.authType}
              color={
                profile.isOpenNetwork
                  ? Color.Yellow
                  : profile.authType.includes("WPA3")
                    ? Color.Green
                    : Color.Blue
              }
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="加密算法 (Cipher)"
            text={profile.cipher || "CCMP (AES)"}
            icon={Icon.Lock}
          />
          <Detail.Metadata.Label
            title="无线频段 (Band)"
            text={profile.band || "Dual-Band"}
            icon={Icon.Signal3}
          />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title="信号强度"
            text={`${profile.signalPercent ?? 85}%`}
            icon={Icon.BarChart}
          />
          <Detail.Metadata.Label
            title="最近连接"
            text={profile.lastConnected || "已保存"}
            icon={Icon.Clock}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {!profile.isOpenNetwork && !profile.isEnterprise && profile.password && (
            <Action
              title="复制 Wi-Fi 密码"
              icon={Icon.CopyClipboard}
              onAction={async () => {
                await Clipboard.copy(profile.password);
                await showToast(Toast.Style.Success, `已复制 "${profile.ssid}" 的密码`);
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
              await Clipboard.copy(profile.ssid);
              await showToast(Toast.Style.Success, `已复制 SSID: ${profile.ssid}`);
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
  const [searchText, setSearchText] = useState("");
  const [securityFilter, setSecurityFilter] = useState<WifiSecurityFilter>("all");
  const [revealInList, setRevealInList] = useState(true);

  const profiles = useMemo(
    () =>
      filterAndSortWifiProfiles(SAMPLE_WIFI_PROFILES, {
        query: searchText,
        securityFilter,
        sortBy: "connected"
      }),
    [searchText, securityFilter]
  );

  return (
    <List
      navigationTitle="Wi-Fi 密码查看器 (WiFi Password Reveal)"
      searchBarPlaceholder="搜索已保存的 Wi-Fi 名称、拼音或频段..."
      onSearchTextChange={setSearchText}
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
              : "证书认证";

          return (
            <List.Item
              key={item.id}
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
                  {!item.isOpenNetwork && !item.isEnterprise && item.password && (
                    <Action
                      title="直接复制 Wi-Fi 密码"
                      icon={Icon.CopyClipboard}
                      shortcut={{ modifiers: ["ctrl"], key: "c" }}
                      onAction={async () => {
                        await Clipboard.copy(item.password);
                        await showToast(Toast.Style.Success, `已复制 "${item.ssid}" 的密码`);
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
                      const qr = generateWifiQrString(item.ssid, item.password, item.authType);
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
