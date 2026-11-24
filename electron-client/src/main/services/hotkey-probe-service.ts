import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { parseHotkeyProbeRequest, type HotkeyProbeResult } from '../../contracts/hotkey-probe.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
export interface HotkeyProbePort { isRegistered(combo: string): boolean; isSuspended(): boolean }
export type HotkeyNativeProbe = (combos: string[], signal?: AbortSignal) => Promise<HotkeyProbeResult[]>
const exec = promisify(execFile)
export function macHotkeysHelperPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacHotkeys') : path.resolve(__dirname, '../../mac-hotkeys-native/native/ZToolsMacHotkeys')
}
export function nativeHotkeyProbe(executable: string): HotkeyNativeProbe {
  return async (combos, signal) => {
    const { stdout } = await exec(executable, [JSON.stringify(combos)], { encoding: 'utf8', signal, timeout: 8000, maxBuffer: 32768, shell: false })
    const result = JSON.parse(stdout) as { success?: boolean; error?: string; results?: HotkeyProbeResult[] }
    if (result?.success !== true) throw new Error(result?.error || 'Invalid system hotkey probe result')
    if (!Array.isArray(result.results) || result.results.length !== combos.length || result.results.some((r, i) => !r || r.combo !== combos[i] || !['registered', 'occupied', 'system'].includes(r.status))) throw new Error('Incomplete system hotkey probe receipt')
    return result.results
  }
}
export class HotkeyProbeService {
  #busy = false
  constructor(private readonly native: HotkeyNativeProbe, private readonly shortcuts: HotkeyProbePort, private readonly ready: () => boolean, private readonly platform = process.platform) {}
  async probe(request: unknown, signal?: AbortSignal) {
    const combos = parseHotkeyProbeRequest(request)
    if (this.platform !== 'darwin') throw new ZToolsError(errorCodes.platformNotSupported, 'Hotkey probe API is only supported on macOS')
    if (this.#busy || !this.ready() || this.shortcuts.isSuspended()) throw new ZToolsError(errorCodes.pluginBusy, 'Hotkey service is not ready, suspended, or currently probing; try again later')
    this.#busy = true
    try {
      signal?.throwIfAborted()
      const owned = new Set(combos.filter(c => this.shortcuts.isRegistered(c))), pending = combos.filter(c => !owned.has(c))
      const native = pending.length ? await this.native(pending, signal) : []
      signal?.throwIfAborted()
      const results: HotkeyProbeResult[] = combos.map(combo => owned.has(combo) ? { combo, status: 'owned' } : native.find(r => r.combo === combo)!)
      if (results.some(r => !r)) throw new Error('Missing system hotkey probe result')
      return { success: true, checkedAt: new Date().toISOString(), results }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (signal?.aborted) throw new ZToolsError(errorCodes.cancelled, 'Hotkey probe cancelled')
      throw new ZToolsError(errorCodes.nativeHostError, `Hotkey probe failed; ensure native client component is built: ${error instanceof Error ? error.message : String(error)}`)
    } finally { this.#busy = false }
  }
}
