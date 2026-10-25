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
import { HIGH_CONFLICT_HOTKEY_PRESETS } from './cheatsheet-data.js'
import {
  filterCheatsheetItems,
  killHotkeySuspectProcess,
  parseAndNormalizeHotkeyCombo,
  probeGlobalHotkeys
} from './hotkey-service.js'
import type { HotkeyModeFilter, HotkeyProbeResultItem } from './types.js'

export * from './types.js'
export * from './cheatsheet-data.js'
export * from './hotkey-service.js'

export interface HotkeyRadarCommandProps {
  featureCode?: string
  hostOverride?: unknown
}

export function HotkeyRadarCommand(props: HotkeyRadarCommandProps = {}) {
  const initialMode: HotkeyModeFilter =
    props.featureCode === 'hotkey-cheatsheet' ? 'sheet:all' : 'conflict'
  const [modeFilter, setModeFilter] = useState<HotkeyModeFilter>(initialMode)
  const [searchText, setSearchText] = useState<string>('')
  const [probedKeys, setProbedKeys] = useState<HotkeyProbeResultItem[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)

  const reloadConflictScan = async (customCombo?: string) => {
    setIsLoading(true)
    try {
      const results = await probeGlobalHotkeys(
        HIGH_CONFLICT_HOTKEY_PRESETS,
        customCombo,
        props.hostOverride
      )
      setProbedKeys(results)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void reloadConflictScan()
  }, [])

  const parsedCustomCombo = useMemo(() => {
    if (!searchText.includes('+')) return null
    return parseAndNormalizeHotkeyCombo(searchText)
  }, [searchText])

  const filteredConflictItems = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    const normalizedSearch = parsedCustomCombo?.valid
      ? parsedCustomCombo.normalized.toLowerCase()
      : q

    return probedKeys.filter((item) => {
      if (modeFilter === 'conflict:occupied' && !item.isOccupied) {
        return false
      }
      if (!normalizedSearch) return true
      return `${item.keyCombo} ${item.title} ${item.subtitle} ${item.suspectApp ?? ''}`
        .toLowerCase()
        .includes(normalizedSearch)
    })
  }, [probedKeys, modeFilter, searchText, parsedCustomCombo])

  const filteredSheetItems = useMemo(() => {
    if (!modeFilter.startsWith('sheet:')) return []
    return filterCheatsheetItems(modeFilter, searchText)
  }, [modeFilter, searchText])

  const occupiedCount = useMemo(
    () => probedKeys.filter((k) => k.isOccupied).length,
    [probedKeys]
  )

  const handleProbeSingleKey = async (combo: string) => {
    const parsed = parseAndNormalizeHotkeyCombo(combo)
    if (!parsed.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: parsed.error || '快捷键格式无效'
      })
      return
    }
    await reloadConflictScan(parsed.normalized)
    await showToast({
      style: Toast.Style.Success,
      title: `已完成组合键 ${parsed.normalized} 实时占用探测`
    })
  }

  const handleKillSuspectProcess = async (item: HotkeyProbeResultItem) => {
    const res = await killHotkeySuspectProcess(item, props.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: res.error || '结束嫌疑占用进程失败'
      })
      return
    }
    await showToast({
      style: Toast.Style.Success,
      title: `已结束占用热键 ${item.keyCombo} 的嫌疑进程 (${item.suspectApp})`
    })
    await reloadConflictScan()
  }

  const isConflictMode = modeFilter.startsWith('conflict')
  const summaryText = isConflictMode
    ? `已检测 ${probedKeys.length} 组高频全局热键 · 发现 ${occupiedCount} 组已被后台程序抢占`
    : `快捷键速查库 · 当前匹配 ${filteredSheetItems.length} 条高频生产力快捷键`

  return (
    <List
      navigationTitle="热键冲突侦测与快捷键速查"
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="输入要测试的组合键（如 Ctrl+Alt+A）或搜索功能名（如 冻结窗格、分屏）..."
      searchBarAccessory={
        <List.Dropdown
          value={modeFilter}
          onChange={(val) => setModeFilter(val as HotkeyModeFilter)}
          tooltip="切换冲突侦测或快捷键速查"
        >
          <List.Dropdown.Section title="热键冲突排查">
            <List.Dropdown.Item
              title="全局热键冲突侦测雷达"
              value="conflict"
              icon={Icon.Terminal}
            />
            <List.Dropdown.Item
              title="仅看当前已被占用的冲突热键"
              value="conflict:occupied"
              icon={Icon.ExclamationMark}
            />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="高频快捷键速查字典">
            <List.Dropdown.Item title="全部高频快捷键速查" value="sheet:all" icon={Icon.Document} />
            <List.Dropdown.Item
              title="Windows / macOS 系统级"
              value="sheet:os"
              icon={Icon.Desktop}
            />
            <List.Dropdown.Item
              title="VS Code 极客开发"
              value="sheet:vscode"
              icon={Icon.Code}
            />
            <List.Dropdown.Item
              title="Excel 职场办公"
              value="sheet:excel"
              icon={Icon.Document}
            />
            <List.Dropdown.Item
              title="Photoshop 设计"
              value="sheet:ps"
              icon={Icon.Image}
            />
            <List.Dropdown.Item
              title="Chrome / Edge 浏览器"
              value="sheet:browser"
              icon={Icon.Globe}
            />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
      filterBar={{
        summaryText,
        actions: [
          {
            id: 'rescan',
            title: '重新扫描占用',
            onAction: () => {
              void reloadConflictScan(parsedCustomCombo?.valid ? parsedCustomCombo.normalized : undefined)
            }
          },
          {
            id: 'switch-sheet',
            title: isConflictMode ? '切至快捷键速查库' : '切至热键冲突雷达',
            onAction: () => {
              setModeFilter(isConflictMode ? 'sheet:all' : 'conflict')
            }
          }
        ]
      }}
    >
      {isConflictMode ? (
        <List.Section
          title="全局热键实时冲突探测结果"
          subtitle="非侵入式瞬间探测并立即释放锁，已被占用的冲突热键置顶标红"
        >
          {parsedCustomCombo && parsedCustomCombo.valid && (
            <List.Item
              id={`probe-custom-${parsedCustomCombo.normalized}`}
              title={`立即实时探测组合键: ${parsedCustomCombo.normalized}`}
              subtitle="按 Enter 调用系统 RegisterHotKey 探测该组合键是否空闲"
              icon={Icon.Terminal}
              accessories={[{ tag: '实时探测' }]}
              actions={
                <ActionPanel>
                  <Action
                    title={`探测 ${parsedCustomCombo.normalized} 占用状态`}
                    icon={Icon.ArrowClockwise}
                    onAction={() => handleProbeSingleKey(parsedCustomCombo.normalized)}
                  />
                  <Action.CopyToClipboard
                    title="复制快捷键组合"
                    content={parsedCustomCombo.normalized}
                  />
                </ActionPanel>
              }
            />
          )}
          {filteredConflictItems.map((item) => (
            <List.Item
              key={item.id}
              id={item.id}
              title={`${item.keyCombo}  —  ${item.title}`}
              subtitle={item.subtitle}
              icon={item.isOccupied ? Icon.ExclamationMark : Icon.Terminal}
              accessories={[
                item.isOccupied
                  ? {
                      tag: {
                        value: `已被占用 (${item.suspectApp || '后台进程'})`,
                        color: Color.Red
                      }
                    }
                  : { tag: item.categoryLabel },
                { text: item.statusText }
              ]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制快捷键组合" content={item.keyCombo} />
                  {item.isOccupied && item.suspectPid && !item.isSystemReserved && (
                    <Action
                      title={`结束嫌疑占用进程 (${item.suspectApp})`}
                      icon={Icon.XMarkCircle}
                      style={Action.Style.Destructive}
                      onAction={() => handleKillSuspectProcess(item)}
                    />
                  )}
                  <Action
                    title="重新测试此组合键状态"
                    icon={Icon.ArrowClockwise}
                    onAction={() => handleProbeSingleKey(item.keyCombo)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : (
        <List.Section
          title="五大常用软件高频快捷键离线速查字典"
          subtitle={`匹配 ${filteredSheetItems.length} 条生产力快捷键`}
        >
          {filteredSheetItems.map((sheet) => (
            <List.Item
              key={sheet.id}
              id={sheet.id}
              title={`${sheet.keyCombo}  —  ${sheet.title}`}
              subtitle={sheet.subtitle}
              icon={Icon.Terminal}
              accessories={[
                { tag: sheet.categoryLabel },
                sheet.macKeyCombo ? { text: `macOS: ${sheet.macKeyCombo}` } : { text: '通用热键' }
              ]}
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制快捷键组合" content={sheet.keyCombo} />
                  <Action
                    title="探测此快捷键是否被后台软件抢占"
                    icon={Icon.ExclamationMark}
                    onAction={() => {
                      setModeFilter('conflict')
                      void handleProbeSingleKey(sheet.keyCombo)
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  )
}

export default HotkeyRadarCommand
