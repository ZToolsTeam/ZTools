import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  useState,
  useEffect,
  showToast,
  Toast,
  confirmAlert,
  FilterBar
} from '../../index.js'
import {
  CapabilityActionItem,
  PDF_TOOLBOX_MODES,
  PdfToolCategory,
  RealPdfDocItem,
  formatBytes,
  fetchRealPdfWorkspace,
  invokeNativeCapability,
  openPdfFileLocation,
  openPdfDocument
} from './logic.js'
import { isRealElectronHost } from '../shared/native-ipc.js'

export * from './logic.js'

const DOC_TYPE_META: Array<{ type: RealPdfDocItem['docType']; label: string; color: string }> = [
  { type: 'pdf', label: 'PDF 文档', color: '#94a3b8' },
  { type: 'word', label: 'Word 文档', color: '#94a3b8' },
  { type: 'excel', label: 'Excel 表格', color: '#94a3b8' },
  { type: 'ppt', label: 'PPT 演示', color: '#94a3b8' },
  { type: 'image', label: '扫描图/PNG', color: '#94a3b8' },
  { type: 'other', label: '文本/Markdown', color: '#94a3b8' }
]

const INITIAL_SAMPLE_PDFS: RealPdfDocItem[] = [
  {
    id: 'pdf-init-1',
    name: 'ZTools_Enterprise_Architecture_Whitepaper_2026.pdf',
    path: 'C:\\Users\\Geek\\Documents\\ZTools_Enterprise_Architecture_Whitepaper_2026.pdf',
    parentDir: 'C:\\Users\\Geek\\Documents',
    extension: '.pdf',
    docType: 'pdf',
    sizeBytes: 18450 * 1024,
    estimatedPages: 142
  },
  {
    id: 'pdf-init-2',
    name: 'Q3_Financial_Audit_Report_Consolidated.pdf',
    path: 'C:\\Users\\Geek\\Documents\\Finance\\Q3_Financial_Audit_Report_Consolidated.pdf',
    parentDir: 'C:\\Users\\Geek\\Documents\\Finance',
    extension: '.pdf',
    docType: 'pdf',
    sizeBytes: 9620 * 1024,
    estimatedPages: 68
  },
  {
    id: 'pdf-init-3',
    name: 'Product_Requirements_Specification_v2.4.docx',
    path: 'C:\\Users\\Geek\\Documents\\Specs\\Product_Requirements_Specification_v2.4.docx',
    parentDir: 'C:\\Users\\Geek\\Documents\\Specs',
    extension: '.docx',
    docType: 'word',
    sizeBytes: 5420 * 1024,
    estimatedPages: 36
  },
  {
    id: 'pdf-init-4',
    name: 'Annual_Cloud_Infrastructure_Budget_Matrix.xlsx',
    path: 'C:\\Users\\Geek\\Downloads\\Annual_Cloud_Infrastructure_Budget_Matrix.xlsx',
    parentDir: 'C:\\Users\\Geek\\Downloads',
    extension: '.xlsx',
    docType: 'excel',
    sizeBytes: 3890 * 1024,
    estimatedPages: 24
  },
  {
    id: 'pdf-init-5',
    name: 'Signed_Vendor_Service_Agreement_Scan_300dpi.pdf',
    path: 'C:\\Users\\Geek\\Desktop\\Signed_Vendor_Service_Agreement_Scan_300dpi.pdf',
    parentDir: 'C:\\Users\\Geek\\Desktop',
    extension: '.pdf',
    docType: 'pdf',
    sizeBytes: 12800 * 1024,
    estimatedPages: 18
  },
  {
    id: 'pdf-init-6',
    name: 'Declarative_UI_SDK_Developer_Manual.pdf',
    path: 'C:\\Users\\Geek\\Documents\\Manuals\\Declarative_UI_SDK_Developer_Manual.pdf',
    parentDir: 'C:\\Users\\Geek\\Documents\\Manuals',
    extension: '.pdf',
    docType: 'pdf',
    sizeBytes: 7240 * 1024,
    estimatedPages: 85
  },
  {
    id: 'pdf-init-7',
    name: 'Keynote_Launch_Deck_2026_Final.pptx',
    path: 'C:\\Users\\Geek\\Desktop\\Keynote_Launch_Deck_2026_Final.pptx',
    parentDir: 'C:\\Users\\Geek\\Desktop',
    extension: '.pptx',
    docType: 'ppt',
    sizeBytes: 15200 * 1024,
    estimatedPages: 45
  },
  {
    id: 'pdf-init-8',
    name: 'Patent_Application_Diagrams_Bundle.pdf',
    path: 'C:\\Users\\Geek\\Downloads\\Patent_Application_Diagrams_Bundle.pdf',
    parentDir: 'C:\\Users\\Geek\\Downloads',
    extension: '.pdf',
    docType: 'pdf',
    sizeBytes: 6120 * 1024,
    estimatedPages: 32
  }
]

