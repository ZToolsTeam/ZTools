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
  BRIGHTNESS_PRESETS,
  filterMonitorDisplays,
  listMonitorDisplays,
  setMonitorBrightness,
  syncAllMonitorsBrightness,
  triggerSleepAllMonitors
} from './monitor-service.js'
import type {
  MonitorDisplayInfo,
  MonitorFilterValue
} from './types.js'

export * from './types.js'
export * from './monitor-service.js'

export function MonitorControlCommand(props?: {
  featureCode?: string
  hostOverride?: unknown
}) {
  const [displays, setDisplays] = useState<MonitorDisplayInfo[]>([])
  const [filterValue, setFilterValue] = useState<MonitorFilterValue>('all')
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const reloadDisplays = async () => {
    setIsLoading(true)
    try {
      const res = await listMonitorDisplays(props?.hostOverride)
      if (!res.ok) {
        await showToast({
          style: Toast.Style.Failure,
          title: '扫描显示器失败',
          message: res.error || '无法读取系统显示器列表'
        })
        return
      }
      setDisplays(res.displays)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let seq = 0

    const init = async () => {
      const mySeq = ++seq
      setIsLoading(true)
      try {
        if (props?.featureCode === 'monitor-sleep') {
          const sleepRes = await triggerSleepAllMonitors(props?.hostOverride)
          if (sleepRes.ok) {
            await showToast({
              style: Toast.Style.Success,
              title: '已发送全屏熄屏信号',
              message: '显示器背光已关闭，移动鼠标或按任意键即可唤醒'
            })
          }
        }
        const res = await listMonitorDisplays(props?.hostOverride)
        if (cancelled || mySeq !== seq) return
        if (res.ok) {
          setDisplays(res.displays)
        }
      } finally {
        if (!cancelled && mySeq === seq) {
          setIsLoading(false)
        }
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [props?.featureCode, props?.hostOverride])

  const supportedCount = useMemo(
    () => displays.filter((d) => d.supportsBrightness).length,
    [displays]
  )

  const filteredDisplays = useMemo(
    () => filterMonitorDisplays(displays, filterValue, searchText),
    [displays, filterValue, searchText]
  )

  const handleAdjustBrightness = async (display: MonitorDisplayInfo, targetBrightness: number) => {
    const res = await setMonitorBrightness(
      display,
      targetBrightness,
      displays,
      props?.hostOverride
    )
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title:
          res.errorCode === 'DDC_UNSUPPORTED'
            ? '该显示器不支持 DDC/CI 硬件调光'
            : '调节亮度失败',
        message: res.error || '请检查显示器 OSD 菜单中 DDC/CI 开关是否已开启'
      })
      return
    }
    if (res.updatedDisplays) {
      setDisplays(res.updatedDisplays)
    }
    await showToast({
      style: Toast.Style.Success,
      title: `${display.name} 亮度已设为 ${res.brightness}%`,
      message: display.protocolLabel
    })
  }

  const handleSyncAll = async (targetBrightness: number) => {
    const res = await syncAllMonitorsBrightness(
      targetBrightness,
      displays,
      props?.hostOverride
    )
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '多屏亮度同步失败',
        message: res.error || '当前无支持硬件调光的显示器'
      })
      return
    }
    if (res.updatedDisplays) {
      setDisplays(res.updatedDisplays)
    }
    await showToast({
      style: Toast.Style.Success,
      title: `已将全部受支持显示器同步设为 ${res.brightness}% 亮度`,
      message: `共更新 ${supportedCount} 台显示器`
    })
  }

  const handleSleepAll = async () => {
    const res = await triggerSleepAllMonitors(props?.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '关闭屏幕电源失败',
        message: res.error || '无法发送 SC_MONITORPOWER 指令'
      })
      return
    }
    await showToast({
      style: Toast.Style.Success,
      title: '已关闭所有显示器电源',
      message: '后台任务继续运行，移动鼠标或按键即可亮屏'
    })
  }

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="搜索显示器名称、分辨率或控制协议..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选显示器类型"
          value={filterValue}
          onChange={(val) => setFilterValue(val as MonitorFilterValue)}
        >
          <List.Dropdown.Item title="全部显示器" value="all" />
          <List.Dropdown.Item title="外接 DDC/CI 显示器" value="ddcci" />
          <List.Dropdown.Item title="内置笔记本屏幕" value="internal" />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `已连接 ${displays.length} 台显示器（${supportedCount} 台支持硬件调光）`,
        actions: [
          {
            id: 'sleep-all',
            title: '立即熄屏省电',
            style: 'primary',
            onAction: () => {
              void handleSleepAll()
            }
          },
          {
            id: 'sync-50',
            title: '全屏统一 50% 亮度',
            style: 'secondary',
            onAction: () => {
              void handleSyncAll(50)
            }
          }
        ]
      }}
    >
      {filteredDisplays.length === 0 ? (
        <List.Section title="检测结果">
          <List.Item
            id="empty-displays"
            icon={Icon.Monitor}
            title="未检测到匹配的显示器"
            subtitle="请确认外接显示器线材已连接，或切换右上角筛选类型重试"
            actions={
              <ActionPanel>
                <Action
                  title="重新扫描连接的显示器"
                  icon={Icon.ArrowClockwise}
                  onAction={() => {
                    void reloadDisplays()
                  }}
                />
                <Action
                  title="立即关闭所有屏幕电源（熄屏）"
                  icon={Icon.Power}
                  style={Action.Style.Destructive}
                  onAction={() => {
                    void handleSleepAll()
                  }}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        <List.Section title="显示器列表" subtitle={`${filteredDisplays.length} 台设备`}>
          {filteredDisplays.map((display) => {
            const currentBri = display.brightness ?? 50
            return (
              <List.Item
                key={display.id}
                id={display.id}
                title={display.name}
                subtitle={`${display.resolution} · ${display.isPrimary ? '主显示器' : '扩展屏'}`}
                icon={Icon.Monitor}
                accessories={[
                  display.supportsBrightness
                    ? { tag: display.protocolLabel }
                    : { tag: { value: '不支持 DDC/CI', color: Color.Red } },
                  {
                    text:
                      display.brightness !== null
                        ? `亮度 ${display.brightness}%`
                        : '仅支持系统熄屏'
                  }
                ]}
                actions={
                  <ActionPanel>
                    <Action
                      title="亮度 +10%"
                      icon={Icon.Plus}
                      onAction={() => {
                        void handleAdjustBrightness(display, currentBri + 10)
                      }}
                    />
                    <Action
                      title="亮度 -10%"
                      icon={Icon.Minus}
                      shortcut={{ modifiers: ['ctrl'], key: 'enter' }}
                      onAction={() => {
                        void handleAdjustBrightness(display, currentBri - 10)
                      }}
                    />
                    {BRIGHTNESS_PRESETS.map((preset) => (
                      <Action
                        key={preset.id}
                        title={preset.label}
                        icon={Icon.Monitor}
                        shortcut={{ modifiers: ['ctrl'], key: preset.shortcutKey }}
                        onAction={() => {
                          void handleAdjustBrightness(display, preset.value)
                        }}
                      />
                    ))}
                    <Action
                      title={`所有显示器同步设为 ${currentBri}% 亮度`}
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['ctrl', 'shift'], key: 's' }}
                      onAction={() => {
                        void handleSyncAll(currentBri)
                      }}
                    />
                    <Action
                      title="立即关闭所有屏幕电源（熄屏）"
                      icon={Icon.Power}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ['ctrl', 'shift'], key: 'l' }}
                      onAction={() => {
                        void handleSleepAll()
                      }}
                    />
                    <Action
                      title="重新扫描连接的显示器"
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['ctrl'], key: 'r' }}
                      onAction={() => {
                        void reloadDisplays()
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

export default MonitorControlCommand
