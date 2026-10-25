import React, {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useNavigation,
  useState
} from '../../index.js'
import {
  buildAudioPlatformCommand,
  defaultAudioDeviceManager
} from './audio-service.js'
import { isRealElectronHost } from '../shared/native-ipc.js'
import type { AudioDevice, IOType } from './types.js'

export * from './types.js'
export * from './audio-service.js'

export function AudioDeviceDetailView({
  device,
  onUpdated
}: {
  device: AudioDevice
  onUpdated?: () => void
}) {
  const winCmd = buildAudioPlatformCommand('switch', device, 'Windows')
  const macCmd = buildAudioPlatformCommand('switch', device, 'macOS')

  const markdown = `
# ${device.name}

${device.isDefault ? `> **当前正作为系统默认${device.type === 'output' ? '输出 (播放)' : '输入 (录音)'}设备**\n` : ''}

---

### 硬件规格与实时状态
- **设备类型**: \`${device.type === 'output' ? '音频输出 (Output)' : '音频输入 (Input)'}\`
- **连接总线 (Transport)**: \`${String(device.transportType).toUpperCase()}\`
- **当前音量**: \`${device.isMuted ? '已静音' : `${device.volume}%`}\`
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
`

  return (
    <Detail
      navigationTitle={`音频设备: ${device.name}`}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="设备名称" text={device.name} icon={Icon.SpeakerOn} />
          <Detail.Metadata.TagList title="默认状态">
            <Detail.Metadata.TagList.Item
              text={device.isDefault ? '当前默认' : '待命'}
            />
          </Detail.Metadata.TagList>
          <Detail.Metadata.Label
            title="当前音量"
            text={device.isMuted ? '已静音 (Muted)' : `${device.volume}%`}
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
            title={`设为默认${device.type === 'output' ? '输出' : '输入'}设备`}
            icon={Icon.Checkmark}
            onAction={async () => {
              const res = await defaultAudioDeviceManager.setDefaultDevice(device.id)
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.success ? `已切换默认设备为: ${device.name}` : res.error || '切换失败'
              )
              onUpdated?.()
            }}
          />
          <Action
            title={device.isMuted ? '取消静音 (Unmute)' : '静音设备 (Mute)'}
            icon={device.isMuted ? Icon.SpeakerOn : Icon.SpeakerOff}
            onAction={async () => {
              const res = await defaultAudioDeviceManager.toggleDeviceMute(device.id)
              await showToast(
                Toast.Style.Success,
                `${res.device?.isMuted ? '已静音' : '已恢复声音'}: ${device.name}`
              )
              onUpdated?.()
            }}
          />
          <Action
            title="复制硬件端点 UID"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(device.uid)
              await showToast(Toast.Style.Success, '已复制硬件 UID')
            }}
          />
        </ActionPanel>
      }
    />
  )
}

