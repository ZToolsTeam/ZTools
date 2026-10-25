import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import {
  copyStartupCommandToClipboard,
  filterStartupItems,
  removeBrokenStartupItems,
  resolveInitialStartupFilter,
  revealStartupExeInFolder,
  scanStartupItems,
  setStartupItemEnabled
} from './startup-service.js'
import type {
  StartupEntryItem,
  StartupSourceFilter
} from './types.js'

function renderStartupItemActions(params: {
  item: StartupEntryItem
  onToggle: (item: StartupEntryItem) => void
  onRevealExe: (exePath: string) => void
  onCopyCommand: (command: string) => void
  onRemoveBroken: (item: StartupEntryItem) => void
  onRescan: () => void
}) {
  const { item, onToggle, onRevealExe, onCopyCommand, onRemoveBroken, onRescan } = params
  return (
    <ActionPanel>
      <Action
        title={item.enabled ? '禁用此开机自启项' : '启用此开机自启项'}
        icon={item.enabled ? Icon.XMarkCircle : Icon.CheckCircle}
        onAction={() => {
          onToggle(item)
        }}
      />
      {item.exePath && (
        <Action
          title="在资源管理器中定位程序"
          icon={Icon.Folder}
          onAction={() => {
            onRevealExe(item.exePath)
          }}
        />
      )}
      <Action
        title="复制启动命令行"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ['ctrl'], key: 'c' }}
        onAction={() => {
          onCopyCommand(item.command)
        }}
      />
      {item.fileMissing && (
        <Action
          title="彻底移除此无效残留项"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
          onAction={() => {
            onRemoveBroken(item)
          }}
        />
      )}
      <Action
        title="重新扫描全部启动项"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ['ctrl'], key: 'r' }}
        onAction={onRescan}
      />
    </ActionPanel>
  )
}

