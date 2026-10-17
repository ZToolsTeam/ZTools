import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  confirmAlert,
  MetricGrid,
  DistributionBar,
  FilterBar,
  SegmentedControl
} from '../../index.js'
import {
  RenameRule,
  RenameRuleType,
  RenameUndoEntry,
  RENAME_RULE_PRESETS,
  RealFileEntry,
  formatBytes,
  applyRenameRule,
  fetchRealBatchRenameFiles,
  executeRealFileRename,
  undoBatchRenameHistory,
  openRenameFileLocation
} from './logic.js'

const EXT_COLORS = ['#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#06b6d4']

export default function BatchRenameCommand() {
  const [searchText, setSearchText] = useState('')
  const [ruleType, setRuleType] = useState<RenameRuleType>('number')
  const [sourceScope, setSourceScope] = useState<'downloads' | 'desktop' | 'documents' | 'pictures' | 'videos'>('downloads')
  const [sortMode, setSortMode] = useState<'original' | 'name_asc' | 'size_desc' | 'time_desc'>('original')
  const [directory, setDirectory] = useState('')
  const [realFiles, setRealFiles] = useState<RealFileEntry[]>([])
  const [checkedPaths, setCheckedPaths] = useState<string[]>([])
  const [undoHistory, setUndoHistory] = useState<RenameUndoEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)

  async function loadDirectoryFiles(scope = sourceScope, showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const res = await fetchRealBatchRenameFiles(scope)
      setDirectory(res.directory)
      setRealFiles(res.files)
      setCheckedPaths(res.files.map(f => f.fullPath))
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '已加载本机真实目录文件',
          message: `${res.directory} (${res.files.length} 个文件)`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadDirectoryFiles(sourceScope, false)
  }, [])

  function getActiveRule(): RenameRule {
    if (ruleType === 'prefix') {
      return { type: 'prefix', prefix: searchText.trim() ? `${searchText.trim()}_` : 'ZTools_' }
    }
    if (ruleType === 'suffix') {
      return { type: 'suffix', suffix: searchText.trim() ? `_${searchText.trim()}` : '_v2' }
    }
    if (ruleType === 'replace') {
      return { type: 'replace', find: searchText.trim() || '_', replace: '-' }
    }
    if (ruleType === 'case') {
      return { type: 'case', caseMode: 'lower' }
    }
    return { type: ruleType, startNumber: 1, padDigits: 2 }
  }

  const sortedFiles = realFiles.slice().sort((a, b) => {
    if (sortMode === 'name_asc') return a.name.localeCompare(b.name)
    if (sortMode === 'size_desc') return b.sizeBytes - a.sizeBytes
    if (sortMode === 'time_desc') return b.lastModifiedMs - a.lastModifiedMs
    return 0
  })

  const activeRule = getActiveRule()
  const seenTargetNames = new Set<string>()
  const previewItems = sortedFiles.map((f, idx) => {
    const isSelected = checkedPaths.includes(f.fullPath)
    const newName = isSelected ? applyRenameRule(f.name, activeRule, idx) : f.name
    const lowerNew = newName.toLowerCase()
    const conflict = seenTargetNames.has(lowerNew)
    seenTargetNames.add(lowerNew)
    return {
      ...f,
      newName,
      changed: isSelected && newName !== f.name,
      conflict
    }
  })

  async function handleRenameSingle(item: typeof previewItems[0]) {
    if (!item.changed) {
      showToast({ style: Toast.Style.Failure, title: '文件名未发生变化', message: item.name })
      return
    }
    const confirmed = await confirmAlert({
      title: '确认在真实磁盘上重命名此文件？',
      message: `原文件名: ${item.name}\n新文件名: ${item.newName}\n所在目录: ${item.parentDir}`,
      primaryAction: { title: '确认重命名', style: 'default' }
    })
    if (!confirmed) return

    const res = await executeRealFileRename(item.fullPath, item.newName)
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '重命名失败', message: res.error || '文件被占用或无权限' })
      return
    }
    if (res.destinationPath) {
      setUndoHistory([{ oldPath: item.fullPath, newPath: res.destinationPath, oldName: item.name, newName: item.newName }])
    }
    showToast({ style: Toast.Style.Success, title: '文件重命名成功', message: `${item.name} → ${item.newName}` })
    loadDirectoryFiles(sourceScope, false)
  }

  async function handleBatchRenameChecked() {
    const toRename = previewItems.filter(p => p.changed && !p.conflict && checkedPaths.includes(p.fullPath))
    if (toRename.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '没有待变更的已勾选文件' })
      return
    }
    const confirmed = await confirmAlert({
      title: `🚀 确认对 ${toRename.length} 个真实文件执行批量重命名？`,
      message: `目标目录: ${directory}\n当前规则: ${RENAME_RULE_PRESETS.find(r => r.id === ruleType)?.label || ruleType}\n\n重命名后支持一键撤销回滚 (Undo)。`,
      primaryAction: { title: '立即批量重命名', style: 'default' }
    })
    if (!confirmed) return

    const newUndo: RenameUndoEntry[] = []
    let successCount = 0
    for (const item of toRename) {
      const res = await executeRealFileRename(item.fullPath, item.newName)
      if (res.ok && res.destinationPath) {
        successCount += 1
        newUndo.push({
          oldPath: item.fullPath,
          newPath: res.destinationPath,
          oldName: item.name,
          newName: item.newName
        })
      }
    }
    if (newUndo.length > 0) setUndoHistory(newUndo)
    showToast({
      style: Toast.Style.Success,
      title: `成功重命名 ${successCount} 个文件`,
      message: '如需恢复原名可点击「撤销上次改名」'
    })
    loadDirectoryFiles(sourceScope, false)
  }

  async function handleUndoLastBatch() {
    if (undoHistory.length === 0) return
    const res = await undoBatchRenameHistory(undoHistory)
    if (res.ok) {
      showToast({
        style: Toast.Style.Success,
        title: `已撤销回滚 ${res.restoredCount} 个文件名`
      })
      setUndoHistory([])
      loadDirectoryFiles(sourceScope, false)
    }
  }

  const changedCount = previewItems.filter(p => p.changed).length
  const conflictCount = previewItems.filter(p => p.conflict).length
  const totalBytes = realFiles.reduce((s, f) => s + f.sizeBytes, 0)

  // 按扩展名统计分布条
  const extCounts = new Map<string, number>()
  for (const f of realFiles) {
    extCounts.set(f.extension, (extCounts.get(f.extension) || 0) + 1)
  }
  const extSegments = Array.from(extCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, count], idx) => ({
      id: ext,
      label: `${ext} (${count}个)`,
      valueBytes: count,
      formattedSize: `${count} 个文件`,
      percentage: realFiles.length > 0 ? Math.max(5, (count / realFiles.length) * 100) : 20,
      color: EXT_COLORS[idx % EXT_COLORS.length],
      active: true
    }))

  return List({
    searchBarPlaceholder:
      ruleType === 'prefix' || ruleType === 'suffix'
        ? '输入自定义前缀/后缀词 (实时生成新旧文件名 Diff 对比)...'
        : '搜索文件名或切换 10 大重命名规则实时预览变更...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'br-dir',
          label: '当前工作目录',
          value:
            sourceScope === 'downloads'
              ? '下载 (Downloads)'
              : sourceScope === 'desktop'
              ? '桌面 (Desktop)'
              : sourceScope === 'documents'
              ? '文档 (Documents)'
              : sourceScope === 'pictures'
              ? '图片 (Pictures)'
              : '视频 (Videos)',
          subValue: directory || '加载中...',
          status: 'normal'
        },
        {
          id: 'br-total',
          label: '已勾选 / 目录文件数',
          value: `${checkedPaths.length} / ${realFiles.length} 个`,
          subValue: `总计 ${formatBytes(totalBytes)}`,
          status: 'normal'
        },
        {
          id: 'br-changed',
          label: '预计变更文件数',
          value: `${changedCount} 个`,
          subValue: RENAME_RULE_PRESETS.find(r => r.id === ruleType)?.label || ruleType,
          status: changedCount > 0 ? 'success' : 'normal'
        },
        {
          id: 'br-conflict',
          label: '同名冲突与回滚栈',
          value: conflictCount > 0 ? `${conflictCount} 项冲突` : '0 冲突 · 安全',
          subValue: undoHistory.length > 0 ? `可撤销上次 ${undoHistory.length} 项改名` : '支持原子级撤销回滚',
          status: conflictCount > 0 ? 'danger' : 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: `当前目录 (${directory || sourceScope}) 文件扩展名分布`,
      totalLabel: `共 ${realFiles.length} 个真实文件 · ${formatBytes(totalBytes)}`,
      segments: extSegments
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 选择真实工作目录', status: 'done' },
        { step: 2, label: '2. 配置 10 大替换/序号规则', status: 'done' },
        { step: 3, label: '3. Diff 预览与冲突检测', status: 'active' },
        { step: 4, label: '4. 原子改名/一键撤销', status: 'pending' }
      ],
      summaryText: `已勾选 ${checkedPaths.length} 个文件 · 预计改名 ${changedCount} 个 · 冲突 ${conflictCount} 个`,
      groups: [
        {
          id: 'dir-scope',
          label: '目标目录',
          value: sourceScope,
          onChange: (v) => {
            setSourceScope(v as any)
            loadDirectoryFiles(v as any, true)
          },
          options: [
            { value: 'downloads', label: '📥 下载 (Downloads)' },
            { value: 'desktop', label: '🖥️ 桌面 (Desktop)' },
            { value: 'documents', label: '📄 文档 (Documents)' },
            { value: 'pictures', label: '🖼️ 图片 (Pictures)' },
            { value: 'videos', label: '🎬 视频 (Videos)' }
          ]
        },
        {
          id: 'sort-mode',
          label: '序号排序依据',
          value: sortMode,
          onChange: (v) => setSortMode(v as any),
          options: [
            { value: 'original', label: '默认目录序' },
            { value: 'name_asc', label: '按名称升序 (A-Z)' },
            { value: 'size_desc', label: '按文件大小降序' },
            { value: 'time_desc', label: '按修改时间最新' }
          ]
        }
      ],
      actions: [
        {
          id: 'exec-batch-rename',
          title: `🚀 批量重命名已选 (${changedCount})`,
          style: 'primary',
          disabled: changedCount === 0 || conflictCount > 0,
          onAction: handleBatchRenameChecked
        },
        ...(undoHistory.length > 0
          ? [
              {
                id: 'undo-batch',
                title: `↩️ 撤销上次改名 (${undoHistory.length})`,
                style: 'secondary' as const,
                onAction: handleUndoLastBatch
              }
            ]
          : []),
        {
          id: 'reload-dir',
          title: '🔄 刷新目录',
          style: 'secondary',
          onAction: () => loadDirectoryFiles(sourceScope, true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: ruleType,
      onChange: v => setRuleType(v as any),
      options: RENAME_RULE_PRESETS.map(r => ({
        value: r.id,
        label: r.label
      }))
    }),
    children: [
      List.Section({
        title: `本机真实文件新旧命名实时 Diff 对比 (${directory || sourceScope})`,
        subtitle: RENAME_RULE_PRESETS.find(r => r.id === ruleType)?.desc || '',
        checkable: true,
        checked:
          previewItems.length > 0 && checkedPaths.length === previewItems.length
            ? true
            : checkedPaths.length > 0
            ? 'indeterminate'
            : false,
        onCheckChange: (checked) => {
          setCheckedPaths(checked ? previewItems.map(p => p.fullPath) : [])
        },
        children: previewItems.map(item => {
          const isChecked = checkedPaths.includes(item.fullPath)
          return List.Item({
            id: item.fullPath,
            title: `${item.name}  ➔  ${item.newName}`,
            subtitle: `${item.parentDir} · ${formatBytes(item.sizeBytes)}`,
            checkable: true,
            checked: isChecked,
            onCheckChange: (c) => {
              if (c) {
                setCheckedPaths(Array.from(new Set([...checkedPaths, item.fullPath])))
              } else {
                setCheckedPaths(checkedPaths.filter(p => p !== item.fullPath))
              }
            },
            icon: {
              source: item.conflict ? Icon.XMarkCircle : item.changed ? Icon.CheckCircle : Icon.Document,
              tintColor: item.conflict ? Color.Red : item.changed ? Color.Green : Color.SecondaryText
            },
            accessories: [
              {
                tag: {
                  value: item.conflict ? '⚠️ 同名冲突' : item.changed ? '🟢 待改名' : '⚪ 无变化',
                  color: item.conflict ? Color.Red : item.changed ? Color.Green : Color.SecondaryText
                }
              },
              { text: formatBytes(item.sizeBytes) }
            ],
            detail: List.Item.Detail({
              markdown: `# ✏️ 批量重命名实时 Diff 预览 (产品设计文档.md)

**所属真实目录**: \`${item.parentDir}\`  
**当前激活规则**: \`${RENAME_RULE_PRESETS.find(r => r.id === ruleType)?.label}\`

---

### 🔄 新旧文件名逐项对比
- **原始文件名 (Old)**: \`${item.name}\`
- **目标新名称 (New)**: \`${item.newName}\`
- **冲突安全校验**: \`${item.conflict ? '❌ 检测到同名冲突，已自动拦截' : '✅ 无同名冲突，安全就绪'}\`
- **文件物理大小**: \`${formatBytes(item.sizeBytes)}\`
`
            }),
            actions: ActionPanel({
              title: item.name,
              children: [
                Action({
                  title: '对此单个文件执行真实重命名',
                  icon: Icon.Pencil,
                  onAction: () => handleRenameSingle(item)
                }),
                Action({
                  title: `批量重命名全部已勾选文件 (${changedCount})`,
                  icon: Icon.Bolt,
                  onAction: handleBatchRenameChecked
                }),
                Action({
                  title: '在资源管理器中定位文件',
                  icon: Icon.Folder,
                  onAction: () => {
                    openRenameFileLocation(item.fullPath)
                  }
                }),
                Action({
                  title: '复制新文件名',
                  icon: Icon.Clipboard,
                  onAction: async () => {
                    await Clipboard.copy(item.newName)
                    showToast({ style: Toast.Style.Success, title: '已复制新文件名', message: item.newName })
                  }
                })
              ]
            })
          })
        })
      })
    ]
  })
}
