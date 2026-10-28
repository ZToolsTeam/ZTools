import { lanScanRange, normalizeLanMac, validateLanRequest } from '../../contracts/lan-network.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { createLanNetworkProvider, type LanNetworkProvider } from './lan-network-provider.js'
const owner = (caller: CallerIdentity) => JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId])
export class LanNetworkService {
  #task: { id: string; owner: string; webContentsId: number; controller: AbortController; promise: Promise<unknown> } | undefined
  #stopped = false
  constructor(private readonly platform: string = process.platform, private readonly provider: LanNetworkProvider = createLanNetworkProvider(platform)) {}
  closeOwner(id: number) { if (this.#task?.webContentsId === id) this.#task.controller.abort(new Error('插件窗口已关闭')) }
  async stop() { this.#stopped = true; this.#task?.controller.abort(new Error('客户端正在退出')); await this.#task?.promise.catch(error => { if (!this.#stopped) throw error }) }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    try {
      validateLanRequest(value); signal.throwIfAborted()
      if (this.#stopped) throw new Error('局域网服务已停止')
      if (this.platform !== 'darwin' && this.platform !== 'win32') throw new Error('此局域网接口目前仅支持 macOS 和 Windows')
      if (value.action === 'cancel') {
        const task = this.#task
        if (task?.id === value.operationId) {
          if (task.owner !== owner(caller)) throw new Error('不能取消其他插件的操作')
          task.controller.abort(new Error('局域网操作已取消'))
          await task.promise.catch(error => { if (!task.controller.signal.aborted) throw error })
        }
        return { success: true, cancelled: task?.id === value.operationId }
      }
      const interfaces = this.provider.interfaces()
      if (value.action === 'interfaces') return { success: true, interfaces }
      if (this.#task) throw new Error('局域网操作正在进行，请等待完成或先停止')
      const iface = interfaces.find(v => v.id === value.interfaceId)
      if (!iface) throw new Error('所选网卡已断开或地址已变化，请重新读取网卡')
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25000)]), started = Date.now()
      const operation = (async () => {
        if (value.action === 'wake') {
          const bytes = await this.provider.wake(normalizeLanMac(value.mac), iface, combined)
          if (bytes !== 102) throw new Error('系统未确认完整发送唤醒包')
          return { success: true, bytes, broadcast: iface.broadcast, mac: normalizeLanMac(value.mac) }
        }
        const range = lanScanRange(iface, value.scanAddress), result = await this.provider.scan(iface, range.hosts, combined)
        combined.throwIfAborted()
        if (!this.provider.interfaces().some(v => v.id === iface.id)) throw new Error('扫描期间网卡已断开或地址变化，请重新扫描')
        return { success: true, ...result, range: range.cidr, scanned: range.hosts.length, durationMs: Date.now() - started, checkedAt: new Date().toISOString() }
      })()
      this.#task = { id: value.operationId, owner: owner(caller), webContentsId: caller.webContentsId, controller, promise: operation }
      try { return await operation } finally { this.#task = undefined }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : String(error)).slice(0, 2000))
    }
  }
}
