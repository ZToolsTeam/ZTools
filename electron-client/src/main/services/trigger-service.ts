import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  isValidElectronAccelerator,
  type TriggerConflictParams,
  type TriggerListParams,
  type TriggerRegisterParams,
  type TriggerSetEnabledParams
} from '../../contracts/method-params.js'
import type { PluginOpenParams } from '../../contracts/method-params.js'
import type { EventService } from './event-service.js'
import { JsonFileStore, type JsonObject } from './json-file-store.js'
import type { PluginStateProvider } from './plugin-state-service.js'
import type {
  NativeHostLifecycleEvent,
  NativeInputEvent,
  NativeKeyboardModifier
} from '../native-host/native-host-client.js'

const TRIGGER_FILE = 'triggers.json'

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface KeyboardDoubleTapAdapter {
  configureKeyboardDoubleTap(modifiers: readonly NativeKeyboardModifier[]): Promise<void>
  onInputEvent(listener: (event: NativeInputEvent) => void): () => void
  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void
}

export interface TriggerDocumentStore {
  read(fileName: string): Promise<JsonObject>
  replace(fileName: string, document: JsonObject): Promise<void>
}

export interface TriggerServiceOptions {
  dataRoot: string
  shortcuts: GlobalShortcutAdapter
  events: Pick<EventService, 'publishHost'>
  toggleMainWindow(): void
  toggleSuperPanel(trigger: 'keyboard_hotkey'): void
  openPlugin(params: PluginOpenParams): Promise<unknown>
  launchLocalApp?(appId: string): Promise<void>
  store?: TriggerDocumentStore
  state?: PluginStateProvider
  keyboard?: KeyboardDoubleTapAdapter
}

interface StoredTrigger {
  id: string
  pluginId: string
  type: 'hotkey' | 'timer' | 'hook' | 'clipboard' | 'network'
  config: JsonObject
  action: {
    mode: 'builtin' | 'dll' | 'script' | 'window'
    target: string
    params: JsonObject
  }
  enabled: boolean
  priority: number
  createTime: string
  raw: JsonObject
  actionShape: 'nested' | 'flat'
}

type ListedTrigger = StoredTrigger & { effectiveEnabled: boolean }
type TriggerOrderItem = { triggerId: string } | { invalid: unknown }

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function parseStoredTrigger(value: unknown): StoredTrigger {
  if (!isRecord(value) || !isIdentifier(value.id) || !isIdentifier(value.pluginId)) {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器配置包含无效标识')
  }
  const type = value.type ?? 'hotkey'
  if (!['hotkey', 'timer', 'hook', 'clipboard', 'network'].includes(String(type))) {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器类型无效')
  }
  const config = value.config === undefined ? {} : value.config
  if (!isRecord(config)) throw new ZToolsError(errorCodes.dataCorrupt, '触发器 config 无效')

  const nestedAction = isRecord(value.action) ? value.action : undefined
  if (value.action !== undefined && nestedAction === undefined) {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器 action 无效')
  }
  const mode = nestedAction?.mode ?? value.actionMode ?? 'builtin'
  const target = nestedAction?.target ?? value.actionTarget ?? ''
  const params = nestedAction?.params ?? value.actionParams ?? {}
  if (
    !['builtin', 'dll', 'script', 'window'].includes(String(mode)) ||
    typeof target !== 'string' ||
    !isRecord(params)
  ) {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器 action 无效')
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器 enabled 无效')
  }
  if (value.priority !== undefined && !Number.isInteger(value.priority)) {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器 priority 无效')
  }
  if (value.createTime !== undefined && typeof value.createTime !== 'string') {
    throw new ZToolsError(errorCodes.dataCorrupt, '触发器 createTime 无效')
  }
  return {
    id: value.id,
    pluginId: value.pluginId,
    type: type as StoredTrigger['type'],
    config: cloneObject(config),
    action: {
      mode: mode as StoredTrigger['action']['mode'],
      target,
      params: cloneObject(params)
    },
    enabled: value.enabled === true,
    priority: typeof value.priority === 'number' ? value.priority : 0,
    createTime: typeof value.createTime === 'string' ? value.createTime : '',
    raw: cloneObject(value),
    actionShape: nestedAction ? 'nested' : 'flat'
  }
}

