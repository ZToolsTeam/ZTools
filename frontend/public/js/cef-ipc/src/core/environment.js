/**
 * 清理语言标签：去首尾空白、剥离 POSIX .UTF-8 / @... 后缀并将 _ 转为 -。
 * 与 packages/ztools-plugins-spec/src/locale.js 保持 100% 行为等价。
 * @param {unknown} raw
 * @returns {string}
 */
export function stripSdkLocaleSuffix(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const withoutPosix = trimmed.split(/[.@]/)[0] || ''
  return withoutPosix.trim().replace(/_/g, '-')
}

/**
 * 严格匹配受支持语言（zh-CN / en-US）。
 * 遇到空值、'system'/'auto'/'default' 或第三语种（如 ja-JP/fr-FR）返回 null，
 * 以便候选列表向后顺延而非提前截断。
 * @param {unknown} raw
 * @returns {'zh-CN' | 'en-US' | null}
 */
export function matchSdkLocale(raw) {
  const cleaned = stripSdkLocaleSuffix(raw)
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  if (lower === 'system' || lower === 'auto' || lower === 'default') {
    return null
  }
  if (lower === 'zh' || lower.startsWith('zh-')) {
    return 'zh-CN'
  }
  if (lower === 'en' || lower.startsWith('en-')) {
    return 'en-US'
  }
  return null
}

/**
 * 按优先级实时解析当前运行环境语言。
 * 读取顺序：globalThis.__ztoolsLocale > window.__ztoolsElectron.initialLocale > document.documentElement.lang > localStorage.ztools_locale > navigator.language
 * 无法识别时回落英文（'en-US'），确保测试与无 DOM 环境稳定。
 * @returns {'zh-CN' | 'en-US'}
 */
export function resolveSdkLocale() {
  try {
    const candidates = [
      typeof globalThis !== 'undefined' ? globalThis.__ztoolsLocale : undefined,
      typeof window !== 'undefined' && window.__ztoolsElectron ? window.__ztoolsElectron.initialLocale : undefined,
      typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : undefined,
      typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
        ? localStorage.getItem('ztools_locale')
        : undefined,
      typeof navigator !== 'undefined' ? navigator.language : undefined
    ]
    for (let i = 0; i < candidates.length; i += 1) {
      const matched = matchSdkLocale(candidates[i])
      if (matched) {
        return matched
      }
    }
  } catch (localeReadError) {
    // 沙箱或受限存储环境下读取语言失败时，遵循默认英文回退
    void localeReadError
  }
  return 'en-US'
}

/**
 * 响应运行期语言热切换（更新全局 __ztoolsLocale 与 html lang）。
 * @param {unknown} nextRawLocale
 */
