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
  MetricGrid,
  FilterBar,
  SegmentedControl
} from '../../index.js'
import {
  INITIAL_OCR_QUEUE_ITEMS,
  OCR_LANGUAGE_MODELS,
  OcrLanguagePreset,
  OcrQueueItem,
  captureScreenAreaOcr,
  executeBatchOcr,
  fetchOcrWorkspace,
  formatBytes,
  openOcrFileLocation
} from './logic.js'

export * from './logic.js'

export function OcrCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'queue' | 'models'>('queue')
  const [languageModelId, setLanguageModelId] = useState<string>(OCR_LANGUAGE_MODELS[0].id)
  const [layoutStrategy, setLayoutStrategy] = useState<'natural_paragraph' | 'single_line' | 'markdown_table'>('natural_paragraph')
  const [postAction, setPostAction] = useState<'copy_clipboard' | 'export_file'>('copy_clipboard')
  const [filterStampNoise, setFilterStampNoise] = useState<boolean>(true)
  const [items, setItems] = useState<OcrQueueItem[]>(INITIAL_OCR_QUEUE_ITEMS)
  const [checkedIds, setCheckedIds] = useState<string[]>(INITIAL_OCR_QUEUE_ITEMS.map(i => i.id))
  const [models, setModels] = useState<OcrLanguagePreset[]>(OCR_LANGUAGE_MODELS)
  const [scannedDirs, setScannedDirs] = useState<string[]>(['C:\\Users\\Geek\\Pictures\\Screenshots', 'C:\\Users\\Geek\\Desktop'])
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchOcrWorkspace()
      setItems(ws.items)
      setCheckedIds(ws.items.map(i => i.id))
      setModels(ws.models)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'OCR 识别队列已刷新',
          message: `已就绪 ${ws.items.length} 张本机截图与图片`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeModel = models.find(m => m.id === languageModelId) || OCR_LANGUAGE_MODELS[0]

  async function handleRunBatchOcr() {
    const selected = items.filter(i => checkedIds.includes(i.id))
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
    await Clipboard.copy(res.combinedText)
    showToast({
      style: Toast.Style.Success,
      title: `已识别 ${res.recognizedCount} 张图片并复制文字`,
      message: `平均单图耗时 ~${res.averageLatencyMs}ms · 共提取 ${res.combinedText.length} 字符`
    })
  }

  async function handleCaptureScreenOcr() {
    const res = await captureScreenAreaOcr()
    if (res.ok) {
      await Clipboard.copy(res.text)
      showToast({
        style: Toast.Style.Success,
        title: res.message,
        message: res.text.slice(0, 64)
      })
    }
  }

  const selectedItems = items.filter(i => checkedIds.includes(i.id))
  const totalBytes = selectedItems.reduce((s, i) => s + i.sizeBytes, 0)
  const q = searchText.trim().toLowerCase()
  const filteredItems = items.filter(
    i =>
      !q ||
      i.name.toLowerCase().includes(q) ||
      i.path.toLowerCase().includes(q) ||
      i.sampleText.toLowerCase().includes(q)
  )

  const maxImgBytes = Math.max(1, filteredItems[0]?.sizeBytes || 1)
  const rightQueueItems = filteredItems.map(item => {
    const isChecked = checkedIds.includes(item.id)
    const volRatio = Math.max(10, Math.min(100, Math.round((item.sizeBytes / maxImgBytes) * 100)))

    return List.Item({
      id: item.id,
      title: item.name,
      subtitle: `${item.sampleText.slice(0, 65)}`,
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
        source: Icon.Text
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `置信度 ${item.confidencePercent}%`
          }
        },
        { text: formatBytes(item.sizeBytes) }
      ],
      actions: ActionPanel({
        title: item.name,
        children: [
          Action({
            title: `识别已勾选图片并复制文字 (${checkedIds.length}项)`,
            icon: Icon.Text,
            onAction: handleRunBatchOcr
          }),
          Action({
            title: '即时框选屏幕区域 OCR',
            icon: Icon.Camera,
            onAction: handleCaptureScreenOcr
          }),
          Action({
            title: '仅复制当前图片提取文本',
            icon: Icon.CopyClipboard,
            onAction: async () => {
              await Clipboard.copy(item.sampleText)
              showToast({ style: Toast.Style.Success, title: `已复制 ${item.name} 识别文本` })
            }
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openOcrFileLocation(item.path)
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索待识别截图、提取文本内容或语言模型 (中英混合 / 代码段 / 公式表格)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 5 大离线 OCR 识别语言模型',
      value: languageModelId,
      onChange: val => setLanguageModelId(val),
      children: OCR_LANGUAGE_MODELS.map(m =>
        List.Dropdown.Item({
          title: `语言模型: ${m.tag}`,
          value: m.id
        })
      )
    }),
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'ocr-count',
          label: '已选 / 扫描图片数',
          value: `${checkedIds.length} / ${items.length} 张`,
          subValue: `${scannedDirs.length} 个截图与图片目录`,
          status: 'normal'
        },
        {
          id: 'ocr-latency',
          label: '平均单图识别耗时',
          value: `~${activeModel.avgLatencyMs}ms`,
          subValue: '本地离线 ONNX 极速推理',
          status: 'success'
        },
        {
          id: 'ocr-model',
          label: '当前激活识别引擎',
          value: activeModel.tag,
          subValue: activeModel.engineCode,
          status: 'success'
        },
        {
          id: 'ocr-size',
          label: '已选队列总体积',
          value: formatBytes(totalBytes),
          subValue: filterStampNoise ? '印章与底噪过滤已开启' : '原图直读模式',
          status: 'normal'
        }
      ]
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 扫描近期截图与图片', status: 'done' },
        { step: 2, label: '2. 选择多语种/公式模型', status: 'done' },
        { step: 3, label: '3. 配置版面还原策略', status: 'active' },
        { step: 4, label: '4. 批量提取至剪贴板', status: 'pending' }
      ],
      summaryText: `已选 ${checkedIds.length}/${items.length} 张待识别图片 (${formatBytes(totalBytes)}) · 引擎: ${activeModel.tag} · 平均耗时 ~${activeModel.avgLatencyMs}ms`,
      groups: [
        {
          id: 'ocr-lang-model',
          label: '识别模型',
          value: languageModelId,
          onChange: v => setLanguageModelId(v),
          options: OCR_LANGUAGE_MODELS.map(m => ({
            value: m.id,
            label: m.tag
          }))
        }
      ],
      actions: [
        {
          id: 'rescan-ocr',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: '离线 OCR 文字提取工作台',
      subtitle: `${activeModel.engineCode} · ~${activeModel.avgLatencyMs}ms/图`,
      fields: [
        {
          id: 'wb-ocr-lang',
          label: '识别语言模型',
          type: 'select',
          value: languageModelId,
          onChange: val => setLanguageModelId(val),
          options: OCR_LANGUAGE_MODELS.map(m => ({
            label: m.tag,
            value: m.id
          }))
        },
        {
          id: 'wb-ocr-layout',
          label: '版面还原策略',
          type: 'select',
          value: layoutStrategy,
          onChange: val => setLayoutStrategy(val as any),
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
          onChange: val => setPostAction(val as any),
          options: [
            { label: '自动复制结果到剪贴板', value: 'copy_clipboard' },
            { label: '导出同名 .txt 或 .md 文件', value: 'export_file' }
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
          { label: '已选图片数', value: `${checkedIds.length} / ${items.length} 张` },
          { label: '单图平均耗时', value: `~${activeModel.avgLatencyMs}ms` },
          { label: '版面还原模式', value: layoutStrategy === 'markdown_table' ? 'Markdown 表格' : layoutStrategy === 'single_line' ? '单行合并' : '自然段落' }
        ]
      }
    },
    subList: {
      title: '待 OCR 识别图片与截图队列 (勾选或按 ↵ 立即识别并复制文字，按 ⌘↵ 框选屏幕区域 OCR)',
      subtitle: `${filteredItems.length} 张图片 · 已选 ${checkedIds.length} 项 · 引擎: ${activeModel.tag}`,
      checkable: filteredItems.length > 0,
      checked:
        filteredItems.length > 0 && filteredItems.every(i => checkedIds.includes(i.id))
          ? true
          : filteredItems.some(i => checkedIds.includes(i.id))
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        setCheckedIds(checked ? filteredItems.map(i => i.id) : [])
      },
      emptyText: '当前未找到待识别图片或截图',
      items: rightQueueItems
    },
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'queue', label: '待识别截图队列', badge: items.length },
        { value: 'models', label: '5 大识别模型', badge: models.length }
      ]
    }),
    children: [
      List.Section({
        title: `本机待识别截图与图片队列 (${filteredItems.length})`,
        children: rightQueueItems
      })
    ]
  })
}

export default OcrCommand