export function AudioVolumeForm({
  device,
  onSaved
}: {
  device: AudioDevice
  onSaved?: () => void
}) {
  const { pop } = useNavigation()

  return (
    <Form
      navigationTitle={`设置音量: ${device.name}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="应用音量设置"
            icon={Icon.Checkmark}
            onSubmit={async (values: Record<string, unknown>) => {
              const vol = Number(values.volume)
              const res = await defaultAudioDeviceManager.setDeviceVolume(device.id, vol)
              if (!res.success) {
                await showToast(Toast.Style.Failure, res.error || '音量设置无效')
                return
              }
              await showToast(Toast.Style.Success, `${device.name} 音量已设为 ${res.device?.volume}%`)
              onSaved?.()
              pop()
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
  )
}

export function AudioDeviceCommand(props?: {
  featureCode?: string
  hostOverride?: unknown
}) {
  const [searchText, setSearchText] = useState('')
  const [ioFilter, setIoFilter] = useState<IOType | 'all' | 'favourites'>(() =>
    props?.featureCode === 'audio-input' ? 'input' : 'all'
  )
  const [version, setVersion] = useState(0)
  const [isLoading, setIsLoading] = useState(() => Boolean(props?.hostOverride) || isRealElectronHost())
  const refresh = () => setVersion((v) => v + 1)

  useEffect(() => {
    if (props?.featureCode === 'audio-input') {
      setIoFilter('input')
    }
  }, [props?.featureCode])

  useEffect(() => {
    let active = true
    setIsLoading(true)
    void defaultAudioDeviceManager
      .syncDevicesFromHost(props?.hostOverride)
      .then(async () => {
        if (!active) return
        if (props?.featureCode === 'audio-mute-toggle') {
          const defOut = defaultAudioDeviceManager.getDefaultOutputDevice()
          if (defOut) {
            await defaultAudioDeviceManager.toggleDeviceMute(defOut.id, undefined, props?.hostOverride)
          }
        }
        setIsLoading(false)
        refresh()
      })
      .catch(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [props?.featureCode, props?.hostOverride])

  const devices = useMemo(
    () =>
      defaultAudioDeviceManager.filterDevices({
        ioType: ioFilter,
        query: searchText
      }),
    [ioFilter, searchText, version]
  )

  const outputDevices = devices.filter((d) => d.type === 'output')
  const inputDevices = devices.filter((d) => d.type === 'input')
  const combos = useMemo(() => defaultAudioDeviceManager.getCombos(), [version])
  const defaultOut = outputDevices.find((d) => d.isDefault) || outputDevices[0]
  const defaultIn = inputDevices.find((d) => d.isDefault) || inputDevices[0]

  const renderDeviceItem = (dev: AudioDevice) => (
    <List.Item
      key={dev.id}
      id={dev.id}
      icon={
        dev.isMuted
          ? Icon.SpeakerOff
          : dev.type === 'output'
            ? Icon.SpeakerHigh
            : Icon.Microphone
      }
      title={dev.name}
      subtitle={`${String(dev.transportType).toUpperCase()} · ${dev.isMuted ? '已静音' : `音量 ${dev.volume}%`}`}
      accessories={[
        ...(dev.isFavourite ? [{ icon: Icon.Star }] : []),
        dev.isDefault ? { tag: '当前默认' } : { text: '待命' }
      ]}
      actions={
        <ActionPanel>
          <Action
            title={`设为默认${dev.type === 'output' ? '输出 (播放)' : '输入 (麦克风)'}设备`}
            icon={Icon.Checkmark}
            onAction={async () => {
              const res = await defaultAudioDeviceManager.setDefaultDevice(dev.id, props?.hostOverride)
              await showToast(
                res.success ? Toast.Style.Success : Toast.Style.Failure,
                res.success ? `已切换至: ${dev.name}` : res.error || '切换失败'
              )
              refresh()
            }}
          />
          <Action
            title={dev.isMuted ? '取消静音 (Unmute)' : '一键静音 (Mute)'}
            icon={dev.isMuted ? Icon.SpeakerOn : Icon.SpeakerOff}
            shortcut={{ modifiers: ['ctrl'], key: 'm' }}
            onAction={async () => {
              const res = await defaultAudioDeviceManager.toggleDeviceMute(
                dev.id,
                undefined,
                props?.hostOverride
              )
              await showToast(
                Toast.Style.Success,
                `${res.device?.isMuted ? '已静音' : '已取消静音'}: ${dev.name}`
              )
              refresh()
            }}
          />
          <Action.Push
            title="精确设置音量百分比..."
            icon={Icon.SpeakerHigh}
            shortcut={{ modifiers: ['ctrl'], key: 'l' }}
            target={<AudioVolumeForm device={dev} onSaved={refresh} />}
          />
          <Action
            title="音量 +10%"
            icon={Icon.Plus}
            shortcut={{ modifiers: ['ctrl'], key: 'arrowup' }}
            onAction={async () => {
              const res = defaultAudioDeviceManager.stepDeviceVolume(dev.id, 10, props?.hostOverride)
              await showToast(Toast.Style.Success, `音量: ${res.device?.volume}%`)
              refresh()
            }}
          />
          <Action
            title="音量 -10%"
            icon={Icon.Minus}
            shortcut={{ modifiers: ['ctrl'], key: 'arrowdown' }}
            onAction={async () => {
              const res = defaultAudioDeviceManager.stepDeviceVolume(dev.id, -10, props?.hostOverride)
              await showToast(Toast.Style.Success, `音量: ${res.device?.volume}%`)
              refresh()
            }}
          />
          {([25, 50, 75, 100] as const).map((presetVol) => (
            <Action
              key={`vol-${presetVol}`}
              title={`快速设置音量为 ${presetVol}%`}
              icon={Icon.SpeakerHigh}
              onAction={async () => {
                const res = await defaultAudioDeviceManager.setDeviceVolume(
                  dev.id,
                  presetVol,
                  props?.hostOverride
                )
                await showToast(
                  res.success ? Toast.Style.Success : Toast.Style.Failure,
                  res.success ? `${dev.name} 音量已设为 ${presetVol}%` : res.error || '设置失败'
                )
                refresh()
              }}
            />
          ))}
          <Action
            title={dev.isFavourite ? '取消常用收藏' : '设为常用收藏'}
            icon={dev.isFavourite ? Icon.StarDisabled : Icon.Star}
            shortcut={{ modifiers: ['ctrl'], key: 'f' }}
            onAction={async () => {
              defaultAudioDeviceManager.toggleFavourite(dev.id)
              refresh()
            }}
          />
          <Action
            title="重新扫描音频设备 (Refresh Devices)"
            icon={Icon.Repeat}
            shortcut={{ modifiers: ['ctrl'], key: 'r' }}
            onAction={async () => {
              const list = await defaultAudioDeviceManager.syncDevicesFromHost(props?.hostOverride)
              refresh()
              await showToast(Toast.Style.Success, `已刷新音频设备 (${list.length} 个)`)
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
  )

  return (
    <List
      isLoading={isLoading}
      navigationTitle="音频设备切换"
      searchBarPlaceholder="搜索耳机、显示器音响、扬声器或麦克风..."
      onSearchTextChange={setSearchText}
      filterBar={{
        summaryText: `默认输出: ${defaultOut ? `${defaultOut.name} (${defaultOut.isMuted ? '静音' : `${defaultOut.volume}%`})` : '无'} | 默认输入: ${defaultIn ? defaultIn.name : '无'}`,
        actions: [
          {
            id: 'mute-default-out',
            title: defaultOut?.isMuted ? '取消输出静音' : '静音当前输出',
            style: 'primary',
            onAction: async () => {
              if (!defaultOut) return
              await defaultAudioDeviceManager.toggleDeviceMute(
                defaultOut.id,
                undefined,
                props?.hostOverride
              )
              refresh()
            }
          },
          {
            id: 'refresh-audio',
            title: '刷新声卡',
            style: 'secondary',
            onAction: async () => {
              const list = await defaultAudioDeviceManager.syncDevicesFromHost(props?.hostOverride)
              refresh()
              await showToast(Toast.Style.Success, `已刷新音频设备 (${list.length} 个)`)
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按输入/输出类型筛选"
          value={ioFilter}
          onChange={(val) => setIoFilter(val as IOType | 'all' | 'favourites')}
        >
          <List.Dropdown.Item title="全部音频设备 (All)" value="all" />
          <List.Dropdown.Item title="仅输出播放设备 (Output)" value="output" />
          <List.Dropdown.Item title="仅输入录音设备 (Input)" value="input" />
          <List.Dropdown.Item title="常用收藏设备 (Favourites)" value="favourites" />
        </List.Dropdown>
      }
    >
      {devices.length === 0 ? (
        <List.Section title="检测结果">
          <List.Item
            id="empty-audio"
            icon={Icon.SpeakerOff}
            title="未检测到匹配的音频设备"
            subtitle="请确认耳机、扬声器或麦克风已连接，或按 Ctrl+R 重新扫描声卡"
          />
        </List.Section>
      ) : (
        <>
          {ioFilter === 'all' && searchText.trim() === '' && (
            <List.Section title="快捷场景组合 (Audio Combos)" subtitle={`${combos.length} 个预设`}>
              {combos.map((combo) => (
                <List.Item
                  key={combo.id}
                  id={combo.id}
                  icon={Icon.SpeakerHigh}
                  title={combo.name}
                  subtitle={combo.description}
                  accessories={[{ tag: combo.shortcut || 'Combo' }]}
                  actions={
                    <ActionPanel>
                      <Action
                        title={`激活场景: ${combo.name}`}
                        icon={Icon.Bolt}
                        onAction={async () => {
                          const res = defaultAudioDeviceManager.applyComboPreset(
                            combo.id,
                            props?.hostOverride
                          )
                          await showToast(
                            res.success ? Toast.Style.Success : Toast.Style.Failure,
                            res.success ? `已应用组合: ${combo.name}` : res.error || '应用失败'
                          )
                          refresh()
                        }}
                      />
                    </ActionPanel>
                  }
                />
              ))}
            </List.Section>
          )}

          {outputDevices.length > 0 && (
            <List.Section title="输出播放设备 (Output)" subtitle={`${outputDevices.length} 个设备`}>
              {outputDevices.map(renderDeviceItem)}
            </List.Section>
          )}

          {inputDevices.length > 0 && (
            <List.Section title="输入录音设备 (Input / Mic)" subtitle={`${inputDevices.length} 个设备`}>
              {inputDevices.map(renderDeviceItem)}
            </List.Section>
          )}
        </>
      )}
    </List>
  )
}

export default AudioDeviceCommand
