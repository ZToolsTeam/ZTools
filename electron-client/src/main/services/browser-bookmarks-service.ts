import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { validateBookmarkRequest, validateBookmarkScan, type BookmarkScan } from '../../contracts/browser-bookmarks.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
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
  /** 读取失败的原因（权限、超时、繁忙）要原样交给插件；普通 Error 经 IPC 会被统一成“宿主内部错误” */
  async scan(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<BookmarkScan> {
    try { return await this.#scan(value, caller, signal) }
    catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
    }
  }
  async #scan(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<BookmarkScan> {
    validateBookmarkRequest(value); signal.throwIfAborted()
    const key = owner(caller)
    if (this.#stopped) throw new Error('Bookmark reader service has stopped')
    if (this.#jobs.size >= 2 || this.#jobs.has(key)) throw new Error('Bookmark scan is already in progress, please retry later')
    const worker = new Worker(new URL('../workers/bookmark-reader-worker.js', pathToFileURL(__filename)), {
      workerData: this.environment satisfies BookmarkEnvironment, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
    })
    let failure: Error | undefined, reply: unknown, messages = 0
    const abort = () => { failure ??= new Error('Bookmark scan cancelled'); void worker.terminate().catch(error => { failure = new Error(`Failed to terminate bookmark scan: ${String(error)}`) }) }
    const done = new Promise<BookmarkScan>((resolve, reject) => {
      const timer = setTimeout(() => { failure = new Error('Bookmark scan timed out; close busy browsers and retry'); abort() }, this.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      worker.on('message', value => { reply = value; if (++messages > 1) { failure = new Error('Duplicate bookmark scan response'); abort() } })
      worker.on('error', error => { failure = error; abort() })
      worker.once('exit', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        this.#jobs.delete(key)
        if (failure) { reject(failure); return }
        if (code || messages !== 1) { reject(new Error('Bookmark reader worker exited unexpectedly')); return }
        try {
          if ((reply as { success?: unknown })?.success === false) throw new Error(String((reply as { error?: unknown }).error || 'Bookmark scan failed'))
          resolve(validateBookmarkScan(reply))
        } catch (error) { reject(error) }
      })
    })
    this.#jobs.set(key, { id: value.operationId, abort, done })
    if (signal.aborted) abort()
    return done
  }
}
