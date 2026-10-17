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

const DOC_TYPE_META: Array<{ type: RealPdfDocItem['docType']; label: string; color: string }> = [
  { type: 'pdf', label: '📕 PDF 文档', color: '#ef4444' },
  { type: 'word', label: '📘 Word 文档', color: '#3b82f6' },
  { type: 'excel', label: '📗 Excel 表格', color: '#10b981' },
  { type: 'ppt', label: '📙 PPT 演示', color: '#f59e0b' },
  { type: 'image', label: '🖼️ 扫描图/PNG', color: '#a855f7' },
  { type: 'other', label: '📄 文本/Markdown', color: '#64748b' }
]

export default function PdfCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'files' | 'presets' | 'all'>('files')
  const [toolCat, setToolCat] = useState<'all' | PdfToolCategory>('all')
  const [activeToolId, setActiveToolId] = useState<string>(PDF_TOOLBOX_MODES[0].id)
  const [pageRangeMode, setPageRangeMode] = useState<'all' | 'first5' | 'odd' | 'single_split'>('all')
  const [files, setFiles] = useState<RealPdfDocItem[]>([])
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [presets, setPresets] = useState<CapabilityActionItem[]>(PDF_TOOLBOX_MODES)
  const [scannedDirs, setScannedDirs] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  async function refreshWorkspace(showIndicator = false) {
    if (showIndicator) setIsLoading(true)
    try {
      const ws = await fetchRealPdfWorkspace()
      setFiles(ws.files)
      setCheckedIds(ws.files.slice(0, 12).map(f => f.id))
      setPresets(ws.presets)
      setScannedDirs(ws.scannedDirs)
      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'PDF 多功能工具箱已刷新',
          message: `检索到 ${ws.files.length} 份本机文档 · 12 项 PDF 专业工具就绪`
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
      title: `📄 确认对 ${selected.length} 份文档执行「${activeTool.title}」？`,
      message: `页码范围策略: ${pageRangeMode}\n执行方法: ${activeTool.method}`,
      primaryAction: { title: '开始批量执行', style: 'default' }
    })
    if (!ok) return

    let count = 0
    for (const f of selected) {
      const res = await invokeNativeCapability(activeTool.method, {
        ...activeTool.params,
        pageRangeMode,
        inputPath: f.path
      })
      if (res.ok) count += 1
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
        ? { ...preset.params, pageRangeMode, inputPath: targetFile.path }
        : { ...preset.params, pageRangeMode }
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

  const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0)
  const pdfCount = files.filter(f => f.docType === 'pdf').length
  const officeImgCount = files.length - pdfCount
  const q = searchText.trim().toLowerCase()
  const filteredFiles = files.filter(
    f => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  )
  const filteredPresets = presets.filter(p => {
    if (toolCat !== 'all' && p.category !== toolCat) return false
    if (!q) return true
    return p.title.toLowerCase().includes(q) || p.subtitle.toLowerCase().includes(q) || p.tag.toLowerCase().includes(q)
  })

  const docSegments = DOC_TYPE_META.map(meta => {
    const docs = files.filter(f => f.docType === meta.type)
    const bytes = docs.reduce((s, f) => s + f.sizeBytes, 0)
    return {
      id: meta.type,
      label: `${meta.label} (${docs.length}份)`,
      valueBytes: bytes,
      formattedSize: `${docs.length}份 · ${formatBytes(bytes)}`,
      percentage: files.length > 0 ? Math.max(5, (docs.length / files.length) * 100) : 16,
      color: meta.color,
      active: true
    }
  }).filter(seg => !seg.label.includes('(0份)'))

  return List({
    searchBarPlaceholder: '搜索本机 PDF / Office 文档或 12 大工具 (PDF转Word / 转Excel / 合并拆分 / 图片转PDF)...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'pdf-files',
          label: '本机扫描文档总数',
          value: `${files.length} 份`,
          subValue: `已勾选 ${checkedIds.length} 份待处理`,
          status: 'normal'
        },
        {
          id: 'pdf-count',
          label: 'PDF / Office 与图片',
          value: `${pdfCount} 份 PDF`,
          subValue: `${officeImgCount} 份 Office/图片文档`,
          status: 'normal'
        },
        {
          id: 'pdf-size',
          label: '文档合计体积',
          value: formatBytes(totalBytes),
          subValue: `${scannedDirs.length} 个真实目录已穿透`,
          status: 'normal'
        },
        {
          id: 'pdf-presets',
          label: '当前激活 PDF 工具',
          value: activeTool.tag,
          subValue: '3 大类 12 项全功能就绪',
          status: 'success'
        }
      ]
    }),
    distributionBar: DistributionBar({
      title: '本机文档与扫描件格式分布 (Documents / Downloads / Desktop)',
      totalLabel: `共 ${files.length} 份文档 · ${formatBytes(totalBytes)}`,
      segments: docSegments
    }),
    filterBar: FilterBar({
      wizardSteps: [
        { step: 1, label: '1. 扫描本机 PDF/Office 文档', status: 'done' },
        { step: 2, label: '2. 选择 12 大转换/合并工具', status: 'done' },
        { step: 3, label: '3. 配置页码范围与300DPI参数', status: 'active' },
        { step: 4, label: '4. 批量转换/无损合并', status: 'pending' }
      ],
      summaryText: `当前工具: ${activeTool.title} · 已勾选 ${checkedIds.length} 份文档`,
      groups: [
        {
          id: 'tool-cat',
          label: '工具大类',
          value: toolCat,
          onChange: (v) => setToolCat(v as any),
          options: [
            { value: 'all', label: '全部 12 项工具', badge: PDF_TOOLBOX_MODES.length },
            { value: 'pdf_to_other', label: '📤 PDF 转其他 (6项)', badge: 6 },
            { value: 'other_to_pdf', label: '📥 其他转 PDF (3项)', badge: 3 },
            { value: 'pdf_ops', label: '✂️ 合并/拆分/压缩 (3项)', badge: 3 }
          ]
        },
        {
          id: 'tool-mode',
          label: '当前激活工具',
          value: activeToolId,
          onChange: (v) => setActiveToolId(v),
          options: filteredPresets.map(m => ({
            value: m.id,
            label: m.tag
          }))
        },
        {
          id: 'page-range',
          label: '页码范围与拆分策略',
          value: pageRangeMode,
          onChange: (v) => setPageRangeMode(v as any),
          options: [
            { value: 'all', label: '全部页面 (All Pages)' },
            { value: 'first5', label: '仅前 5 页预览提取' },
            { value: 'odd', label: '仅奇数页 (1, 3, 5...)' },
            { value: 'single_split', label: '逐页拆分为独立文档' }
          ]
        }
      ],
      actions: [
        {
          id: 'run-batch-pdf',
          title: `📄 立即执行已选 (${checkedIds.length})`,
          style: 'primary',
          disabled: checkedIds.length === 0,
          onAction: handleRunBatchChecked
        },
        {
          id: 'rescan-pdf',
          title: '🔄 刷新文档库',
          style: 'secondary',
          onAction: () => refreshWorkspace(true)
        }
      ]
    }),
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'files', label: '本机文档批处理队列 (三态勾选)', badge: files.length },
        { value: 'presets', label: '12 大 PDF 工具箱矩阵', badge: filteredPresets.length },
        { value: 'all', label: '完整混合工作台', badge: files.length + filteredPresets.length }
      ]
    }),
    children: [
      ...(tab === 'all' || tab === 'files'
        ? [
            List.Section({
              title: `本机目录文档与扫描件清单 (${filteredFiles.length})`,
              subtitle: `当前应用工具: ${activeTool.title} · 页码范围: ${pageRangeMode}`,
              checkable: true,
              checked:
                filteredFiles.length > 0 && filteredFiles.every(f => checkedIds.includes(f.id))
                  ? true
                  : filteredFiles.some(f => checkedIds.includes(f.id))
                  ? 'indeterminate'
                  : false,
              onCheckChange: (checked) => {
                setCheckedIds(checked ? filteredFiles.map(f => f.id) : [])
              },
              children: filteredFiles.map(f => {
                const isChecked = checkedIds.includes(f.id)
                return List.Item({
                  id: f.id,
                  title: f.name,
                  subtitle: `${f.parentDir} · 约 ${f.estimatedPages} 页`,
                  checkable: true,
                  checked: isChecked,
                  onCheckChange: (c) => {
                    if (c) {
                      setCheckedIds(Array.from(new Set([...checkedIds, f.id])))
                    } else {
                      setCheckedIds(checkedIds.filter(id => id !== f.id))
                    }
                  },
                  icon: {
                    source: Icon.Document,
                    tintColor: f.docType === 'pdf' ? Color.Red : isChecked ? Color.Blue : Color.SecondaryText
                  },
                  accessories: [
                    { tag: { value: `${f.extension.toUpperCase()} · ${activeTool.tag}`, color: f.docType === 'pdf' ? Color.Red : Color.Blue } },
                    { text: formatBytes(f.sizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 📑 ${f.name}

**本机真实路径**: \`${f.path}\`

---

### 📊 PDF 工具箱转换与处理预览 (产品设计文档.md)
- **当前激活工具**: **${activeTool.title}**
- **页码范围策略**: \`${pageRangeMode}\`
- **实际文件体积**: \`${formatBytes(f.sizeBytes)}\` (估算约 \`${f.estimatedPages} 页\`)
- **文档类型识别**: \`${f.docType.toUpperCase()} (${f.extension})\`
`
                  }),
                  actions: ActionPanel({
                    title: f.name,
                    children: [
                      Action({
                        title: `执行「${activeTool.title}」`,
                        icon: Icon.Bolt,
                        onAction: () => handleRunPreset(activeTool, f)
                      }),
                      Action({
                        title: `批量执行全部已选文档 (${checkedIds.length})`,
                        icon: Icon.Play,
                        onAction: handleRunBatchChecked
                      }),
                      Action({
                        title: '使用系统默认阅读器打开文档',
                        icon: Icon.Eye,
                        onAction: () => {
                          openPdfDocument(f.path)
                        }
                      }),
                      Action({
                        title: '在资源管理器中定位文档',
                        icon: Icon.Folder,
                        onAction: () => {
                          openPdfFileLocation(f.path)
                        }
                      })
                    ]
                  })
                })
              })
            })
          ]
        : []),
      ...(tab === 'all' || tab === 'presets'
        ? [
            List.Section({
              title: `PDF 专业转换、合并拆分与压缩工具箱 (${filteredPresets.length})`,
              children: filteredPresets.map(p =>
                List.Item({
                  id: p.id,
                  title: p.title,
                  subtitle: p.subtitle,
                  icon: {
                    source: Icon.Gear,
                    tintColor: p.id === activeToolId ? Color.Green : Color.Orange
                  },
                  accessories: [
                    { tag: { value: p.tag, color: p.id === activeToolId ? Color.Green : Color.Orange } },
                    { text: p.method }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# 🧰 ${p.title}\n\n${p.subtitle}\n\n### 调用参数契约\n\`\`\`json\n${JSON.stringify(p.params, null, 2)}\n\`\`\``
                  }),
                  actions: ActionPanel({
                    title: p.title,
                    children: [
                      Action({
                        title: '设为当前激活工具并切换到文档队列',
                        icon: Icon.CheckCircle,
                        onAction: () => {
                          setActiveToolId(p.id)
                          setTab('files')
                        }
                      }),
                      Action({
                        title: '对当前文档执行此转换工具',
                        icon: Icon.Play,
                        onAction: () => handleRunPreset(p, files[0])
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [])
    ]
  })
}