export function applyApiLocaleChange(nextRawLocale) {
  const resolved = matchSdkLocale(nextRawLocale)
  if (!resolved) return
  if (typeof window !== 'undefined') {
    try {
      window.__ztoolsLocale = resolved
    } catch (err) {
      void err
    }
  }
  if (typeof globalThis !== 'undefined') {
    try {
      globalThis.__ztoolsLocale = resolved
    } catch (err) {
      void err
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = resolved
  }
}

/**
 * 根据当前运行环境语言选择 SDK 双语文案。
 * @param {string} zh - 简体中文文案
 * @param {string} en - 英文文案
 * @returns {string}
 */
export function resolveSdkText(zh, en) {
  return resolveSdkLocale() === 'zh-CN' ? zh : en
}

/**
 * SDK 统一双语错误与操作文案字典（通过 resolveSdkText 按运行时语言查表）
 */
export const SDK_ERROR_MESSAGES = Object.freeze({
  'zh-CN': Object.freeze({
    mockFileContent: '这是 Mock 文件内容\nMock file content',
    mockSecureStorageUnsupported: 'Mock 环境不支持安全凭据存储',
    mockShortcutCreated: '快捷方式已创建 (Mock)',
    mockOcrResult: 'Mock OCR 识别结果\nMock OCR text result',
    invalidCancelCleanupLimit: '取消等待上限无效',
    hostNoPerMethodCancel: '宿主没有逐方法取消入口',
    fileRequestCancelled: '文件请求已取消',
    invalidFileTransferOptions: '文件传输选项无效',
    fileRequestLimitExceeded: '文件请求超过上限',
    fileRequestOutcomeUnconfirmed: '文件请求结束未确认',
    networkCancelUnconfirmed: '取消请求未确认底层网络请求已结束',
    hostNoAtomicNoOverwriteWrite: '当前宿主不支持原子禁止覆盖写入',
    hostNoAtomicNoOverwriteCacheWrite: '当前宿主缓存写入接口不支持原子禁止覆盖',
    invalidRegionCaptureCancelResponse: '区域截图取消响应无效',
    invalidScreenshotRefResponse: '截图引用响应无效',
    screenshotCancelOptionsUnsupported: '当前截图合约不支持引用取消选项',
    invalidFileDialogPrompt: '文件选择提示无效',
    saveNameSingleFileOnly: '保存名称只能有一个文件名',
    invalidFileDialogFilterType: '文件选择类型无效',
    invalidDirectoryAccessScope: '目录授权范围无效',
    invalidFileDialogResponse: '文件选择响应无效',
    refSdkNoTempPath: '文件引用SDK不返回临时路径',
    clipboardTextTooLarge: '剪贴板文本超过8MiB',
    invalidFileClipboardResponse: '文件剪贴板响应无效',
    invalidFileClipboardErrorResponse: '文件剪贴板错误响应无效',
    refEventHostUnavailable: '文件引用事件宿主不可用',
    invalidClipboardEventHandler: '剪贴板事件处理器无效',
    clipboardEventHandlerLimitExceeded: '剪贴板事件处理器超过上限',
    invalidFileClipboardEventContract: '文件剪贴板事件契约无效',
    invalidFileClipboardEventState: '文件剪贴板事件状态无效',
    invalidImageClipboardResponse: '图片剪贴板响应无效',
    invalidImageDataResponse: '图片数据响应无效',
    directImageDataTooLarge: '直接图片数据超出上限',
    invalidFileClipboardCount: '文件剪贴板数量无效',
    refFilePasteNotWired: '引用文件粘贴消费者尚未接线',
    invalidImageRefResponse: '图片引用响应无效',
    invalidFileTransferUrl: '文件传输URL无效',
    invalidFileTransferTimeout: '文件传输超时范围无效',
    invalidFileTransferHeaders: '文件传输headers无效',
    fileTransferHeadersTooLarge: '文件传输headers超出上限',
    invalidUploadFieldName: '上传字段名无效',
    downloadResponseUnconfirmed: '下载完成后的响应无法确认',
    invalidUploadResponse: '上传响应无效',
    invalidPortListResponse: '端口列表响应无效',
    invalidProcessListResponse: '进程列表响应无效',
    ffmpegTaskControlNotWired: 'FFmpeg任务的进度、完成与取消能力尚未接入',
    invalidLocalOcrResult: '本地OCR结果无效',
    invalidLocalOcrLanguages: '本地OCR语言无效',
    localOcrNoLanguages: '本地OCR未提供语言',
    invalidLocalOcrLine: '本地OCR行无效',
    localOcrTextTooLarge: '本地OCR文字过多',
    localOcrTextMismatch: '本地OCR文字不一致',
    refEncodePreservesFormat: '引用编码保留原始PNG/JPEG格式',
    imageCrossPlatformProviderNotImplemented: '此图片方法的跨平台provider尚未实现',
    hostRefPreviewUnavailable: '当前宿主尚未开放引用预览',
    legacyImageOptionsUnsupported: '旧图片处理器不支持请求选项',
    gifPreviewRequiresRefImageHandler: 'GIF预览需要引用图片处理器',
    gifEncodeRequiresRefImageHandler: '真实GIF编码需要引用图片处理器',
    pdfRequestOptionsUnsupported: '当前图片桥不支持新增PDF请求选项',
    invalidGifPreviewParams: 'GIF预览图片或间隔无效',
    invalidGifPreviewResponse: 'GIF预览响应无效',
    invalidGifInputParams: 'GIF输入图片或间隔无效',
    gifSaveOutcomeUnconfirmed: 'GIF保存结果未确认',
    invalidPdfImageList: 'PDF输入图片列表无效',
    pdfSaveOutcomeUnconfirmed: 'PDF保存结果未确认',
    invalidImagePreviewParams: '图片预览参数无效',
    invalidImagePreviewFormatOrQuality: '图片预览格式或质量无效',
    invalidImagePreviewResponse: '图片预览响应无效',
    invalidBase64Response: 'Base64编码响应无效',
    invalidJpegQualityRange: 'JPEG质量须为1到100',
    invalidImageSaveReceipt: '图片保存收据无效，请核实目标文件',
    invalidImageProcessResponse: '图片处理响应无效',
    invalidImageOutputFormat: '请明确选择PNG或JPEG输出格式',
    invalidImageResizeDimensions: '图片缩放尺寸无效',
    invalidImageScaleRatio: '图片缩放比例须为0.1到5',
    invalidImageCropBounds: '图片裁剪范围无效',
    invalidImageRotateAngle: '图片旋转角度无效',
    invalidImageFlipDirection: '图片翻转方向无效',
    invalidBrowserSnapshotOptions: '浏览器快照选项无效',
    invalidSqliteResponse: 'SQLite响应无效',
    invalidSqliteRow: 'SQLite行无效',
    sqliteFieldTooLarge: 'SQLite字段超过上限',
    invalidSqliteField: 'SQLite字段无效',
    sqliteResultTooLarge: 'SQLite结果超过8MiB',
    imageOpProcess: '图片处理',
    imageOpConvert: '图片格式转换',
    imageOpResize: '图片缩放',
    imageOpScale: '图片按比例缩放',
    imageOpCrop: '图片裁剪',
    imageOpRotate: '图片旋转',
    imageOpFlip: '图片翻转',
    imageOpCompress: '图片压缩',
    imageOpCompressPng: 'PNG 压缩',
    imageOpCompressPngLossy: 'PNG 有损压缩',
    imageOpWatermark: '图片水印',
    imageOpAnnotateText: '图片文字标注',
    imageOpStitch: '图片拼接',
    imageOpBorder: '图片边框',
    imageOpRoundCorners: '图片圆角',
    imageOpToPdf: '图片转 PDF',
    imageOpGenerateQr: '二维码生成',
    imageOpDecodeQr: '二维码解码',
    imageOpSvgToPng: 'SVG 转 PNG',
    imageOpGetInfo: '获取图片信息',
    imageOpToBase64: '图片转 Base64',
    imageOpFromBase64: 'Base64 转图片',
    imageEmptyResult: '{operation}返回空结果'
  }),
  'en-US': Object.freeze({
    mockFileContent: 'Mock file content',
    mockSecureStorageUnsupported: 'Secure credential storage is not supported in mock environment',
    mockShortcutCreated: 'Shortcut created (Mock)',
    mockOcrResult: 'Mock OCR text result',
    invalidCancelCleanupLimit: 'Invalid cancellation cleanup timeout',
    hostNoPerMethodCancel: 'Host does not provide a per-method cancellation handler',
    fileRequestCancelled: 'File request was cancelled',
    invalidFileTransferOptions: 'Invalid file transfer options',
    fileRequestLimitExceeded: 'Concurrent file request limit exceeded',
    fileRequestOutcomeUnconfirmed: 'File request completion outcome is unconfirmed',
    networkCancelUnconfirmed: 'Cancellation did not confirm termination of the underlying network request',
    hostNoAtomicNoOverwriteWrite: 'Current host does not support atomic no-overwrite file writes',
    hostNoAtomicNoOverwriteCacheWrite: 'Current host cache write API does not support atomic no-overwrite',
    invalidRegionCaptureCancelResponse: 'Invalid region screenshot cancellation response',
    invalidScreenshotRefResponse: 'Invalid screenshot reference response',
    screenshotCancelOptionsUnsupported: 'Current screenshot contract does not support reference cancellation options',
    invalidFileDialogPrompt: 'Invalid file dialog prompt options',
    saveNameSingleFileOnly: 'Save filename must be a single file name without path separators',
    invalidFileDialogFilterType: 'Invalid file dialog selection properties',
    invalidDirectoryAccessScope: 'Invalid directory access scope',
    invalidFileDialogResponse: 'Invalid file dialog response',
    refSdkNoTempPath: 'File reference SDK does not return temporary file paths',
    clipboardTextTooLarge: 'Clipboard text exceeds 8 MiB limit',
    invalidFileClipboardResponse: 'Invalid file clipboard response',
    invalidFileClipboardErrorResponse: 'Invalid file clipboard error response',
    refEventHostUnavailable: 'File reference event host is unavailable',
    invalidClipboardEventHandler: 'Invalid clipboard event handler',
    clipboardEventHandlerLimitExceeded: 'Clipboard event handler limit exceeded',
    invalidFileClipboardEventContract: 'Invalid file clipboard event contract',
    invalidFileClipboardEventState: 'Invalid file clipboard event state',
    invalidImageClipboardResponse: 'Invalid image clipboard response',
    invalidImageDataResponse: 'Invalid image data response',
    directImageDataTooLarge: 'Inline image data exceeds size limit',
    invalidFileClipboardCount: 'Invalid clipboard file list count',
    refFilePasteNotWired: 'Reference file paste consumer is not wired yet',
    invalidImageRefResponse: 'Invalid image reference response',
    invalidFileTransferUrl: 'Invalid file transfer URL',
    invalidFileTransferTimeout: 'Invalid file transfer timeout range',
    invalidFileTransferHeaders: 'Invalid file transfer headers',
    fileTransferHeadersTooLarge: 'File transfer headers exceed size limit',
    invalidUploadFieldName: 'Invalid upload field name',
    downloadResponseUnconfirmed: 'Download completion response could not be confirmed',
    invalidUploadResponse: 'Invalid upload response',
    invalidPortListResponse: 'Invalid port list response',
    invalidProcessListResponse: 'Invalid process list response',
    ffmpegTaskControlNotWired: 'FFmpeg task progress, completion, and cancellation are not wired yet',
    invalidLocalOcrResult: 'Invalid local OCR result',
    invalidLocalOcrLanguages: 'Invalid local OCR languages',
    localOcrNoLanguages: 'Local OCR returned no supported languages',
    invalidLocalOcrLine: 'Invalid local OCR text line',
    localOcrTextTooLarge: 'Local OCR recognized text exceeds size limit',
    localOcrTextMismatch: 'Local OCR combined text does not match line items',
    refEncodePreservesFormat: 'Reference encoding preserves the original PNG/JPEG format',
    imageCrossPlatformProviderNotImplemented: 'Cross-platform provider for this image method is not implemented yet',
    hostRefPreviewUnavailable: 'Current host does not expose reference image preview',
    legacyImageOptionsUnsupported: 'Legacy image processor does not support request options',
    gifPreviewRequiresRefImageHandler: 'GIF preview requires the reference image processor',
    gifEncodeRequiresRefImageHandler: 'True GIF encoding requires the reference image processor',
    pdfRequestOptionsUnsupported: 'Current image bridge does not support additional PDF request options',
    invalidGifPreviewParams: 'Invalid GIF preview image list or interval',
    invalidGifPreviewResponse: 'Invalid GIF preview response',
    invalidGifInputParams: 'Invalid GIF input image list or interval',
    gifSaveOutcomeUnconfirmed: 'GIF save outcome could not be confirmed',
    invalidPdfImageList: 'Invalid PDF input image list',
    pdfSaveOutcomeUnconfirmed: 'PDF save outcome could not be confirmed',
    invalidImagePreviewParams: 'Invalid image preview parameters',
    invalidImagePreviewFormatOrQuality: 'Invalid image preview format or quality',
    invalidImagePreviewResponse: 'Invalid image preview response',
    invalidBase64Response: 'Invalid Base64 encoding response',
    invalidJpegQualityRange: 'JPEG quality must be an integer between 1 and 100',
    invalidImageSaveReceipt: 'Invalid image save receipt; verify the destination file',
    invalidImageProcessResponse: 'Invalid image processing response',
    invalidImageOutputFormat: 'Please explicitly choose PNG or JPEG output format',
    invalidImageResizeDimensions: 'Invalid image resize dimensions',
    invalidImageScaleRatio: 'Image scale ratio must be between 0.1 and 5',
    invalidImageCropBounds: 'Invalid image crop bounds',
    invalidImageRotateAngle: 'Invalid image rotation angle',
    invalidImageFlipDirection: 'Invalid image flip direction',
    invalidBrowserSnapshotOptions: 'Invalid browser snapshot options',
    invalidSqliteResponse: 'Invalid SQLite response',
    invalidSqliteRow: 'Invalid SQLite row',
    sqliteFieldTooLarge: 'SQLite field exceeds size limit',
    invalidSqliteField: 'Invalid SQLite field value',
    sqliteResultTooLarge: 'SQLite result exceeds 8 MiB limit',
    imageOpProcess: 'Image processing',
    imageOpConvert: 'Image format conversion',
    imageOpResize: 'Image resize',
    imageOpScale: 'Image scale',
    imageOpCrop: 'Image crop',
    imageOpRotate: 'Image rotate',
    imageOpFlip: 'Image flip',
    imageOpCompress: 'Image compression',
    imageOpCompressPng: 'PNG compression',
    imageOpCompressPngLossy: 'Lossy PNG compression',
    imageOpWatermark: 'Image watermark',
    imageOpAnnotateText: 'Image text annotation',
    imageOpStitch: 'Image stitching',
    imageOpBorder: 'Image border',
    imageOpRoundCorners: 'Image rounded corners',
    imageOpToPdf: 'Images to PDF',
    imageOpGenerateQr: 'QR code generation',
    imageOpDecodeQr: 'QR code decoding',
    imageOpSvgToPng: 'SVG to PNG',
    imageOpGetInfo: 'Get image info',
    imageOpToBase64: 'Image to Base64',
    imageOpFromBase64: 'Base64 to image',
    imageEmptyResult: '{operation} returned an empty result'
  })
})

/**
 * 按统一错误字典键解析当前运行语言的 SDK 文案（遵循 DEFAULT_LOCALE = 'en-US'）
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function resolveSdkErrorText(key, params) {
  const zh = Object.prototype.hasOwnProperty.call(SDK_ERROR_MESSAGES['zh-CN'], key)
    ? SDK_ERROR_MESSAGES['zh-CN'][key]
    : key
  const en = Object.prototype.hasOwnProperty.call(SDK_ERROR_MESSAGES['en-US'], key)
    ? SDK_ERROR_MESSAGES['en-US'][key]
    : key
  const template = resolveSdkText(zh, en)
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, token) =>
    params[token] !== undefined ? String(params[token]) : match
  )
}

/**
 * 创建带标准错误码的双语 SDK Error（保留原有 .code 与附加属性）
 * @param {string} code
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {Error & { code: string }}
 */
export function createSdkError(code, key, params) {
  const error = new Error(resolveSdkErrorText(key, params))
  error.code = code
  return error
}

if (typeof globalThis !== 'undefined') {
  globalThis.__ztoolsStripSdkLocaleSuffix = stripSdkLocaleSuffix
  globalThis.__ztoolsMatchSdkLocale = matchSdkLocale
  globalThis.__ztoolsResolveSdkLocale = resolveSdkLocale
  globalThis.__ztoolsResolveSdkText = resolveSdkText
  globalThis.__ztoolsResolveSdkErrorText = resolveSdkErrorText
  globalThis.__ztoolsCreateSdkError = createSdkError
  globalThis.__ztoolsSdkErrorMessages = SDK_ERROR_MESSAGES
}

/**
 * Environment - 环境检测与适配
 * 检测运行环境，提供环境适配
 */
class Environment {
  constructor() {
    this.type = this._detectEnvironment()
  }

  /**
   * 获取 Electron preload 暴露的受控传输层。
   * @returns {object|null}
   */
  getElectronTransport() {
    try {
      if (typeof window === 'undefined') return null
      const transport = window.__ztoolsElectron?.transport
      return transport &&
        transport.methods &&
        typeof transport.methods === 'object'
        ? transport
        : null
    } catch {
      return null
    }
  }

  /**
   * 获取 CEF 注入的 V8 绑定。
   * @returns {object|null}
   */
  getCEFBridge() {
    try {
      if (typeof window === 'undefined') return null
      const bridge = window.ztools
      return bridge && typeof bridge._sendMessage === 'function' ? bridge : null
    } catch {
      return null
    }
  }

  /**
   * 检测运行环境
   * @returns {'electron'|'cef'|'browser'} 环境类型
   */
  _detectEnvironment() {
    // Electron preload 只暴露逐方法 transport，不暴露 ipcRenderer。
    if (this.getElectronTransport()) {
      return 'electron'
    }

    // 检查是否存在 V8 绑定的特征
    if (this.getCEFBridge()) {
      return 'cef'
    }
    return 'browser'
  }

  /**
   * 判断是否在 CEF 环境中
   */
  isCEF() {
    return this.type === 'cef'
  }

  /**
   * 判断是否在 Electron 环境中
   */
  isElectron() {
    return this.type === 'electron'
  }

  /**
   * 判断是否在浏览器环境中
   */
  isBrowser() {
    return this.type === 'browser'
  }

  /**
   * 获取环境信息
   */
  getInfo() {
    return {
      type: this.type,
      isElectron: this.isElectron(),
      isCEF: this.isCEF(),
      isBrowser: this.isBrowser(),
      userAgent: navigator.userAgent,
      platform: navigator.platform
    }
  }

  /**
   * 创建环境错误
   */
  createEnvironmentError(method) {
    const errorMessage = resolveSdkText(
      `环境错误: ${method} 需要在 ZTools 应用中运行。当前环境: ${this.type}`,
      `Environment error: ${method} must run inside the ZTools desktop app. Current environment: ${this.type}`
    )

    const error = new Error(errorMessage)
    error.code = 'ENVIRONMENT_ERROR'
    error.environment = this.type
    error.method = method

    return error
  }

  /**
   * 显示环境警告(仅在浏览器环境首次显示)
   */
  showEnvironmentWarning() {
    if (this.isBrowser() && !this._warningShown) {
      this._warningShown = true

      console.warn(
        resolveSdkText(
          `[ztools] 当前在浏览器环境中 - ZTools API 需要在 ZTools 应用中运行（环境类型: ${this.type}）`,
          `[ztools] Running in browser mode - ZTools API requires the ZTools desktop app (environment: ${this.type})`
        )
      )
    }
  }
}

// 创建全局单例
const environment = new Environment()

export default environment
