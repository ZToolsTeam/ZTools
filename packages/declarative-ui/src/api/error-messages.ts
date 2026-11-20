import { createTranslator } from "../runtime/locale.js";

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
