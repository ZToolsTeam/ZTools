import { contextBridge, ipcRenderer } from 'electron'
import {
  RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL,
  RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL,
  type RuntimeCapabilityPromptRequest
} from '../contracts/runtime-capability-prompt.js'

const promptApi = Object.freeze({
  onRequest(callback: (request: RuntimeCapabilityPromptRequest) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('权限提示回调无效')
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
    if (typeof allowed !== 'boolean') return Promise.reject(new TypeError('权限提示响应无效'))
    return ipcRenderer.invoke(RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL, allowed)
  }
})

const promptProcess = process as NodeJS.Process & { isMainFrame?: boolean }
if (promptProcess.isMainFrame === true && typeof location !== 'undefined' &&
    location.href === 'ztools://web/platform/runtime-permission-consent.html') {
  contextBridge.exposeInMainWorld('ztoolsRuntimeCapabilityPrompt', promptApi)
}
