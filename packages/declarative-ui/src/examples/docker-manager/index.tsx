import React, {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import { controlContainer, getContainerTailLogs, listContainers } from './docker-service.js'
import type { ContainerStatusFilter, ContainerSummary } from './types.js'

export * from './types.js'
export * from './docker-service.js'

export interface DockerManagerCommandProps {
  featureCode?: string
  initialContainers?: ContainerSummary[]
  hostOverride?: unknown
}

export function DockerManagerCommand(props: DockerManagerCommandProps = {}) {
  const defaultFilter: ContainerStatusFilter =
    props.featureCode === 'docker-running'
      ? 'running'
      : props.featureCode === 'docker-clean-stopped'
        ? 'exited'
        : 'all'

  const [containers, setContainers] = useState<ContainerSummary[]>(props.initialContainers ?? [])
  const [statusFilter, setStatusFilter] = useState<ContainerStatusFilter>(defaultFilter)
  const [searchText, setSearchText] = useState<string>('')
  const [daemonOfflineError, setDaemonOfflineError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(!props.initialContainers)

  const handleRefresh = async () => {
    setIsLoading(true)
    setDaemonOfflineError(null)
    try {
      const list = await listContainers(undefined, props.hostOverride)
      setContainers(list)
    } catch (err) {
      setDaemonOfflineError(err instanceof Error ? err.message : '未检测到正在运行的 Docker 引擎')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!props.initialContainers) {
      void handleRefresh()
    }
  }, [])

  const runningCount = useMemo(
    () => containers.filter((c) => c.isRunning).length,
    [containers]
  )

  const filteredContainers = useMemo(() => {
    const byStatus = containers.filter((c) => {
      if (statusFilter === 'running') return c.isRunning
      if (statusFilter === 'exited') return !c.isRunning
      return true
    })
    const q = searchText.trim().toLowerCase()
    if (!q) return byStatus
    return byStatus.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.portsDisplay.toLowerCase().includes(q)
    )
  }, [containers, statusFilter, searchText])

  const handleToggleContainer = async (c: ContainerSummary) => {
    const nextAction = c.isRunning ? 'stop' : 'start'
    const res = await controlContainer(c.id, nextAction, undefined, props.hostOverride)
    if (!res.ok) {
      await showToast({ style: Toast.Style.Failure, title: res.error || '操作容器失败' })
      return
    }
    setContainers((prev) =>
      prev.map((item) =>
        item.id === c.id
          ? {
              ...item,
              isRunning: !item.isRunning,
              statusDisplay: !item.isRunning ? 'Up Just Now' : 'Exited (0)'
            }
          : item
      )
    )
    await showToast({
      style: Toast.Style.Success,
      title: `${c.name} 已${c.isRunning ? '停止' : '启动'}`
    })
  }

  const handlePruneStopped = async () => {
    const stopped = containers.filter((c) => !c.isRunning)
    let removedCount = 0
    for (const c of stopped) {
      const res = await controlContainer(c.id, 'remove', undefined, props.hostOverride)
      if (res.ok) removedCount++
    }
    setContainers((prev) => prev.filter((c) => c.isRunning))
    await showToast({
      style: Toast.Style.Success,
      title: `已清理 ${removedCount || stopped.length} 个已停止的容器`
    })
  }

  const handleLoadLogs = async (c: ContainerSummary) => {
    const logs = await getContainerTailLogs(c.id, 100, undefined, props.hostOverride)
    setContainers((prev) =>
      prev.map((item) => (item.id === c.id ? { ...item, tailLogs: logs || '暂无日志输出' } : item))
    )
    await showToast({
      style: Toast.Style.Success,
      title: `已加载 ${c.name} 最新日志`
    })
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索容器名、镜像、端口或 ID (如: nginx、redis、3306) ..."
      searchBarAccessory={
        <List.Dropdown
          value={statusFilter}
          onChange={(v: string) => setStatusFilter(v as ContainerStatusFilter)}
          tooltip="按状态筛选"
        >
          <List.Dropdown.Item title="全部容器" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="运行中 (Running)" value="running" icon={Icon.CheckCircle} />
          <List.Dropdown.Item title="已停止 (Exited)" value="exited" icon={Icon.XMarkCircle} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: daemonOfflineError
          ? `Docker 引擎未就绪: ${daemonOfflineError}`
          : `Docker 状态: 运行中 · 共 ${containers.length} 个容器（${runningCount} 个活跃中）`,
        actions: [
          { id: 'refresh', title: '刷新状态', onAction: handleRefresh },
          { id: 'prune', title: '清理停止容器', onAction: handlePruneStopped }
        ]
      }}
    >
      {filteredContainers.map((c) => (
        <List.Item
          key={c.id}
          id={c.id}
          title={c.name}
          subtitle={c.image}
          icon={c.isRunning ? Icon.CheckCircle : Icon.Circle}
          accessories={[
            ...(c.primaryPort ? [{ tag: c.primaryPort }] : []),
            { text: c.statusDisplay }
          ]}
          detail={
            <List.Item.Detail
              markdown={`### 容器日志 (尾部 100 行)\n\`\`\`bash\n${c.tailLogs || '暂无日志输出'}\n\`\`\``}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="容器全名" text={c.name} />
                  <List.Item.Detail.Metadata.Label title="容器 ID" text={c.id.substring(0, 12)} />
                  <List.Item.Detail.Metadata.Label title="基础镜像" text={c.image} />
                  <List.Item.Detail.Metadata.Label title="运行状态" text={c.statusDisplay} />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label
                    title="端口映射"
                    text={c.portsDisplay || '无端口映射'}
                  />
                  <List.Item.Detail.Metadata.Label title="创建时间" text={c.createdFormatted} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              {c.webUrl && c.isRunning ? (
                <Action.OpenInBrowser
                  title={`在浏览器中打开 ${c.webUrl}`}
                  url={c.webUrl}
                  icon={Icon.Globe}
                />
              ) : null}
              <Action
                title={c.isRunning ? '停止容器 (docker stop)' : '启动容器 (docker start)'}
                icon={c.isRunning ? Icon.XMarkCircle : Icon.Play}
                shortcut={{ modifiers: ['cmd'], key: 'enter' }}
                onAction={() => handleToggleContainer(c)}
              />
              <Action
                title="加载容器最新日志 (100行)"
                icon={Icon.Document}
                onAction={() => handleLoadLogs(c)}
              />
              <Action.CopyToClipboard
                title="复制 12 位短容器 ID"
                content={c.id.substring(0, 12)}
                shortcut={{ modifiers: ['cmd'], key: 'c' }}
              />
              <Action
                title="清理停止容器"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={handlePruneStopped}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default DockerManagerCommand