function fromRegisterParams(params: TriggerRegisterParams): StoredTrigger {
  const sourceAction = params.action ?? {
    mode: params.actionMode as StoredTrigger['action']['mode'],
    target: params.actionTarget as string,
    params: params.actionParams as JsonObject
  }
  return {
    id: params.id ?? randomUUID().toLowerCase(),
    pluginId: params.pluginId,
    type: params.type,
    config: cloneObject(params.config),
    action: {
      mode: sourceAction.mode,
      target: sourceAction.target,
      params: cloneObject(sourceAction.params)
    },
    enabled: params.enabled,
    priority: params.priority ?? 0,
    createTime: new Date().toISOString(),
    raw: {},
    actionShape: 'nested'
  }
}

function serializeTrigger(trigger: StoredTrigger): JsonObject {
  const document = cloneObject(trigger.raw)
  document.id = trigger.id
  document.pluginId = trigger.pluginId
  document.type = trigger.type
  document.config = cloneObject(trigger.config)
  document.enabled = trigger.enabled
  document.priority = trigger.priority
  document.createTime = trigger.createTime
  if (trigger.actionShape === 'nested') {
    const previousAction = isRecord(document.action) ? document.action : {}
    document.action = {
      ...previousAction,
      mode: trigger.action.mode,
      target: trigger.action.target,
      params: cloneObject(trigger.action.params)
    }
  } else {
    document.actionMode = trigger.action.mode
    document.actionTarget = trigger.action.target
    document.actionParams = cloneObject(trigger.action.params)
  }
  return document
}

function acceleratorOf(trigger: StoredTrigger): string | undefined {
  const key = trigger.config.key
  return trigger.type === 'hotkey' && typeof key === 'string' && key.trim() !== ''
    ? key.trim()
    : undefined
}

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta'
}
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta']

/**
 * 快捷键比较用的规范形式：忽略大小写与空白、统一修饰键别名（Option = Alt 等）并按固定顺序排列，
 * 这样 `Shift+Alt+Space` 与 `alt + shift + space` 会被识别为同一个组合键。
 */
