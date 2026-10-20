/**
 * PDF 多功能转换、合并拆分与加密工具箱业务逻辑层 (Pdf 2.0 Logic)
 * 1:1 复刻 DLLPlugins/pdf/PdfPlugin/产品设计文档.md 的 3 大分类 12 项核心 PDF 工具能力
 * 真实扫描本机 Documents / Downloads / Desktop 目录下的 PDF、Office 文档与图片，对接 PdfPlugin 与 image_to_pdf 宿主能力
 */

import {
  callHostTransport,
  formatBytes,
  getRealSystemPath,
  invokeDllPluginCapability,
  openRealPath,
  scanRealDirectoryTree,
  showRealItemInFolder
} from '../shared/native-ipc.js'

export { formatBytes } from '../shared/native-ipc.js'

export type PdfToolCategory = 'pdf_to_other' | 'other_to_pdf' | 'pdf_ops'

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  category?: PdfToolCategory
  params: Record<string, unknown>
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export interface RealPdfDocItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  docType: 'pdf' | 'word' | 'excel' | 'ppt' | 'image' | 'other'
  sizeBytes: number
  estimatedPages: number
}

export const DLL_PLUGIN_NAME = 'PdfPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i')
export const FORBIDDEN_REASON = 'PDF 转换输出路径禁止包含目录穿越或覆盖系统核心目录'

/**
 * 1:1 复刻 DLLPlugins/pdf/PdfPlugin/产品设计文档.md 的 3 大分类 12 项核心工具
 */
