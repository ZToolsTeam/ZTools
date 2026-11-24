import { errorCodes, ZToolsError } from './errors.js'

/** 本机识别支持的语言（与内置识别服务的语言表一致） */
export const IMAGE_OCR_LANGUAGES = ['zh-Hans-CN', 'en-US', 'ja-JP', 'ko-KR'] as const
export type ImageOcrLanguage = (typeof IMAGE_OCR_LANGUAGES)[number]

export type ImageOcrRequest =
  | { action: 'recognizeImage'; path: string; lang?: ImageOcrLanguage }
  | { action: 'recognizeClipboard'; lang?: ImageOcrLanguage }
  /** restoreWindow：框选前收起调用方窗口，结束后是否重新显示（默认显示） */
  | { action: 'captureRegion'; lang?: ImageOcrLanguage; restoreWindow?: boolean }

/** 图片路径：绝对路径，不含 NUL，长度有上限（公式识别共用） */
export function validImagePath(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0') &&
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
}

/** 文字识别只接受三种动作：识别已授权的图片文件、识别剪贴板图片、框选屏幕后识别 */
export function validateImageOcrRequest(value: unknown): asserts value is ImageOcrRequest {
  const input = value as Record<string, unknown> | null
  const action = input?.action
  const keys = action === 'recognizeImage' ? ['action', 'path', 'lang'] : action === 'captureRegion' ? ['action', 'lang', 'restoreWindow'] : ['action', 'lang']
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (action !== 'recognizeImage' && action !== 'recognizeClipboard' && action !== 'captureRegion') ||
      Object.keys(input).some(key => !keys.includes(key)) ||
      (action === 'recognizeImage' && !validImagePath(input.path)) ||
      (input.restoreWindow !== undefined && typeof input.restoreWindow !== 'boolean') ||
      (input.lang !== undefined && !(IMAGE_OCR_LANGUAGES as readonly unknown[]).includes(input.lang))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid image OCR request')
  }
}