export function normalizedAccelerator(key: string): string {
  const parts = key.replace(/\s+/g, '').toLowerCase().split('+').filter(Boolean)
  if (parts.length === 0) return ''
  const mainKey = parts[parts.length - 1] as string
  const modifiers = new Set<string>()
  for (const part of parts.slice(0, -1)) {
    if (part === 'commandorcontrol' || part === 'cmdorctrl') {
      modifiers.add(process.platform === 'darwin' ? 'meta' : 'ctrl')
    } else {
      modifiers.add(MODIFIER_ALIASES[part] ?? part)
    }
  }
  const ordered = [...modifiers].sort((a, b) => {
    const ia = MODIFIER_ORDER.indexOf(a)
    const ib = MODIFIER_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  return [...ordered, mainKey].join('+')
}

/** 冲突提示里展示占用者：系统内置触发器用功能名，其余显示插件 ID */
const SYSTEM_TRIGGER_NAMES: Record<string, string> = {
  super_panel_keyboard_hotkey: '超级面板',
  global_wake_hotkey: '全局唤醒'
}

function triggerOwnerName(trigger: StoredTrigger): string {
  if (Object.hasOwn(SYSTEM_TRIGGER_NAMES, trigger.id)) return SYSTEM_TRIGGER_NAMES[trigger.id] as string
  return trigger.pluginId.toLowerCase() === 'system' ? '系统快捷键' : `插件 ${trigger.pluginId}`
}

function localAppIdOf(trigger: StoredTrigger): string | undefined {
  if (trigger.action.mode !== 'builtin' || trigger.action.target !== 'launch_local_app') return undefined
  const params = trigger.action.params
  const appId = params.appId
  if (
    Object.keys(params).length !== 1 ||
    typeof appId !== 'string' ||
    !/^localapp:[A-F0-9]{8}$/i.test(appId) ||
    trigger.pluginId.toLowerCase() !== appId.toLowerCase()
  ) return undefined
  return appId
}

function doubleModifierOf(key: string): NativeKeyboardModifier | undefined {
  switch (key.replace(/[+\s]/g, '').toLowerCase()) {
    case 'doublectrl':
    case 'doublecontrol':
      return 'ctrl'
    case 'doublealt':
      return 'alt'
    case 'doubleshift':
      return 'shift'
    default:
      return undefined
  }
}

function isDoubleModifier(key: string): boolean {
  return doubleModifierOf(key) !== undefined
}

function isLocalAppId(value: unknown): value is string {
  return typeof value === 'string' && /^localapp:[A-F0-9]{8}$/i.test(value)
}

function hasRuntimeAction(trigger: StoredTrigger, canLaunchLocalApp: boolean): boolean {
  if (trigger.action.mode === 'window') return isIdentifier(trigger.action.target)
  if (trigger.action.mode !== 'builtin') return false
  if (trigger.action.target === 'toggle_main_window' || trigger.action.target === 'toggle_super_panel') return true
  return canLaunchLocalApp && trigger.action.target === 'launch_local_app' && localAppIdOf(trigger) !== undefined
}

export class TriggerService {
  readonly #store: TriggerDocumentStore
  readonly #triggers = new Map<string, StoredTrigger>()
  readonly #registered = new Map<string, string>()
  readonly #ready: Promise<void>
  #document: JsonObject = {}
  #order: TriggerOrderItem[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #stopping = false
  #stopPromise: Promise<void> | undefined
  #removeKeyboardInputListener: (() => void) | undefined
  #removeKeyboardLifecycleListener: (() => void) | undefined
  #keyboardConfig: NativeKeyboardModifier[] | undefined

  constructor(private readonly options: TriggerServiceOptions) {
    this.#store = options.store ?? new JsonFileStore(options.dataRoot, new Set([TRIGGER_FILE]))
    if (options.keyboard) {
      this.#removeKeyboardInputListener = options.keyboard.onInputEvent((event) => {
        this.#handleKeyboardInput(event)
      })
      this.#removeKeyboardLifecycleListener = options.keyboard.onLifecycleEvent((event) => {
        if (event.type === 'crashed') {
          this.#keyboardConfig = undefined
          return
        }
        if (event.type === 'restarted' && !this.#stopping) {
          this.#keyboardConfig = undefined
          void this.#serialize(async () => {
            await this.#syncKeyboardConfig()
          }).catch((error: unknown) => {
            console.warn('NativeHost32 重启后恢复双击修饰键失败', error)
          })
        }
      })
    }
    this.#ready = this.#load()
  }

  register(params: TriggerRegisterParams, caller: CallerIdentity): Promise<{ success: true; data: { triggerId: string } }> {
    return this.#serialize(async () => {
      const trigger = fromRegisterParams(params)
      this.#assertPluginAccess(trigger.pluginId, caller)
      await this.#requirePluginEnabled(trigger.pluginId)
      this.#requireSupported(trigger, caller)
      await this.#assertNoConflict(trigger)

      const previous = this.#triggers.get(trigger.id)
      if (previous) this.#assertPluginAccess(previous.pluginId, caller)
      const previousAccelerator = previous?.enabled ? acceleratorOf(previous) : undefined
      const nextAccelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
      const registrationChanged =
        previousAccelerator !== nextAccelerator ||
        (nextAccelerator !== undefined && this.#registered.get(trigger.id) !== nextAccelerator)

      if (registrationChanged && previousAccelerator) this.#unregister(trigger.id, previousAccelerator)
      if (
        registrationChanged &&
        nextAccelerator &&
        !this.#registerWithRestore(trigger.id, nextAccelerator, previousAccelerator)
      ) {
        throw new ZToolsError(errorCodes.triggerConflict, '操作系统拒绝注册该快捷键')
      }

      const next = new Map(this.#triggers)
      next.set(trigger.id, trigger)
      try {
        await this.#persist(next)
      } catch (error) {
        if (registrationChanged && nextAccelerator) this.#unregister(trigger.id, nextAccelerator)
        if (registrationChanged && previousAccelerator) this.#restore(trigger.id, previousAccelerator)
        throw error
      }
      this.#replaceTriggers(next)
      await this.#syncKeyboardConfig()
      return { success: true, data: { triggerId: trigger.id } }
    })
  }

  unregister(triggerId: string, caller: CallerIdentity): Promise<{ success: true; data: string }> {
    return this.#serialize(async () => {
      const previous = this.#triggers.get(triggerId)
      // 启动清理和重复注销均允许目标已经不存在。
      if (!previous) return { success: true, data: 'Trigger unregistered' }
      this.#assertPluginAccess(previous.pluginId, caller)
      const previousAccelerator = previous.enabled ? acceleratorOf(previous) : undefined
      if (previousAccelerator) this.#unregister(triggerId, previousAccelerator)

      const next = new Map(this.#triggers)
      next.delete(triggerId)
      try {
        await this.#persist(next)
      } catch (error) {
        if (previousAccelerator) this.#restore(triggerId, previousAccelerator)
        throw error
      }
      this.#replaceTriggers(next)
      await this.#syncKeyboardConfig()
      return { success: true, data: 'Trigger unregistered' }
    })
  }

  list(
    params: TriggerListParams,
    caller: CallerIdentity
  ): Promise<{ success: true; data: ListedTrigger[] }> {
    return this.#serialize(async () => {
      const pluginId = this.#effectivePluginId(params.pluginId, caller)
      const data = [...this.#triggers.values()]
        .filter((trigger) => pluginId === '' || trigger.pluginId === pluginId)
        .map((trigger) => ({
          ...parseStoredTrigger(trigger),
          effectiveEnabled: this.#isEffectivelyEnabled(trigger)
        }))
      return { success: true, data }
    })
  }

  syncPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    return this.#serialize(async () => {
      const affected = [...this.#triggers.values()].filter((trigger) =>
        trigger.pluginId.toLowerCase() === pluginId.toLowerCase()
      )
      for (const trigger of affected) {
        const accelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
        if (!enabled) {
          if (accelerator) this.#unregister(trigger.id, accelerator)
          continue
        }
        if (!accelerator || this.#registered.has(trigger.id)) continue
        try {
          this.#requireSupported(trigger)
          await this.#assertNoConflict(trigger)
          if (!this.#register(trigger.id, accelerator)) {
            console.warn(`插件触发器恢复失败: ${trigger.id}`)
          }
        } catch {
          console.warn(`插件触发器暂不可用: ${trigger.id}`)
        }
      }
      await this.#syncKeyboardConfig()
    })
  }

  removePlugin(pluginId: string): Promise<void> {
    return this.#serialize(async () => {
      const affected = [...this.#triggers.values()].filter((trigger) =>
        trigger.pluginId.toLowerCase() === pluginId.toLowerCase()
      )
      if (affected.length === 0) return
      const registrations = affected
        .map((trigger) => ({ trigger, accelerator: this.#registered.get(trigger.id) }))
        .filter((item): item is { trigger: StoredTrigger; accelerator: string } => item.accelerator !== undefined)
      for (const { trigger, accelerator } of registrations) {
        this.#unregister(trigger.id, accelerator)
      }
      const next = new Map(this.#triggers)
      for (const trigger of affected) next.delete(trigger.id)
      try {
        await this.#persist(next)
      } catch (error) {
        for (const { trigger, accelerator } of registrations) this.#restore(trigger.id, accelerator)
        throw error
      }
      this.#replaceTriggers(next)
      await this.#syncKeyboardConfig()
    })
  }

  syncSuperPanelHotkey(enabled: boolean, accelerator: string): Promise<void> {
    return this.#serialize(async () => {
      const triggerId = 'super_panel_keyboard_hotkey'
      const previous = this.#triggers.get(triggerId)
      const previousAccelerator = previous?.enabled ? acceleratorOf(previous) : undefined
      if (!enabled) {
        if (previousAccelerator) this.#unregister(triggerId, previousAccelerator)
        if (!previous) return
        const next = new Map(this.#triggers)
        next.delete(triggerId)
        try {
          await this.#persist(next)
        } catch (error) {
          if (previousAccelerator) this.#restore(triggerId, previousAccelerator)
          throw error
        }
        this.#replaceTriggers(next)
        await this.#syncKeyboardConfig()
        return
      }

      const trigger: StoredTrigger = {
        id: triggerId,
        pluginId: 'system',
        type: 'hotkey',
        config: { key: accelerator },
        action: { mode: 'builtin', target: 'toggle_super_panel', params: {} },
        enabled: true,
        priority: 0,
        createTime: previous?.createTime || new Date().toISOString(),
        raw: previous?.raw ?? {},
        actionShape: previous?.actionShape ?? 'nested'
      }
      this.#requireSupported(trigger)
      await this.#assertNoConflict(trigger)
      const nextAccelerator = acceleratorOf(trigger)
      if (!nextAccelerator) {
        throw new ZToolsError(errorCodes.invalidRequest, '超级面板快捷键不能为空')
      }
      const registrationChanged = previousAccelerator !== nextAccelerator ||
        this.#registered.get(triggerId) !== nextAccelerator
      if (registrationChanged && previousAccelerator) this.#unregister(triggerId, previousAccelerator)
      if (
        registrationChanged &&
        !this.#registerWithRestore(triggerId, nextAccelerator, previousAccelerator)
      ) {
        throw new ZToolsError(errorCodes.triggerConflict, '操作系统拒绝注册超级面板快捷键')
      }
      const next = new Map(this.#triggers)
      next.set(triggerId, trigger)
      try {
        await this.#persist(next)
      } catch (error) {
        if (registrationChanged) this.#unregister(triggerId, nextAccelerator)
        if (registrationChanged && previousAccelerator) this.#restore(triggerId, previousAccelerator)
        throw error
      }
      this.#replaceTriggers(next)
      await this.#syncKeyboardConfig()
    })
  }

  setEnabled(params: TriggerSetEnabledParams, caller: CallerIdentity): Promise<{ success: true; data: string }> {
    return this.#serialize(async () => {
      const previous = this.#requireTrigger(params.triggerId)
      this.#assertPluginAccess(previous.pluginId, caller)
      if (params.enabled) await this.#requirePluginEnabled(previous.pluginId)
      if (previous.enabled === params.enabled) {
        const currentAccelerator = acceleratorOf(previous)
        if (
          params.enabled &&
          currentAccelerator &&
          this.#registered.get(previous.id) !== currentAccelerator
        ) {
          this.#requireSupported(previous, caller)
          await this.#assertNoConflict(previous)
          if (!this.#register(previous.id, currentAccelerator)) {
            throw new ZToolsError(errorCodes.triggerConflict, '快捷键无效或已被其他程序占用')
          }
        }
        await this.#syncKeyboardConfig()
        return { success: true, data: 'Trigger state updated' }
      }
      const trigger: StoredTrigger = { ...previous, enabled: params.enabled }
      if (trigger.enabled) {
        this.#requireSupported(trigger, caller)
        await this.#assertNoConflict(trigger)
      }
      const accelerator = acceleratorOf(trigger) ?? acceleratorOf(previous)

      if (params.enabled && (!accelerator || !this.#register(trigger.id, accelerator))) {
        throw new ZToolsError(errorCodes.triggerConflict, '快捷键无效或已被其他程序占用')
      }
      if (!params.enabled && accelerator) this.#unregister(trigger.id, accelerator)

      const next = new Map(this.#triggers)
      next.set(trigger.id, trigger)
      try {
        await this.#persist(next)
      } catch (error) {
        if (params.enabled && accelerator) this.#unregister(trigger.id, accelerator)
        else if (accelerator) this.#restore(trigger.id, accelerator)
        throw error
      }
      this.#replaceTriggers(next)
      await this.#syncKeyboardConfig()
      return { success: true, data: 'Trigger state updated' }
    })
  }

  checkConflict(params: TriggerConflictParams, caller: CallerIdentity): Promise<{
    success: true
    data: {
      hasConflict: boolean
      conflicts: Array<{ pluginId: string; pluginName: string; triggerId: string; key: string }>
    }
  }> {
    return this.#serialize(async () => {
      const pluginId = this.#effectivePluginId(params.pluginId, caller)
      const normalized = normalizedAccelerator(params.key)
      const requestedModifier = doubleModifierOf(params.key)
      const conflicts = [...this.#triggers.values()]
        .filter((trigger) => {
          const key = acceleratorOf(trigger)
          return trigger.enabled && key !== undefined &&
            (requestedModifier !== undefined
              ? doubleModifierOf(key) === requestedModifier
              : trigger.pluginId.toLowerCase() !== pluginId.toLowerCase() &&
                normalizedAccelerator(key) === normalized)
        })
      const activeConflicts = []
      for (const trigger of conflicts) {
        if (await this.#isPluginEnabled(trigger.pluginId)) activeConflicts.push(trigger)
      }
      const result = activeConflicts.map((trigger) => ({
          pluginId: trigger.pluginId,
          pluginName: triggerOwnerName(trigger),
          triggerId: trigger.id,
          key: acceleratorOf(trigger) as string
        }))
      return { success: true, data: { hasConflict: result.length > 0, conflicts: result } }
    })
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#removeKeyboardInputListener?.()
    this.#removeKeyboardLifecycleListener?.()
    this.#stopPromise = this.#queue.catch(() => undefined).then(async () => {
      await this.#ready.catch(() => undefined)
      for (const [triggerId, accelerator] of this.#registered) {
        this.#unregister(triggerId, accelerator)
      }
      if (this.options.keyboard) {
        await this.options.keyboard.configureKeyboardDoubleTap([]).catch(() => undefined)
        this.#keyboardConfig = []
      }
    })
    this.#queue = this.#stopPromise
    return this.#stopPromise
  }

  async #load(): Promise<void> {
    const document = await this.#store.read(TRIGGER_FILE)
    const values = document.triggers ?? []
    if (!Array.isArray(values)) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'triggers.json 缺少 triggers 数组')
    }
    const loaded = new Map<string, StoredTrigger>()
    const order: TriggerOrderItem[] = []
    for (const [index, value] of values.entries()) {
      try {
        const trigger = parseStoredTrigger(value)
        if (loaded.has(trigger.id)) {
          throw new ZToolsError(errorCodes.dataCorrupt, `触发器 ID 重复: ${trigger.id}`)
        }
        loaded.set(trigger.id, trigger)
        order.push({ triggerId: trigger.id })
      } catch (error) {
        order.push({ invalid: value })
        this.#reportInvalidRecord(index, error)
      }
    }
    this.#document = document
    this.#order = order
    this.#replaceTriggers(loaded)
    for (const trigger of loaded.values()) {
      const accelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
      if (
        !accelerator ||
        (isDoubleModifier(accelerator)
          ? !this.options.keyboard
          : !isValidElectronAccelerator(accelerator)) ||
        !hasRuntimeAction(trigger, this.options.launchLocalApp !== undefined) ||
        !(await this.#isPluginEnabled(trigger.pluginId))
      ) continue
      try {
        if (!this.#register(trigger.id, accelerator)) {
          console.warn(`Global shortcut unavailable: ${trigger.id}`)
        }
      } catch {
        console.warn(`Global shortcut registration failed: ${trigger.id}`)
      }
    }
    await this.#syncKeyboardConfig()
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#queue.catch(() => undefined).then(async () => {
      await this.#ready
      if (this.#stopping) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
      return operation()
    })
    this.#queue = current
    return current
  }

  async #persist(triggers: Map<string, StoredTrigger>): Promise<void> {
    const values: unknown[] = []
    const nextOrder: TriggerOrderItem[] = []
    const emitted = new Set<string>()
    for (const item of this.#order) {
      if ('invalid' in item) {
        values.push(item.invalid)
        nextOrder.push(item)
        continue
      }
      const trigger = triggers.get(item.triggerId)
      if (!trigger) continue
      values.push(serializeTrigger(trigger))
      emitted.add(item.triggerId)
      nextOrder.push({ triggerId: trigger.id })
    }
    for (const trigger of triggers.values()) {
      if (!emitted.has(trigger.id)) {
        values.push(serializeTrigger(trigger))
        nextOrder.push({ triggerId: trigger.id })
      }
    }
    const document: JsonObject = {
      ...this.#document,
      triggers: values
    }
    await this.#store.replace(TRIGGER_FILE, document)
    this.#document = document
    this.#order = nextOrder
  }

  #replaceTriggers(triggers: Map<string, StoredTrigger>): void {
    this.#triggers.clear()
    for (const [triggerId, trigger] of triggers) this.#triggers.set(triggerId, trigger)
  }

  #reportInvalidRecord(index: number, error: unknown): void {
    const code = error instanceof ZToolsError ? error.code : errorCodes.dataCorrupt
    const message = error instanceof Error ? error.message : '触发器记录无效'
    console.warn(`忽略损坏的触发器记录: index=${index}, code=${code}, message=${message}`)
    try {
      this.options.events.publishHost('trigger_config_invalid', { index, code, message })
    } catch {
      // Diagnostics must not prevent the remaining triggers from loading.
    }
  }

  async #isPluginEnabled(pluginId: string): Promise<boolean> {
    if (pluginId.toLowerCase() === 'system' || isLocalAppId(pluginId) || !this.options.state) return true
    try {
      return await this.options.state.isEnabled(pluginId, true)
    } catch (error) {
      console.warn(`无法读取插件触发器状态: pluginId=${pluginId}`, error)
      return false
    }
  }

  async #requirePluginEnabled(pluginId: string): Promise<void> {
    if (!(await this.#isPluginEnabled(pluginId))) {
      throw new ZToolsError(errorCodes.pluginNotFound, '插件已禁用')
    }
  }

  #requireTrigger(triggerId: string): StoredTrigger {
    const trigger = this.#triggers.get(triggerId)
    if (!trigger) throw new ZToolsError(errorCodes.triggerNotFound, '触发器不存在')
    return trigger
  }

  #isEffectivelyEnabled(trigger: StoredTrigger): boolean {
    const accelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
    return accelerator !== undefined && this.#registered.get(trigger.id) === accelerator
  }

  #requireSupported(trigger: StoredTrigger, caller?: CallerIdentity): void {
    const accelerator = acceleratorOf(trigger)
    if (trigger.type !== 'hotkey') {
      throw new ZToolsError(errorCodes.notSupported, '当前阶段只支持全局快捷键触发器')
    }
    if (!accelerator) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷键不能为空')
    }
    if (isDoubleModifier(accelerator)) {
      if (!this.options.keyboard) {
        throw new ZToolsError(errorCodes.notSupported, '双击修饰键触发器需要 NativeHost32 输入适配器')
      }
    } else if (!isValidElectronAccelerator(accelerator)) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷键 Electron accelerator 格式无效')
    }
    if (!hasRuntimeAction(trigger, this.options.launchLocalApp !== undefined)) {
      throw new ZToolsError(errorCodes.notSupported, '该触发动作当前不受支持')
    }
    if (
      caller?.type === 'plugin' &&
      trigger.action.mode === 'window' &&
      trigger.action.target.toLowerCase() !== trigger.pluginId.toLowerCase()
    ) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件只能打开自己的窗口动作')
    }
  }

  async #assertNoConflict(candidate: StoredTrigger): Promise<void> {
    if (!candidate.enabled) return
    const accelerator = acceleratorOf(candidate)
    if (!accelerator) return
    const candidateModifier = doubleModifierOf(accelerator)
    const normalized = normalizedAccelerator(accelerator)
    // 同一个组合键在系统里只能注册一次：只要不是同一个触发器（无论是否属于同一插件）就算冲突，
    // 否则会落到系统注册失败，只能报出误导性的「操作系统拒绝注册」。
    for (const trigger of this.#triggers.values()) {
      const key = acceleratorOf(trigger)
      if (
        trigger.id !== candidate.id &&
        trigger.enabled &&
        key !== undefined &&
        (candidateModifier !== undefined
          ? doubleModifierOf(key) === candidateModifier
          : normalizedAccelerator(key) === normalized) &&
        await this.#isPluginEnabled(trigger.pluginId)
      ) {
        throw new ZToolsError(
          errorCodes.triggerConflict,
          `快捷键 ${accelerator} 已被「${triggerOwnerName(trigger)}」占用，请换一个组合键`
        )
      }
    }
  }

  #assertPluginAccess(pluginId: string, caller: CallerIdentity): void {
    if (caller.type === 'main') return
    if (!caller.pluginId || caller.pluginId.toLowerCase() !== pluginId.toLowerCase()) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件只能管理自己的触发器')
    }
  }

  #effectivePluginId(requested: string, caller: CallerIdentity): string {
    if (caller.type === 'main') return requested
    if (!caller.pluginId || (requested !== '' && requested.toLowerCase() !== caller.pluginId.toLowerCase())) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件只能查询自己的触发器')
    }
    return caller.pluginId
  }

  #register(triggerId: string, accelerator: string): boolean {
    if (isDoubleModifier(accelerator)) {
      this.#registered.set(triggerId, accelerator)
      return true
    }
    if (!isValidElectronAccelerator(accelerator)) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷键 Electron accelerator 格式无效')
    }
    const registered = this.options.shortcuts.register(accelerator, () => this.#fire(triggerId))
    if (registered) this.#registered.set(triggerId, accelerator)
    return registered
  }

  #unregister(triggerId: string, accelerator: string): void {
    if (isDoubleModifier(accelerator)) {
      this.#registered.delete(triggerId)
      return
    }
    try {
      this.options.shortcuts.unregister(accelerator)
    } finally {
      this.#registered.delete(triggerId)
    }
  }

  #restore(triggerId: string, accelerator: string): void {
    try {
      if (!this.#register(triggerId, accelerator)) {
        console.error('Failed to restore global shortcut after rollback')
      }
    } catch {
      console.error('Failed to restore global shortcut after rollback')
    }
  }

  #registerWithRestore(
    triggerId: string,
    accelerator: string,
    previousAccelerator: string | undefined
  ): boolean {
    let registered: boolean
    try {
      registered = this.#register(triggerId, accelerator)
    } catch (error) {
      if (previousAccelerator) this.#restore(triggerId, previousAccelerator)
      throw error
    }
    if (!registered && previousAccelerator) this.#restore(triggerId, previousAccelerator)
    return registered
  }

  #fire(triggerId: string): void {
    const trigger = this.#triggers.get(triggerId)
    if (!trigger?.enabled || this.#stopping) return
    if (!this.options.state || trigger.pluginId.toLowerCase() === 'system') {
      this.#dispatch(trigger)
      return
    }
    void this.#isPluginEnabled(trigger.pluginId).then((enabled) => {
      if (enabled && !this.#stopping && this.#triggers.get(triggerId) === trigger) {
        this.#dispatch(trigger)
      }
    })
  }

  #handleKeyboardInput(event: NativeInputEvent): void {
    if (this.#stopping || event.type !== 'keyboard-double-tap') return
    const trigger = [...this.#triggers.values()].find((candidate) =>
      candidate.enabled && hasRuntimeAction(candidate, this.options.launchLocalApp !== undefined) &&
      doubleModifierOf(acceleratorOf(candidate) ?? '') === event.modifier
    )
    if (!trigger) return
    if (!this.options.state || trigger.pluginId.toLowerCase() === 'system') {
      this.#dispatch(trigger)
      return
    }
    void this.#isPluginEnabled(trigger.pluginId).then((enabled) => {
      if (enabled && !this.#stopping && this.#triggers.get(trigger.id) === trigger) {
        this.#dispatch(trigger)
      }
    })
  }

  async #syncKeyboardConfig(): Promise<void> {
    const keyboard = this.options.keyboard
    if (!keyboard) return
    const modifiers: NativeKeyboardModifier[] = []
    for (const modifier of ['ctrl', 'alt', 'shift'] as const) {
      const trigger = [...this.#triggers.values()].find((candidate) =>
        candidate.enabled && hasRuntimeAction(candidate, this.options.launchLocalApp !== undefined) &&
        doubleModifierOf(acceleratorOf(candidate) ?? '') === modifier
      )
      if (trigger && await this.#isPluginEnabled(trigger.pluginId)) modifiers.push(modifier)
    }
    if (
      this.#keyboardConfig !== undefined &&
      this.#keyboardConfig.length === modifiers.length &&
      this.#keyboardConfig.every((modifier, index) => modifier === modifiers[index])
    ) return
    try {
      await keyboard.configureKeyboardDoubleTap(modifiers)
      this.#keyboardConfig = modifiers
    } catch (error) {
      console.warn('NativeHost32 双击修饰键配置失败', error)
    }
  }

  #dispatch(trigger: StoredTrigger): void {
    const keys = acceleratorOf(trigger) ?? ''
    try {
      this.options.events.publishHost('hotkey_triggered', { id: trigger.id, keys })
    } catch {
      console.error('Failed to publish hotkey event')
    }
    if (trigger.action.mode === 'builtin' && trigger.action.target === 'toggle_main_window') {
      this.options.toggleMainWindow()
    } else if (trigger.action.mode === 'builtin' && trigger.action.target === 'toggle_super_panel') {
      this.options.toggleSuperPanel('keyboard_hotkey')
    } else if (trigger.action.mode === 'window') {
      try {
        void this.options.openPlugin({
          pluginId: trigger.action.target,
          payload: cloneObject(trigger.action.params)
        }).catch((error: unknown) => this.#publishActionFailure(trigger, error))
      } catch (error) {
        this.#publishActionFailure(trigger, error)
      }
    } else if (trigger.action.mode === 'builtin' && trigger.action.target === 'launch_local_app') {
      const appId = localAppIdOf(trigger)
      if (!appId || !this.options.launchLocalApp) return
      try {
        void this.options.launchLocalApp(appId).catch(() => {
          console.error('Failed to launch local app from hotkey')
        })
      } catch {
        console.error('Failed to launch local app from hotkey')
      }
    }
  }

  #publishActionFailure(trigger: StoredTrigger, error: unknown): void {
    try {
      this.options.events.publishHost('hotkey_action_failed', {
        id: trigger.id,
        target: trigger.action.target,
        message: error instanceof Error ? error.message.slice(0, 512) : '快捷键动作执行失败'
      })
    } catch {
      // Action failures must not break the global shortcut callback.
    }
  }
}
