/**
 * 示例通用列表导入 UI 状态 Hook 与标准动作生成辅助
 * 统一封装批次号防竞态、AbortController 取消、顶栏 2 按钮与 ActionPanel 列表管理区，避免 13 个示例重复实现
 */
import { Action, ActionPanel, Icon, Toast, confirmAlert, showToast, useEffect, useRef, useState } from '../../index.js'
import {
  type ExampleImportProgress,
  type ExampleImportResult,
  type ExampleImportRules,
  type ExampleImportedFile,
  type NormalizedExampleFileInput,
  createExampleImportProps,
  expandExampleInputPaths,
  friendlyExampleFileError,
  mergeExampleByPath,
  pickExampleFiles,
  pickExampleFolderFiles,
  summarizeExampleImport
} from './file-import.js'

export interface UseExampleImportQueueOptions<TItem> {
  rules: ExampleImportRules
  toItem: (file: ExampleImportedFile, index: number) => TItem
  pathOf: (item: TItem) => string
  idOf: (item: TItem) => string
  fileTitle: string
  folderTitle: string
  filterName?: string
  supportedText?: string
  defaultChecked?: boolean
  isBusy?: () => boolean
  dropTitle?: string
  dropSubtitle?: string
  onImported?: (added: TItem[], merged: TItem[]) => void | Promise<void>
  onCleared?: () => void
  onTextPaste?: (text: string) => boolean | void | Promise<boolean | void>
  allowClipboardImage?: boolean
}

export function buildTopImportActions(onPickFiles: () => void, onPickFolder: () => void) {
  return [
    { id: 'pick-files', label: '选择文件', title: '选择文件', style: 'secondary', onAction: onPickFiles },
    { id: 'pick-folder', label: '选择文件夹', title: '选择文件夹', style: 'secondary', onAction: onPickFolder }
  ]
}

export function buildImportEmptyActionPanel(
  onPickFiles: () => void,
  onPickFolder: () => void,
  extraActions: ReturnType<typeof Action>[] = []
) {
  return ActionPanel({
    children: [
      Action({ title: '选择文件…', icon: Icon.Document, shortcut: { modifiers: ['ctrl'], key: 'o' }, onAction: onPickFiles }),
      Action({ title: '选择文件夹…', icon: Icon.Folder, shortcut: { modifiers: ['ctrl', 'shift'], key: 'o' }, onAction: onPickFolder }),
      ...extraActions
    ]
  })
}

export function buildListManagementSection(opts: {
  onRemove?: () => void
  canRemove?: boolean
  onPickFiles: () => void
  onPickFolder: () => void
  onToggleAll?: () => void
  allSelected?: boolean
  onClear: () => void
}) {
  const children: ReturnType<typeof Action>[] = []
  if (opts.onRemove && opts.canRemove !== false) {
    children.push(
      Action({ title: '从列表移除', icon: Icon.Minus, shortcut: { modifiers: ['ctrl'], key: 'backspace' }, onAction: opts.onRemove })
    )
  }
  children.push(
    Action({ title: '选择文件…', icon: Icon.Document, shortcut: { modifiers: ['ctrl'], key: 'o' }, onAction: opts.onPickFiles }),
    Action({ title: '选择文件夹…', icon: Icon.Folder, shortcut: { modifiers: ['ctrl', 'shift'], key: 'o' }, onAction: opts.onPickFolder })
  )
  if (opts.onToggleAll) {
    children.push(
      Action({
        title: opts.allSelected ? '取消全选' : '全选列表',
        icon: Icon.CheckCircle,
        shortcut: { modifiers: ['ctrl'], key: 'a' },
        onAction: opts.onToggleAll
      })
    )
  }
  children.push(
    Action({
      title: '清空列表',
      icon: Icon.Trash,
      style: Action.Style.Destructive,
      shortcut: { modifiers: ['ctrl', 'shift'], key: 'backspace' },
      onAction: opts.onClear
    })
  )
  return ActionPanel.Section({ title: '列表', children })
}