export const PDF_TOOLBOX_MODES: CapabilityActionItem[] = [
  // 1. PDF 转其他格式 (PRD 2.1)
  {
    id: 'pdf-to-word',
    title: '01. PDF 转可编辑 Word 文档 (.docx)',
    subtitle: '精准保留原始段落排版、字体样式、内嵌图片与表格结构 (PRD 2.1.1)',
    tag: 'PDF转Word',
    category: 'pdf_to_other',
    method: 'PdfToWord',
    params: { preserveLayout: true, format: 'docx' }
  },
  {
    id: 'pdf-to-excel',
    title: '02. PDF 财务/数据表提取转 Excel (.xlsx)',
    subtitle: '自动识别跨页表格边框并生成标准可计算工作表 (PRD 2.1.2)',
    tag: 'PDF转Excel',
    category: 'pdf_to_other',
    method: 'PdfToExcel',
    params: { mergeSheets: false }
  },
  {
    id: 'pdf-to-ppt',
    title: '03. PDF 转演示文稿幻灯片 (.pptx)',
    subtitle: '将 PDF 每一页智能还原为可独立编辑的 PowerPoint 幻灯片 (PRD 2.1.3)',
    tag: 'PDF转PPT',
    category: 'pdf_to_other',
    method: 'PdfToPpt',
    params: { editableText: true }
  },
  {
    id: 'pdf-to-image',
    title: '04. PDF 逐页导出为 300DPI 高清 PNG/JPG 图片',
    subtitle: '适合制作演示文稿素材或移动端高清长图阅读 (PRD 2.1.4)',
    tag: 'PDF转高清图',
    category: 'pdf_to_other',
    method: 'PdfToImage',
    params: { dpi: 300, format: 'png' }
  },
  {
    id: 'pdf-to-html',
    title: '05. PDF 转响应式网页文档 (.html)',
    subtitle: '生成带书签导航与矢量字体的独立 HTML5 网页 (PRD 2.1.5)',
    tag: 'PDF转HTML',
    category: 'pdf_to_other',
    method: 'PdfToHtml',
    params: { embedAssets: true }
  },
  {
    id: 'pdf-to-txt',
    title: '06. PDF 纯文本与章节无损提取 (.txt)',
    subtitle: '快速提取全文文本供本地知识库索引或大模型阅读 (PRD 2.1.6)',
    tag: 'PDF提取文本',
    category: 'pdf_to_other',
    method: 'PdfToTxt',
    params: { encoding: 'utf-8' }
  },
  // 2. 其他格式转 PDF (PRD 2.2)
  {
    id: 'word-to-pdf',
    title: '07. Word 文档批量转标准 PDF/A (.docx → .pdf)',
    subtitle: '嵌入字体子集，确保跨设备打印与审阅版式零偏差 (PRD 2.2.1)',
    tag: 'Word转PDF',
    category: 'other_to_pdf',
    method: 'WordToPdf',
    params: { standard: 'PDF/A-1b' }
  },
  {
    id: 'excel-to-pdf',
    title: '08. Excel 报表自适应宽幅转 PDF (.xlsx → .pdf)',
    subtitle: '自动横向缩放超宽报表防止跨页折断 (PRD 2.2.2)',
    tag: 'Excel转PDF',
    category: 'other_to_pdf',
    method: 'ExcelToPdf',
    params: { fitToPageWide: true }
  },
  {
    id: 'image-to-pdf',
    title: '09. 多张扫描件/图片合并转单个 PDF 画册',
    subtitle: '将勾选的 PNG/JPG 图片按顺序无损封装为标准 A4 PDF (PRD 2.2.4)',
    tag: '图片转PDF',
    category: 'other_to_pdf',
    method: 'ImageToPdf',
    params: { pageSize: 'A4', marginPt: 18 }
  },
  // 3. PDF 深度操作 (PRD 2.3)
  {
    id: 'pdf-merge',
    title: '10. 多份 PDF 文档按顺序无损合并',
    subtitle: '按勾选顺序合并多个 PDF 文件并自动保留书签目录树 (PRD 2.3.1)',
    tag: 'PDF合并',
    category: 'pdf_ops',
    method: 'MergePdf',
    params: { keepBookmarks: true }
  },
  {
    id: 'pdf-split',
    title: '11. PDF 按页码范围/单页智能拆分',
    subtitle: '支持奇偶页拆分、按指定页码区间提取或逐页拆分为独立 PDF (PRD 2.3.2)',
    tag: 'PDF拆分',
    category: 'pdf_ops',
    method: 'SplitPdf',
    params: { splitMode: 'by_range' }
  },
  {
    id: 'pdf-compress',
    title: '12. PDF 体积无损瘦身压缩与密码保护管理',
    subtitle: '重采样内嵌冗余位图并清理元数据，缩减 40%~70% 体积 (PRD 2.3.3)',
    tag: 'PDF瘦身加密',
    category: 'pdf_ops',
    method: 'CompressPdf',
    params: { compressionLevel: 'high', removeUnusedObjects: true }
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PDF_TOOLBOX_MODES.map(item => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(item => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }

  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) {
        return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      }
      if (FORBIDDEN_TARGET_PATTERN.test(val)) {
        return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` }
      }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
    }
  }

  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }

  const trimmedMethod = method.trim()
  const runtimeHost = hostBridge ?? (globalThis as Record<string, unknown>).ztools
  if (trimmedMethod === 'ImageToPdf' && !(runtimeHost as any)?.dllplugin?.call && !(hostBridge as any)?.invokeNative) {
    const imgToPdfRes = await callHostTransport<any>('image_to_pdf', params, hostBridge)
    if (imgToPdfRes.ok && imgToPdfRes.data !== undefined) {
      return {
        ok: true,
        pluginName: DLL_PLUGIN_NAME,
        method: trimmedMethod,
        data: imgToPdfRes.data,
        fromFallback: false
      }
    }
  }

  const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, trimmedMethod, params, hostBridge)
  return {
    ok: res.ok,
    pluginName: DLL_PLUGIN_NAME,
    method: trimmedMethod,
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}

function classifyDocType(ext: string): RealPdfDocItem['docType'] {
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx' || ext === '.doc') return 'word'
  if (ext === '.xlsx' || ext === '.xls') return 'excel'
  if (ext === '.pptx' || ext === '.ppt') return 'ppt'
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return 'image'
  return 'other'
}

const PDF_DOC_EXT_REGEX = /\.(?:pdf|docx|doc|xlsx|xls|pptx|ppt|md|txt|png|jpg|jpeg)$/i

export type PdfWorkspaceSnapshot = RealPdfDocItem[] & {
  scannedDirs: string[]
  files: RealPdfDocItem[]
  items: RealPdfDocItem[]
  presets: CapabilityActionItem[]
}

export async function fetchRealPdfWorkspace(hostOverride?: any): Promise<PdfWorkspaceSnapshot> {
  const [documentsDir, downloadsDir, desktopDir] = await Promise.all([
    getRealSystemPath('documents', hostOverride),
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('desktop', hostOverride)
  ])

  const scannedDirs = [documentsDir, downloadsDir, desktopDir].filter(Boolean)
  const files: RealPdfDocItem[] = []
  const seenPaths = new Set<string>()

  for (const dir of scannedDirs) {
    const scanRes = await scanRealDirectoryTree(dir, {
      maxDepth: 2,
      maxFiles: 250,
      collectTopN: 40,
      filterExt: PDF_DOC_EXT_REGEX,
      hostOverride
    })
    for (const f of scanRes.files) {
      if (f.sizeBytes <= 0) continue
      if (!PDF_DOC_EXT_REGEX.test(f.name)) continue
      const normPath = f.path.toLowerCase()
      if (seenPaths.has(normPath)) continue
      seenPaths.add(normPath)
      const dot = f.name.lastIndexOf('.')
      const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '.pdf'
      files.push({
        id: `pdf-${files.length}-${f.path}`,
        name: f.name,
        path: f.path,
        parentDir: dir,
        extension: ext,
        docType: classifyDocType(ext),
        sizeBytes: f.sizeBytes,
        estimatedPages: Math.max(1, Math.round(f.sizeBytes / (64 * 1024)))
      })
    }
  }

  files.sort((a, b) => {
    if (a.docType === 'pdf' && b.docType !== 'pdf') return -1
    if (a.docType !== 'pdf' && b.docType === 'pdf') return 1
    return b.sizeBytes - a.sizeBytes
  })

  const presets = getCapabilityItems()

  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    presets
  })
}

export const scanLocalPdfQueue = fetchRealPdfWorkspace

export async function openPdfFileLocation(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}

export async function openPdfDocument(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath) return false
  return openRealPath(fullPath, hostOverride)
}
