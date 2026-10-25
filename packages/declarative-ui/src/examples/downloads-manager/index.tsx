import React, {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useEffect,
  useMemo,
  useNavigation,
  useState
} from '../../index.js'
import {
  addCustomDownloadDirectory,
  cleanExpiredDownloads,
  cleanRedundantInstallers,
  computeDashboardSummary,
  copyDownloadFileEntity,
  copyDownloadFilePath,
  filterDownloadEntries,
  getDownloadCategoryLabel,
  getDownloadChannelLabel,
  getCustomDownloadDirectories,
  openDownloadItem,
  removeCustomDownloadDirectory,
  revealDownloadItem,
  scanDownloadsDirectory,
  togglePinEntry,
  trashDownloadItem
} from './downloads-service.js'
import type {
  DownloadEntry,
  DownloadFileCategory,
  DownloadsDashboardSummary
} from './types.js'

function getCategoryIcon(category: Exclude<DownloadFileCategory, 'all'>): string {
  switch (category) {
    case 'installer':
      return Icon.Download
    case 'archive':
      return Icon.Folder
    case 'document':
      return Icon.Document
    case 'image':
      return Icon.Image
    case 'media':
      return Icon.Video
    case 'code':
      return Icon.Code
    case 'other':
      return Icon.Document
  }
}

function resolveInitialFilterFromFeature(featureCode?: string): string {
  switch (featureCode) {
    case 'downloads-netdisk':
      return 'netdisk'
    case 'downloads-im':
      return 'im'
    case 'downloads-clean-installers':
      return 'type:installer'
    default:
      return 'all'
  }
}

export function AddCustomDownloadDirectoryForm(props: {
  customDirs: string[]
  onAdded: (dirPath: string) => void
  onRemoved: (dirPath: string) => void
}) {
  const { pop } = useNavigation()
  const [dirInput, setDirInput] = useState('')

  return (
    <Form
      navigationTitle="管理自定义下载监控目录"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="添加监控目录"
            icon={Icon.Plus}
            onSubmit={async (values: Record<string, unknown>) => {
              const rawPath = String(values.dirPath ?? dirInput ?? '').trim()
              const res = await addCustomDownloadDirectory(rawPath)
              if (!res.ok || !res.path) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: '添加目录失败',
                  message: res.error || '请输入合法且可访问的绝对目录路径'
                })
                return
              }
              await showToast({
                style: Toast.Style.Success,
                title: '已添加自定义监控目录',
                message: res.path
              })
              props.onAdded(res.path)
              pop()
            }}
          />
          {props.customDirs.map((customDir) => (
            <Action
              key={`rm-${customDir}`}
              title={`移除自定义目录: ${customDir}`}
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              onAction={async () => {
                removeCustomDownloadDirectory(customDir)
                await showToast({
                  style: Toast.Style.Success,
                  title: '已移除监控目录',
                  message: customDir
                })
                props.onRemoved(customDir)
              }}
            />
          ))}
        </ActionPanel>
      }
    >
      <Form.Description
        title="说明"
        text="输入本地自定义下载文件夹的绝对路径（如 D:\MyDownloads 或 /Users/name/MyDownloads），插件将自动聚合并实时索引该目录下的下载文件。"
      />
      <Form.TextField
        id="dirPath"
        title="文件夹绝对路径"
        placeholder="例如 D:\Downloads_Custom"
        value={dirInput}
        onChange={(v: string) => setDirInput(v)}
      />
    </Form>
  )
}

export function DownloadFileDetailView({ entry }: { entry: DownloadEntry }) {
  const markdown = [
    `# ${entry.name}`,
    '',
    `- **来源渠道**: ${entry.sourceLabel} (${getDownloadChannelLabel(entry.channel)})`,
    `- **文件类型**: ${getDownloadCategoryLabel(entry.category)} (\`${entry.ext || '无扩展名'}\`)`,
    `- **文件大小**: \`${entry.sizeFormatted}\` (${entry.sizeBytes.toLocaleString()} Bytes)`,
    `- **修改时间**: \`${entry.modifiedAt}\` (${entry.ageDays === 0 ? '今天' : `${entry.ageDays} 天前`})`,
    `- **完整路径**: \`${entry.path}\``
  ].join('\n')

  return <Detail navigationTitle={entry.name} markdown={markdown} />
}

