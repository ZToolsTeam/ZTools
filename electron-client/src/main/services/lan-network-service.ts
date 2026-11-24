import { lanScanRange, normalizeLanMac, validateLanRequest } from '../../contracts/lan-network.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { createLanNetworkProvider, type LanNetworkProvider } from './lan-network-provider.js'
const owner = (caller: CallerIdentity) => JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId])
export class LanNetworkService {
  #task: { id: string; owner: string; webContentsId: number; controller: AbortController; promise: Promise<unknown> } | undefined
  #stopped = false
  constructor(private readonly platform: string = process.platform, private readonly provider: LanNetworkProvider = createLanNetworkProvider(platform)) {}
  closeOwner(id: number) { if (this.#task?.webContentsId === id) this.#task.controller.abort(new Error('Plugin window closed')) }
  async stop() { this.#stopped = true; this.#task?.controller.abort(new Error('Client is exiting')); await this.#task?.promise.catch(error => { if (!this.#stopped) throw error }) }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    try {
      validateLanRequest(value); signal.throwIfAborted()
      if (this.#stopped) throw new Error('LAN network service has stopped')
      if (this.platform !== 'darwin' && this.platform !== 'win32') throw new Error('LAN network API is currently only supported on macOS and Windows')
      if (value.action === 'cancel') {
        const task = this.#task
        if (task?.id === value.operationId) {
          if (task.owner !== owner(caller)) throw new Error('Cannot cancel an operation owned by another plugin')
          task.controller.abort(new Error('LAN network operation cancelled'))
          await task.promise.catch(error => { if (!task.controller.signal.aborted) throw error })
        }
        return { success: true, cancelled: task?.id === value.operationId }
      }
      const interfaces = this.provider.interfaces()
      if (value.action === 'interfaces') return { success: true, interfaces }
      if (this.#task) throw new Error('A LAN network operation is already in progress; wait for completion or cancel it first')
      const iface = interfaces.find(v => v.id === value.interfaceId)
      if (!iface) throw new Error('Selected network interface is disconnected or its address changed; reload interfaces')
      const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(25000)]), started = Date.now()
      const operation = (async () => {
        if (value.action === 'wake') {
          const bytes = await this.provider.wake(normalizeLanMac(value.mac), iface, combined)
          if (bytes !== 102) throw new Error('System did not confirm full transmission of Wake-on-LAN packet')
          return { success: true, bytes, broadcast: iface.broadcast, mac: normalizeLanMac(value.mac) }
        }
        const range = lanScanRange(iface, value.scanAddress), result = await this.provider.scan(iface, range.hosts, combined)
        combined.throwIfAborted()
        if (!this.provider.interfaces().some(v => v.id === iface.id)) throw new Error('Network interface disconnected or address changed during scan; scan again')
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
