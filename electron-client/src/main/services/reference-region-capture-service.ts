import { setTimeout as delay } from 'node:timers/promises'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RegionSelectionBackend } from '../platform/macos/region-selection.js'
import type { ScreenService } from './screen-service.js'
/** All overlays close before capture; display changes cancel rather than capture shifted coordinates. */
export class ReferenceRegionCaptureService {
  #stopped = false
  readonly #pending = new Map<number, { controller: AbortController; drained: Promise<void> }>()
  constructor(
    private readonly screen: Pick<ScreenService, 'getAllDisplays' | 'captureReference'> &
      Partial<Pick<ScreenService, 'beginCaptureAuthorization'>>,
    private readonly selection: RegionSelectionBackend,
    private readonly afterSelection: (signal: AbortSignal) => Promise<void> = signal => delay(100, undefined, { signal })
  ) {}
  async capture(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new ZToolsError(errorCodes.invalidRequest, 'Region selection does not accept path or preset parameters')
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.size) throw new ZToolsError(errorCodes.pluginBusy, 'Region selection is already in progress')
    if (caller.type === 'plugin' && !this.screen.beginCaptureAuthorization) {
      throw new ZToolsError(errorCodes.notSupported, 'Screen capture authorization service is not wired; capture aborted')
    }
    const lease = this.screen.beginCaptureAuthorization?.(caller)
    if (caller.type === 'plugin' && !lease) {
      throw new ZToolsError(errorCodes.permissionDenied, 'Current plugin instance is not authorized for screen capture')
    }
    const controller = new AbortController(), combined = lease
      ? AbortSignal.any([controller.signal, signal, lease.signal])
      : AbortSignal.any([controller.signal, signal])
    let drain!: () => void
    this.#pending.set(caller.webContentsId, { controller, drained: new Promise<void>(resolve => { drain = resolve }) })
    const active = () => {
      if (this.#stopped || signal.aborted || controller.signal.aborted) throw cancelled()
      if (lease?.signal.aborted) {
        lease.assertCurrent()
        throw new ZToolsError(errorCodes.permissionDenied, 'Screen capture authorization has been revoked')
      }
      if (combined.aborted) throw cancelled()
      lease?.assertCurrent()
    }
    try {
      const displays = this.screen.getAllDisplays().displays
      const fingerprint = (items: typeof displays) => JSON.stringify(items.map(item => ({ id: item.id, bounds: item.bounds, scaleFactor: item.scaleFactor, rotation: item.rotation })))
      const before = fingerprint(displays), rect = await this.selection.select(displays.map(display => ({ ...display.bounds })), combined)
      active(); if (!rect) return { success: true as const, cancelled: true as const }
      try { await this.afterSelection(combined) } catch { active(); throw new ZToolsError(errorCodes.screenError, 'Failed waiting after selection overlay closed') }
      active()
      if (fingerprint(this.screen.getAllDisplays().displays) !== before) throw new ZToolsError(errorCodes.screenError, 'Display layout changed; please select again')
      // Selection is one display at a time; negative desktop origins remain valid.
      if (!displays.some(display => rect.x >= display.bounds.x && rect.y >= display.bounds.y && rect.x + rect.width <= display.bounds.x + display.bounds.width && rect.y + rect.height <= display.bounds.y + display.bounds.height) || !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key as keyof typeof rect])) || rect.width < 1 || rect.height < 1) throw new ZToolsError(errorCodes.screenError, 'Selection area is no longer valid')
      return await this.screen.captureReference({ rect }, caller, combined, lease)
    } finally { this.#pending.delete(caller.webContentsId); drain(); lease?.release() }
  }
  async stop(): Promise<void> {
    this.#stopped = true; const tasks = [...this.#pending.values()]; for (const task of tasks) task.controller.abort()
    await Promise.all(tasks.map(task => task.drained)); await this.selection.stop()
  }
}
function cancelled() { return new ZToolsError(errorCodes.callerDestroyed, 'Region capture cancelled') }
