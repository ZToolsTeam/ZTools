import type { ConfigService } from '../services/config-service.js'
import type { TriggerService } from '../services/trigger-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeMouseTriggerConfig
} from '../native-host/native-host-client.js'
import {
  decodeSuperPanelConfig,
  DEFAULT_SUPER_PANEL_CONFIG,
  DEFAULT_SUPER_PANEL_MODIFIERS,
  LEGACY_SUPER_PANEL_ACCELERATOR,
  type SuperPanelConfig
} from './config.js'
import { normalizedAccelerator } from '../services/trigger-service.js'

const USER_SETTINGS_FILE = 'user_settings.json'
/** 全局唤醒（悬浮条）未设置时，渲染进程启动会按这个默认值注册；存的是空串表示用户已关闭 */
export const DEFAULT_GLOBAL_WAKE_ACCELERATOR = 'Alt+Space'

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
  config: Pick<ConfigService, 'get'> & Partial<Pick<ConfigService, 'set'>>
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
      const encoded = await this.options.config.get(USER_SETTINGS_FILE, 'super_panel', {})
      const config = await this.#migrateLegacyKeyboard(encoded, decodeSuperPanelConfig(encoded))
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

  /**
   * 旧版本超级面板与全局唤醒默认都是 Alt+Space，两者同时启用时总有一个注册失败。
   * 仅当超级面板仍是旧默认值、且全局唤醒实际也在用 Alt+Space 时，把超级面板改为新默认值并写回配置；
   * 用户已把全局唤醒改成别的键时，保留超级面板的 Alt+Space 不动。
   */
  async #migrateLegacyKeyboard(encoded: string, config: SuperPanelConfig): Promise<SuperPanelConfig> {
    const legacy = normalizedAccelerator(LEGACY_SUPER_PANEL_ACCELERATOR)
    if (!config.enabled || !config.keyboard.enabled || normalizedAccelerator(config.keyboard.accelerator) !== legacy) {
      return config
    }
    let wake = ''
    try {
      wake = String(await this.options.config.get(USER_SETTINGS_FILE, 'hotkey.global', DEFAULT_GLOBAL_WAKE_ACCELERATOR)).trim()
    } catch {
      // 读不到全局唤醒设置时不做迁移，维持原状
      return config
    }
    // 空串表示用户已关闭全局唤醒，Alt+Space 不再被占用，保留超级面板原设置
    if (normalizedAccelerator(wake) !== legacy) return config

    const migrated: SuperPanelConfig = {
      ...config,
      keyboard: { ...config.keyboard, accelerator: DEFAULT_SUPER_PANEL_CONFIG.keyboard.accelerator }
    }
    if (typeof this.options.config.set === 'function') {
      try {
        const stored: Record<string, unknown> = (() => {
          try {
            const parsed: unknown = JSON.parse(encoded)
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
          } catch {
            return {}
          }
        })()
        const keyboard = typeof stored.keyboardHotkey === 'object' && stored.keyboardHotkey !== null && !Array.isArray(stored.keyboardHotkey)
          ? stored.keyboardHotkey as Record<string, unknown>
          : {}
        stored.keyboardHotkey = { ...keyboard, enabled: true, modifiers: [...DEFAULT_SUPER_PANEL_MODIFIERS], key: 'Space' }
        await this.options.config.set(USER_SETTINGS_FILE, 'super_panel', JSON.stringify(stored), false)
      } catch (error) {
        // 写回失败不影响本次使用新键，下次启动会再次迁移
        console.warn('超级面板快捷键迁移写回配置失败', error)
      }
    }
    return migrated
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
  config: Pick<ConfigService, 'get'> & Partial<Pick<ConfigService, 'set'>>,
  triggers: Pick<TriggerService, 'syncSuperPanelHotkey'>,
  nativeInput: NativeInputAdapter | null,
  toggle: (trigger: 'mouse_hotkey') => void
): SuperPanelInputService {
  return new SuperPanelInputService({ config, triggers, nativeInput, toggle })
}
