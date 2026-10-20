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
  type LanShareItem,
  type LanShareFilterMode,
  formatBytes,
  fetchLanShareSnapshot,
  toggleFileShare,
  openSharedFileLocation,
  filterLanShareItems
} from './logic.js'

export * from './logic.js'

function renderSharePreviewMarkdown(item: LanShareItem): string {
  const sizeLine =
    item.category === 'files'
      ? `- **文件体积**: \`${formatBytes(item.sizeBytes)}\`\n- **本地路径**: \`${item.filePath}\``
      : item.category === 'clipboard'
      ? `- **文本长度**: \`${item.sizeBytes} 字符\`\n- **同步内容**: \`${item.textPreview || item.subtitle}\``
      : `- **服务模式**: \`HTTP 零配置局域网双向快传\``

  return `# ${item.title}

![扫码直连下载](${item.qrCodeDataUri})

### 局域网直连访问地址
\`\`\`text
${item.shareUrl}
\`\`\`

---

### 传输状态与连接规格
- **共享状态**: \`${item.isShared ? '正在共享 (手机同一 Wi-Fi 扫码即下)' : '已暂停共享'}\`
- **累计下载次数**: \`${item.downloadCount} 次\`
${sizeLine}
`
}

export function LanShareCommand() {
  const [searchText, setSearchText] = useState('')
  const [filterMode, setFilterMode] = useState<LanShareFilterMode>('all')
  const [items, setItems] = useState<LanShareItem[]>([])
  const [portalUrl, setPortalUrl] = useState('http://127.0.0.1:18580')
  const [totalSharedBytes, setTotalSharedBytes] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshShareList(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await fetchLanShareSnapshot()
      setItems(snap.items)
      setPortalUrl(snap.portalUrl)
      setTotalSharedBytes(snap.totalSharedBytes)
      if (showNotice) {
        showToast({
          style: Toast.Style.Success,
          title: '局域网共享列表已刷新',
          message: `内网地址: ${snap.portalUrl} · 共 ${snap.sharedCount} 项就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void refreshShareList(false)
  }, [])

  async function handleToggleShare(item: LanShareItem) {
    const nextState = !item.isShared
    const res = await toggleFileShare(item.id, nextState)
    if (res.ok) {
      setItems((prev) =>
        prev.map((cur) =>
          cur.id === item.id ? { ...cur, isShared: nextState, shareUrl: res.shareUrl || cur.shareUrl } : cur
        )
      )
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: res.shareUrl || item.shareUrl
      })
    } else {
      showToast({
        style: Toast.Style.Failure,
        title: '切换共享状态失败',
        message: res.message
      })
    }
  }

  const filtered = filterLanShareItems(items, searchText, filterMode)
  const sharedCount = items.filter((i) => i.isShared).length

  return List({
    navigationTitle: '局域网免密快传与扫码投送',
    searchBarPlaceholder: '搜索局域网共享文件、剪贴板投送或内网直连 URL...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '筛选局域网共享内容类型',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as LanShareFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部共享项 (All Shared Items)', value: 'all' }),
        List.Dropdown.Item({ title: '剪贴板文本投送 (Clipboard Sync)', value: 'clipboard' }),
        List.Dropdown.Item({ title: '桌面与下载目录文件 (Local Files)', value: 'files' })
      ]
    }),
    filterBar: {
      summaryText: `本机内网直连: ${portalUrl} · 共享就绪 ${sharedCount} 项 (${formatBytes(totalSharedBytes)}) · 手机同一 Wi-Fi 扫码即下`,
      actions: [
        {
          id: 'copy-portal',
          label: '复制内网主页地址',
          title: '复制内网主页地址',
          style: 'secondary',
          onAction: async () => {
            await Clipboard.copy(portalUrl)
            showToast({
              style: Toast.Style.Success,
              title: '已复制内网访问地址',
              message: portalUrl
            })
          }
        },
        {
          id: 'refresh-lan',
          label: '刷新共享列表',
          title: '刷新共享列表',
          style: 'secondary',
          onAction: () => void refreshShareList(true)
        }
      ]
    },
    children: [
      List.Section({
        title: `局域网直连与扫码投送列表 (${filtered.length})`,
        children: filtered.map((item) =>
          List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.subtitle,
            icon:
              item.category === 'portal'
                ? Icon.Wifi
                : item.category === 'clipboard'
                ? Icon.Clipboard
                : Icon.Document,
            accessories: [
              { tag: { value: item.categoryLabel } },
              {
                text:
                  item.category === 'files'
                    ? formatBytes(item.sizeBytes)
                    : item.isShared
                    ? '扫码直连'
                    : '已暂停'
              }
            ],
            detail: List.Item.Detail({
              markdown: renderSharePreviewMarkdown(item)
            }),
            actions: ActionPanel({
              title: item.title,
              children: [
                Action({
                  title: '复制局域网直连下载 URL',
                  icon: Icon.Clipboard,
                  onAction: async () => {
                    await Clipboard.copy(item.shareUrl)
                    showToast({
                      style: Toast.Style.Success,
                      title: '已复制内网直连链接',
                      message: item.shareUrl
                    })
                  }
                }),
                Action({
                  title: item.isShared ? '暂停该项局域网共享' : '开启该项局域网共享',
                  icon: item.isShared ? Icon.Stop : Icon.Checkmark,
                  shortcut: { modifiers: ['ctrl'], key: 'return' },
                  onAction: () => handleToggleShare(item)
                }),
                ...(item.filePath
                  ? [
                      Action({
                        title: '在资源管理器中定位文件',
                        icon: Icon.Folder,
                        shortcut: { modifiers: ['ctrl'], key: 'o' },
                        onAction: () => {
                          void openSharedFileLocation(item.filePath)
                        }
                      })
                    ]
                  : []),
                Action({
                  title: '刷新共享列表',
                  icon: Icon.ArrowClockwise,
                  shortcut: { modifiers: ['ctrl'], key: 'r' },
                  onAction: () => refreshShareList(true)
                })
              ]
            })
          })
        )
      })
    ]
  })
}

export default LanShareCommand
