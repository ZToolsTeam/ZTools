/**
 * 音频设备一键切换 (audio-device) 声明式主视图
 *
 * 借鉴 Raycast 官方 `extensions/audio-device` 源码改造：
 * - 支持输出设备（蓝牙耳机、外接显示器音响、本机扬声器、USB DAC）与输入设备（麦克风）一键切换
 * - 支持精确音量设定（0% ~ 100%）、快捷步进调音与一键静音/取消静音
 * - 支持常用场景组合（Combo Presets：线上会议模式 / 桌面外放模式 / Hi-Fi 听歌模式）一键激活
 */

import React from "../../index.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useMemo } from "../../runtime/hooks.js";
import { AudioDevice, IOType } from "./types.js";
import {
  defaultAudioDeviceManager,
  buildAudioPlatformCommand
} from "./audio-service.js";

export * from "./types.js";
export * from "./audio-service.js";

/**
 * 单个音频设备详情视图
 */
export function AudioDeviceDetailView({
  device,
  onUpdated
}: {
  device: AudioDevice;
  onUpdated?: () => void;
}) {
  const winCmd = buildAudioPlatformCommand("switch", device, "Windows");
  const macCmd = buildAudioPlatformCommand("switch", device, "macOS");

  const markdown = `
# ${device.type === "output" ? "🔊" : "🎙️"} ${device.name}

${device.isDefault ? `> 🟢 **当前正作为系统默认${device.type === "output" ? "输出 (播放)" : "输入 (录音)"}设备**\n` : ""}

---

### 硬件规格与实时状态
- **设备类型**: \`${device.type === "output" ? "音频输出 (Output)" : "音频输入 (Input)"}\`
- **连接总线 (Transport)**: \`${String(device.transportType).toUpperCase()}\`
- **当前音量**: \`${device.isMuted ? "🔇 已静音" : `${device.volume}%`}\`
- **采样率 / 声道**: \`${device.sampleRate || 48000} Hz / ${device.channels || 2} Ch\`
- **硬件端点 UID**: \`${device.uid}\`

---

### 底层平台切换指令预览
**Windows (CoreAudio / PowerShell)**:
\`\`\`powershell
${winCmd.commandLine}
\`\`\`

**macOS (SwitchAudioSource)**:
\`\`\`bash
${macCmd.commandLine}
\`\`\`
`;

  return (
    <Detail
      navigationTitle={`音频设备: ${device.name}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="设备名称" text={device.name} icon={Icon.SpeakerOn} />
          <Detail.Metadata.TagList title="默认状态">
            <Detail.Metadata.TagList.Item
              text={device.isDefault ? "DEFAULT (当前默认)" : "STANDBY (待命)"}
              color={device.isDefault ? Color.Green : Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="当前音量"
            text={device.isMuted ? "已静音 (Muted)" : `${device.volume}%`}
            icon={device.isMuted ? Icon.SpeakerOff : Icon.SpeakerHigh}
          />
          <Detail.Metadata.Label
            title="传输协议"
            text={String(device.transportType).toUpperCase()}
            icon={Icon.Plug}
          />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <Action
            title={`设为默认${device.type === "output" ? "输出" : "输入"}设备`}
            icon={Icon.Checkmark}
            onAction={async () => {
              const res = defaultAudioDeviceManager.setDefaultDevice(device.id);
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.success ? `已切换默认设备为: ${device.name}` : res.error || "切换失败"
              );
              onUpdated?.();
            }}
          />
          <Action
            title={device.isMuted ? "取消静音 (Unmute)" : "静音设备 (Mute)"}
            icon={device.isMuted ? Icon.SpeakerOn : Icon.SpeakerOff}
            onAction={async () => {
              const res = defaultAudioDeviceManager.toggleDeviceMute(device.id);
              await showToast(
                Toast.Style.Success,
                `${res.device?.isMuted ? "已静音" : "已恢复声音"}: ${device.name}`
              );
              onUpdated?.();
            }}
          />
          <Action
            title="复制硬件端点 UID"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(device.uid);
              await showToast(Toast.Style.Success, "已复制硬件 UID");
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * 精确调整音量表单视图
 */
export function AudioVolumeForm({
  device,
  onSaved
}: {
  device: AudioDevice;
  onSaved?: () => void;
}) {
  const { pop } = useNavigation();

  return (
    <Form
      navigationTitle={`设置音量: ${device.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="应用音量设置"
            icon={Icon.Checkmark}
            onSubmit={async (values: Record<string, any>) => {
              const vol = Number(values.volume);
              const res = defaultAudioDeviceManager.setDeviceVolume(device.id, vol);
              if (!res.success) {
                await showToast(Toast.Style.Failure, res.error || "音量设置无效");
                return;
              }
              await showToast(Toast.Style.Success, `${device.name} 音量已设为 ${res.device?.volume}%`);
              onSaved?.();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="volume"
        title="目标音量百分比 (0 ~ 100)"
        placeholder="输入 0 到 100 之间的数字..."
        defaultValue={String(device.volume)}
      />
    </Form>
  );
}

/**
 * 音频设备一键切换主命令组件
 */
export default function AudioDeviceCommand() {
  const [searchText, setSearchText] = useState("");
  const [ioFilter, setIoFilter] = useState<IOType | "all" | "favourites">("all");
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const devices = useMemo(
    () =>
      defaultAudioDeviceManager.filterDevices({
        ioType: ioFilter,
        query: searchText
      }),
    [ioFilter, searchText, version]
  );

  const outputDevices = devices.filter((d) => d.type === "output");
  const inputDevices = devices.filter((d) => d.type === "input");
  const combos = useMemo(() => defaultAudioDeviceManager.getCombos(), [version]);

  const renderDeviceItem = (dev: AudioDevice) => (
    <List.Item
      key={dev.id}
      icon={{
        source: dev.isMuted
          ? Icon.SpeakerOff
          : dev.type === "output"
            ? Icon.SpeakerHigh
            : Icon.Microphone,
        tintColor: dev.isDefault ? Color.Green : Color.SecondaryText
      }}
      title={dev.name}
      subtitle={`${String(dev.transportType).toUpperCase()} • ${dev.isMuted ? "🔇 已静音" : `音量 ${dev.volume}%`}`}
      accessories={[
        dev.isFavourite ? { icon: { source: Icon.Star, tintColor: Color.Yellow } } : {},
        dev.isDefault
          ? { tag: { value: "当前默认", color: Color.Green } }
          : { tag: { value: "待命", color: Color.SecondaryText } }
      ]}
      actions={
        <ActionPanel>
          <Action
            title={`设为默认${dev.type === "output" ? "输出 (播放)" : "输入 (麦克风)"}设备`}
            icon={Icon.Checkmark}
            onAction={async () => {
              const res = defaultAudioDeviceManager.setDefaultDevice(dev.id);
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.success ? `已切换至: ${dev.name}` : res.error || "切换失败"
              );
              refresh();
            }}
          />
          <Action
            title={dev.isMuted ? "取消静音 (Unmute)" : "一键静音 (Mute)"}
            icon={dev.isMuted ? Icon.SpeakerOn : Icon.SpeakerOff}
            shortcut={{ modifiers: ["ctrl"], key: "m" }}
            onAction={async () => {
              const res = defaultAudioDeviceManager.toggleDeviceMute(dev.id);
              await showToast(
                Toast.Style.Success,
                `${res.device?.isMuted ? "已静音" : "已取消静音"}: ${dev.name}`
              );
              refresh();
            }}
          />
          <Action.Push
            title="精确设置音量百分比..."
            icon={Icon.SpeakerHigh}
            shortcut={{ modifiers: ["ctrl"], key: "l" }}
            target={<AudioVolumeForm device={dev} onSaved={refresh} />}
          />
          <Action
            title="音量 +10%"
            icon={Icon.Plus}
            shortcut={{ modifiers: ["ctrl"], key: "arrowup" }}
            onAction={async () => {
              const res = defaultAudioDeviceManager.stepDeviceVolume(dev.id, 10);
              await showToast(Toast.Style.Success, `音量: ${res.device?.volume}%`);
              refresh();
            }}
          />
          <Action
            title="音量 -10%"
            icon={Icon.Minus}
            shortcut={{ modifiers: ["ctrl"], key: "arrowdown" }}
            onAction={async () => {
              const res = defaultAudioDeviceManager.stepDeviceVolume(dev.id, -10);
              await showToast(Toast.Style.Success, `音量: ${res.device?.volume}%`);
              refresh();
            }}
          />
          <Action
            title={dev.isFavourite ? "取消常用收藏" : "设为常用收藏"}
            icon={dev.isFavourite ? Icon.StarDisabled : Icon.Star}
            shortcut={{ modifiers: ["ctrl"], key: "f" }}
            onAction={async () => {
              defaultAudioDeviceManager.toggleFavourite(dev.id);
              refresh();
            }}
          />
          <Action.Push
            title="查看硬件与底层命令详情"
            icon={Icon.Info}
            target={<AudioDeviceDetailView device={dev} onUpdated={refresh} />}
          />
        </ActionPanel>
      }
    />
  );

  return (
    <List
      navigationTitle="音频设备一键切换 (Set Audio Device)"
      searchBarPlaceholder="搜索耳机、显示器音响、扬声器或麦克风..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按输入/输出类型筛选"
          value={ioFilter}
          onChange={(val) => setIoFilter(val as IOType | "all" | "favourites")}
        >
          <List.Dropdown.Item title="全部音频设备 (All)" value="all" />
          <List.Dropdown.Item title="仅输出播放设备 (Output)" value="output" />
          <List.Dropdown.Item title="仅输入录音设备 (Input)" value="input" />
          <List.Dropdown.Item title="常用收藏设备 (Favourites)" value="favourites" />
        </List.Dropdown>
      }
    >
      {ioFilter === "all" && !searchText && (
        <List.Section title="⚡ 一键场景组合切换 (Audio Combos)">
          {combos.map((combo) => (
            <List.Item
              key={combo.id}
              icon={{ source: Icon.Bolt, tintColor: Color.Purple }}
              title={combo.name}
              subtitle={combo.description}
              accessories={[{ tag: { value: combo.shortcut || "Combo", color: Color.Purple } }]}
              actions={
                <ActionPanel>
                  <Action
                    title="立即激活此音频场景组合"
                    icon={Icon.Checkmark}
                    onAction={async () => {
                      const res = defaultAudioDeviceManager.applyComboPreset(combo.id);
                      await showToast(
                        res.success ? Toast.Style.Success : Toast.Style.Failure,
                        res.success ? `已切换场景: ${combo.name}` : res.error || "切换失败"
                      );
                      refresh();
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {outputDevices.length > 0 && (
        <List.Section title="🔊 音频输出设备 (Output / 耳机与扬声器)" subtitle={`${outputDevices.length} 个设备`}>
          {outputDevices.map(renderDeviceItem)}
        </List.Section>
      )}

      {inputDevices.length > 0 && (
        <List.Section title="🎙️ 音频输入设备 (Input / 麦克风)" subtitle={`${inputDevices.length} 个设备`}>
          {inputDevices.map(renderDeviceItem)}
        </List.Section>
      )}
    </List>
  );
}
