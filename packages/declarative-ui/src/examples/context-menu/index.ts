import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast
} from '../../index.js'
import {
  type ContextMenuEntry,
  type ContextMenuFilterMode,
  DEFAULT_CONTEXT_MENU_ENTRIES,
  fetchContextMenuEntries,
  toggleContextMenuEntry,
  switchWin11ClassicMenu,
  filterContextMenuEntries
} from './logic.js'

export * from './logic.js'

export function ContextMenuCommand() {
  const [searchText, setSearchText] = useState('')
  const [filterMode, setFilterMode] = useState<ContextMenuFilterMode>('all')
  const [entries, setEntries] = useState<ContextMenuEntry[]>(DEFAULT_CONTEXT_MENU_ENTRIES)
  const [win11Classic, setWin11Classic] = useState(true)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshEntries(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await fetchContextMenuEntries()
      setEntries(snap.entries)
      setWin11Classic(snap.win11ClassicEnabled)
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: '注册表右键菜单已同步',
          message: `已启用 ${snap.enabledCount} 项 · 已禁用 ${snap.disabledCount} 项`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshEntries(false)
  }, [])

  async function handleToggleEntry(item: ContextMenuEntry) {
    const nextState = !item.enabled
    const res = await toggleContextMenuEntry(item.id, nextState, undefined, item.registryKey)
    if (res.ok) {
      setEntries((prev) =>
        prev.map((cur) => (cur.id === item.id ? { ...cur, enabled: nextState } : cur))
      )
      if (item.isWin11ClassicToggle) {
        setWin11Classic(nextState)
      }
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: item.registryKey
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '修改注册表右键菜单失败',
        message: res.message
      })
    }
  }

  async function handleToggleWin11Classic() {
    const next = !win11Classic
    const res = await switchWin11ClassicMenu(next)
    if (res.ok) {
      setWin11Classic(next)
      setEntries((prev) =>
        prev.map((cur) => (cur.isWin11ClassicToggle ? { ...cur, enabled: next } : cur))
      )
      showToast({
        style: Toast.Style.Success,
        title: res.message
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '切换 Windows 11 右键模式失败',
        message: res.message
      })
    }
  }

  const filtered = filterContextMenuEntries(entries, searchText, filterMode)
  const enabledCount = entries.filter((e) => e.enabled).length
  const disabledCount = entries.length - enabledCount

  return List({
    navigationTitle: '系统右键菜单管理',
    searchBarPlaceholder: '搜索右键菜单名称、厂商、注册表路径 (如 VS Code, Git Bash, 7-Zip, 百度网盘, Win11 经典菜单)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '按挂载点筛选右键菜单',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as ContextMenuFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部挂载点 (All Context Menus)', value: 'all' }),
        List.Dropdown.Item({ title: '文件右键 (HKCR\\*\\shell)', value: 'file' }),
        List.Dropdown.Item({ title: '目录右键 (Directory\\shell)', value: 'directory' }),
        List.Dropdown.Item({ title: '桌面背景 (DesktopBackground\\Shell)', value: 'background' }),
        List.Dropdown.Item({ title: '已禁用项 (Disabled Entries)', value: 'disabled' })
      ]
    }),
    filterBar: {
      summaryText: `系统右键扩展共 ${entries.length} 项 · 已启用 ${enabledCount} 项 / 已禁用 ${disabledCount} 项 · Win11 菜单: ${win11Classic ? '经典完整模式' : '默认折叠模式'}`,
      actions: [
        {
          id: 'rescan-reg',
          label: '重新扫描注册表',
          title: '重新扫描注册表',
          style: 'secondary',
          onAction: () => void refreshEntries(true)
        },
        {
          id: 'toggle-win11-mode',
          label: win11Classic ? '恢复Win11默认菜单' : '切换Win11经典菜单',
          title: win11Classic ? '恢复Win11默认菜单' : '切换Win11经典菜单',
          style: 'secondary',
          onAction: () => void handleToggleWin11Classic()
        }
      ]
    },
    children: [
      List.Section({
        title: `系统右键菜单扩展项 (${filtered.length})`,
        children: filtered.map((item) =>
          List.Item({
            id: item.id,
            title: item.title,
            subtitle: `${item.publisher} · ${item.registryKey} · ${item.command}`,
            icon: item.isWin11ClassicToggle ? Icon.Gear : item.enabled ? Icon.Checkmark : Icon.XMarkCircle,
            accessories: [
              { tag: { value: item.scopeLabel } },
              { text: item.enabled ? '已启用' : '已禁用' }
            ],
            actions: ActionPanel({
              title: item.title,
              children: [
                Action({
                  title: item.enabled ? '禁用该右键菜单项' : '启用该右键菜单项',
                  icon: item.enabled ? Icon.XMarkCircle : Icon.Checkmark,
                  onAction: () => handleToggleEntry(item)
                }),
                Action({
                  title: '复制注册表项路径 (Registry Key)',
                  icon: Icon.Clipboard,
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: async () => {
                    await Clipboard.copy(item.registryKey)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制注册表路径',
                      message: item.registryKey
                    })
                  }
                }),
                Action({
                  title: '复制关联执行命令 (Command)',
                  icon: Icon.Code,
                  shortcut: { modifiers: ['ctrl'], key: 'c' },
                  onAction: async () => {
                    await Clipboard.copy(item.command)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制执行命令',
                      message: item.command
                    })
                  }
                }),
                Action({
                  title: '重新扫描注册表',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshEntries(true)
                })
              ]
            })
          })
        )
      })
    ]
  })
}

export default ContextMenuCommand
