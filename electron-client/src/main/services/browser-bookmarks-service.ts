import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { validateBookmarkRequest, validateBookmarkScan, type BookmarkScan } from '../../contracts/browser-bookmarks.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { bookmarkEnvironment, type BookmarkEnvironment } from './bookmark-discovery.js'

function owner(caller: CallerIdentity) { return JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId]) }
export class BrowserBookmarksService {
  #jobs = new Map<string, { id: string; abort: () => void; done: Promise<BookmarkScan> }>()
  #stopped = false
  constructor(private readonly environment = bookmarkEnvironment(), private readonly timeoutMs = 15000) {}
  stop() { this.#stopped = true; for (const job of this.#jobs.values()) job.abort(); return Promise.allSettled([...this.#jobs.values()].map(job => job.done)).then(() => {}) }
  cancel(value: unknown, caller: CallerIdentity) {
    validateBookmarkRequest(value)
    const job = this.#jobs.get(owner(caller)), found = job?.id === value.operationId
    if (found) job!.abort()
    return { success: true, cancelRequested: found }
  }
  async scan(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<BookmarkScan> {
    validateBookmarkRequest(value); signal.throwIfAborted()
    const key = owner(caller)
    if (this.#stopped) throw new Error('书签读取服务已停止')
    if (this.#jobs.size >= 2 || this.#jobs.has(key)) throw new Error('书签正在读取，请稍后重试')
    const worker = new Worker(new URL('../workers/bookmark-reader-worker.js', pathToFileURL(__filename)), {
      workerData: this.environment satisfies BookmarkEnvironment, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
    })
    let failure: Error | undefined, reply: unknown, messages = 0
    const abort = () => { failure ??= new Error('书签读取已取消'); void worker.terminate().catch(error => { failure = new Error(`停止书签读取失败：${String(error)}`) }) }
    const done = new Promise<BookmarkScan>((resolve, reject) => {
      const timer = setTimeout(() => { failure = new Error('书签读取超时，请关闭繁忙的浏览器后重试'); abort() }, this.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      worker.on('message', value => { reply = value; if (++messages > 1) { failure = new Error('书签读取响应重复'); abort() } })
      worker.on('error', error => { failure = error; abort() })
      worker.once('exit', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        this.#jobs.delete(key)
        if (failure) { reject(failure); return }
        if (code || messages !== 1) { reject(new Error('书签读取进程意外退出')); return }
        try {
          if ((reply as { success?: unknown })?.success === false) throw new Error(String((reply as { error?: unknown }).error || '书签读取失败'))
          resolve(validateBookmarkScan(reply))
        } catch (error) { reject(error) }
      })
    })
    this.#jobs.set(key, { id: value.operationId, abort, done })
    if (signal.aborted) abort()
    return done
  }
}