export default function StartupManagerCommand(props?: {
  featureCode?: string
  hostOverride?: unknown
}) {
  const [items, setItems] = useState<StartupEntryItem[]>([])
  const [sourceFilter, setSourceFilter] = useState<StartupSourceFilter>(
    resolveInitialStartupFilter(props?.featureCode)
  )
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const reloadItems = async () => {
    setIsLoading(true)
    try {
      const res = await scanStartupItems(props?.hostOverride)
      if (!res.ok) {
        await showToast({
          style: Toast.Style.Failure,
          title: '扫描启动项失败',
          message: res.error || '请检查系统服务与注册表访问权限'
        })
        return
      }
      setItems(res.items)
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
        const res = await scanStartupItems(props?.hostOverride)
        if (cancelled || mySeq !== seq) return
        if (res.ok) {
          setItems(res.items)
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
  }, [props?.hostOverride])

  useEffect(() => {
    if (props?.featureCode) {
      setSourceFilter(resolveInitialStartupFilter(props.featureCode))
    }
  }, [props?.featureCode])

  const enabledCount = useMemo(() => items.filter((i) => i.enabled).length, [items])
  const serviceCount = useMemo(() => items.filter((i) => i.source === 'service').length, [items])
  const brokenCount = useMemo(() => items.filter((i) => i.fileMissing).length, [items])

  const filteredItems = useMemo(
    () => filterStartupItems(items, sourceFilter, searchText),
    [items, sourceFilter, searchText]
  )

  const handleToggleItem = async (item: StartupEntryItem) => {
    const targetEnabled = !item.enabled
    const res = await setStartupItemEnabled(
      item,
      targetEnabled,
      items,
      props?.hostOverride
    )
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title:
          res.errorCode === 'ADMIN_REQUIRED'
            ? '需要管理员权限'
            : '修改开机自启状态失败',
        message: res.error || '当前启动项状态保持不变'
      })
      return
    }
    if (res.updatedItems) {
      setItems(res.updatedItems)
    }
    await showToast({
      style: Toast.Style.Success,
      title: targetEnabled
        ? `已恢复启用: ${item.name}`
        : `已禁用自启: ${item.name}`,
      message: `${item.sourceLabel} · ${targetEnabled ? '开机自动运行' : '已阻止后台自启'}`
    })
  }

  const handleRemoveSingleBroken = async (item: StartupEntryItem) => {
    if (!item.fileMissing) {
      await showToast({
        style: Toast.Style.Failure,
        title: '仅允许清理无效残留项',
        message: '正常启动项请使用「禁用」功能，以保证操作可逆'
      })
      return
    }
    const confirmed = await confirmAlert({
      title: `确认彻底清除无效残留启动项「${item.name}」？`,
      message: `目标可执行文件已丢失: ${item.exePath || item.command}`
    })
    if (!confirmed) return

    const res = await removeBrokenStartupItems([item], items, props?.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '清理无效残留项失败',
        message: res.error || '请尝试使用管理员权限重试'
      })
      return
    }
    if (res.remainingItems) {
      setItems(res.remainingItems)
    }
    await showToast({
      style: Toast.Style.Success,
      title: `已彻底移除残留项: ${item.name}`
    })
  }

  const handleCleanAllBroken = async () => {
    const brokenList = items.filter((i) => i.fileMissing)
    if (brokenList.length === 0) {
      await showToast({
        style: Toast.Style.Animated,
        title: '未发现无效残留启动项',
        message: '当前所有启动项指向的可执行文件均有效存在'
      })
      return
    }
    const confirmed = await confirmAlert({
      title: `确认一键清理 ${brokenList.length} 个无效残留启动项？`,
      message: '这些启动项指向的程序已被卸载或丢失，清理后可保持系统注册表与任务列表整洁。'
    })
    if (!confirmed) return

    const res = await removeBrokenStartupItems(brokenList, items, props?.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '批量清理残留启动项失败',
        message: res.error || '部分系统级条目需要管理员权限'
      })
      return
    }
    if (res.remainingItems) {
      setItems(res.remainingItems)
    }
    await showToast({
      style: Toast.Style.Success,
      title: `已清理 ${res.removedCount} 个无效残留启动项`
    })
  }

  return (
    <List
      navigationTitle="启动管理"
      isLoading={isLoading}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索自启软件名、服务名、可执行路径或厂商..."
      searchBarAccessory={
        <List.Dropdown
          value={sourceFilter}
          onChange={(val: string) => setSourceFilter(val as StartupSourceFilter)}
          tooltip="按自启位置或状态筛选"
        >
          <List.Dropdown.Item title="全部自启源" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="注册表与启动目录" value="app" icon={Icon.Window} />
          <List.Dropdown.Item title="第三方后台服务 (Services)" value="service" icon={Icon.Gear} />
          <List.Dropdown.Item title="第三方计划任务 (Tasks)" value="task" icon={Icon.Clock} />
          <List.Dropdown.Item title="仅看已启用项" value="enabled" icon={Icon.CheckCircle} />
          <List.Dropdown.Item title="残留无效启动项" value="broken" icon={Icon.ExclamationMark} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共发现 ${items.length} 个自启项（已启用 ${enabledCount} 项 · 第三方服务 ${serviceCount} 项 · 无效残留 ${brokenCount} 项）`,
        actions: [
          {
            id: 'rescan',
            title: '重新扫描',
            onAction: () => {
              void reloadItems()
            }
          },
          {
            id: 'clean-broken',
            title: '清理无效残留',
            style: 'destructive',
            onAction: () => {
              void handleCleanAllBroken()
            }
          }
        ]
      }}
    >
      {filteredItems.length === 0 ? (
        <List.Section title="扫描结果">
          <List.Item
            id="empty-startup"
            icon={Icon.CheckCircle}
            title="当前筛选条件下未发现开机自启项"
            subtitle="可切换右上角筛选分类，或按 Ctrl+R 重新穿透扫描"
            actions={
              <ActionPanel>
                <Action
                  title="重新扫描全部启动项"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['ctrl'], key: 'r' }}
                  onAction={() => {
                    void reloadItems()
                  }}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        <List.Section
          title="开机自启与后台驻留项"
          subtitle={`${filteredItems.length} 项`}
        >
          {filteredItems.map((item) => {
            const accessories = [
              ...(item.fileMissing ? [{ tag: { value: '文件已丢失', color: Color.Red } }] : []),
              { tag: item.sourceLabel },
              { text: item.enabled ? '已启用' : '已禁用' }
            ]
            return (
              <List.Item
                key={item.id}
                id={item.id}
                title={item.name}
                subtitle={`${item.publisher ? `[${item.publisher}] ` : ''}${item.command}`}
                icon={item.enabled ? Icon.CheckCircle : Icon.Circle}
                accessories={accessories}
                actions={renderStartupItemActions({
                  item,
                  onToggle: (entry) => {
                    void handleToggleItem(entry)
                  },
                  onRevealExe: (exePath) => {
                    void revealStartupExeInFolder(exePath, props?.hostOverride)
                  },
                  onCopyCommand: async (cmd) => {
                    await copyStartupCommandToClipboard(cmd, props?.hostOverride)
                    await showToast({
                      style: Toast.Style.Success,
                      title: '已复制启动命令行'
                    })
                  },
                  onRemoveBroken: (entry) => {
                    void handleRemoveSingleBroken(entry)
                  },
                  onRescan: () => {
                    void reloadItems()
                  }
                })}
              />
            )
          })}
        </List.Section>
      )}
    </List>
  )
}
