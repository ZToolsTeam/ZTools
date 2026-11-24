import {
  errorCodes,
  toPublicError,
  ZToolsError,
  type PublicError,
  type ZToolsErrorCode
} from '../../contracts/errors.js'
import { getResolvedLocale, t, type SupportedLocale } from '../i18n/index.js'

/**
 * 开发者契约类错误码：默认保留原始英文调试详情（如参数字段校验错误、未知方法名），
 * 除非抛错方显式提供了 details.i18nKey 要求本地化。
 */
const DEVELOPER_CONTRACT_ERROR_CODES: ReadonlySet<ZToolsErrorCode> = new Set([
  errorCodes.invalidRequest,
  errorCodes.methodNotFound
])

const CJK_PATTERN = /[\u4e00-\u9fa5]/
const PARAM_KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/
const MAX_PARAM_STRING_LENGTH = 512

/**
 * 过滤并清洗用于错误插值的参数：
 * - 仅允许合法键名与安全字符串/有限数字；
 * - 清洗控制字符并限制长度；
 * - 在 en-US 模式下过滤含中文字符的 detail，防止中文异常绕过本地化（R9）。
 */
export function sanitizeErrorI18nParams(
  raw: Readonly<Record<string, string | number>> | undefined,
  locale: SupportedLocale
): Readonly<Record<string, string | number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string | number> = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(raw, key) || !PARAM_KEY_PATTERN.test(key)) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      out[key] = value
      count += 1
    } else if (typeof value === 'string') {
      const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
      const isDetailKey = key === 'detail' || key === 'stderr'
      if (!cleaned) {
        if (isDetailKey) {
          out[key] = t('common.detailUnavailable', undefined, locale)
          count += 1
        }
        continue
      }
      if (locale === 'en-US' && isDetailKey && CJK_PATTERN.test(cleaned)) {
        out[key] = t('common.detailUnavailable', undefined, locale)
        count += 1
        continue
      }
      out[key] = cleaned.length > MAX_PARAM_STRING_LENGTH
        ? `${cleaned.slice(0, MAX_PARAM_STRING_LENGTH)}...`
        : cleaned
      count += 1
    }
  }
  return count > 0 ? out : undefined
}

function tryTranslateKey(
  key: string,
  params: Readonly<Record<string, string | number>> | undefined,
  locale: SupportedLocale
): string | undefined {
  if (!key || !/^[A-Za-z0-9_.-]{1,128}$/.test(key)) return undefined
  const rawTemplate = t(key, undefined, locale)
  if (rawTemplate === key) return undefined
  const needsDetail = rawTemplate.includes('{detail}') && (!params || !Object.hasOwn(params, 'detail'))
  const needsStderr = rawTemplate.includes('{stderr}') && (!params || !Object.hasOwn(params, 'stderr'))
  let mergedParams = params
  if (needsDetail || needsStderr) {
    const unavailable = t('common.detailUnavailable', undefined, locale)
    mergedParams = {
      ...(params ?? {}),
      ...(needsDetail ? { detail: unavailable } : {}),
      ...(needsStderr ? { stderr: unavailable } : {})
    }
  }
  const translated = t(key, mergedParams, locale)
  return translated !== key ? translated : undefined
}

/**
 * 主进程 IPC 统一错误本地化出口（遵循 R3 分流与隐私白名单规范）：
 * 1. 非 ZToolsError 统一脱敏为 INTERNAL_ERROR 并按当前 locale 翻译；
 * 2. 开发者契约错误（INVALID_REQUEST / METHOD_NOT_FOUND）若未显式提供 i18nKey，保留原样详细调试信息；
 * 3. 用户运行期错误按 details.i18nKey -> error.<hostCode> -> error.<code> 优先级查词典；
 * 4. 仅允许 details.public 进入返回对象的 details，绝不泄露本机敏感路径或内部诊断字段。
 */
export function toLocalizedPublicError(
  error: unknown,
  locale?: SupportedLocale
): PublicError {
  const targetLocale = locale ?? getResolvedLocale()
  const base = toPublicError(error)

  if (!(error instanceof ZToolsError)) {
    const fallback = tryTranslateKey(`error.${errorCodes.internalError}`, undefined, targetLocale)
    return {
      code: errorCodes.internalError,
      message: fallback ?? base.message
    }
  }

  const details = error.details
  const safeParams = sanitizeErrorI18nParams(details?.i18nParams, targetLocale)

  // 开发者契约错误：中文模式与英文纯 ASCII 调试消息保留原样；英文模式下若消息含中文则按 error.<code> 兜底
  if (DEVELOPER_CONTRACT_ERROR_CODES.has(error.code) && !details?.i18nKey) {
    const rawMsg = error.message.trim()
    if (targetLocale === 'en-US' && CJK_PATTERN.test(rawMsg)) {
      const fallback = tryTranslateKey(`error.${error.code}`, safeParams, targetLocale)
      if (fallback) {
        return base.details
          ? { code: base.code, message: fallback, details: base.details }
          : { code: base.code, message: fallback }
      }
    }
    return base
  }

  // 优先级 1：显式 i18nKey
  let localized: string | undefined
  if (details?.i18nKey) {
    localized = tryTranslateKey(details.i18nKey, safeParams, targetLocale)
  }

  // 优先级 2：细分 hostCode（error.<hostCode>）
  if (!localized && details?.hostCode) {
    localized = tryTranslateKey(`error.${details.hostCode}`, safeParams, targetLocale)
  }

  // 优先级 3：标准错误码（error.<code>）
  // 仅当调用方没有提供自定义上下文且需要替换，或显式期望走标准词典时：
  // 注意：为避免在阶段 0 尚未完成各服务细分 i18nKey 迁移前误覆盖已有精确上下文消息（例如已有英文测试断言、
  // 或已经过 main/i18n t() 翻译的 focus/trigger/update/windowActions 精确文案），
  // 仅在消息为空或仅在 en-US 下检测到未翻译中文时才由标准 error.<code> 兜底替换！
  if (!localized) {
    const rawMsg = error.message.trim()
    const shouldFallbackToCode =
      !rawMsg || (targetLocale === 'en-US' && CJK_PATTERN.test(rawMsg))
    if (shouldFallbackToCode) {
      localized = tryTranslateKey(`error.${error.code}`, safeParams, targetLocale)
    }
  }

  const message = localized ?? base.message
  return base.details
    ? { code: base.code, message, details: base.details }
    : { code: base.code, message }
}