export function useExampleImportQueue<TItem>(options: UseExampleImportQueueOptions<TItem>) {
  const [items, setItems] = useState<TItem[]>([])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [isImporting, setIsImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<ExampleImportProgress | null>(null)

  const itemsRef = useRef<TItem[]>([])
  itemsRef.current = items
  const seqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      seqRef.current += 1
      abortRef.current?.abort()
    }
  }, [])

  const applyResult = async (result: ExampleImportResult) => {
    const startIdx = itemsRef.current.length
    const incoming = result.files.map((f, idx) => options.toItem(f, startIdx + idx))
    const { merged, added, duplicates } = mergeExampleByPath(itemsRef.current, incoming, options.pathOf)
    if (added.length > 0) {
      itemsRef.current = merged
      setItems(merged)
      if (options.defaultChecked !== false) {
        const newIds = added.map(options.idOf)
        setCheckedIds(prev => Array.from(new Set([...prev, ...newIds])))
      }
      await options.onImported?.(added, merged)
    }
    const summary = summarizeExampleImport(result, { added: added.length, duplicates }, options.supportedText)
    if (summary) {
      await showToast({ style: summary.ok ? Toast.Style.Success : Toast.Style.Failure, title: summary.title, message: summary.message })
    }
  }

  const runImport = async (runner: (signal: AbortSignal, onProgress: (p: ExampleImportProgress) => void) => Promise<ExampleImportResult>) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const seq = ++seqRef.current
    setIsImporting(true)
    setImportProgress(null)
    try {
      const res = await runner(controller.signal, p => {
        if (aliveRef.current && seq === seqRef.current) setImportProgress(p)
      })
      if (!aliveRef.current || seq !== seqRef.current) return
      await applyResult(res)
    } catch (err) {
      if (!aliveRef.current || seq !== seqRef.current) return
      await showToast({ style: Toast.Style.Failure, title: '导入失败', message: friendlyExampleFileError(err) })
    } finally {
      if (aliveRef.current && seq === seqRef.current) {
        abortRef.current = null
        setIsImporting(false)
        setImportProgress(null)
      }
    }
  }

  const handlePickFiles = () => {
    void runImport(() => pickExampleFiles(options.rules, { title: options.fileTitle, filterName: options.filterName }))
  }

  const handlePickFolder = () => {
    void runImport((signal, onProgress) =>
      pickExampleFolderFiles(options.rules, {
        title: options.folderTitle,
        signal,
        onProgress,
        confirmVolumeRoot: folderPath =>
          confirmAlert({
            title: `导入整个磁盘 ${folderPath}？`,
            message: '将逐层扫描符合规则的文件，目录较大时可能耗时较长。',
            primaryAction: { title: '继续导入', style: 'default' }
          })
      })
    )
  }

  const handleFileInput = (input: NormalizedExampleFileInput) => {
    void runImport((signal, onProgress) =>
      expandExampleInputPaths(input.paths, options.rules, { knownDirectories: input.directories, signal, onProgress })
    )
  }

  const removeItem = (id: string) => {
    const next = itemsRef.current.filter(item => options.idOf(item) !== id)
    itemsRef.current = next
    setItems(next)
    setCheckedIds(prev => prev.filter(cid => cid !== id))
  }

  const clearQueue = () => {
    if (options.isBusy?.()) {
      void showToast({ style: Toast.Style.Failure, title: '正在处理，完成后再清空' })
      return
    }
    seqRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    setIsImporting(false)
    setImportProgress(null)
    itemsRef.current = []
    setItems([])
    setCheckedIds([])
    options.onCleared?.()
  }

  const toggleCheck = (id: string, checked?: boolean) => {
    setCheckedIds(prev => {
      const has = prev.includes(id)
      const nextChecked = checked !== undefined ? checked : !has
      if (nextChecked && !has) return [...prev, id]
      if (!nextChecked && has) return prev.filter(x => x !== id)
      return prev
    })
  }

  const toggleAllVisible = (visibleItems: readonly TItem[]) => {
    const ids = visibleItems.map(options.idOf)
    const allChecked = ids.length > 0 && ids.every(id => checkedIds.includes(id))
    if (allChecked) {
      const rm = new Set(ids)
      setCheckedIds(prev => prev.filter(id => !rm.has(id)))
    } else {
      setCheckedIds(prev => Array.from(new Set([...prev, ...ids])))
    }
  }

  const replaceItems = (updater: TItem[] | ((prev: TItem[]) => TItem[])) => {
    const next = typeof updater === 'function' ? updater(itemsRef.current) : updater
    itemsRef.current = next
    setItems(next)
  }

  const fileInputProps = createExampleImportProps(handleFileInput, {
    dropTitle: options.dropTitle || '拖入文件或文件夹',
    dropSubtitle: options.dropSubtitle || '松开后自动筛选并加入列表',
    allowClipboardImage: options.allowClipboardImage,
    onTextPaste: options.onTextPaste
  })

  const importStatusText = importProgress
    ? `正在导入：已读取 ${importProgress.visitedDirs} 个文件夹，找到 ${importProgress.matchedFiles} 个文件`
    : isImporting
      ? '正在导入文件...'
      : ''

  return {
    items,
    itemsRef,
    setItems: replaceItems,
    checkedIds,
    setCheckedIds,
    isImporting,
    importProgress,
    importStatusText,
    fileInputProps,
    handlePickFiles,
    handlePickFolder,
    handleFileInput,
    removeItem,
    clearQueue,
    toggleCheck,
    toggleAllVisible,
    topBarActions: buildTopImportActions(handlePickFiles, handlePickFolder),
    emptyActions: buildImportEmptyActionPanel(handlePickFiles, handlePickFolder)
  }
}
