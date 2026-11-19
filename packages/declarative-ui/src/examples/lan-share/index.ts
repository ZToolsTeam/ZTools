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
  buildImportEmptyActionPanel,
  buildListManagementSection,
  useExampleImportQueue
} from '../shared/import-ui.js'
import {
  type LanShareItem,
  type LanShareFilterMode,
  LAN_SHARE_IMPORT_RULES,
  createClipboardShareItem,
  fetchLanShareSnapshot,
  filterLanShareItems,
  formatBytes,
  generateQrCodeSvgDataUri,
  openSharedFileLocation,
  syncLanShareItemsToHost,
  toLanShareFileItem,
  toggleFileShare
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
  const [portalUrl, setPortalUrl] = useState('http://127.0.0.1:18580')
  const [isLoading, setIsLoading] = useState(false)

  const queue = useExampleImportQueue<LanShareItem>({
    rules: LAN_SHARE_IMPORT_RULES,
    toItem: (entry) => toLanShareFileItem(entry, portalUrl),
    pathOf: (item) => item.filePath || item.id,
    idOf: (item) => item.id,
    fileTitle: '选择要共享的文件',
    folderTitle: '选择要共享的文件夹',
    onImported: async (added) => {
      if (added.length === 0) return
      const res = await syncLanShareItemsToHost(added)
      setPortalUrl(res.portalUrl)
    },
    onTextPaste: (text) => {
      const clipUrl = `${portalUrl}/clip/latest`
      const clipItem: LanShareItem = {
        id: 'lan-clip-share',
        title: '粘贴文本实时投送',
        subtitle: text.replace(/\s+/g, ' ').slice(0, 72),
        category: 'clipboard',
        categoryLabel: '剪贴板投送',
        filePath: '',
        sizeBytes: text.length,
        shareUrl: clipUrl,
        qrCodeDataUri: generateQrCodeSvgDataUri(clipUrl),
        isShared: true,
        downloadCount: 0,
        textPreview: text
      }
      queue.setItems((prev) => [clipItem, ...prev.filter((i) => i.id !== 'lan-clip-share')])
      return true
    },
    onCleared: () => {
      void showToast({ style: Toast.Style.Success, title: '已清空局域网共享列表' })
    }
  })

  async function refreshShareList(showNotice = false) {
    if (showNotice) setIsLoading(true)
    try {
      const snap = await fetchLanShareSnapshot()
      setPortalUrl(snap.portalUrl)
      if (snap.items.length > 0) {
        queue.setItems((prev) => {
          const existingIds = new Set(prev.map((i) => i.id))
          const incoming = snap.items.filter((i) => !existingIds.has(i.id))
          return incoming.length > 0 ? [...prev, ...incoming] : prev
        })
      }
      if (showNotice) {
        void showToast({
          style: Toast.Style.Success,
          title: '局域网共享状态已刷新',
          message: `内网地址: ${snap.portalUrl}`
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
      queue.setItems((prev) =>
        prev.map((cur) =>
          cur.id === item.id ? { ...cur, isShared: nextState, shareUrl: res.shareUrl || cur.shareUrl } : cur
        )
      )
      void showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: res.shareUrl || item.shareUrl
      })
    } else {
      void showToast({
        style: Toast.Style.Failure,
        title: '切换共享状态失败',
        message: res.message
      })
    }
  }

  async function handleShareClipboardText() {
    const res = await createClipboardShareItem()
    if (!res.ok || !res.item) {
      void showToast({ style: Toast.Style.Failure, title: res.message })
      return
    }
    const created = res.item
    queue.setItems((prev) => [created, ...prev.filter((i) => i.id !== created.id)])
    void showToast({ style: Toast.Style.Success, title: res.message })
  }

  const filtered = filterLanShareItems(queue.items, searchText, filterMode)
  const sharedCount = queue.items.filter((i) => i.isShared).length
  const totalSharedBytes = queue.items.reduce((acc, cur) => acc + (cur.sizeBytes || 0), 0)

  const summaryText =
    queue.importStatusText ||
    `本机内网直连: ${portalUrl} · 共享就绪 ${sharedCount} 项 (${formatBytes(totalSharedBytes)})`

  return List({
    navigationTitle: '局域网免密快传与扫码投送',
    searchBarPlaceholder: '搜索局域网共享文件、粘贴文本投送或输入 URL...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading: isLoading || queue.isImporting,
    ...queue.fileInputProps,
    searchBarAccessory: List.Dropdown({
      tooltip: '筛选局域网共享内容类型',
      value: filterMode,
      onChange: (val: string) => setFilterMode(val as LanShareFilterMode),
      children: [
        List.Dropdown.Item({ title: '全部共享项 (All Shared Items)', value: 'all' }),
        List.Dropdown.Item({ title: '剪贴板文本投送 (Clipboard Sync)', value: 'clipboard' }),
        List.Dropdown.Item({ title: '本地文件共享 (Local Files)', value: 'files' })
      ]
    }),
    filterBar: {
      summaryText,
      actions: queue.topBarActions
    },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder, [
      Action({
        title: '共享当前剪贴板文本',
        icon: Icon.Clipboard,
        onAction: handleShareClipboardText
      }),
      Action({
        title: '复制内网主页地址',
        icon: Icon.Link,
        onAction: async () => {
          await Clipboard.copy(portalUrl)
          void showToast({ style: Toast.Style.Success, title: '已复制内网访问地址', message: portalUrl })
        }
      }),
      Action({
        title: '刷新共享状态',
        icon: Icon.ArrowClockwise,
        onAction: () => void refreshShareList(true)
      })
    ]),
    children:
      filtered.length === 0
        ? []
        : [
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
                          void showToast({
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
                              onAction: () => {
                                void openSharedFileLocation(item.filePath)
                              }
                            })
                          ]
                        : []),
                      Action({
                        title: '共享当前剪贴板文本',
                        icon: Icon.Clipboard,
                        onAction: handleShareClipboardText
                      }),
                      Action({
                        title: '刷新共享状态',
                        icon: Icon.ArrowClockwise,
                        shortcut: { modifiers: ['ctrl'], key: 'r' },
                        onAction: () => refreshShareList(true)
                      }),
                      buildListManagementSection({
                        onRemove: () => queue.removeItem(item.id),
                        onPickFiles: queue.handlePickFiles,
                        onPickFolder: queue.handlePickFolder,
                        onClear: queue.clearQueue
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
