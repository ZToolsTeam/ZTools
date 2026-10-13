import { randomBytes } from 'node:crypto'
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL,
  RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL,
  RUNTIME_CAPABILITY_PROMPT_URL,
  type RuntimeCapabilityPromptRequest
} from '../../contracts/runtime-capability-prompt.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { RuntimeCapabilityPromptPort } from './runtime-capability-authorization-service.js'

const PROMPT_TIMEOUT_MS = 110_000

function ownerKey(owner: CallerIdentity): string {
  return JSON.stringify([owner.type, owner.webContentsId, owner.pluginId ?? null, owner.pluginInstanceId ?? null])
}

interface PendingPrompt {
  readonly nonce: string
  readonly owner: CallerIdentity
  readonly window: BrowserWindow
  readonly webContents: WebContents
  readonly webContentsId: number
  readonly request: RuntimeCapabilityPromptRequest
  readonly resolve: (allowed: boolean) => void
  readonly signal: AbortSignal
  timer: NodeJS.Timeout
  settled: boolean
  abortListener: () => void
}

/** A restricted Main-owned child window. Its WebContents never enters WindowRegistry. */
export class RuntimeCapabilityPromptService implements RuntimeCapabilityPromptPort {
  readonly #byContents = new Map<number, PendingPrompt>()
  readonly #byNonce = new Map<string, PendingPrompt>()
  #registered = false
  #stopped = false

  constructor(private readonly registry: Pick<WindowRegistry, 'getWebContents'>) {}

  register(): void {
    if (this.#stopped) throw new Error('Runtime capability prompt service is stopped')
    if (this.#registered) throw new Error('Runtime capability prompt handler is already registered')
    ipcMain.handle(RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL, this.#handleAnswer)
    this.#registered = true
  }

  request(owner: CallerIdentity, pluginName: string, signal: AbortSignal): Promise<boolean> {
    if (this.#stopped || !this.#registered || signal.aborted) return Promise.resolve(false)
    if (owner.type !== 'plugin' || !owner.pluginId || !owner.pluginInstanceId) return Promise.resolve(false)
    const contents = this.registry.getWebContents(owner.webContentsId)
    if (!contents || contents.isDestroyed()) return Promise.resolve(false)
    const parent = BrowserWindow.fromWebContents(contents)
    if (!parent || parent.isDestroyed()) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      const nonce = randomBytes(32).toString('base64url')
      const promptWindow = new BrowserWindow({
        parent,
        modal: true,
        width: 520,
        height: 390,
        minWidth: 480,
        minHeight: 360,
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: path.resolve(__dirname, '../../preload/runtime-capability-prompt.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false
        }
      })
      const request: RuntimeCapabilityPromptRequest = {
        pluginName: pluginName.slice(0, 128),
        pluginId: owner.pluginId!,
        purpose: '读取屏幕画面以完成插件发起的截图操作。'
      }
      const pending: PendingPrompt = {
        nonce,
        owner: { ...owner },
        window: promptWindow,
        webContents: promptWindow.webContents,
        webContentsId: promptWindow.webContents.id,
        request,
        resolve,
        signal,
        timer: setTimeout(() => this.#complete(pending, false), PROMPT_TIMEOUT_MS),
        settled: false,
        abortListener: () => this.#complete(pending, false)
      }
      this.#byContents.set(promptWindow.webContents.id, pending)
      this.#byNonce.set(nonce, pending)
      signal.addEventListener('abort', pending.abortListener, { once: true })
      promptWindow.once('closed', () => this.#complete(pending, false, false))
      promptWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== RUNTIME_CAPABILITY_PROMPT_URL) {
          event.preventDefault()
          this.#complete(pending, false)
        }
      })
      promptWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      promptWindow.webContents.on('will-attach-webview', event => event.preventDefault())
      promptWindow.webContents.once('render-process-gone', () => this.#complete(pending, false))
      promptWindow.webContents.once('did-finish-load', () => {
        if (pending.settled || promptWindow.isDestroyed()) return
        promptWindow.webContents.send(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL, request)
      })
      promptWindow.once('ready-to-show', () => {
        if (!pending.settled && !promptWindow.isDestroyed()) promptWindow.show()
      })
      void promptWindow.loadURL(RUNTIME_CAPABILITY_PROMPT_URL).catch(() => this.#complete(pending, false))
    })
  }

  cancelOwner(owner: CallerIdentity): void {
    for (const pending of this.#byNonce.values()) {
      if (ownerKey(pending.owner) === ownerKey(owner)) this.#complete(pending, false)
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const pending of [...this.#byNonce.values()]) this.#complete(pending, false)
    if (this.#registered) ipcMain.removeHandler(RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL)
    this.#registered = false
  }

  readonly #handleAnswer = (event: IpcMainInvokeEvent, value: unknown): { success: true } => {
    const pending = this.#byContents.get(event.sender.id)
    const frame = event.senderFrame
    if (!pending || pending.webContents !== event.sender || pending.settled || typeof value !== 'boolean' ||
        this.#byNonce.get(pending.nonce) !== pending || !frame || frame !== event.sender.mainFrame ||
        frame.url !== RUNTIME_CAPABILITY_PROMPT_URL) {
      throw new ZToolsError(errorCodes.permissionDenied, '屏幕采集授权响应无效')
    }
    this.#complete(pending, value)
    return { success: true }
  }

  #complete(pending: PendingPrompt, allowed: boolean, closeWindow = true): void {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    pending.signal.removeEventListener('abort', pending.abortListener)
    this.#byContents.delete(pending.webContentsId)
    this.#byNonce.delete(pending.nonce)
    pending.resolve(allowed)
    if (closeWindow && !pending.window.isDestroyed()) pending.window.close()
  }
}
