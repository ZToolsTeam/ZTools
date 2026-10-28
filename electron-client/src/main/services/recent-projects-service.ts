import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { validateRecentProjectsRequest, validateRecentProjectsScan, type RecentProjectsScan, type RecentProject } from '../../contracts/recent-projects.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { projectsEnvironment, type ProjectsEnvironment } from './recent-projects-reader.js'
import { launchRecentProject } from './recent-projects-launcher.js'

export async function readProjectsInWorker(env: ProjectsEnvironment, signal: AbortSignal): Promise<RecentProjectsScan> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('../workers/recent-projects-worker.js', pathToFileURL(__filename)), { workerData: env, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 } })
  return new Promise((resolve, reject) => {
    let response: unknown, count = 0, error: Error | undefined
    const terminate = () => { void worker.terminate().catch(e => { error = new Error(`项目读取进程停止失败：${String(e)}`) }) }
    const abort = () => { error = new Error('项目读取已取消'); terminate() }
    const timeout = setTimeout(() => { error = new Error('项目读取超时，请稍后重试'); terminate() }, 15000)
    worker.on('message', message => { response = message; count++; if (count > 1) { error = new Error('项目扫描响应重复'); terminate() } })
    worker.on('error', e => { error = e; terminate() })
    signal.addEventListener('abort', abort, { once: true })
    worker.once('exit', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', abort)
      try {
        if (error) throw error
        if (code || count !== 1) throw new Error('项目读取进程未完整返回')
        if ((response as { success?: unknown })?.success === false) throw new Error(String((response as { error?: unknown }).error || '项目读取失败'))
        resolve(validateRecentProjectsScan(response))
      } catch (e) { reject(e) }
    })
    if (signal.aborted) abort()
  })
}
const ownerKey = (c: CallerIdentity) => JSON.stringify([c.webContentsId, c.pluginId, c.pluginInstanceId, c.attributedPlugin?.sessionId])
export class RecentProjectsService {
  #stopped = false
  #jobs = new Map<string, { id: string; window: number; controller: AbortController; done: Promise<unknown> }>()
  #records = new Map<string, { window: number; projects: RecentProject[] }>()
  constructor(private readonly environment = projectsEnvironment(), private readonly scan = readProjectsInWorker, private readonly launch = launchRecentProject, private readonly platform = process.platform) {}
  closeOwner(id: number) {
    for (const job of this.#jobs.values()) if (job.window === id) job.controller.abort()
    for (const [key, data] of this.#records) if (data.window === id) this.#records.delete(key)
  }
  async stop() { this.#stopped = true; this.#records.clear(); for (const j of this.#jobs.values()) j.controller.abort(); await Promise.allSettled([...this.#jobs.values()].map(j => j.done)) }
  async handle(input: unknown, caller: CallerIdentity, signal: AbortSignal) {
    try {
      validateRecentProjectsRequest(input); signal.throwIfAborted()
      if (this.#stopped || (this.platform !== 'darwin' && this.platform !== 'win32')) throw new Error('最近项目服务不可用')
      const key = ownerKey(caller), running = this.#jobs.get(key)
      if (input.action === 'cancel') {
        const matching = running?.id === input.operationId
        if (matching) { running.controller.abort(); await Promise.allSettled([running.done]) }
        return { success: true, cancelled: matching }
      }
      if (running || this.#jobs.size >= 2) throw new Error('项目操作正在进行，请稍后重试')
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(20000)])
      const operation = (async () => {
        if (input.action === 'scan') {
          this.#records.delete(key)
          const result = validateRecentProjectsScan(await this.scan(this.environment, combined))
          combined.throwIfAborted()
          if (this.#records.size >= 8) this.#records.delete(this.#records.keys().next().value!)
          this.#records.set(key, { window: caller.webContentsId, projects: result.projects })
          return result
        }
        const cache = this.#records.get(key), project = cache?.projects.find(p => p.id === input.id)
        if (!cache || !project) throw new Error('项目记录已过期或不属于当前插件，请重新扫描')
        return this.launch(project, input.action, combined)
      })()
      this.#jobs.set(key, { id: input.action === 'scan' ? input.operationId : input.id, window: caller.webContentsId, controller, done: operation })
      try { return await operation } finally { this.#jobs.delete(key) }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
    }
  }
}
