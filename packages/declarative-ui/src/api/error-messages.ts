import {
  DEFAULT_LOCALE,
  createTranslator,
  getLocale,
  resolveLocale,
  type SupportedLocale
} from "../runtime/locale.js";

const API_ERROR_MESSAGES = {
  "zh-CN": {
    clipboardPasteUnsupported: "当前宿主不支持粘贴到前台应用，内容已复制到剪贴板",
    processInvalidPid: "pid 必须是 2–4294967295 的整数",
    processTerminateUnsupported: "当前宿主不支持结束任意进程，请升级 ZTools",
    secureStorageInvalidKey:
      "SecureStorage 的 key 必须是 1–128 个字符，以字母或数字开头，只含字母、数字和 . _ : -",
    secureStorageUnavailable: "当前宿主不支持加密存储，请升级 ZTools",
    storageConflict: "数据正在被其他窗口修改，请重试",
    storageAtomicUnsupported: "当前宿主不支持原子存储，请升级 ZTools"
  },
  "en-US": {
    clipboardPasteUnsupported:
      "The current host does not support pasting into the frontmost app; content has been copied to the clipboard",
    processInvalidPid: "pid must be an integer between 2 and 4294967295",
    processTerminateUnsupported:
      "The current host does not support terminating arbitrary processes; please upgrade ZTools",
    secureStorageInvalidKey:
      "SecureStorage key must be 1–128 characters, start with a letter or digit, and contain only letters, digits, and . _ : -",
    secureStorageUnavailable:
      "The current host does not support encrypted storage; please upgrade ZTools",
    storageConflict: "The data is being modified by another window; please retry",
    storageAtomicUnsupported:
      "The current host does not support atomic storage; please upgrade ZTools"
  }
} as const;

export type ApiErrorMessages = Record<keyof (typeof API_ERROR_MESSAGES)["en-US"], string>;

export const tApiError = createTranslator<ApiErrorMessages>(API_ERROR_MESSAGES, {
  defaultLocale: "en-US"
});

/**
 * 宿主结构化错误码双语标准提示词典（用于对称防漏映射）
 */
