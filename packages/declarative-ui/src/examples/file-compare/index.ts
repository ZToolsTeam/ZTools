import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  FilterBar
} from '../../index.js'
import {
  COMPARE_ENGINE_MODES,
  INITIAL_COMPARE_PAIRS,
  CompareEnginePreset,
  FileComparePairItem,
  executeDeepFileCompare,
  executeFileComparison,
  fetchFileCompareWorkspace,
  formatBytes,
  getDiffStatusLabel,
  openComparedFileLocation
} from './logic.js'
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'
export { executeFileComparison }

export function FileCompareCommand() {
  const realHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [engineModeId, setEngineModeId] = useState<string>(COMPARE_ENGINE_MODES[0].id)
  const [diffFilterView, setDiffFilterView] = useState<'all' | 'modified' | 'identical' | 'added'>('all')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState<boolean>(true)
  const [ignoreCase, setIgnoreCase] = useState<boolean>(false)
  const [pairs, setPairs] = useState<FileComparePairItem[]>(realHost ? [] : INITIAL_COMPARE_PAIRS)
  const [checkedIds, setCheckedIds] = useState<string[]>(realHost ? [] : INITIAL_COMPARE_PAIRS.map(p => p.id))
  const [engines, setEngines] = useState<CompareEnginePreset[]>(COMPARE_ENGINE_MODES)
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchFileCompareWorkspace()
      setPairs(ws.pairs)
      setCheckedIds(ws.pairs.map(p => p.id))
      setEngines(ws.engines)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '文件比对工作台已刷新',
          message: `已生成 ${ws.pairs.length} 组文件哈希与 Diff 比对队列`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeEngine = engines.find(e => e.id === engineModeId) || COMPARE_ENGINE_MODES[0]

  async function handleRunCompareChecked() {
    const selected = pairs.filter(p => checkedIds.includes(p.id))
    const res = await executeDeepFileCompare(selected, {
      engineModeId,
      diffFilterView,
      ignoreWhitespace,
      ignoreCase
    })
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '文件比对未执行', message: res.error || '请勾选待比对项' })
      return
    }
    if (Array.isArray(res.pairs) && res.pairs.length > 0) {
      const updatedMap = new Map(res.pairs.map(p => [p.id, p]))
      setPairs(pairs.map(p => updatedMap.get(p.id) || p))
    }
    await Clipboard.copy(res.reportMarkdown)
    showToast({
      style: Toast.Style.Success,
      title: `已完成 ${res.totalPairs} 组文件比对并复制报告`,
      message: `存在差异 ${res.modifiedCount} · 完全一致 ${res.identicalCount} · 耗时 ${res.elapsedMs}ms`
    })
  }

  const modifiedCount = pairs.filter(p => p.diffStatus === 'modified').length
  const identicalCount = pairs.filter(p => p.diffStatus === 'identical').length
  const addedCount = pairs.filter(p => p.diffStatus === 'added').length
  const elapsedMs = Math.max(8, pairs.length * 4)

  const q = searchText.trim().toLowerCase()
  const filteredPairs = pairs.filter(p => {
    if (diffFilterView !== 'all' && p.diffStatus !== diffFilterView) return false
    if (!q) return true
    return (
      p.name.toLowerCase().includes(q) ||
      p.leftPath.toLowerCase().includes(q) ||
      p.rightPath.toLowerCase().includes(q) ||
      p.leftSha256Short.toLowerCase().includes(q)
    )
  })

  const maxFileBytes = Math.max(1, ...filteredPairs.map(p => p.sizeBytes))
  const rightQueueItems = filteredPairs.map(item => {
    const isChecked = checkedIds.includes(item.id)
    const statusLabel = getDiffStatusLabel(item.diffStatus)
    const sizeRatio = Math.max(12, Math.min(100, Math.round((item.sizeBytes / maxFileBytes) * 100)))

    return List.Item({
      id: item.id,
      title: item.name,
      subtitle: `SHA-256: ${item.leftSha256Short} ↔ ${item.rightSha256Short} · ${item.diffLinesSummary}`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => {
        if (c) {
          setCheckedIds(Array.from(new Set([...checkedIds, item.id])))
        } else {
          setCheckedIds(checkedIds.filter(id => id !== item.id))
        }
      },
      icon: {
        source: Icon.Document
      },
      accessories: [
        {
          progress: {
            value: sizeRatio
          }
        },
        {
          tag: {
            value: statusLabel
          }
        },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        title: item.name,
        children: [
          Action({
            title: `执行批量哈希/Diff比对并复制报告 (${checkedIds.length}对)`,
            icon: Icon.Bolt,
            onAction: handleRunCompareChecked
          }),
          Action({
            title: '在资源管理器定位左侧源文件',
            icon: Icon.Folder,
            onAction: () => {
              openComparedFileLocation(item.leftPath)
            }
          }),
          Action({
            title: '复制双侧 SHA-256 哈希对比摘要',
            icon: Icon.CopyClipboard,
            onAction: async () => {
              const summary = `${item.name} | Left: ${item.leftSha256Short} | Right: ${item.rightSha256Short} | ${statusLabel} (${item.diffLinesSummary})`
              await Clipboard.copy(summary)
              showToast({ style: Toast.Style.Success, title: '已复制 SHA-256 对比摘要' })
            }
          }),
          Action({
            title: '在资源管理器定位右侧目标文件',
            icon: Icon.Folder,
            onAction: () => {
              openComparedFileLocation(item.rightPath)
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索比对文件名、路径或 SHA-256 哈希值 (Modified / Identical)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '按差异状态筛选比对结果队列',
      value: diffFilterView,
      onChange: val => setDiffFilterView(val as any),
      children: [
        List.Dropdown.Item({ title: '视图: 全部比对文件', value: 'all' }),
        List.Dropdown.Item({ title: '视图: 仅看存在差异项', value: 'modified' }),
        List.Dropdown.Item({ title: '视图: 仅看完全一致项', value: 'identical' }),
        List.Dropdown.Item({ title: '视图: 仅看单侧独有项', value: 'added' })
      ]
    }),
    filterBar: FilterBar({
      summaryText: `共比对 ${pairs.length} 对文件 · 存在差异 ${modifiedCount} 对 · 完全一致 ${identicalCount} 对 · 新增文件 ${addedCount} 对 · 耗时 ${elapsedMs}ms`,
      actions: [
        {
          id: 'rescan-compare',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: '双目录/文件 Diff 比对工作台',
      subtitle: `${activeEngine.algorithm} · 耗时 ${elapsedMs}ms`,
      fields: [
        {
          id: 'wb-cmp-engine',
          label: '比对引擎模式',
          type: 'select',
          value: engineModeId,
          onChange: val => setEngineModeId(val),
          options: COMPARE_ENGINE_MODES.map(e => ({
            label: e.tag,
            value: e.id
          }))
        },
        {
          id: 'wb-cmp-ws',
          label: '忽略空白字符与行尾 CRLF/LF 差异',
          type: 'toggle',
          value: ignoreWhitespace,
          onChange: val => setIgnoreWhitespace(Boolean(val))
        },
        {
          id: 'wb-cmp-case',
          label: '忽略大小写差异',
          type: 'toggle',
          value: ignoreCase,
          onChange: val => setIgnoreCase(Boolean(val))
        },
        {
          id: 'wb-cmp-algo',
          label: '校验算法标准',
          type: 'info',
          value: `${activeEngine.algorithm} (64KB 分块流水线)`
        }
      ],
      previewCard: {
        title: '文件比对与哈希校验统计',
        badge: `${modifiedCount} 项差异`,
        subtitle: `当前引擎: ${activeEngine.title}`,
        metrics: [
          { label: '比对总文件对数', value: `${pairs.length} 对` },
          { label: '内容差异数', value: `${modifiedCount} 对` },
          { label: '完全一致数', value: `${identicalCount} 对` },
          { label: '哈希校验耗时', value: `${elapsedMs} ms` }
        ]
      }
    },
    subList: {
      title: '文件比对结果队列 (展示左右 SHA-256 指纹与行数差异，按 ↵ 导出比对报告)',
      subtitle: `${filteredPairs.length} 对文件 · 存在差异 ${modifiedCount} · 完全一致 ${identicalCount} · 新增文件 ${addedCount}`,
      checkable: filteredPairs.length > 0,
      checked:
        filteredPairs.length > 0 && filteredPairs.every(p => checkedIds.includes(p.id))
          ? true
          : filteredPairs.some(p => checkedIds.includes(p.id))
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        setCheckedIds(checked ? filteredPairs.map(p => p.id) : [])
      },
      emptyText: '当前过滤视图下暂无匹配文件对',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `双侧文件哈希与 Diff 比对队列 (${filteredPairs.length})`,
        children: rightQueueItems
      })
    ]
  })
}

export default FileCompareCommand