export default function DownloadsManagerCommand(props?: {
  launchContext?: { featureCode?: string }
  featureCode?: string
}) {
  const { push } = useNavigation()
  const activeFeatureCode = props?.launchContext?.featureCode || props?.featureCode
  const [summary, setSummary] = useState<DownloadsDashboardSummary>(() =>
    computeDashboardSummary('', [], [])
  )
  const [filterValue, setFilterValue] = useState<string>(() =>
    resolveInitialFilterFromFeature(activeFeatureCode)
  )
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [customDirs, setCustomDirs] = useState<string[]>(() => getCustomDownloadDirectories())

  const reloadDownloads = async (nextCustomDirs = customDirs) => {
    setIsLoading(true)
    try {
      const realSummary = await scanDownloadsDirectory({
        customDirs: nextCustomDirs,
        maxFilesPerSource: 100
      })
      setSummary(realSummary)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (activeFeatureCode) {
      setFilterValue(resolveInitialFilterFromFeature(activeFeatureCode))
    }
  }, [activeFeatureCode])

  useEffect(() => {
    let active = true
    setIsLoading(true)
    scanDownloadsDirectory({ customDirs, maxFilesPerSource: 100 })
      .then((realSummary) => {
        if (active) setSummary(realSummary)
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const isInstallerCleanMode =
    filterValue === 'type:installer' || activeFeatureCode === 'downloads-clean-installers'

  const filteredEntries = useMemo(
    () =>
      filterDownloadEntries(summary.entries, {
        filterValue,
        query: searchQuery,
        sortBy: isInstallerCleanMode ? 'size' : 'mtime'
      }),
    [summary.entries, filterValue, searchQuery, isInstallerCleanMode]
  )

  const groupedSections = useMemo(() => {
    if (isInstallerCleanMode) {
      return [
        {
          id: 'sec-installers',
          title: '可清理安装包（按体积从大到小）',
          subtitle: `${filteredEntries.length} 个安装包 · 共 ${summary.installerSizeFormatted}`,
          items: filteredEntries
        }
      ]
    }
    const todayItems: DownloadEntry[] = []
    const weekItems: DownloadEntry[] = []
    const olderItems: DownloadEntry[] = []
    for (const item of filteredEntries) {
      if (item.ageDays <= 0) {
        todayItems.push(item)
      } else if (item.ageDays <= 7) {
        weekItems.push(item)
      } else {
        olderItems.push(item)
      }
    }
    const sections: Array<{ id: string; title: string; subtitle: string; items: DownloadEntry[] }> = []
    if (todayItems.length > 0) {
      sections.push({
        id: 'sec-today',
        title: '今日新增',
        subtitle: `${todayItems.length} 项`,
        items: todayItems
      })
    }
    if (weekItems.length > 0) {
      sections.push({
        id: 'sec-week',
        title: '近 7 天',
        subtitle: `${weekItems.length} 项`,
        items: weekItems
      })
    }
    if (olderItems.length > 0 || sections.length === 0) {
      sections.push({
        id: 'sec-older',
        title: sections.length === 0 ? '下载与接收记录' : '更早之前',
        subtitle: `${olderItems.length} 项`,
        items: olderItems
      })
    }
    return sections
  }, [filteredEntries, isInstallerCleanMode, summary.installerSizeFormatted])

  const handleCleanInstallers = async () => {
    if (summary.installerCount === 0) {
      await showToast({
        style: Toast.Style.Animated,
        title: '没有可清理的安装包',
        message: '所有渠道均未发现残留的 .exe / .msi / .dmg / .pkg 安装包'
      })
      return
    }
    const confirmed = await confirmAlert({
      title: `确认将 ${summary.installerCount} 个安装包移入回收站？`,
      message: `预计可释放 ${summary.installerSizeFormatted} 磁盘空间（已置顶保护项将跳过）。`
    })
    if (!confirmed) return
    const result = await cleanRedundantInstallers(summary.entries)
    setSummary(computeDashboardSummary(summary.downloadDir, result.remainingEntries, summary.sources))
    await showToast({
      style: result.cleanedCount > 0 ? Toast.Style.Success : Toast.Style.Failure,
      title:
        result.cleanedCount > 0
          ? `已清理 ${result.cleanedCount} 个安装包`
          : '清理安装包未生效',
      message:
        result.cleanedCount > 0
          ? `释放空间 ${result.freedFormatted}`
          : result.error || '文件可能正在被占用'
    })
  }

  const handleCleanLargeOldFiles = async () => {
    const candidates = summary.entries.filter(
      (e) => e.ageDays >= 30 && e.sizeBytes >= 100 * 1024 * 1024 && !e.isPinned
    )
    if (candidates.length === 0) {
      await showToast({
        style: Toast.Style.Animated,
        title: '无需清理',
        message: '未发现超过 30 天且大于 100 MB 的未置顶大文件'
      })
      return
    }
    const confirmed = await confirmAlert({
      title: `确认清理 ${candidates.length} 个 30 天前的大文件 (> 100 MB)？`,
      message: '文件将被安全移入系统回收站，可随时还原。'
    })
    if (!confirmed) return
    const result = await cleanExpiredDownloads(summary.entries, 30, 100 * 1024 * 1024)
    setSummary(computeDashboardSummary(summary.downloadDir, result.remainingEntries, summary.sources))
    await showToast({
      style: result.cleanedCount > 0 ? Toast.Style.Success : Toast.Style.Failure,
      title: `已清理 ${result.cleanedCount} 个过期大文件`,
      message: `释放空间 ${result.freedFormatted}`
    })
  }

  const openCustomDirManager = () => {
    push(
      <AddCustomDownloadDirectoryForm
        customDirs={customDirs}
        onAdded={(added) => {
          const next = Array.from(new Set([...customDirs, added]))
          setCustomDirs(next)
          void reloadDownloads(next)
        }}
        onRemoved={(removed) => {
          const next = customDirs.filter((d) => d !== removed)
          setCustomDirs(next)
          void reloadDownloads(next)
        }}
      />
    )
  }

  const renderGlobalActions = () => (
    <ActionPanel.Section title="批量清理与渠道配置">
      <Action
        title={`一键清理全部安装包 (${summary.installerCount} 个 · ${summary.installerSizeFormatted})`}
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        shortcut={{ modifiers: ['ctrl', 'shift'], key: 'backspace' }}
        onAction={handleCleanInstallers}
      />
      <Action
        title="清理 30 天前大文件 (> 100 MB)"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        onAction={handleCleanLargeOldFiles}
      />
      <Action
        title="添加/管理自定义下载监控目录..."
        icon={Icon.Plus}
        shortcut={{ modifiers: ['ctrl'], key: 'n' }}
        onAction={openCustomDirManager}
      />
      <Action
        title="刷新全渠道扫描"
        icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ['ctrl'], key: 'r' }}
        onAction={() => reloadDownloads(customDirs)}
      />
    </ActionPanel.Section>
  )

  return (
    <List
      navigationTitle="下载管理"
      searchBarPlaceholder="检索文件名、后缀(.exe/.pdf/.zip)或来源(微信/百度网盘/夸克/QQ)..."
      isLoading={isLoading}
      isShowingDetail={false}
      onSearchTextChange={(q: string) => setSearchQuery(q)}
      filterBar={{
        summaryText: `已聚合 ${summary.sources.length || 1} 个渠道目录 · 共 ${summary.totalCount} 个文件 (${summary.totalSizeFormatted}) · 安装包 ${summary.installerCount} 个 (${summary.installerSizeFormatted})`
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按来源渠道或文件类型筛选"
          value={filterValue}
          onChange={(val: string) => setFilterValue(val)}
        >
          <List.Dropdown.Section title="按来源渠道">
            <List.Dropdown.Item title="全渠道汇总" value="all" />
            <List.Dropdown.Item title="办公 IM 接收 (微信 / 企微 / QQ / 飞书 / 钉钉)" value="im" />
            <List.Dropdown.Item title="网盘与下载器 (百度 / 夸克 / 阿里 / 迅雷 / IDM)" value="netdisk" />
            <List.Dropdown.Item title="浏览器与系统下载 (Downloads)" value="browser" />
            <List.Dropdown.Item title="自定义监控目录" value="custom" />
          </List.Dropdown.Section>
          <List.Dropdown.Section title="按文件类型">
            <List.Dropdown.Item
              title={`安装包 (.exe / .msi / .dmg / .pkg) [${summary.installerCount}]`}
              value="type:installer"
            />
            <List.Dropdown.Item title="办公文档 (.pdf / .docx / .xlsx / .pptx)" value="type:document" />
            <List.Dropdown.Item title="压缩归档 (.zip / .7z / .rar / .tar)" value="type:archive" />
            <List.Dropdown.Item title="图片设计 (.png / .jpg / .webp / .svg)" value="type:image" />
            <List.Dropdown.Item title="音视频媒体 (.mp4 / .mkv / .mp3 / .wav)" value="type:media" />
            <List.Dropdown.Item title="代码与数据 (.json / .sql / .ts / .py)" value="type:code" />
          </List.Dropdown.Section>
        </List.Dropdown>
      }
    >
      {filteredEntries.length === 0 ? (
        <List.Section title="当前筛选状态">
          <List.Item
            id="downloads-empty"
            icon={{ source: Icon.Folder, tintColor: Color.SecondaryText }}
            title={isLoading ? '正在扫描全渠道下载与接收目录...' : '当前筛选条件下暂无下载文件'}
            subtitle="可切换右上角渠道筛选（全渠道 / 办公 IM / 网盘下载 / 安装包），或按 Ctrl+N 添加自定义下载监控目录"
            actions={
              <ActionPanel>
                <Action
                  title="重置为全渠道汇总"
                  icon={Icon.ArrowClockwise}
                  onAction={() => {
                    setFilterValue('all')
                    setSearchQuery('')
                  }}
                />
                {renderGlobalActions()}
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        groupedSections.map((section) => (
          <List.Section key={section.id} title={section.title} subtitle={section.subtitle}>
            {section.items.map((item) => (
              <List.Item
                key={item.id}
                id={item.id}
                icon={{
                  source: getCategoryIcon(item.category),
                  tintColor: Color.SecondaryText
                }}
                title={item.name}
                subtitle={`${item.sourceLabel} · ${getDownloadCategoryLabel(item.category)}`}
                keywords={[
                  item.ext,
                  item.category,
                  item.channel,
                  item.sourceLabel,
                  item.appName,
                  getDownloadCategoryLabel(item.category)
                ]}
                accessories={[
                  ...(item.isPinned ? [{ tag: { value: '已置顶', color: Color.SecondaryText } }] : []),
                  { tag: { value: item.sourceLabel, color: Color.SecondaryText } },
                  { text: item.sizeFormatted },
                  { text: item.ageDays === 0 ? `今天 ${item.modifiedAt.slice(11)}` : `${item.ageDays} 天前` }
                ]}
                actions={
                  <ActionPanel>
                    <ActionPanel.Section title={item.name}>
                      <Action
                        title="打开文件"
                        icon={Icon.Document}
                        onAction={async () => {
                          const ok = await openDownloadItem(item.path)
                          await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? `已打开: ${item.name}` : '无法打开文件',
                            message: item.path
                          })
                        }}
                      />
                      <Action
                        title="打开所在文件夹并选中"
                        icon={Icon.Folder}
                        shortcut={{ modifiers: ['ctrl'], key: 'enter' }}
                        onAction={async () => {
                          const ok = await revealDownloadItem(item.path)
                          await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? '已在资源管理器中定位文件' : '无法定位文件',
                            message: item.path
                          })
                        }}
                      />
                      <Action
                        title="复制文件实体（可直接粘贴到微信/桌面）"
                        icon={Icon.Clipboard}
                        shortcut={{ modifiers: ['ctrl', 'shift'], key: 'c' }}
                        onAction={async () => {
                          const res = await copyDownloadFileEntity(item.path)
                          await showToast({
                            style: res.ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: res.ok ? `已复制文件实体: ${item.name}` : '复制文件实体失败',
                            message: res.ok ? '可直接按 Ctrl+V 粘贴到聊天窗口或文件夹' : res.error
                          })
                        }}
                      />
                      <Action
                        title="复制完整路径"
                        icon={Icon.Clipboard}
                        shortcut={{ modifiers: ['ctrl'], key: 'c' }}
                        onAction={async () => {
                          const ok = await copyDownloadFilePath(item.path)
                          await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? '已复制完整路径' : '复制路径失败',
                            message: item.path
                          })
                        }}
                      />
                      <Action
                        title={item.isPinned ? '取消置顶保护' : '置顶并保护（跳过自动清理）'}
                        icon={Icon.Pin}
                        shortcut={{ modifiers: ['ctrl'], key: 'p' }}
                        onAction={() => {
                          const next = togglePinEntry(summary.entries, item.id)
                          setSummary(computeDashboardSummary(summary.downloadDir, next, summary.sources))
                        }}
                      />
                      <Action
                        title="移入回收站"
                        icon={Icon.Trash}
                        style={Action.Style.Destructive}
                        shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                        onAction={async () => {
                          const confirmed = await confirmAlert({
                            title: `确认将「${item.name}」移入回收站？`,
                            message: `文件大小: ${item.sizeFormatted}\n来源: ${item.path}`
                          })
                          if (!confirmed) return
                          const res = await trashDownloadItem(summary.entries, item.id)
                          if (!res.ok) {
                            await showToast({
                              style: Toast.Style.Failure,
                              title: '移入回收站失败',
                              message: res.error || '文件可能正在被占用'
                            })
                            return
                          }
                          setSummary(
                            computeDashboardSummary(
                              summary.downloadDir,
                              res.remainingEntries,
                              summary.sources
                            )
                          )
                          await showToast({
                            style: Toast.Style.Success,
                            title: `已移入回收站: ${item.name}`,
                            message: `释放空间 ${item.sizeFormatted}`
                          })
                        }}
                      />
                    </ActionPanel.Section>
                    {renderGlobalActions()}
                  </ActionPanel>
                }
              />
            ))}
          </List.Section>
        ))
      )}
    </List>
  )
}