export const HOST_ERROR_MESSAGES: Record<SupportedLocale, Readonly<Record<string, string>>> = {
  "zh-CN": Object.freeze({
    NOT_SUPPORTED: "当前宿主环境不支持该操作",
    HOST_FEATURE_UNAVAILABLE: "当前宿主不支持此功能，请升级 ZTools",
    INVALID_REQUEST: "请求参数无效",
    INVALID_PARAMS: "请求参数无效",
    INVALID_STORAGE_KEY: "存储键名格式无效",
    PERMISSION_DENIED: "权限不足，无法执行该操作",
    PLUGIN_PERMISSION_REQUIRED: "缺少所需的插件权限",
    PLUGIN_IDENTITY_REQUIRED: "缺少有效的插件身份凭证",
    PROCESS_PROTECTED: "目标进程受系统保护，无法结束",
    PROCESS_NOT_FOUND: "未找到指定的进程",
    PROCESS_ACCESS_DENIED: "无权访问或结束该进程",
    PROCESS_IDENTITY_MISMATCH: "目标进程身份已变化，已取消操作",
    PROCESS_TERMINATE_TIMEOUT: "等待进程退出超时",
    SECURE_STORAGE_UNAVAILABLE: "当前宿主不支持加密存储，请升级 ZTools",
    STORAGE_CONFLICT: "数据正在被其他窗口修改，请重试",
    STORAGE_QUOTA_EXCEEDED: "存储空间超出配额限制",
    TIMEOUT: "操作超时，请稍后重试",
    REQUEST_TIMEOUT: "请求超时，请稍后重试",
    CANCELLED: "操作已取消",
    ABORTED: "操作已中止",
    NOT_FOUND: "未找到请求的资源",
    FILE_NOT_FOUND: "未找到目标文件",
    FILE_TOO_LARGE: "文件体积超出限制",
    NETWORK_ERROR: "网络请求失败，请检查网络连接",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    UNAUTHORIZED: "身份验证失败，请重新登录",
    FORBIDDEN: "无权执行该操作",
    INTERNAL_ERROR: "宿主内部错误，请稍后重试",
    UNKNOWN_ERROR: "操作失败，请稍后重试"
  }),
  "en-US": Object.freeze({
    NOT_SUPPORTED: "This operation is not supported by the current host",
    HOST_FEATURE_UNAVAILABLE: "This feature is unavailable in the current host; please upgrade ZTools",
    INVALID_REQUEST: "Invalid request parameters",
    INVALID_PARAMS: "Invalid request parameters",
    INVALID_STORAGE_KEY: "Invalid storage key format",
    PERMISSION_DENIED: "Permission denied for this operation",
    PLUGIN_PERMISSION_REQUIRED: "Missing required plugin permission",
    PLUGIN_IDENTITY_REQUIRED: "Missing valid plugin identity",
    PROCESS_PROTECTED: "The target process is protected and cannot be terminated",
    PROCESS_NOT_FOUND: "The specified process was not found",
    PROCESS_ACCESS_DENIED: "Access denied while terminating the process",
    PROCESS_IDENTITY_MISMATCH: "Process identity changed; operation cancelled",
    PROCESS_TERMINATE_TIMEOUT: "Timed out waiting for the process to exit",
    SECURE_STORAGE_UNAVAILABLE: "The current host does not support encrypted storage; please upgrade ZTools",
    STORAGE_CONFLICT: "The data is being modified by another window; please retry",
    STORAGE_QUOTA_EXCEEDED: "Storage quota exceeded",
    TIMEOUT: "Operation timed out; please try again",
    REQUEST_TIMEOUT: "Request timed out; please try again",
    CANCELLED: "Operation was cancelled",
    ABORTED: "Operation was aborted",
    NOT_FOUND: "Requested resource not found",
    FILE_NOT_FOUND: "Target file not found",
    FILE_TOO_LARGE: "File size exceeds the allowed limit",
    NETWORK_ERROR: "Network request failed; please check your connection",
    RATE_LIMITED: "Too many requests; please try again later",
    UNAUTHORIZED: "Authentication failed; please sign in again",
    FORBIDDEN: "You do not have permission to perform this action",
    INTERNAL_ERROR: "Internal host error; please try again later",
    UNKNOWN_ERROR: "Operation failed; please try again"
  })
};

const CJK_CHAR_REGEX = /[\u4e00-\u9fff]/;
const ASCII_LETTER_REGEX = /[A-Za-z]/;

function hasCjk(text: string): boolean {
  return CJK_CHAR_REGEX.test(text);
}

function isPureEnglishTechnicalText(text: string): boolean {
  return text.length > 0 && !hasCjk(text) && ASCII_LETTER_REGEX.test(text);
}

/**
 * 解析宿主错误并输出符合目标语言的友好文案（对称防漏）：
 * - 识别 `ZToolsHostError`、`Error`、`{ code, message }` 对象与纯字符串；
 * - 英文态下拦截含中文的原文并映射到英文标准译文；
 * - 中文态下拦截纯英文技术错误原文并映射到中文标准译文；
 * - 若错误原文已与目标语言一致且非空，则保留更具体的原始错误提示。
 */
export function resolveHostErrorMessage(error: unknown, locale?: string): string {
  const targetLocale: SupportedLocale =
    locale !== undefined
      ? resolveLocale(locale, DEFAULT_LOCALE)
      : resolveLocale(getLocale(), DEFAULT_LOCALE);

  let code: string | undefined;
  let rawMessage = "";

  if (typeof error === "string") {
    rawMessage = error.trim();
  } else if (error && typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    if (typeof record.code === "string" && record.code.trim().length > 0) {
      code = record.code.trim();
    }
    if (typeof record.message === "string") {
      rawMessage = record.message.trim();
    }
  }

  const dict = HOST_ERROR_MESSAGES[targetLocale];
  const mapped = code && Object.prototype.hasOwnProperty.call(dict, code) ? dict[code] : undefined;
  const fallbackMessage = mapped ?? dict.UNKNOWN_ERROR;

  if (!rawMessage) {
    return fallbackMessage;
  }

  if (targetLocale === "en-US" && hasCjk(rawMessage)) {
    return fallbackMessage;
  }

  if (targetLocale === "zh-CN" && isPureEnglishTechnicalText(rawMessage)) {
    return fallbackMessage;
  }

  return rawMessage;
}
