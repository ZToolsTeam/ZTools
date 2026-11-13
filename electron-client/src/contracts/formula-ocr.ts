import { errorCodes, ZToolsError } from './errors.js'
import { validImagePath } from './image-ocr.js'

export type FormulaOcrRequest =
  /** 查询模型状态：missing / downloading（带进度）/ ready / failed */
  | { action: 'modelStatus' }
  /** 开始下载模型（已在下载时返回当前进度） */
  | { action: 'downloadModel' }
  | { action: 'cancelDownload' }
  | { action: 'recognizeImage'; path: string; includePreview?: boolean }
  | { action: 'recognizeClipboard'; includePreview?: boolean }
  /** restoreWindow：框选前收起调用方窗口，结束后是否重新显示（默认显示） */
  | { action: 'captureRegion'; restoreWindow?: boolean; includePreview?: boolean }

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  modelStatus: ['action'],
  downloadModel: ['action'],
  cancelDownload: ['action'],
  recognizeImage: ['action', 'path', 'includePreview'],
  recognizeClipboard: ['action', 'includePreview'],
  captureRegion: ['action', 'restoreWindow', 'includePreview']
}

/** 公式识别只接受模型管理与三种识别动作（已授权的图片文件、剪贴板图片、框选屏幕） */
export function validateFormulaOcrRequest(value: unknown): asserts value is FormulaOcrRequest {
  const input = value as Record<string, unknown> | null
  const keys = typeof input?.action === 'string' && Object.hasOwn(ALLOWED_KEYS, input.action) ? ALLOWED_KEYS[input.action] : undefined
  if (!input || typeof input !== 'object' || Array.isArray(input) || !keys ||
      Object.keys(input).some(key => !keys.includes(key)) ||
      (input.action === 'recognizeImage' && !validImagePath(input.path)) ||
      (input.restoreWindow !== undefined && typeof input.restoreWindow !== 'boolean') ||
      (input.includePreview !== undefined && typeof input.includePreview !== 'boolean')) {
    throw new ZToolsError(errorCodes.invalidRequest, '公式识别请求无效')
  }
}
