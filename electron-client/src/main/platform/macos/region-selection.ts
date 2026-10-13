import { BrowserWindow, ipcMain, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { ScreenRectangle } from '../../services/screen-service.js'
export const REGION_SELECTION_URL = 'ztools://web/platform/region-selector.html'
export const REGION_SELECTION_CHANNEL = 'ztools:region-selection'
export interface RegionSelectionBackend { select(bounds: ScreenRectangle[], signal: AbortSignal): Promise<ScreenRectangle | undefined>; stop(): Promise<void> }
interface RegionWindow {
  webContents: { id: number; mainFrame: unknown; getURL(): string; setZoomFactor(value: number): void }
  loadURL(url: string): Promise<unknown>; show(): void; destroy(): void; isDestroyed(): boolean
  once(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}
interface SelectionEvent { sender: unknown; senderFrame: unknown }
type ScreenEventSource = Pick<typeof screen, 'on' | 'removeListener'>
function failed() { return new ZToolsError(errorCodes.screenError, '区域选择窗口未完成或关闭未确认') }
function cancelled() { return new ZToolsError(errorCodes.callerDestroyed, '区域选择已取消') }
function observeDisplayChanges(source: ScreenEventSource, listener: () => void): () => void {
  const removers: Array<() => void> = []
  let detached = false
  const detach = () => {
    if (detached) return
    detached = true
    let didFail = false, firstFailure: unknown
    for (const remove of removers.splice(0).reverse()) {
      try { remove() } catch (error) { if (!didFail) firstFailure = error; didFail = true }
    }
    if (didFail) throw firstFailure
  }
  try {
    removers.push(() => source.removeListener('display-added', listener)); source.on('display-added', listener)
    removers.push(() => source.removeListener('display-removed', listener)); source.on('display-removed', listener)
    removers.push(() => source.removeListener('display-metrics-changed', listener)); source.on('display-metrics-changed', listener)
  } catch (error) {
    detach()
    throw error
  }
  return detach
}
function bounded(rect: ScreenRectangle) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key as keyof ScreenRectangle])) && Math.abs(rect.x) <= 100000 && Math.abs(rect.y) <= 100000 && rect.width > 0 && rect.height > 0 && rect.width <= 32768 && rect.height <= 32768 && rect.width * rect.height <= 32 * 1024 * 1024
}
/** idle -> observing/creating/selecting -> closing -> idle; the first result or cancellation wins. */
export class MacRegionSelection implements RegionSelectionBackend {
  readonly #windows = new Set<RegionWindow>()
  #stopped = false
  #active: { controller: AbortController; drained: Promise<void> } | undefined
  constructor(private readonly preload: string, private readonly dependencies: {
    platform?: NodeJS.Platform; timeoutMs?: number; closeTimeoutMs?: number
    createWindow?: (bounds: ScreenRectangle, nonce: string) => RegionWindow
    listen?: (callback: (event: SelectionEvent, value: unknown) => void) => () => void
    screenEvents?: ScreenEventSource
  } = {}) {
    if (!path.isAbsolute(preload) || [dependencies.timeoutMs ?? 120000, dependencies.closeTimeoutMs ?? 2000].some(v => !Number.isSafeInteger(v) || v < 1 || v > 120000)) throw failed()
  }
  async select(bounds: ScreenRectangle[], signal: AbortSignal): Promise<ScreenRectangle | undefined> {
    if ((this.dependencies.platform ?? process.platform) !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '此区域选择provider需要macOS')
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#active || this.#windows.size) throw new ZToolsError(errorCodes.pluginBusy, '区域选择正在处理中')
    if (!Array.isArray(bounds) || !bounds.length || bounds.length > 8 || bounds.some(rect => !bounded(rect))) throw failed()
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, signal]), nonce = randomUUID()
    let drain!: () => void
    this.#active = { controller, drained: new Promise<void>(resolve => { drain = resolve }) }
    const owned = new Map<RegionWindow, ScreenRectangle>()
    let detach = () => {}, detachDisplayChanges = () => {}, timer: NodeJS.Timeout | undefined, onAbort = () => {}, closing = false
    try {
      return await new Promise<ScreenRectangle | undefined>((resolve, reject) => {
        let finished = false
        const finish = (rect?: ScreenRectangle, error?: ZToolsError) => { if (finished) return; finished = true; error ? reject(error) : resolve(rect) }
        onAbort = () => finish(undefined, cancelled())
        timer = setTimeout(() => finish(undefined, new ZToolsError(errorCodes.requestTimeout, '区域选择超时')), this.dependencies.timeoutMs ?? 120000)
        combined.addEventListener('abort', onAbort, { once: true })
        try {
          detachDisplayChanges = observeDisplayChanges(this.dependencies.screenEvents ?? screen, () => finish(undefined, new ZToolsError(errorCodes.screenError, '显示器布局已更改，请重新选择')))
        } catch {
          finish(undefined, failed())
          return
        }
        detach = (this.dependencies.listen ?? (callback => {
          const listener = (event: Electron.IpcMainEvent, value: unknown) => callback(event, value)
          ipcMain.on(REGION_SELECTION_CHANNEL, listener); return () => ipcMain.removeListener(REGION_SELECTION_CHANNEL, listener)
        }))((event, value) => {
          const entry = [...owned].find(([window]) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && window.webContents.getURL() === REGION_SELECTION_URL)
          if (!entry || !value || typeof value !== 'object' || Array.isArray(value)) return
          const input = value as Record<string, unknown>
          if (input.nonce !== nonce || Object.keys(input).some(key => !['nonce', 'rect', 'cancel'].includes(key))) return
          if (input.cancel === true && input.rect === undefined) { finish(); return }
          const local = input.rect as ScreenRectangle, display = entry[1]
          if (input.cancel !== undefined || !local || typeof local !== 'object' || Array.isArray(local) || Object.keys(local).some(key => !['x', 'y', 'width', 'height'].includes(key)) || !bounded(local) || local.x < 0 || local.y < 0 || local.x + local.width > display.width || local.y + local.height > display.height) return
          finish({ x: display.x + local.x, y: display.y + local.y, width: local.width, height: local.height })
        })
        for (const display of bounds) {
          if (finished) break
          if (combined.aborted) { onAbort(); break }
          const window = (this.dependencies.createWindow ?? ((rect, token) => {
            const overlay = new BrowserWindow({ ...rect, frame: false, transparent: true, resizable: false, movable: false,
              hasShadow: false, show: false, alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, acceptFirstMouse: true,
              webPreferences: { preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
                additionalArguments: [`--ztools-region-selection=${token}`] } })
            return overlay
          }))(display, nonce)
          this.#windows.add(window); owned.set(window, { ...display })
          window.once('closed', () => { this.#windows.delete(window); if (!closing) finish() })
          if (finished) break
          window.webContents.setZoomFactor(1)
          if (!this.dependencies.createWindow) {
            const overlay = window as BrowserWindow
            overlay.setMenu(null); overlay.setAlwaysOnTop(true, 'screen-saver'); overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
            overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            overlay.webContents.on('will-navigate', (event, url) => { if (url !== REGION_SELECTION_URL) event.preventDefault() })
          }
          if (finished) break
          void window.loadURL(REGION_SELECTION_URL).then(() => { if (!finished && !window.isDestroyed()) window.show() }).catch(() => { if (!finished) finish(undefined, failed()) })
        }
        if (combined.aborted) onAbort()
      })
    } finally {
      closing = true; if (timer) clearTimeout(timer); let detached = true
      try { detachDisplayChanges() } catch { detached = false }
      try { detach() } catch { detached = false }
      combined.removeEventListener('abort', onAbort)
      try { await this.#closeAll(); if (!detached) throw failed() } finally { this.#active = undefined; drain() }
    }
  }
  async stop(): Promise<void> { this.#stopped = true; const active = this.#active; active?.controller.abort(); await active?.drained; await this.#closeAll() }
  async #closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#windows].map(window => new Promise<void>((resolve, reject) => {
      if (window.isDestroyed()) { this.#windows.delete(window); resolve(); return }
      const closed = () => { clearTimeout(timer); this.#windows.delete(window); resolve() }
      const timer = setTimeout(() => { window.removeListener('closed', closed); reject(failed()) }, this.dependencies.closeTimeoutMs ?? 2000)
      window.once('closed', closed)
      try { window.destroy() } catch { clearTimeout(timer); window.removeListener('closed', closed); reject(failed()) }
    })))
    if (results.some(result => result.status === 'rejected')) throw failed()
  }
}
