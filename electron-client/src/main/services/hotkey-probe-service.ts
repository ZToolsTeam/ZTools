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
    if (result?.success !== true) throw new Error(result?.error || '系统探测结果无效')
    if (!Array.isArray(result.results) || result.results.length !== combos.length || result.results.some((r, i) => !r || r.combo !== combos[i] || !['registered', 'occupied', 'system'].includes(r.status))) throw new Error('系统探测回执不完整')
    return result.results
  }
}
export class HotkeyProbeService {
  #busy = false
  constructor(private readonly native: HotkeyNativeProbe, private readonly shortcuts: HotkeyProbePort, private readonly ready: () => boolean, private readonly platform = process.platform) {}
  async probe(request: unknown, signal?: AbortSignal) {
    const combos = parseHotkeyProbeRequest(request)
    if (this.platform !== 'darwin') throw new ZToolsError(errorCodes.platformNotSupported, '当前探测接口仅用于 macOS')
    if (this.#busy || !this.ready() || this.shortcuts.isSuspended()) throw new ZToolsError(errorCodes.pluginBusy, '快捷键服务尚未就绪、已暂停或正在检测，请稍后重试')
    this.#busy = true
    try {
      signal?.throwIfAborted()
      const owned = new Set(combos.filter(c => this.shortcuts.isRegistered(c))), pending = combos.filter(c => !owned.has(c))
      const native = pending.length ? await this.native(pending, signal) : []
      signal?.throwIfAborted()
      const results: HotkeyProbeResult[] = combos.map(combo => owned.has(combo) ? { combo, status: 'owned' } : native.find(r => r.combo === combo)!)
      if (results.some(r => !r)) throw new Error('系统探测结果缺失')
      return { success: true, checkedAt: new Date().toISOString(), results }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (signal?.aborted) throw new ZToolsError(errorCodes.cancelled, '热键探测已取消')
      throw new ZToolsError(errorCodes.nativeHostError, `热键探测失败，请确认客户端原生组件已构建：${error instanceof Error ? error.message : String(error)}`)
    } finally { this.#busy = false }
  }
}
