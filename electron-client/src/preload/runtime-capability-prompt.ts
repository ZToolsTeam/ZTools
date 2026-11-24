import { contextBridge, ipcRenderer } from 'electron'
import {
  RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL,
  RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL,
  type RuntimeCapabilityPromptRequest
} from '../contracts/runtime-capability-prompt.js'

export type RuntimeCapabilityPromptLocale = 'zh-CN' | 'en-US'

/** 从预加载进程启动参数中解析宿主注入的初始语言，仅允许受支持语言，默认回退 en-US */
export function parseRuntimeCapabilityPromptLocale(
  argv: readonly string[] | undefined
): RuntimeCapabilityPromptLocale {
  if (!Array.isArray(argv)) return 'en-US'
  const initialLocaleArg = argv
    .find((value) => typeof value === 'string' && value.startsWith('--ztools-locale='))
    ?.slice('--ztools-locale='.length)
  return initialLocaleArg === 'zh-CN' || initialLocaleArg === 'en-US'
    ? initialLocaleArg
    : 'en-US'
}

const initialLocale = parseRuntimeCapabilityPromptLocale(process.argv)

const promptApi = Object.freeze({
  locale: initialLocale,
  onRequest(callback: (request: RuntimeCapabilityPromptRequest) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Invalid permission prompt callback')
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const request = value as Partial<RuntimeCapabilityPromptRequest>
      if (typeof request.pluginName !== 'string' || typeof request.pluginId !== 'string' || typeof request.purpose !== 'string') return
      callback({ pluginName: request.pluginName, pluginId: request.pluginId, purpose: request.purpose })
    }
    ipcRenderer.on(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL, listener)
    return () => ipcRenderer.removeListener(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL, listener)
  },
  answer(allowed: boolean): Promise<{ success: true }> {
    if (typeof allowed !== 'boolean') return Promise.reject(new TypeError('Invalid permission prompt response'))
    return ipcRenderer.invoke(RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL, allowed)
  }
})

const promptProcess = process as NodeJS.Process & { isMainFrame?: boolean }
if (promptProcess.isMainFrame === true && typeof location !== 'undefined' &&
    location.href === 'ztools://web/platform/runtime-permission-consent.html') {
  contextBridge.exposeInMainWorld('ztoolsRuntimeCapabilityPrompt', promptApi)
}
