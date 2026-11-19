import {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  useState,
  useRef,
  showToast,
  Toast,
  FilterBar
} from '../../index.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  OCR_IMPORT_RULES,
  OCR_LANGUAGE_MODELS,
  OCR_SUPPORTED_TEXT,
  OcrQueueItem,
  captureScreenAreaOcr,
  executeBatchOcr,
  formatBytes,
  openOcrFileLocation,
  toOcrQueueItem
} from './logic.js'

export * from './logic.js'

export function OcrCommand() {
  const [searchText, setSearchText] = useState('')
  const [languageModelId, setLanguageModelId] = useState<string>(OCR_LANGUAGE_MODELS[0].id)
  const [layoutStrategy, setLayoutStrategy] = useState<'natural_paragraph' | 'single_line' | 'markdown_table'>('natural_paragraph')
  const [postAction, setPostAction] = useState<'copy_clipboard' | 'export_file' | 'copy_and_export'>('copy_clipboard')
  const [filterStampNoise, setFilterStampNoise] = useState<boolean>(true)
  const [isRunning, setIsRunning] = useState(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<OcrQueueItem>({
    rules: OCR_IMPORT_RULES,
    toItem: (file, idx) => toOcrQueueItem(file, idx),
    pathOf: item => item.path,
    idOf: item => item.id,
    fileTitle: '添加待识别图片',
    folderTitle: '选择包含待识别图片的文件夹（最多 100 张）',
    filterName: '图片文件',
    supportedText: OCR_SUPPORTED_TEXT,
    defaultChecked: true,
    isBusy: () => runningRef.current,
    allowClipboardImage: true,
    dropTitle: '拖入待识别的图片或文件夹',
    dropSubtitle: '文件夹内最多导入前 100 张图片'
  })

  const activeModel = OCR_LANGUAGE_MODELS.find(m => m.id === languageModelId) || OCR_LANGUAGE_MODELS[0]

  async function handleRunBatchOcr() {
    const selected = queue.items.filter(i => queue.checkedIds.includes(i.id))
    runningRef.current = true
    setIsRunning(true)
    try {
      const res = await executeBatchOcr(selected, {
        languageModelId,
        layoutStrategy,
        postAction,
        filterStampNoise
      })
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: 'OCR 识别未执行', message: res.error || '队列为空' })
        return
      }
      if (Array.isArray(res.items) && res.items.length > 0) {
        const recognizedMap = new Map(res.items.map(r => [r.id, r]))
        // 只更新仍在当前列表中的条目，避免将执行期间被移除的项加回
        queue.setItems(prev => prev.map(item => recognizedMap.get(item.id) ?? item))
      }
      if (postAction === 'copy_clipboard' || postAction === 'copy_and_export') {
        await Clipboard.copy(res.combinedText)
      }
      showToast({
        style: Toast.Style.Success,
        title: postAction === 'export_file' ? `已识别 ${res.recognizedCount} 张图片并导出文件` : `已识别 ${res.recognizedCount} 张图片并复制文字`,
        message: `平均单图耗时 ~${res.averageLatencyMs}ms · 共提取 ${res.combinedText.length} 字符`
      })
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  async function handleCaptureScreenOcr() {
    const res = await captureScreenAreaOcr()
    if (!res.ok) {
      showToast({ style: Toast.Style.Failure, title: '框选屏幕 OCR 失败', message: res.error || res.message })
      return
    }
    await Clipboard.copy(res.text)
    showToast({ style: Toast.Style.Success, title: res.message, message: res.text.slice(0, 64) })
  }

  const selectedItems = queue.items.filter(i => queue.checkedIds.includes(i.id))
  const totalBytes = selectedItems.reduce((s, i) => s + i.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredItems = queue.items.filter(
    i => !q || i.name.toLowerCase().includes(q) || i.path.toLowerCase().includes(q) || i.sampleText.toLowerCase().includes(q)
  )
  const allVisibleChecked = filteredItems.length > 0 && filteredItems.every(i => queue.checkedIds.includes(i.id))

  const maxImgBytes = Math.max(1, filteredItems[0]?.sizeBytes || 1)
  const rightQueueItems = filteredItems.map(item => {
    const isChecked = queue.checkedIds.includes(item.id)
    const volRatio = item.sizeBytes > 0 ? Math.max(10, Math.min(100, Math.round((item.sizeBytes / maxImgBytes) * 100))) : 0

    return List.Item({
      id: item.id,
      title: item.name,
      subtitle: item.sampleText ? item.sampleText.slice(0, 65) : item.parentDir,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => queue.toggleCheck(item.id, c),
      icon: { source: Icon.Text },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: item.confidencePercent > 0 ? `置信度 ${item.confidencePercent}%` : '待识别' } },
        { text: item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        title: item.name,
        children: [
          Action({ title: `识别已勾选图片 (${selectedItems.length}项)`, icon: Icon.Text, onAction: handleRunBatchOcr }),
          Action({ title: '截图识别', icon: Icon.Camera, shortcut: { modifiers: ['ctrl'], key: 'return' }, onAction: handleCaptureScreenOcr }),
          Action({
            title: '仅复制当前图片提取文本',
            icon: Icon.CopyClipboard,
            onAction: async () => {
              if (!item.sampleText) {
                showToast({ style: Toast.Style.Failure, title: '该图片尚未执行 OCR 识别' })
                return
              }
              await Clipboard.copy(item.sampleText)
              showToast({ style: Toast.Style.Success, title: `已复制 ${item.name} 识别文本` })
            }
          }),
          Action({ title: '在资源管理器定位', icon: Icon.Folder, onAction: () => { void openOcrFileLocation(item.path) } }),
          buildListManagementSection({
            canRemove: !isRunning,
            onRemove: () => queue.removeItem(item.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(filteredItems),
            allSelected: allVisibleChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  // OCR 顶栏严格保持 2 个按钮：「截图识别」「添加图片」
  const ocrTopActions = [
    { id: 'ocr-region', label: '截图识别', title: '截图识别', style: 'secondary', onAction: () => { void handleCaptureScreenOcr() } },
    { id: 'ocr-add-images', label: '添加图片', title: '添加图片', style: 'secondary', onAction: queue.handlePickFiles }
  ]

  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加图片 · 可截图识别、添加图片、选择文件夹，或直接拖入'
      : `已选 ${selectedItems.length}/${queue.items.length} 张图片 (${formatBytes(totalBytes)}) · 引擎: ${activeModel.tag} · 清空列表 Ctrl+Shift+Backspace`

  return List({
    ...queue.fileInputProps,
    searchBarPlaceholder: '搜索待识别截图、提取文本内容或语言模型 (中英混合 / 代码段 / 公式表格)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading: isRunning || queue.isImporting,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 5 大离线 OCR 识别语言模型',
      value: languageModelId,
      onChange: val => setLanguageModelId(val),
      children: OCR_LANGUAGE_MODELS.map(m => List.Dropdown.Item({ title: `语言模型: ${m.tag}`, value: m.id }))
    }),
    filterBar: FilterBar({ summaryText, actions: ocrTopActions }),
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder, [
      Action({ title: '截图识别', icon: Icon.Camera, shortcut: { modifiers: ['ctrl'], key: 'n' }, onAction: handleCaptureScreenOcr })
    ]),
    workbenchPanel: {
      title: '离线 OCR 文字提取工作台',
      subtitle: `${activeModel.engineCode} · ~${activeModel.avgLatencyMs}ms/图`,
      fields: [
        {
          id: 'wb-ocr-layout',
          label: '版面还原策略',
          type: 'select',
          value: layoutStrategy,
          onChange: val => setLayoutStrategy(val as typeof layoutStrategy),
          options: [
            { label: '保持自然段落排版', value: 'natural_paragraph' },
            { label: '合并为单行纯文本', value: 'single_line' },
            { label: '提取为 Markdown 表格', value: 'markdown_table' }
          ]
        },
        {
          id: 'wb-ocr-post',
          label: '识别后自动动作',
          type: 'select',
          value: postAction,
          onChange: val => setPostAction(val as typeof postAction),
          options: [
            { label: '自动复制结果到剪贴板', value: 'copy_clipboard' },
            { label: '导出同名 .txt 或 .md 文件', value: 'export_file' },
            { label: '复制剪贴板并导出文件', value: 'copy_and_export' }
          ]
        },
        {
          id: 'wb-ocr-stamp',
          label: '过滤印章与背景噪点',
          type: 'toggle',
          value: filterStampNoise,
          onChange: val => setFilterStampNoise(Boolean(val))
        },
        {
          id: 'wb-ocr-runtime',
          label: '推理引擎状态',
          type: 'info',
          value: '100% 本地离线推理 (零数据上传)'
        }
      ],
      previewCard: {
        title: '批量 OCR 识别性能预估',
        badge: `~${activeModel.avgLatencyMs}ms/图`,
        subtitle: `当前模型: ${activeModel.title}`,
        metrics: [
          { label: '识别引擎状态', value: 'ONNX 离线就绪' },
          { label: '已选图片数', value: `${selectedItems.length} / ${queue.items.length} 张` },
          { label: '单图平均耗时', value: `~${activeModel.avgLatencyMs}ms` },
          {
            label: '版面还原模式',
            value: layoutStrategy === 'markdown_table' ? 'Markdown 表格' : layoutStrategy === 'single_line' ? '单行合并' : '自然段落'
          }
        ]
      }
    },
    subList: {
      title: '待 OCR 识别图片与截图队列 (勾选或按 Enter 立即识别并复制文字)',
      subtitle: `${filteredItems.length} 张图片 · 已选 ${selectedItems.length} 项 · 引擎: ${activeModel.tag}`,
      checkable: filteredItems.length > 0,
      checked: allVisibleChecked ? true : filteredItems.some(i => queue.checkedIds.includes(i.id)) ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(filteredItems),
      emptyText: '尚未添加图片，按 Ctrl+O 添加图片、Ctrl+Shift+O 选择文件夹或点击截图识别',
      items: rightQueueItems
    },
    children: rightQueueItems.length > 0 ? [List.Section({ title: `待识别截图与图片队列 (${filteredItems.length})`, children: rightQueueItems })] : []
  })
}

export default OcrCommand