export function PdfCommand() {
  const [searchText, setSearchText] = useState('')
  const [toolCat, setToolCat] = useState<'all' | PdfToolCategory>('all')
  const [activeToolId, setActiveToolId] = useState<string>(PDF_TOOLBOX_MODES[0].id)
  const [pageRangeMode, setPageRangeMode] = useState<'all' | 'first5' | 'odd' | 'even' | 'single_split'>('all')
  const [renderDpi, setRenderDpi] = useState<'300' | '150' | '72'>('300')
  const [compressionLevel, setCompressionLevel] = useState<'lossless' | 'archive' | 'raw'>('lossless')
  const [keepBookmarks, setKeepBookmarks] = useState<boolean>(true)
  const isRealHost = isRealElectronHost()
  const initialPdfs = isRealHost ? [] : INITIAL_SAMPLE_PDFS
  const [files, setFiles] = useState<RealPdfDocItem[]>(initialPdfs)
  const [checkedIds, setCheckedIds] = useState<string[]>(initialPdfs.map(f => f.id))
  const [presets, setPresets] = useState<CapabilityActionItem[]>(PDF_TOOLBOX_MODES)
  const [isLoading, setIsLoading] = useState(false)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealPdfWorkspace()
      const nextFiles = isRealElectronHost()
        ? ws.files
        : ws.files.length > 0
          ? ws.files
          : INITIAL_SAMPLE_PDFS
      setFiles(nextFiles)
      setCheckedIds(nextFiles.slice(0, 12).map(f => f.id))
      setPresets(ws.presets)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'PDF 多功能工具箱已刷新',
          message: `队列就绪 ${nextFiles.length} 份本机文档 · 12 项 PDF 专业工具就绪`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshWorkspace(false)
  }, [])

  const activeTool = presets.find(p => p.id === activeToolId) || PDF_TOOLBOX_MODES[0]

  async function handleRunBatchChecked() {
    const selected = files.filter(f => checkedIds.includes(f.id))
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
        showToast({
          style: Toast.Style.Failure,
          title: '批量 PDF 合并未执行成功',
          message: res.error || 'PDF 合并调用失败'
        })
        return
      }
      showToast({
        style: Toast.Style.Success,
        title: `已完成 ${selected.length} 份文档无损合并`,
        message: activeTool.title
      })
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
      if (res.ok) {
        count += 1
      } else {
        lastErr = res.error || 'PDF 转换调用失败'
      }
    }
    if (count === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '批量 PDF 任务未执行成功',
        message: lastErr
      })
      return
    }
    showToast({
      style: Toast.Style.Success,
      title: `已完成 ${count} 份文档任务下发`,
      message: activeTool.title
    })
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
      showToast({
        style: Toast.Style.Success,
        title: 'PDF 任务指令已下发',
        message: `${preset.title}${targetFile ? ` (${targetFile.name})` : ''}`
      })
    } catch (err: any) {
      showToast({ style: Toast.Style.Failure, title: '安全拦截', message: err?.message || String(err) })
    }
  }

  const selectedFiles = files.filter(f => checkedIds.includes(f.id))
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.sizeBytes, 0)
  const selectedPages = selectedFiles.reduce((s, f) => s + f.estimatedPages, 0)
  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(p => {
    if (toolCat !== 'all' && p.category !== toolCat) return false
    if (!q) return true
    return p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  })

  const maxDocBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightQueueItems = filteredFiles.map(f => {
    const isChecked = checkedIds.includes(f.id)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxDocBytes) * 100)))
    const docMeta = DOC_TYPE_META.find(m => m.type === f.docType)

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: `${f.parentDir} · 约 ${f.estimatedPages} 页 · ${docMeta?.label || 'PDF 文档'} → ${activeTool.tag}`,
      checkable: true,
      checked: isChecked,
      onCheckChange: c => {
        if (c) {
          setCheckedIds(Array.from(new Set([...checkedIds, f.id])))
        } else {
          setCheckedIds(checkedIds.filter(id => id !== f.id))
        }
      },
      icon: {
        source: Icon.Document
      },
      accessories: [
        {
          progress: {
            value: volRatio
          }
        },
        {
          tag: {
            value: `${f.estimatedPages}页 → ${activeTool.tag}`
          }
        },
        { text: formatBytes(f.sizeBytes) }
      ],
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `开始批量执行 (${checkedIds.length}份)`,
            icon: Icon.Bolt,
            onAction: handleRunBatchChecked
          }),
          Action({
            title: '在资源管理器中定位文档',
            icon: Icon.Folder,
            onAction: () => {
              openPdfFileLocation(f.path)
            }
          }),
          Action({
            title: `仅对当前文档执行「${activeTool.tag}」`,
            icon: Icon.Play,
            onAction: () => handleRunPreset(activeTool, f)
          }),
          Action({
            title: '使用系统默认阅读器打开文档',
            icon: Icon.Eye,
            onAction: () => {
              openPdfDocument(f.path)
            }
          })
        ]
      })
    })
  })

  return List({
    searchBarPlaceholder: '搜索本机 PDF / Office 文档或 12 大工具 (PDF转Word / 转Excel / 合并拆分 / 图片转PDF)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择 12 大 PDF 工具模式',
      value: activeToolId,
      onChange: val => setActiveToolId(val),
      children: PDF_TOOLBOX_MODES.map(m =>
        List.Dropdown.Item({
          title: `工具: ${m.tag}`,
          value: m.id
        })
      )
    }),
    filterBar: FilterBar({
      summaryText: `已选 ${checkedIds.length}/${files.length} 份文档 (共约 ${selectedPages} 页 / ${formatBytes(selectedBytes)}) · 当前工具: ${activeTool.tag} · ${renderDpi} DPI`,
      actions: [
        {
          id: 'rescan-pdf',
          label: '重新扫描队列',
          title: '重新扫描队列',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    workbenchPanel: {
      title: 'PDF 转换与拆分参数工作台',
      subtitle: `${renderDpi} DPI 矢量版面还原引擎`,
      fields: [
        {
          id: 'wb-tool-cat',
          label: '工具分类筛选',
          type: 'select',
          value: toolCat,
          onChange: val => setToolCat(val as any),
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
          onChange: val => setPageRangeMode(val as any),
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
          onChange: val => setRenderDpi(val as any),
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
          onChange: val => setCompressionLevel(val as any),
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
          { label: '已选队列', value: `${checkedIds.length} / ${files.length} 份` }
        ]
      }
    },
    subList: {
      title: '待处理 PDF / Office 文档队列 (按体积与类型排序，勾选或按 ↵ 立即开始批量转换)',
      subtitle: `${filteredFiles.length} 份 · 共约 ${selectedPages} 页 · ${formatBytes(selectedBytes)}`,
      checkable: filteredFiles.length > 0,
      checked:
        filteredFiles.length > 0 && filteredFiles.every(f => checkedIds.includes(f.id))
          ? true
          : filteredFiles.some(f => checkedIds.includes(f.id))
          ? 'indeterminate'
          : false,
      onCheckChange: checked => {
        setCheckedIds(checked ? filteredFiles.map(f => f.id) : [])
      },
      emptyText: '当前队列暂无匹配文档',
      items: rightQueueItems
    },
    children: [
      List.Section({
        title: `本机目录文档与扫描件清单 (${filteredFiles.length})`,
        children: rightQueueItems
      }),
      List.Section({
        title: `PDF 专业转换、合并拆分与压缩工具箱 (${filteredPresets.length})`,
        children: filteredPresets.map(p =>
          List.Item({
            id: p.id,
            title: p.title,
            subtitle: p.subtitle,
            icon: {
              source: Icon.Gear,
              tintColor: Color.SecondaryText
            },
            accessories: [
              { tag: { value: p.tag } },
              { text: p.method }
            ],
            actions: ActionPanel({
              title: p.title,
              children: [
                Action({
                  title: '设为当前激活工具',
                  icon: Icon.CheckCircle,
                  onAction: () => {
                    setActiveToolId(p.id)
                  }
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

