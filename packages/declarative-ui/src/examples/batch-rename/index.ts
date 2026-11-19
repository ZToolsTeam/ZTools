/**
 * 批量文件重命名工作台视图 (BatchRename 2.0 - 布局二：左 32% 10 大重命名规则导航树 + 右 68% 实时原名->新名对比可勾选列表)
 * - 初始列表为空 []，不扫描任何本机默认目录
 * - 顶栏固定 2 个全局按钮：选择文件、选择文件夹（仅取一级子文件）
 */

import { Action, ActionPanel, Icon, List, Toast, showToast, useRef, useState } from '../../index.js'
import { formatBytes } from '../shared/native-ipc.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  BATCH_RENAME_IMPORT_RULES,
  RENAME_RULE_PRESETS,
  applyRenameRule,
  executeRealFileRename,
  openRenameFileLocation,
  toRealFileEntry,
  undoBatchRenameHistory,
  type RealFileEntry,
  type RenameRule,
  type RenameRuleType,
  type RenameUndoEntry
} from './logic.js'

type SortOrder = 'imported' | 'name_asc' | 'size_desc'

export function BatchRenameCommand() {
  const [sortOrder, setSortOrder] = useState<SortOrder>('imported')
  const [ruleType, setRuleType] = useState<RenameRuleType>('number')
  const [searchText, setSearchText] = useState<string>('')
  const [undoStack, setUndoStack] = useState<RenameUndoEntry[]>([])
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [isRunning, setIsRunning] = useState<boolean>(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<RealFileEntry>({
    rules: BATCH_RENAME_IMPORT_RULES,
    toItem: file => toRealFileEntry(file),
    pathOf: item => item.fullPath,
    idOf: item => item.fullPath,
    fileTitle: '选择要批量重命名的文件',
    folderTitle: '选择要批量重命名的文件夹（仅读取一级文件）',
    filterName: '所有文件',
    defaultChecked: true,
    isBusy: () => runningRef.current,
    dropTitle: '拖入待重命名的文件或文件夹',
    dropSubtitle: '文件夹仅导入一级子文件',
    onCleared: () => {
      setUndoStack([])
      setStatusMessage('')
    }
  })

  const trimmedQuery = searchText.trim()
  const buildActiveRule = (): RenameRule => {
    if (trimmedQuery.includes('->')) {
      const [findPart, replacePart] = trimmedQuery.split('->')
      return {
        type: 'replace',
        find: (findPart || '').trim(),
        replace: (replacePart || '').trim()
      }
    }
    switch (ruleType) {
      case 'prefix':
        return { type: 'prefix', prefix: trimmedQuery || 'ZTools_' }
      case 'date_prefix':
        return { type: 'date_prefix' }
      case 'suffix':
        return { type: 'suffix', suffix: trimmedQuery || '_v2' }
      case 'case':
        return { type: 'case', caseMode: 'lower' }
      case 'number_cn':
        return { type: 'number_cn' }
      case 'number_roman':
        return { type: 'number_roman' }
      case 'trim_head3':
        return { type: 'trim_head3' }
      case 'clean_brackets':
        return { type: 'clean_brackets' }
      case 'snake_case':
        return { type: 'snake_case' }
      case 'number':
      default:
        return { type: 'number', startNumber: 1, padDigits: 2 }
    }
  }

  const activeRule = buildActiveRule()
  const filterKeyword =
    trimmedQuery.includes('->') || ruleType === 'prefix' || ruleType === 'suffix' ? '' : trimmedQuery.toLowerCase()

  const sortedFiles = [...queue.items]
  if (sortOrder === 'name_asc') {
    sortedFiles.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  } else if (sortOrder === 'size_desc') {
    sortedFiles.sort((a, b) => b.sizeBytes - a.sizeBytes)
  }

  const visibleFiles = sortedFiles.filter(file => !filterKeyword || file.name.toLowerCase().includes(filterKeyword))
  const checkedSet = new Set(queue.checkedIds)
  const seenTargetsByDir = new Map<string, Set<string>>()

  const previewItems = visibleFiles.map((file, idx) => {
    const isChecked = checkedSet.has(file.fullPath)
    const newName = applyRenameRule(file.name, activeRule, idx)
    const dirKey = file.parentDir.toLowerCase()
    let seen = seenTargetsByDir.get(dirKey)
    if (!seen) {
      seen = new Set<string>()
      seenTargetsByDir.set(dirKey, seen)
    }
    const lowerTarget = newName.toLowerCase()
    const hasConflict = seen.has(lowerTarget)
    seen.add(lowerTarget)
    return { ...file, newName, changed: newName !== file.name, conflict: hasConflict, isChecked }
  })

  const selectedItems = previewItems.filter(item => item.isChecked)
  const changedSelectedCount = selectedItems.filter(item => item.changed && !item.conflict).length
  const conflictCount = previewItems.filter(item => item.conflict).length

  const applyRenamedEntries = (batch: RenameUndoEntry[], reverse = false) => {
    const mapByPath = new Map<string, RenameUndoEntry>()
    for (const entry of batch) {
      mapByPath.set(reverse ? entry.newPath : entry.oldPath, entry)
    }
    queue.setItems(prev =>
      prev.map(item => {
        const matched = mapByPath.get(item.fullPath)
        if (!matched) return item
        const nextPath = reverse ? matched.oldPath : matched.newPath
        const nextName = reverse ? matched.oldName : matched.newName
        const dot = nextName.lastIndexOf('.')
        return {
          ...item,
          name: nextName,
          fullPath: nextPath,
          extension: dot > 0 ? nextName.slice(dot).toLowerCase() : item.extension
        }
      })
    )
    queue.setCheckedIds(prev =>
      prev.map(p => {
        const matched = mapByPath.get(p)
        return matched ? (reverse ? matched.oldPath : matched.newPath) : p
      })
    )
  }

  const executeBatchRename = async () => {
    const targets = selectedItems.filter(item => item.changed && !item.conflict)
    if (targets.length === 0) {
      setStatusMessage('没有需要改名的已勾选文件，或存在同名冲突需先解除')
      await showToast({ style: Toast.Style.Failure, title: '没有可执行的改名项' })
      return
    }
    runningRef.current = true
    setIsRunning(true)
    const historyBatch: RenameUndoEntry[] = []
    let successCount = 0
    try {
      for (const item of targets) {
        const res = await executeRealFileRename(item.fullPath, item.newName)
        if (res.ok && res.destinationPath) {
          successCount += 1
          historyBatch.push({ oldPath: item.fullPath, newPath: res.destinationPath, oldName: item.name, newName: item.newName })
        }
      }
      if (historyBatch.length > 0) {
        applyRenamedEntries(historyBatch, false)
        setUndoStack(historyBatch)
      }
      const msg = `已完成批量重命名：成功改名 ${successCount}/${targets.length} 个文件`
      setStatusMessage(msg)
      await showToast({ style: successCount > 0 ? Toast.Style.Success : Toast.Style.Failure, title: msg })
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  const handleUndoLastBatch = async () => {
    if (undoStack.length === 0) {
      setStatusMessage('当前没有可撤销的重命名历史记录')
      return
    }
    runningRef.current = true
    setIsRunning(true)
    try {
      const res = await undoBatchRenameHistory(undoStack)
      if (res.ok) {
        applyRenamedEntries(undoStack, true)
        setUndoStack([])
      }
      setStatusMessage(`已撤销回滚 ${res.restoredCount} 个文件至原文件名`)
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  const activePresetMeta = RENAME_RULE_PRESETS.find(r => r.id === ruleType) || RENAME_RULE_PRESETS[0]
  const allChecked = previewItems.length > 0 && previewItems.every(f => f.isChecked)
  const someChecked = previewItems.some(f => f.isChecked)

  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加文件 · 可选择文件、文件夹（仅读取一级文件），或直接拖入'
      : statusMessage ||
        `规则: ${activePresetMeta.label} · 已选 ${selectedItems.length}/${queue.items.length} 项 · 待改名 ${changedSelectedCount} 项` +
          (conflictCount > 0 ? ` · ${conflictCount} 项冲突` : '') +
          (undoStack.length > 0 ? ` · 可撤销 ${undoStack.length} 项` : '') +
          ' · 清空列表 Ctrl+Shift+Backspace'

  const maxSizeBytes = Math.max(1, ...previewItems.map(f => f.sizeBytes))

  const leftNavNodes = RENAME_RULE_PRESETS.map(preset => {
    const isActive = ruleType === preset.id
    return List.Item({
      id: `nav-rule-${preset.id}`,
      title: preset.label,
      subtitle: preset.desc,
      icon: Icon.Document,
      onSelect: () => setRuleType(preset.id),
      accessories: [{ tag: { value: isActive ? '当前生效' : '规则预设' } }],
      actions: ActionPanel({
        children: [
          Action({ title: `切换至「${preset.label}」规则`, icon: Icon.CheckCircle, onAction: () => setRuleType(preset.id) }),
          Action({
            title: `立即执行批量重命名 (${changedSelectedCount} 项)`,
            icon: Icon.ArrowRight,
            shortcut: { modifiers: ['ctrl'], key: 'return' },
            onAction: executeBatchRename
          }),
          Action({
            title: `撤销上一次批量重命名 (${undoStack.length} 项)`,
            icon: Icon.RotateAntiClockwise,
            onAction: handleUndoLastBatch
          }),
          buildListManagementSection({
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(visibleFiles),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  const subListItems = previewItems.map(item => {
    const ratio = Math.min(1, item.sizeBytes / maxSizeBytes)
    const statusLabel = item.conflict ? '同名冲突' : item.changed ? '待改名' : '保持不变'
    return List.Item({
      id: `rename-item-${item.fullPath}`,
      title: item.name,
      subtitle: `${item.parentDir} -> ${item.newName}`,
      icon: Icon.Document,
      checkable: true,
      checked: item.isChecked,
      onCheckChange: checked => queue.toggleCheck(item.fullPath, checked),
      onToggleCheck: checked => queue.toggleCheck(item.fullPath, checked),
      accessories: [
        { progress: ratio },
        { tag: { value: statusLabel, color: item.conflict ? 'red' : undefined } },
        { text: item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        children: [
          Action({ title: `执行批量重命名 (${changedSelectedCount} 个已选文件)`, icon: Icon.CheckCircle, onAction: executeBatchRename }),
          Action({
            title: undoStack.length > 0 ? `撤销上一次重命名回滚 (${undoStack.length} 项)` : '在资源管理器中定位此文件',
            icon: undoStack.length > 0 ? Icon.RotateAntiClockwise : Icon.Folder,
            shortcut: { modifiers: ['ctrl'], key: 'return' },
            onAction: async () => {
              if (undoStack.length > 0) await handleUndoLastBatch()
              else await openRenameFileLocation(item.fullPath)
            }
          }),
          Action({
            title: '单条立即改名此文件',
            icon: Icon.Document,
            onAction: async () => {
              const res = await executeRealFileRename(item.fullPath, item.newName)
              if (res.ok && res.destinationPath) {
                applyRenamedEntries([{ oldPath: item.fullPath, newPath: res.destinationPath, oldName: item.name, newName: item.newName }], false)
                setStatusMessage(`已将 ${item.name} 改名为 ${item.newName}`)
              } else {
                setStatusMessage(`改名失败: ${res.error}`)
              }
            }
          }),
          Action({ title: '在资源管理器中定位此文件', icon: Icon.Folder, onAction: () => void openRenameFileLocation(item.fullPath) }),
          buildListManagementSection({
            canRemove: !isRunning,
            onRemove: () => queue.removeItem(item.fullPath),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(visibleFiles),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  return List({
    ...queue.fileInputProps,
    isLoading: isRunning || queue.isImporting,
    searchBarPlaceholder: '输入「旧词->新词」实时替换，或输入前缀/后缀参数、搜索文件名...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择待重命名文件排序方式',
      value: sortOrder,
      onChange: val => setSortOrder(val as SortOrder),
      children: [
        List.Dropdown.Item({ title: '排序: 按导入顺序', value: 'imported' }),
        List.Dropdown.Item({ title: '排序: 按文件名升序', value: 'name_asc' }),
        List.Dropdown.Item({ title: '排序: 按文件大小降序', value: 'size_desc' })
      ]
    }),
    filterBar: { summaryText, actions: queue.topBarActions },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    subList: {
      title: `原名 -> 新名实时对比预览 (${previewItems.length} 项 · 待执行 ${changedSelectedCount} 项)`,
      subtitle: queue.items.length === 0 ? '请选择文件、文件夹或拖入文件' : `${queue.items.length} 个文件`,
      emptyText: '尚未添加文件，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      checkable: previewItems.length > 0,
      checked: allChecked ? true : someChecked ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(visibleFiles),
      items: subListItems
    },
    children: [
      List.Section({
        title: '10 大重命名规则预设导航 (32%)',
        subtitle: '点击实时预览新文件名',
        children: leftNavNodes
      })
    ]
  })
}

export default BatchRenameCommand
