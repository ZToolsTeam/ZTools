import { randomUUID } from 'node:crypto'
import { BrowserWindow, session } from 'electron'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { ReferencePdfRenderer } from '../services/reference-pdf-service.js'
/** Dedicated internal HTML renderer; no system printer, external resources, paths or Node access. */
export class ElectronReferencePdfRenderer implements ReferencePdfRenderer {
  readonly #partition = 'ztools-reference-pdf-' + randomUUID()
  readonly #session = session.fromPartition(this.#partition)
  readonly #documents = new Map<string, string>()
  readonly #windows = new Set<BrowserWindow>()
  #stopped = false
  constructor() {
    this.#session.protocol.handle('ztools-reference-pdf', request => {
      const html = this.#documents.get(request.url)
      return html === undefined ? new Response('', { status: 404 }) : new Response(html, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" } })
    })
  }
  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const window of this.#windows) if (!window.isDestroyed()) window.destroy()
    this.#documents.clear(); this.#session.protocol.unhandle('ztools-reference-pdf')
  }
  async render(html: string, signal: AbortSignal): Promise<Buffer> {
    const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'PDF渲染已取消')
    if (this.#stopped || signal.aborted) throw cancelled()
    const url = 'ztools-reference-pdf://render/' + randomUUID()
    const window = new BrowserWindow({ show: false, webPreferences: { partition: this.#partition,
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } })
    this.#windows.add(window); this.#documents.set(url, html)
    const abort = () => { if (!window.isDestroyed()) window.destroy() }
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; abort() }, 45_000)
    try {
      await window.loadURL(url)
      if (signal.aborted || this.#stopped || window.isDestroyed()) throw cancelled()
      const bytes = await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true,
        displayHeaderFooter: false, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
      if (signal.aborted || this.#stopped || window.isDestroyed()) throw cancelled()
      return bytes
    } catch (error) {
      if (timedOut) throw new ZToolsError(errorCodes.requestTimeout, 'PDF渲染超时')
      if (signal.aborted || this.#stopped || window.isDestroyed()) throw cancelled()
      throw error
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', abort)
      this.#documents.delete(url); this.#windows.delete(window); if (!window.isDestroyed()) window.destroy()
    }
  }
}
