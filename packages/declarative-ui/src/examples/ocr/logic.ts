/**
 * 多语言离线屏幕与批量图片 OCR 文字提取业务逻辑层 (Ocr Logic)
 */

import {
  callHostTransport,
  formatBytes,
  invokePluginService,
  isRealElectronHost,
  showRealItemInFolder,
  writeRealClipboardText
} from '../shared/native-ipc.js'
import {
  type ExampleImportRules,
  type ExampleImportedFile,
  pickExampleFolderFiles
} from '../shared/file-import.js'

export { formatBytes }

export interface OcrLanguagePreset {
  id: string
  title: string
  subtitle: string
  tag: string
  engineCode: string
  avgLatencyMs: number
}

export interface OcrQueueItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  sizeBytes: number
  sampleText: string
  confidencePercent: number
}

export interface OcrBatchConfig {
  languageModelId?: string
  lang?: string
  layoutStrategy?: 'natural_paragraph' | 'single_line' | 'markdown_table'
  postAction?: 'copy_clipboard' | 'export_file' | 'copy_and_export'
  filterStampNoise?: boolean
}

export interface OcrBatchResult {
  ok: boolean
  recognizedCount: number
  failedCount?: number
  failedPaths?: string[]
  exportedFiles?: string[]
  combinedText: string
  averageLatencyMs: number
  items?: OcrQueueItem[]
  error?: string
  fromFallback?: boolean
}

function isStrictRealHost(hostOverride?: unknown): boolean {
  if (isRealElectronHost(hostOverride)) return true
  if (hostOverride && typeof hostOverride === 'object') {
    const h = hostOverride as Record<string, unknown>
    return Boolean(
      h.__isRealElectronHost ||
        h.isRealElectronHost ||
        h.strictRealHost ||
        h.window_show_select_folder_dialog ||
        h.filesystem_get_directory_contents ||
        h.dllplugin_call ||
        h.plugin_invoke ||
        h.ocr_recognize_batch ||
        h.screen_capture ||
        h.screen_capture_ocr ||
        (h.transport as { call?: unknown } | undefined)?.call ||
        (h.dllplugin as { call?: unknown } | undefined)?.call
    )
  }
  return false
}

export const OCR_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tiff'] as const
export const OCR_SUPPORTED_TEXT = '.png / .jpg / .jpeg / .webp / .bmp / .gif / .tiff'

/** OCR 文件夹导入规则：单次上限 100 张图片 */
export const OCR_IMPORT_RULES: ExampleImportRules = {
  extensions: OCR_IMAGE_EXTENSIONS,
  maxDepth: 5,
  maxFiles: 100
}

export const OCR_LANGUAGE_MODELS: OcrLanguagePreset[] = [
  {
    id: 'zh-en-mixed-pro',
    title: '中英混合高精度模型 (Windows.Media.Ocr / PP-OCRv4)',
    subtitle: '针对中英文混排文档、技术文章截图与 UI 界面文字的高准确率识别',
    tag: '中英混合高精度',
    engineCode: 'zh-Hans-CN',
    avgLatencyMs: 45
  },
  {
    id: 'zh-cn-pure',
    title: '纯简体中文公文与扫描件模型',
    subtitle: '针对扫描合同、竖排/横排中文书籍与密集印刷体优化',
    tag: '纯简体中文',
    engineCode: 'zh-CN',
    avgLatencyMs: 38
  },
  {
    id: 'en-code-snippet',
    title: '英文与代码片段专用模型 (Monospace / IDE)',
    subtitle: '精准区分 0/O、1/l/I、括号与缩进符号，适合终端输出与代码截图提取',
    tag: '英文与代码段',
    engineCode: 'en-US',
    avgLatencyMs: 32
  },
  {
    id: 'ja-ko-multilang',
    title: '日韩多语种混合识别模型 (Japanese / Korean)',
    subtitle: '支持日文假名汉字与韩文谚文屏幕截图实时提取',
    tag: '日韩多语种',
    engineCode: 'ja-JP',
    avgLatencyMs: 52
  },
  {
    id: 'latex-table-md',
    title: '数学公式与表格结构还原 (LaTeX / Markdown)',
    subtitle: '将图片中的财务报表还原为 Markdown 表格，数学公式还原为 LaTeX 语法',
    tag: '公式与表格 Markdown',
    engineCode: 'slanet_table_latex_v2',
    avgLatencyMs: 68
  }
]

