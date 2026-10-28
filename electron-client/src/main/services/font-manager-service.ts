import fs from 'node:fs/promises'
import path from 'node:path'
import { validateFontRequest } from '../../contracts/font-manager.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { FontProvider } from './font-provider.js'

export class FontManagerService {
  #jobs = new Set<{ caller: CallerIdentity; id: string; controller: AbortController }>()
  #stopped = false
  constructor(private readonly provider: FontProvider, private readonly reveal: (file: string) => void) {}
  stop() { this.#stopped = true; for (const job of this.#jobs) job.controller.abort() }
  cancel(id: string, caller: CallerIdentity) {
    const job = [...this.#jobs].find(job => job.id === id && job.caller.webContentsId === caller.webContentsId && job.caller.pluginId === caller.pluginId)
    job?.controller.abort()
    return { success: true, cancelRequested: Boolean(job) }
  }
  async execute(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    validateFontRequest(value)
    if (this.#stopped || this.#jobs.size >= 4) throw new Error('字体读取繁忙，请稍后重试')
    if ([...this.#jobs].some(job => job.id === value.operationId && job.caller.webContentsId === caller.webContentsId && job.caller.pluginId === caller.pluginId)) throw new Error('字体操作标识重复')
    const job = { caller, id: value.operationId, controller: new AbortController() }
    signal = AbortSignal.any([signal, job.controller.signal]); signal.throwIfAborted()
    this.#jobs.add(job)
    try {
      if (value.action === 'preview') {
        const preview = await this.provider.preview(value.id!, value.text!, signal)
        signal.throwIfAborted(); return { success: true, preview }
      }
      const fonts = await this.provider.list(signal); signal.throwIfAborted()
      if (value.action === 'list') return { success: true, fonts }
      const file = fonts.find(font => font.id === value.id)?.filePath
      if (!file || !path.isAbsolute(file) || !(await fs.stat(file)).isFile()) throw new Error('该字体没有可定位的本地文件，请重新扫描')
      signal.throwIfAborted(); this.reveal(file)
      return { success: true, revealRequested: true }
    } finally { this.#jobs.delete(job) }
  }
}
