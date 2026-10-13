import type { ConfigService } from '../services/config-service.js'
import type { TriggerService } from '../services/trigger-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeMouseTriggerConfig
} from '../native-host/native-host-client.js'
import { decodeSuperPanelConfig } from './config.js'

export interface NativeInputAdapter {
  readonly state: string
  configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void>
  onInputEvent(listener: (event: NativeInputEvent) => void): () => void
  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void
}

function isNativeInputAdapter(
  value: NativeInputAdapter | null | undefined
): value is NativeInputAdapter {
  return value !== null && typeof value === 'object' &&
    typeof value.state === 'string' &&
    typeof value.configureMouseTrigger === 'function' &&
    typeof value.onInputEvent === 'function' &&
    typeof value.onLifecycleEvent === 'function'
}

export interface SuperPanelInputServiceOptions {
  config: Pick<ConfigService, 'get'>
  triggers: Pick<TriggerService, 'syncSuperPanelHotkey'>
  nativeInput: NativeInputAdapter | null
  toggle(trigger: 'mouse_hotkey'): void
}

export class SuperPanelInputService {
  readonly ready: Promise<void>
  readonly #nativeInput: NativeInputAdapter | null
  readonly #removeInputListener: () => void
  readonly #removeLifecycleListener: () => void
  #queue: Promise<unknown> = Promise.resolve()
  #appliedMouse: NativeMouseTriggerConfig | null = null
  #stopping = false
  #lastError = ''

  constructor(private readonly options: SuperPanelInputServiceOptions) {
    const nativeInput = isNativeInputAdapter(options.nativeInput) ? options.nativeInput : null
    this.#nativeInput = nativeInput
    let removeInputListener: (() => void) | undefined
    let removeLifecycleListener: (() => void) | undefined
    try {
      if (nativeInput) {
        removeInputListener = nativeInput.onInputEvent((event) => this.#handleInput(event))
        removeLifecycleListener = nativeInput.onLifecycleEvent((event) => {
          if (event.type !== 'restarted' || this.#stopping) return
          this.#appliedMouse = null
          void this.reload().catch((error: unknown) => {
            this.#lastError = error instanceof Error ? error.message : String(error)
            console.error('超级面板输入在 NativeHost32 重启后恢复失败', error)
          })
        })
      }
      this.#removeInputListener = removeInputListener ?? (() => undefined)
      this.#removeLifecycleListener = removeLifecycleListener ?? (() => undefined)
      this.ready = this.reload()
    } catch (constructionError) {
      const cleanupErrors: unknown[] = []
      for (const cleanup of [removeLifecycleListener, removeInputListener]) {
        if (!cleanup) continue
        try {
          cleanup()
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [constructionError, ...cleanupErrors],
          'SuperPanelInputService construction and listener cleanup both failed'
        )
      }
      throw constructionError
    }
  }

  get diagnostics(): { mouseSupported: boolean; mouseEnabled: boolean; lastError: string } {
    return {
      mouseSupported: this.#nativeInput !== null,
      mouseEnabled: this.#appliedMouse !== null,
      lastError: this.#lastError
    }
  }

  reload(): Promise<void> {
    return this.#serialize(async () => {
      const encoded = await this.options.config.get('user_settings.json', 'super_panel', {})
      const config = decodeSuperPanelConfig(encoded)
      const desiredMouse = config.enabled && config.mouse.enabled ? config.mouse.trigger : null
      const errors: unknown[] = []
      try {
        await this.options.triggers.syncSuperPanelHotkey(
          config.enabled && config.keyboard.enabled,
          config.keyboard.accelerator
        )
      } catch (error) {
        errors.push(error)
      }
      const nativeInput = this.#nativeInput
      if (nativeInput) {
        try {
          await nativeInput.configureMouseTrigger(desiredMouse)
          this.#appliedMouse = desiredMouse
        } catch (error) {
          this.#appliedMouse = null
          errors.push(error)
        }
      } else {
        this.#appliedMouse = null
      }
      if (errors.length > 0) {
        this.#lastError = errors
          .map((error) => error instanceof Error ? error.message : String(error))
          .join('; ')
        throw errors[0]
      }
      this.#lastError = ''
    })
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#queue.then(() => undefined, () => undefined)
    this.#stopping = true
    this.#removeInputListener()
    this.#removeLifecycleListener()
    const stopped = this.#queue.catch(() => undefined).then(async () => {
      const nativeInput = this.#nativeInput
      if (nativeInput?.state === 'ready') {
        await nativeInput.configureMouseTrigger(null).catch(() => undefined)
      }
      this.#appliedMouse = null
    })
    this.#queue = stopped
    return stopped
  }

  #serialize(operation: () => Promise<void>): Promise<void> {
    const current = this.#queue.catch(() => undefined).then(async () => {
      if (this.#stopping) return
      await operation()
    })
    this.#queue = current
    return current
  }

  #handleInput(event: NativeInputEvent): void {
    if (this.#stopping || event.type !== 'mouse-trigger' || !this.#appliedMouse) return
    const applied = this.#appliedMouse
    if (
      event.config.button !== applied.button || event.config.action !== applied.action ||
      event.config.longPressMs !== applied.longPressMs
    ) return
    this.options.toggle('mouse_hotkey')
  }
}

export function createSuperPanelInputService(
  config: Pick<ConfigService, 'get'>,
  triggers: Pick<TriggerService, 'syncSuperPanelHotkey'>,
  nativeInput: NativeInputAdapter | null,
  toggle: (trigger: 'mouse_hotkey') => void
): SuperPanelInputService {
  return new SuperPanelInputService({ config, triggers, nativeInput, toggle })
}
