import { errorCodes, ZToolsError } from '../../contracts/errors.js'

const DRAIN_METHODS = new Set(['dll_query_task', 'dll_cancel_task', 'dll_clear_task', 'dll_unload'])

/** Main-only update lease. A timed-out transport request remains owned until
 * its actual response or Host exit; timeout cannot authorize replacing a DLL. */
export class NativePluginMaintenance {
  readonly #locks = new Map<string, symbol>()
  readonly #sent = new Map<string, string>()

  assertAllowed(pluginId: string, method: string): void {
    if (this.#locks.has(pluginId.toLowerCase()) && !DRAIN_METHODS.has(method)) {
      throw new ZToolsError(errorCodes.pluginBusy, '插件原生模块正在更新')
    }
  }

  sent(requestId: string, pluginId: string, method: string): void {
    this.assertAllowed(pluginId, method)
    if (pluginId && !DRAIN_METHODS.has(method)) this.#sent.set(requestId, pluginId.toLowerCase())
  }

  settled(requestId: string): void { this.#sent.delete(requestId) }
  hostExited(): void { this.#sent.clear() }

  async acquire(pluginId: string, timeoutMs = 8_000): Promise<() => void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pluginId) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new ZToolsError(errorCodes.invalidRequest, '原生维护参数无效')
    }
    const key = pluginId.toLowerCase()
    if (this.#locks.has(key)) throw new ZToolsError(errorCodes.pluginBusy, '插件原生模块已在更新')
    const token = Symbol(key)
    this.#locks.set(key, token)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (this.#locks.get(key) === token) this.#locks.delete(key)
    }
    const deadline = Date.now() + timeoutMs
    try {
      while ([...this.#sent.values()].includes(key)) {
        if (Date.now() >= deadline) throw new ZToolsError(errorCodes.pluginBusy, '插件仍有未确认的原生调用')
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))))
      }
      return release
    } catch (error) { release(); throw error }
  }
}