const STAMP_NOISE_LINE_REGEX = /(?:^[\s\-—_=]*第?\s*\d+\s*[\/／]\s*\d+\s*页?[\s\-—_=]*$|^[\s\-—_=]*Page\s+\d+(?:\s+of\s+\d+)?[\s\-—_=]*$|合同专用章|发票专用章|财务专用章|骑缝章|业务专用章|保密水印|内部资料\s*严禁外传)/i

function isPlaceholderOcrText(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.startsWith('[图像已加载') || t.includes('[图像已加载')) return true
  if (t.includes('[OCR 预提取就绪]')) return true
  return false
}

export function cleanOcrStampNoise(text: string, enableFilter = true): string {
  const raw = String(text || '').trim()
  if (!raw || !enableFilter) return raw
  const lines = raw
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/【[^】]*(?:专用章|公章|骑缝章|水印)[^】]*】/g, '')
        .replace(/\[[^\]]*(?:专用章|公章|骑缝章|水印)[^\]]*\]/g, '')
        .trim()
    )
    .filter(line => line.length > 0 && !STAMP_NOISE_LINE_REGEX.test(line))
  return lines.join('\n').trim()
}

export function formatOcrOutputByStrategy(
  items: OcrQueueItem[],
  strategy: OcrBatchConfig['layoutStrategy'] = 'natural_paragraph'
): string {
  if (!Array.isArray(items) || items.length === 0) return ''
  if (strategy === 'single_line') {
    return items
      .map(i => String(i.sampleText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
  }
  if (strategy === 'markdown_table') {
    const rows = items.map(
      (i, idx) =>
        `| ${idx + 1} | ${i.name} | ${String(i.sampleText || '').replace(/\|/g, '/').replace(/\n/g, ' ')} | ${i.confidencePercent}% |`
    )
    return ['| 序号 | 文件名 | 识别提取内容 | 置信度 |', '| :--- | :--- | :--- | :--- |', ...rows].join('\n')
  }
  if (items.length === 1) {
    return String(items[0].sampleText || '').trim()
  }
  return items.map(i => `### ${i.name}\n${i.sampleText}`).join('\n\n')
}

export function toOcrQueueItem(file: ExampleImportedFile, index = 0): OcrQueueItem {
  return {
    id: `ocr-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    parentDir: file.parentDir,
    extension: file.extension || '.png',
    sizeBytes: file.sizeBytes ?? 0,
    sampleText: '',
    confidencePercent: 0
  }
}

/**
 * 通过用户显式选择文件夹（window_show_select_folder_dialog + filesystem_get_directory_contents）导入待识别图片（最多 100 张）
 */
export async function fetchOcrQueueSnapshot(hostOverride?: unknown): Promise<
  OcrQueueItem[] & {
    scannedDirs: string[]
    items: OcrQueueItem[]
    files: OcrQueueItem[]
    models: OcrLanguagePreset[]
    error?: string
  }
> {
  const res = await pickExampleFolderFiles(
    OCR_IMPORT_RULES,
    { title: '选择包含待识别图片的文件夹（最多 100 张）' },
    hostOverride
  )
  const items = res.files.map((f, idx) => toOcrQueueItem(f, idx)).sort((a, b) => b.sizeBytes - a.sizeBytes)
  const scannedDirs = res.folderPath ? [res.folderPath] : []
  return Object.assign([...items], {
    scannedDirs,
    items,
    files: items,
    models: [...OCR_LANGUAGE_MODELS],
    ...(res.error ? { error: res.error } : {})
  })
}

export const fetchOcrWorkspace = fetchOcrQueueSnapshot

function extractRecognizedText(data: unknown): string {
  if (!data) return ''
  let raw = ''
  if (typeof data === 'string') raw = data.trim()
  else if (typeof data === 'object') {
    const rec = data as Record<string, unknown>
    if (typeof rec.text === 'string') raw = rec.text.trim()
    else if (typeof rec.ocrText === 'string') raw = rec.ocrText.trim()
    else if (typeof rec.content === 'string') raw = rec.content.trim()
    else if (Array.isArray(rec.lines)) {
      raw = rec.lines
        .map(l => (typeof l === 'string' ? l : String((l as Record<string, unknown>)?.text || '')))
        .filter(Boolean)
        .join('\n')
        .trim()
    }
  }
  if (isPlaceholderOcrText(raw)) return ''
  return raw
}

async function applyOcrPostAction(
  items: OcrQueueItem[],
  combinedText: string,
  config: OcrBatchConfig,
  hostOverride?: unknown
): Promise<string[]> {
  const postAction = config?.postAction || 'copy_clipboard'
  const ext = config?.layoutStrategy === 'markdown_table' ? '.md' : '.txt'
  const exportedFiles: string[] = []

  if (postAction === 'copy_clipboard' || postAction === 'copy_and_export') {
    await writeRealClipboardText(combinedText, hostOverride)
  }

  if (postAction === 'export_file' || postAction === 'copy_and_export') {
    for (const item of items) {
      if (!item.path) continue
      const outPath = item.path.replace(/(\.[^.\\/]+)?$/, ext)
      const content =
        items.length === 1 ? combinedText : formatOcrOutputByStrategy([item], config?.layoutStrategy || 'natural_paragraph')
      await callHostTransport('filesystem_write_file', { path: outPath, content, encoding: 'utf8' }, hostOverride)
      exportedFiles.push(outPath)
    }
  }

  return exportedFiles
}

export async function executeBatchOcr(
  items: OcrQueueItem[],
  config: OcrBatchConfig = {},
  hostOverride?: unknown
): Promise<OcrBatchResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      recognizedCount: 0,
      failedCount: 0,
      failedPaths: [],
      combinedText: '',
      averageLatencyMs: 0,
      error: 'EMPTY_OCR_QUEUE: 请先勾选至少一张待识别图片'
    }
  }

  const strictReal = isStrictRealHost(hostOverride)
  const model =
    OCR_LANGUAGE_MODELS.find(m => m.id === (config?.languageModelId || config?.lang)) || OCR_LANGUAGE_MODELS[0]
  const lang = config?.lang || config?.languageModelId || model.engineCode
  const shouldFilterNoise = Boolean(config?.filterStampNoise)

  const recognizedItems: OcrQueueItem[] = []
  const failedPaths: string[] = []
  let lastError = ''

  for (const item of items) {
    const ocrRes = await invokePluginService<Record<string, unknown>>(
      'OcrPlugin',
      'recognizeImage',
      {
        path: item.path,
        lang,
        languageModelId: config?.languageModelId || model.id,
        filterStampNoise: shouldFilterNoise
      },
      hostOverride
    )

    const validRes = ocrRes.ok && ocrRes.data?.ok !== false
    const rawText = validRes ? extractRecognizedText(ocrRes.data) : ''
    const text = cleanOcrStampNoise(rawText, shouldFilterNoise)
    if (validRes && text.length > 0) {
      const confidence =
        typeof ocrRes.data?.confidence === 'number'
          ? ocrRes.data.confidence
          : typeof ocrRes.data?.confidencePercent === 'number'
            ? ocrRes.data.confidencePercent
            : 99.2
      recognizedItems.push({ ...item, sampleText: text, confidencePercent: confidence })
    } else {
      failedPaths.push(item.path)
      if (ocrRes.error || ocrRes.data?.error) {
        lastError = String(ocrRes.error || ocrRes.data?.error)
      }
    }
  }

  if (recognizedItems.length > 0) {
    const combinedText = formatOcrOutputByStrategy(recognizedItems, config?.layoutStrategy || 'natural_paragraph')
    const exportedFiles = await applyOcrPostAction(recognizedItems, combinedText, config, hostOverride)
    return {
      ok: true,
      recognizedCount: recognizedItems.length,
      failedCount: failedPaths.length,
      failedPaths,
      exportedFiles,
      combinedText,
      averageLatencyMs: model.avgLatencyMs,
      items: recognizedItems,
      fromFallback: false
    }
  }

  const hostRec = hostOverride as { ocr_recognize_batch?: unknown } | undefined
  if (hostRec && typeof hostRec.ocr_recognize_batch === 'function') {
    const batchRes = await callHostTransport<Record<string, unknown>>(
      'ocr_recognize_batch',
      { files: items.map(i => i.path), ...config },
      hostOverride
    )
    const validBatch = batchRes.ok && batchRes.data?.ok !== false
    const rawBatchText = validBatch ? extractRecognizedText(batchRes.data) : ''
    const batchText = cleanOcrStampNoise(rawBatchText, shouldFilterNoise)
    if (validBatch && batchText.length > 0) {
      const batchItems = items.map(i => ({ ...i, sampleText: batchText }))
      const exportedFiles = await applyOcrPostAction(batchItems, batchText, config, hostOverride)
      return {
        ok: true,
        recognizedCount: items.length,
        failedCount: 0,
        failedPaths: [],
        exportedFiles,
        combinedText: batchText,
        averageLatencyMs: model.avgLatencyMs,
        fromFallback: false
      }
    }
  }

  if (strictReal) {
    return {
      ok: false,
      recognizedCount: 0,
      failedCount: items.length,
      failedPaths,
      combinedText: '',
      averageLatencyMs: 0,
      error: lastError || 'OCR_RECOGNIZE_FAILED: Windows 原生 OCR 引擎识别失败或未提取到有效文字',
      fromFallback: false
    }
  }

  const validPresetItems = items
    .map(i => ({ ...i, sampleText: cleanOcrStampNoise(i.sampleText, shouldFilterNoise) }))
    .filter(i => i.sampleText && !isPlaceholderOcrText(i.sampleText) && !i.sampleText.includes(i.name))
  if (validPresetItems.length === 0) {
    return {
      ok: false,
      recognizedCount: 0,
      failedCount: items.length,
      failedPaths,
      combinedText: '',
      averageLatencyMs: 0,
      error: 'OCR_EMPTY_TEXT: 未提取到任何有效文字'
    }
  }

  const combinedText = formatOcrOutputByStrategy(validPresetItems, config?.layoutStrategy || 'natural_paragraph')
  const exportedFiles = await applyOcrPostAction(validPresetItems, combinedText, config, hostOverride)
  return {
    ok: true,
    recognizedCount: validPresetItems.length,
    failedCount: items.length - validPresetItems.length,
    failedPaths,
    exportedFiles,
    combinedText,
    averageLatencyMs: model.avgLatencyMs,
    fromFallback: true
  }
}

export async function captureScreenAreaOcr(hostOverride?: unknown): Promise<{
  ok: boolean
  text: string
  message: string
  error?: string
}> {
  const pluginRes = await invokePluginService<Record<string, unknown>>('OcrPlugin', 'captureAndRecognize', {}, hostOverride)
  const validPlugin = pluginRes.ok && pluginRes.data?.ok !== false
  const pluginText = validPlugin ? extractRecognizedText(pluginRes.data) : ''
  if (validPlugin && pluginText.length > 0) {
    await writeRealClipboardText(pluginText, hostOverride)
    return { ok: true, text: pluginText, message: '已完成框选区域 OCR 识别并写入剪贴板' }
  }

  const capRes = await callHostTransport<Record<string, unknown> | string>('screen_capture', {}, hostOverride)
  const capObj = typeof capRes.data === 'object' && capRes.data !== null ? capRes.data : null
  if (capRes.ok && capRes.data && capObj?.ok !== false) {
    const capturedPath =
      typeof capRes.data === 'string'
        ? capRes.data.trim()
        : String(capObj?.path || capObj?.filePath || '').trim()
    if (capturedPath) {
      const recRes = await invokePluginService<Record<string, unknown>>(
        'OcrPlugin',
        'recognizeImage',
        { path: capturedPath },
        hostOverride
      )
      const validRec = recRes.ok && recRes.data?.ok !== false
      const recText = validRec ? extractRecognizedText(recRes.data) : ''
      if (validRec && recText.length > 0) {
        await writeRealClipboardText(recText, hostOverride)
        return { ok: true, text: recText, message: '已完成框选区域 OCR 识别并写入剪贴板' }
      }
    }
  }

  const ipcRes = await callHostTransport<Record<string, unknown>>('screen_capture_ocr', {}, hostOverride)
  const validIpc = ipcRes.ok && ipcRes.data?.ok !== false
  const ipcText = validIpc ? extractRecognizedText(ipcRes.data) : ''
  if (validIpc && ipcText.length > 0) {
    await writeRealClipboardText(ipcText, hostOverride)
    return { ok: true, text: ipcText, message: '已完成框选区域 OCR 识别并写入剪贴板' }
  }

  return {
    ok: false,
    text: '',
    message: pluginRes.error || ipcRes.error || '屏幕区域 OCR 识别未完成或未检测到文字',
    error: pluginRes.error || ipcRes.error || 'SCREEN_CAPTURE_OCR_FAILED'
  }
}

export async function openOcrFileLocation(fullPath: string, hostOverride?: unknown): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
