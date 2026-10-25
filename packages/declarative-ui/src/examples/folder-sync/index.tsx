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
import { callHostTransport } from '../shared/native-ipc.js'
import {
  compareFolderTrees,
  executeFolderSync,
  filterSyncDiffItems,
  formatSyncBytes,
  shortenFolderPath
} from './sync-service.js'
import type { DiffFilterType, FolderSyncDiffItem, SyncMode } from './types.js'

export * from './types.js'
export * from './sync-service.js'

export interface FolderSyncCommandProps {
  featureCode?: string
  initialSourceDir?: string
  initialTargetDir?: string
  initialSyncMode?: SyncMode
  hostOverride?: unknown
}

export function FolderSyncCommand(props: FolderSyncCommandProps = {}) {
  const [sourceDir, setSourceDir] = useState<string>(props.initialSourceDir ?? '')
  const [targetDir, setTargetDir] = useState<string>(props.initialTargetDir ?? '')
  const [syncMode, setSyncMode] = useState<SyncMode>(props.initialSyncMode ?? 'incremental')
  const [ignoreDevJunk, setIgnoreDevJunk] = useState<boolean>(true)
  const [diffFilter, setDiffFilter] = useState<DiffFilterType>('all')
  const [searchText, setSearchText] = useState<string>('')
  const [diffItems, setDiffItems] = useState<FolderSyncDiffItem[]>([])
  const [checkedSet, setCheckedSet] = useState<Set<string>>(new Set())
  const [isBusy, setIsBusy] = useState<boolean>(false)

  const handleCompareDirectories = async (
    customSource = sourceDir,
    customTarget = targetDir,
    customMode = syncMode,
    customIgnore = ignoreDevJunk
  ) => {
    if (!customSource || !customTarget) {
      setDiffItems([])
      setCheckedSet(new Set())
      return
    }
    setIsBusy(true)
    try {
      const res = await compareFolderTrees({
        sourceDir: customSource,
        targetDir: customTarget,
        syncMode: customMode,
        ignoreDevJunk: customIgnore,
        hostOverride: props.hostOverride
      })
      if (!res.ok) {
        await showToast({
          style: Toast.Style.Failure,
          title: res.error || '目录差异比对失败'
        })
        setDiffItems([])
        setCheckedSet(new Set())
        return
      }
      setDiffItems(res.diffs)
      setCheckedSet(new Set(res.diffs.map((d) => d.relPath)))
    } finally {
      setIsBusy(false)
    }
  }

  useEffect(() => {
    if (sourceDir && targetDir) {
      void handleCompareDirectories(sourceDir, targetDir, syncMode, ignoreDevJunk)
    }
  }, [sourceDir, targetDir, syncMode, ignoreDevJunk])

  const filteredDiffs = useMemo(
    () => filterSyncDiffItems(diffItems, diffFilter, searchText),
    [diffItems, diffFilter, searchText]
  )

  const checkedItems = useMemo(
    () => diffItems.filter((d) => checkedSet.has(d.relPath)),
    [diffItems, checkedSet]
  )

  const transferBytes = useMemo(
    () =>
      checkedItems
        .filter((d) => d.direction !== 'delete-dst')
        .reduce((acc, d) => acc + d.sizeBytes, 0),
    [checkedItems]
  )

  const allChecked =
    filteredDiffs.length > 0 && filteredDiffs.every((d) => checkedSet.has(d.relPath))
  const someChecked =
    !allChecked && filteredDiffs.some((d) => checkedSet.has(d.relPath))

  const toggleCheck = (relPath: string) => {
    setCheckedSet((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) next.delete(relPath)
      else next.add(relPath)
      return next
    })
  }

  const toggleAllVisible = () => {
    setCheckedSet((prev) => {
      const next = new Set(prev)
      if (allChecked) {
        for (const d of filteredDiffs) next.delete(d.relPath)
      } else {
        for (const d of filteredDiffs) next.add(d.relPath)
      }
      return next
    })
  }

  const handleSelectDirectories = async () => {
    const srcRes = await callHostTransport<{ filePaths?: string[]; paths?: string[] }>(
      'dialog_show_open',
      { properties: ['openDirectory'], title: '选择源文件夹 (Source Folder)' },
      props.hostOverride
    )
    const pickedSrc = srcRes.data?.filePaths?.[0] ?? srcRes.data?.paths?.[0]
    if (!pickedSrc) return

    const dstRes = await callHostTransport<{ filePaths?: string[]; paths?: string[] }>(
      'dialog_show_open',
      { properties: ['openDirectory'], title: '选择目标备份文件夹 (Target Folder)' },
      props.hostOverride
    )
    const pickedDst = dstRes.data?.filePaths?.[0] ?? dstRes.data?.paths?.[0]
    if (!pickedDst) return

    setSourceDir(pickedSrc)
    setTargetDir(pickedDst)
  }

  const handleExecuteSync = async () => {
    if (checkedItems.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: '请先勾选至少一项待同步差异文件'
      })
      return
    }
    setIsBusy(true)
    try {
      const res = await executeFolderSync({
        sourceDir,
        targetDir,
        syncMode,
        ignoreDevJunk,
        selectedRelPaths: checkedItems.map((d) => d.relPath),
        hostOverride: props.hostOverride
      })
      if (!res.ok && res.failures.length === 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: res.error || '目录增量同步失败'
        })
        return
      }
      if (res.failures.length > 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: `同步完成 ${res.syncedCount} 项，但有 ${res.failures.length} 个文件被占用跳过 (${res.failures[0]!.relPath})`
        })
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: `增量同步完成：已写入 ${res.syncedCount} 个文件 (${formatSyncBytes(res.transferredBytes)})`
        })
      }
      await handleCompareDirectories(sourceDir, targetDir, syncMode, ignoreDevJunk)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <List
      navigationTitle="目录增量同步"
      isLoading={isBusy}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="在差异文件队列中搜索文件名或相对路径..."
      searchBarAccessory={
        <List.Dropdown
          value={diffFilter}
          onChange={(val) => setDiffFilter(val as DiffFilterType)}
          tooltip="按差异类型筛选"
        >
          <List.Dropdown.Item title="全部差异文件" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="仅看新增文件 (+)" value="added" icon={Icon.Plus} />
          <List.Dropdown.Item title="仅看已修改文件 (↑)" value="modified" icon={Icon.Pencil} />
          <List.Dropdown.Item
            title="仅看目标端多余文件 (-)"
            value="orphan"
            icon={Icon.Trash}
          />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `比对完成：共发现 ${diffItems.length} 处差异 · 已勾选 ${checkedItems.length} 项（待传输 ${formatSyncBytes(transferBytes)}）`,
        actions: [
          {
            id: 'pick-dirs',
            title: '选择源/目标目录',
            onAction: () => {
              void handleSelectDirectories()
            }
          },
          {
            id: 'rescan',
            title: '重新比对',
            onAction: () => {
              void handleCompareDirectories()
            }
          }
        ]
      }}
      workbenchPanel={{
        title: '同步策略与目录配置',
        subtitle: `${shortenFolderPath(sourceDir)} → ${shortenFolderPath(targetDir)}`,
        fields: [
          {
            id: 'syncMode',
            label: '同步模式',
            type: 'select',
            value: syncMode,
            options: [
              { label: '单向增量备份 (仅新增/更新，最安全)', value: 'incremental' },
              { label: '双向最新合并 (两边互相同步)', value: 'two-way' },
              { label: '单向镜像克隆 (清理目标端多余项)', value: 'mirror' }
            ],
            onChange: (val: unknown) => setSyncMode(val as SyncMode)
          },
          {
            id: 'ignoreDevJunk',
            label: '忽略缓存目录 (node_modules/.git)',
            type: 'toggle',
            value: ignoreDevJunk,
            onChange: (val: unknown) => setIgnoreDevJunk(Boolean(val))
          },
          {
            id: 'sourceInfo',
            label: '源文件夹',
            type: 'info',
            value: sourceDir || '未选择'
          },
          {
            id: 'targetInfo',
            label: '目标文件夹',
            type: 'info',
            value: targetDir || '未选择'
          }
        ],
        previewCard: {
          title: '本次同步传输预估',
          subtitle: `预计写入 ${checkedItems.length} 个文件 · 共 ${formatSyncBytes(transferBytes)}`
        }
      }}
      subList={{
        title: `待同步差异文件明细 (${filteredDiffs.length} 项)`,
        subtitle: '按空格勾选或取消，按 Enter 开始执行增量同步',
        emptyText: '源目录与目标目录内容完全一致，无需同步',
        checkable: filteredDiffs.length > 0,
        checked: allChecked ? true : someChecked ? 'indeterminate' : false,
        onCheckChange: toggleAllVisible,
        items: filteredDiffs.map((item) => (
          <List.Item
            key={item.relPath}
            id={item.relPath}
            title={item.relPath}
            subtitle={item.reasonText}
            icon={
              item.diffType === 'added' || item.diffType === 'reverse-add'
                ? Icon.Plus
                : item.diffType === 'modified'
                  ? Icon.ArrowUp
                  : Icon.Trash
            }
            checkable={true}
            checked={checkedSet.has(item.relPath)}
            onCheckChange={() => toggleCheck(item.relPath)}
            accessories={[
              item.diffType === 'orphan'
                ? { tag: { value: '目标多余(移入回收站)', color: Color.Red } }
                : { tag: item.actionBadge },
              { text: formatSyncBytes(item.sizeBytes) }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={`开始执行增量同步 (${checkedItems.length} 个文件)`}
                  icon={Icon.Play}
                  onAction={handleExecuteSync}
                />
                <Action.ShowInFinder
                  title="在资源管理器中查看源文件"
                  path={item.sourceFullPath || item.targetFullPath}
                />
                <Action
                  title="更换源目录与目标目录"
                  icon={Icon.Folder}
                  onAction={handleSelectDirectories}
                />
              </ActionPanel>
            }
          />
        ))
      }}
    />
  )
}

export default FolderSyncCommand
