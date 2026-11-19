import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  useState,
  useRef,
  showToast,
  Toast,
  confirmAlert,
  FilterBar
} from '../../index.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  CapabilityActionItem,
  PDF_TOOLBOX_IMPORT_RULES,
  PDF_TOOLBOX_MODES,
  PDF_TOOLBOX_SUPPORTED_TEXT,
  PdfToolCategory,
  RealPdfDocItem,
  formatBytes,
  invokeNativeCapability,
  openPdfDocument,
  openPdfFileLocation,
  toRealPdfDocItem
} from './logic.js'

export * from './logic.js'

const DOC_TYPE_LABELS: Record<RealPdfDocItem['docType'], string> = {
  pdf: 'PDF 文档',
  word: 'Word 文档',
  excel: 'Excel 表格',
  ppt: 'PPT 演示',
  image: '扫描图/PNG',
  other: '文本/Markdown'
}

export function PdfCommand() {
  const [searchText, setSearchText] = useState('')
  const [toolCat, setToolCat] = useState<'all' | PdfToolCategory>('all')
  const [activeToolId, setActiveToolId] = useState<string>(PDF_TOOLBOX_MODES[0].id)
  const [pageRangeMode, setPageRangeMode] = useState<'all' | 'first5' | 'odd' | 'even' | 'single_split'>('all')
  const [renderDpi, setRenderDpi] = useState<'300' | '150' | '72'>('300')
  const [compressionLevel, setCompressionLevel] = useState<'lossless' | 'archive' | 'raw'>('lossless')
  const [keepBookmarks, setKeepBookmarks] = useState<boolean>(true)
  const [isRunning, setIsRunning] = useState(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<RealPdfDocItem>({
    rules: PDF_TOOLBOX_IMPORT_RULES,
    toItem: (file, idx) => toRealPdfDocItem(file, idx),
    pathOf: f => f.path,
    idOf: f => f.id,
    fileTitle: '选择 PDF 或可转换文档',
    folderTitle: '选择包含 PDF 或待转换文档的文件夹',
    filterName: 'PDF 与办公文档',
    supportedText: PDF_TOOLBOX_SUPPORTED_TEXT,
    defaultChecked: true,
    isBusy: () => runningRef.current,
    dropTitle: '拖入 PDF、Office 文档或图片',
    dropSubtitle: '文件夹内 5 层以内支持的文档会自动导入'
  })

  const presets = PDF_TOOLBOX_MODES
  const activeTool = presets.find(p => p.id === activeToolId) || PDF_TOOLBOX_MODES[0]

  async function handleRunBatchChecked() {
    const selected = queue.items.filter(f => queue.checkedIds.includes(f.id))
    if (selected.length === 0) {
      showToast({ style: Toast.Style.Failure, title: '请先勾选待处理的文档或图片' })
      return
    }
    const ok = await confirmAlert({
      title: `确认对 ${selected.length} 份文档执行「${activeTool.title}」？`,
      message: `页码范围策略: ${pageRangeMode} · 渲染精度: ${renderDpi} DPI · 压缩: ${compressionLevel}\n执行方法: ${activeTool.method}`,
      primaryAction: { title: '开始批量执行', style: 'default' }
    })
    if (!ok) return

    runningRef.current = true
    setIsRunning(true)
    try {
      const outputDir = selected[0]?.parentDir || ''
      if (activeToolId === 'merge' || activeToolId === 'pdf-merge' || activeTool.method === 'MergePdf') {
        const res = await invokeNativeCapability('MergePdf', {
          ...activeTool.params,
          paths: selected.map(f => f.path),
          inputPath: selected[0].path,
          outputDir,
          pageRangeMode,
          renderDpi: Number(renderDpi),
          compressionLevel,
          keepBookmarks
        })
        if (!res.ok) {
          showToast({ style: Toast.Style.Failure, title: '批量 PDF 合并未执行成功', message: res.error || 'PDF 合并调用失败' })
          return
        }
        showToast({ style: Toast.Style.Success, title: `已完成 ${selected.length} 份文档无损合并`, message: activeTool.title })
        return
      }

      let count = 0
      let lastErr = ''
      for (const f of selected) {
        const res = await invokeNativeCapability(activeTool.method, {
          ...activeTool.params,
          pageRangeMode,
          renderDpi: Number(renderDpi),
          compressionLevel,
          keepBookmarks,
          outputDir: f.parentDir || outputDir,
          inputPath: f.path
        })
        if (res.ok) count += 1
        else lastErr = res.error || 'PDF 转换调用失败'
      }
      if (count === 0) {
        showToast({ style: Toast.Style.Failure, title: '批量 PDF 任务未执行成功', message: lastErr })
        return
      }
      showToast({ style: Toast.Style.Success, title: `已完成 ${count} 份文档任务下发`, message: activeTool.title })
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  async function handleRunPreset(preset: CapabilityActionItem, targetFile?: RealPdfDocItem) {
    try {
      const payload = targetFile
        ? { ...preset.params, pageRangeMode, renderDpi: Number(renderDpi), compressionLevel, keepBookmarks, inputPath: targetFile.path }
        : { ...preset.params, pageRangeMode, renderDpi: Number(renderDpi), compressionLevel, keepBookmarks }
      const res = await invokeNativeCapability(preset.method, payload)
      if (!res.ok) {
        showToast({ style: Toast.Style.Failure, title: 'PDF 处理失败', message: res.error || '原生模块返回错误' })
        return
      }
      showToast({ style: Toast.Style.Success, title: 'PDF 任务指令已下发', message: `${preset.title}${targetFile ? ` (${targetFile.name})` : ''}` })
    } catch (err) {
      showToast({ style: Toast.Style.Failure, title: '安全拦截', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const selectedFiles = queue.items.filter(f => queue.checkedIds.includes(f.id))
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const selectedPages = selectedFiles.reduce((s, f) => s + f.estimatedPages, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = queue.items.filter(f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
  const filteredPresets = presets.filter(p => {
    if (toolCat !== 'all' && p.category !== toolCat) return false
    if (!q) return true
    return p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  })
  const allVisibleChecked = filteredFiles.length > 0 && filteredFiles.every(f => queue.checkedIds.includes(f.id))

  const maxDocBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = queue.checkedIds.includes(f.id)
    const volRatio = f.sizeBytes > 0 ? Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxDocBytes) * 100))) : 0

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · 约 ${f.estimatedPages} 页 · ${DOC_TYPE_LABELS[f.docType]} -> ${activeTool.tag}`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => queue.toggleCheck(f.id, c),
      icon: { source: Icon.Document },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: `${f.estimatedPages}页 -> ${activeTool.tag}` } },
        { text: f.sizeBytes > 0 ? formatBytes(f.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({ title: `开始批量执行 (${selectedFiles.length}份)`, icon: Icon.Bolt, onAction: handleRunBatchChecked }),
          Action({ title: '在资源管理器中定位文档', icon: Icon.Folder, onAction: () => { void openPdfFileLocation(f.path) } }),
          Action({ title: `仅对当前文档执行「${activeTool.tag}」`, icon: Icon.Play, onAction: () => handleRunPreset(activeTool, f) }),
          Action({ title: '使用系统默认阅读器打开文档', icon: Icon.Eye, onAction: () => { void openPdfDocument(f.path) } }),
          buildListManagementSection({
            canRemove: !isRunning,
            onRemove: () => queue.removeItem(f.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(filteredFiles),
            allSelected: allVisibleChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加文件 · 可选择 PDF/Office/图片、文件夹，或直接拖入'
      : `已选 ${selectedFiles.length}/${queue.items.length} 份文档 (${formatBytes(selectedBytes)}) · 工具: ${activeTool.tag} · 清空列表 Ctrl+Shift+Backspace`

  return List({
    ...queue.fileInputProps,
    searchBarPlaceholder: '搜索 PDF / Office 文档或 12 大工具 (PDF转Word / 转Excel / 合并拆分 / 图片转PDF)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading: isRunning || queue.isImporting,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 12 大 PDF 工具模式',
      value: activeToolId,
      onChange: val => setActiveToolId(val),
      children: PDF_TOOLBOX_MODES.map(m => List.Dropdown.Item({ title: `工具: ${m.tag}`, value: m.id }))
    }),
    filterBar: FilterBar({ summaryText, actions: queue.topBarActions }),
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    workbenchPanel: {
      title: 'PDF 转换与拆分参数工作台',
      subtitle: `${renderDpi} DPI 矢量版面还原引擎`,
      fields: [
        {
          id: 'wb-tool-cat',
          label: '工具分类筛选',
          type: 'select',
          value: toolCat,
          onChange: val => setToolCat(val as typeof toolCat),
          options: [
            { label: '全部 12 项 PDF 工具', value: 'all' },
            { label: 'PDF 转其他格式 (6项)', value: 'pdf_to_other' },
            { label: 'Office/图片转 PDF (3项)', value: 'other_to_pdf' },
            { label: '合并/拆分/压缩 (3项)', value: 'pdf_ops' }
          ]
        },
        {
          id: 'wb-page-range',
          label: '页码范围策略',
          type: 'select',
          value: pageRangeMode,
          onChange: val => setPageRangeMode(val as typeof pageRangeMode),
          options: [
            { label: '全部页面 (All Pages)', value: 'all' },
            { label: '仅前 5 页预览提取', value: 'first5' },
            { label: '奇数页 (1, 3, 5...)', value: 'odd' },
            { label: '偶数页 (2, 4, 6...)', value: 'even' },
            { label: '逐页独立拆分导出', value: 'single_split' }
          ]
        },
        {
          id: 'wb-dpi',
          label: '图像渲染分辨率',
          type: 'select',
          value: renderDpi,
          onChange: val => setRenderDpi(val as typeof renderDpi),
          options: [
            { label: '300 DPI 印刷级超清', value: '300' },
            { label: '150 DPI 标准办公阅读', value: '150' },
            { label: '72 DPI 轻量网页预览', value: '72' }
          ]
        },
        {
          id: 'wb-compress',
          label: '压缩等级',
          type: 'select',
          value: compressionLevel,
          onChange: val => setCompressionLevel(val as typeof compressionLevel),
          options: [
            { label: '视觉无损 (智能平衡)', value: 'lossless' },
            { label: '高压缩归档 (最小体积)', value: 'archive' },
            { label: '保持原流 (零重采样)', value: 'raw' }
          ]
        },
        {
          id: 'wb-bookmarks',
          label: '保留书签目录大纲',
          type: 'toggle',
          value: keepBookmarks,
          onChange: val => setKeepBookmarks(Boolean(val))
        },
        {
          id: 'wb-outdir',
          label: '输出位置',
          type: 'info',
          value: `源文档同级目录 (*_${activeTool.tag})`
        }
      ],
      previewCard: {
        title: '文档转换与排版产出预估',
        badge: activeTool.tag,
        subtitle: `当前管线: ${activeTool.title}`,
        metrics: [
          { label: '已选文档体积', value: formatBytes(selectedBytes) },
          { label: '预计处理页数', value: `${selectedPages} 页` },
          { label: '渲染分辨率', value: `${renderDpi} DPI` },
          { label: '已选队列', value: `${selectedFiles.length} / ${queue.items.length} 份` }
        ]
      }
    },
    subList: {
      title: '待处理 PDF / Office 文档队列 (勾选或按 Enter 立即开始批量转换)',
      subtitle: `${filteredFiles.length} 份 · 共约 ${selectedPages} 页 · ${formatBytes(selectedBytes)}`,
      checkable: filteredFiles.length > 0,
      checked: allVisibleChecked ? true : filteredFiles.some(f => queue.checkedIds.includes(f.id)) ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(filteredFiles),
      emptyText: '尚未添加文档，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      items: rightQueueItems
    },
    children: [
      ...(rightQueueItems.length > 0
        ? [List.Section({ title: `待处理文档与扫描件清单 (${filteredFiles.length})`, children: rightQueueItems })]
        : []),
      List.Section({
        title: `PDF 专业转换、合并拆分与压缩工具箱 (${filteredPresets.length})`,
        children: filteredPresets.map(p =>
          List.Item({
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            icon: { source: Icon.Gear, tintColor: Color.SecondaryText },
            accessories: [{ tag: { value: p.tag } }, { text: p.method }],
            actions: ActionPanel({
              title: p.title,
              children: [
                Action({ title: '设为当前激活工具', icon: Icon.CheckCircle, onAction: () => setActiveToolId(p.id) }),
                buildListManagementSection({
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

export default PdfCommand
