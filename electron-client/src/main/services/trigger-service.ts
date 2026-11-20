import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  doubleModifierOf,
  getGlobalHotkeyBlacklistReason,
  isDoubleModifier,
  normalizedAccelerator,
  type NativeMouseAction,
  type NativeMouseButton
} from '../../contracts/hotkey-rules.js'
export { normalizedAccelerator } from '../../contracts/hotkey-rules.js'
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
  NativeKeyboardModifier,
  NativeMouseTriggerConfig
} from '../native-host/native-host-client.js'
import { t } from '../i18n/index.js'

const TRIGGER_FILE = 'triggers.json'

export interface GlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered?(accelerator: string): boolean
}

export interface KeyboardDoubleTapAdapter {
  configureKeyboardDoubleTap(
    modifiers: readonly NativeKeyboardModifier[],
    fullscreenDnd?: boolean
  ): Promise<void>
  configureMouseTrigger?(config: NativeMouseTriggerConfig | null): Promise<void>
  onInputEvent(listener: (event: NativeInputEvent) => void): () => void
  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void
}

export interface MouseTriggerAdapter {
  configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void>
  onInputEvent(listener: (event: NativeInputEvent) => void): () => void
  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void
}

export interface HotkeyConflictItem {
  type: 'system'
  key: string
  pluginId: string
  triggerId: string
}

export interface TriggerDocumentStore {
  read(fileName: string): Promise<JsonObject>
  replace(fileName: string, document: JsonObject): Promise<void>
}

export interface TriggerServiceOptions {
  dataRoot: string
  shortcuts: GlobalShortcutAdapter
  events: Pick<EventService, 'publishHost'> & Partial<Pick<EventService, 'onSubscriptionChanged'>>
  toggleMainWindow(): void
  openPlugin(params: PluginOpenParams): Promise<unknown>
  forwardHotkeyToRecorder?(accelerator: string): Promise<boolean> | boolean
  store?: TriggerDocumentStore
  state?: PluginStateProvider
  keyboard?: KeyboardDoubleTapAdapter
  mouse?: MouseTriggerAdapter
  /** 冷启动时若 triggers.json 尚未建立任何记录，则用该值自动初始化全局唤醒触发器 */
  initialWakeHotkey?: string
  /** 运行平台（测试中可覆盖为 darwin/win32 验证跨平台规则） */
  platform?: NodeJS.Platform
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
    params: params.actionParams ?? {}
  }
  return {
    id: params.id ?? randomUUID().toLowerCase(),
    pluginId: params.pluginId,
    type: params.type,
    config: cloneObject(params.config),
    action: {
      mode: sourceAction.mode,
      target: sourceAction.target,
      params: sourceAction.params ? cloneObject(sourceAction.params) : {}
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

const VALID_MOUSE_BUTTONS = new Set<NativeMouseButton>(['middle', 'right', 'forward', 'backward'])
const VALID_MOUSE_ACTIONS = new Set<NativeMouseAction>(['press', 'long'])

function parseMouseHookConfig(config: JsonObject): NativeMouseTriggerConfig | undefined {
  if (config.kind !== 'mouse') return undefined
  const button = config.button
  const action = config.action
  const longPressMs = config.longPressMs
  const fullscreenDnd = config.fullscreenDnd
  if (
    typeof button !== 'string' ||
    !VALID_MOUSE_BUTTONS.has(button as NativeMouseButton) ||
    typeof action !== 'string' ||
    !VALID_MOUSE_ACTIONS.has(action as NativeMouseAction) ||
    !Number.isInteger(longPressMs) ||
    (longPressMs as number) < 200 ||
    (longPressMs as number) > 500 ||
    (fullscreenDnd !== undefined && typeof fullscreenDnd !== 'boolean')
  ) {
    return undefined
  }
  if (button === 'right' && action === 'press') return undefined
  return {
    button: button as NativeMouseButton,
    action: action as NativeMouseAction,
    longPressMs: longPressMs as number,
    fullscreenDnd: fullscreenDnd !== false
  }
}

const DOUBLE_MODIFIER_ACCELERATORS: Record<NativeKeyboardModifier, string> = {
  ctrl: 'DoubleCtrl',
  alt: 'DoubleAlt',
  shift: 'DoubleShift'
}

/** 冲突提示里展示占用者：系统内置触发器用功能名，其余显示插件 ID */
const SYSTEM_TRIGGER_NAME_KEYS: Record<string, string> = {
  global_wake_hotkey: 'trigger.owner.globalWake'
}

/** 旧超级面板键盘热键的触发器 ID：超级面板已移除，加载时清理遗留记录 */
const RETIRED_SUPER_PANEL_TRIGGER_ID = 'super_panel_keyboard_hotkey'

/** 判定已下线功能的遗留触发器记录（旧超级面板热键、旧本地软件热键），启动读取时跳过并清理 */
function isRetiredTrigger(trigger: StoredTrigger): boolean {
  return (
    trigger.id === RETIRED_SUPER_PANEL_TRIGGER_ID ||
    trigger.action.target === 'launch_local_app' ||
    /^localapp:/i.test(trigger.pluginId)
  )
}

function triggerOwnerName(trigger: StoredTrigger): string {
  if (Object.hasOwn(SYSTEM_TRIGGER_NAME_KEYS, trigger.id)) {
    return t(SYSTEM_TRIGGER_NAME_KEYS[trigger.id] as string)
  }
  return trigger.pluginId.toLowerCase() === 'system'
    ? t('trigger.owner.systemShortcut')
    : t('trigger.owner.plugin', { pluginId: trigger.pluginId })
}

function hasRuntimeAction(trigger: StoredTrigger): boolean {
  if (trigger.action.mode === 'window') return isIdentifier(trigger.action.target)
  return trigger.action.mode === 'builtin' && trigger.action.target === 'toggle_main_window'
}

/**
 * 快捷键录制框激活期间需要临时在系统内核层捕获的 Space 组合键：
 * - Windows 下 Ctrl+Space / Shift+Space 默认被系统 IME 热键（00000010 / 00000011）拦截，
 *   通过 RegisterHotKey 临时注册后在 win32k 内核热键链表中优先级高于系统 IME 热键；
 * - Windows 下 Alt+Space 默认触发 WM_SYSCHAR -> SC_KEYMENU 弹出左上角系统窗口菜单并导致录制框失焦退出，
 *   通过 RegisterHotKey 临时注册后直接转为 WM_HOTKEY 投递给录制框，不再触发系统菜单。
 */
function recorderSpaceAccelerators(platform: NodeJS.Platform): readonly string[] {
  return [
    'Ctrl+Space',
    'Alt+Space',
    'Shift+Space',
    'Ctrl+Alt+Space',
    'Ctrl+Shift+Space',
    'Alt+Shift+Space',
    'Ctrl+Alt+Shift+Space',
    ...(platform === 'darwin'
      ? [
          'Control+Space',
          'Control+Alt+Space',
          'Control+Shift+Space',
          'Control+Alt+Shift+Space'
        ]
      : [])
  ]
}

export class TriggerService {
  readonly #platform: NodeJS.Platform
  readonly #keyboardAdapter: KeyboardDoubleTapAdapter | undefined
  readonly #mouseAdapter: MouseTriggerAdapter | undefined
  readonly #recorderCaptured = new Set<string>()
  #recorderCaptureActive = false
  #lastRecorderReleaseAt = 0
  readonly #store: TriggerDocumentStore
  readonly #triggers = new Map<string, StoredTrigger>()
  readonly #registered = new Map<string, string>()
  readonly #ready: Promise<void>
  #document: JsonObject = {}
  #order: TriggerOrderItem[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #stopping = false
  #stopPromise: Promise<void> | undefined
  readonly #removeInputListeners: Array<() => void> = []
  readonly #removeLifecycleListeners: Array<() => void> = []
  #removeConflictSubscriptionListener: (() => void) | undefined
  #keyboardConfig: { modifiers: NativeKeyboardModifier[]; fullscreenDnd: boolean } | undefined
  #mouseConfig: NativeMouseTriggerConfig | null | undefined
  #activeMouseTriggerId: string | undefined
  #lastStartupConflicts: HotkeyConflictItem[] = []
  #pendingStartupConflicts: HotkeyConflictItem[] = []

  constructor(private readonly options: TriggerServiceOptions) {
    this.#platform = options.platform ?? process.platform
    this.#keyboardAdapter = options.keyboard
    this.#mouseAdapter = options.mouse ?? (
      options.keyboard && typeof options.keyboard.configureMouseTrigger === 'function'
        ? options.keyboard as MouseTriggerAdapter
        : undefined
    )
    this.#store = options.store ?? new JsonFileStore(options.dataRoot, new Set([TRIGGER_FILE]))

    // 对同一底层原生输入通道去重绑定，避免 keyboard 与 mouse 共用 NativeHostClient 时事件触发两次
    const inputAdapters = new Set<KeyboardDoubleTapAdapter | MouseTriggerAdapter>()
    if (this.#keyboardAdapter) inputAdapters.add(this.#keyboardAdapter)
    if (this.#mouseAdapter) inputAdapters.add(this.#mouseAdapter)

    for (const adapter of inputAdapters) {
      this.#removeInputListeners.push(adapter.onInputEvent((event) => {
        this.#handleNativeInput(event)
      }))
      this.#removeLifecycleListeners.push(adapter.onLifecycleEvent((event) => {
        if (event.type === 'crashed') {
          this.#keyboardConfig = undefined
          this.#mouseConfig = undefined
          this.#activeMouseTriggerId = undefined
          return
        }
        if (event.type === 'restarted' && !this.#stopping) {
          this.#keyboardConfig = undefined
          this.#mouseConfig = undefined
          this.#activeMouseTriggerId = undefined
          void this.#serialize(async () => {
            await this.#syncKeyboardConfig()
            await this.#syncMouseHookConfig(this.#triggers, false)
          }).catch((error: unknown) => {
            console.warn('NativeHost32 重启后恢复输入触发器失败', error)
          })
        }
      }))
    }
    this.#ready = this.#load()
  }

  waitUntilReady(): Promise<void> {
    return this.#ready
  }

  getGlobalWakeHotkey(): { exists: boolean; enabled: boolean; key: string } {
    const trigger = this.#triggers.get('global_wake_hotkey')
    if (!trigger) return { exists: false, enabled: false, key: '' }
    return {
      exists: true,
      enabled: trigger.enabled,
      key: acceleratorOf(trigger) ?? ''
    }
  }

  getStartupConflicts(): HotkeyConflictItem[] {
    return this.#lastStartupConflicts.map((item) => ({ ...item }))
  }

  flushStartupConflicts(): void {
    if (this.#stopping || this.#pendingStartupConflicts.length === 0) return
    try {
      const result = this.options.events.publishHost('hotkey_conflicts_detected', {
        conflicts: this.#pendingStartupConflicts.map((item) => ({ ...item }))
      })
      if (result.delivered > 0) {
        this.#pendingStartupConflicts = []
        this.#removeConflictSubscriptionListener?.()
        this.#removeConflictSubscriptionListener = undefined
      }
    } catch {
      // 冲突推送失败不能影响主窗口正常加载
    }
  }

  verifyRegistrations(): Promise<void> {
    return this.#serialize(async () => {
      const conflicts = await this.#verifyAndCollectConflicts()
      this.#lastStartupConflicts = conflicts.map((item) => ({ ...item }))
      if (conflicts.length > 0) {
        this.#publishDetectedConflicts(conflicts, false)
      } else {
        this.#pendingStartupConflicts = []
        this.#removeConflictSubscriptionListener?.()
        this.#removeConflictSubscriptionListener = undefined
      }
    })
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
        throw new ZToolsError(errorCodes.triggerConflict, t('trigger.conflict.osRejected'))
      }

      const next = new Map(this.#triggers)
      next.set(trigger.id, trigger)
      try {
        await this.#syncMouseHookConfig(next, true)
      } catch (error) {
        if (registrationChanged && nextAccelerator) this.#unregister(trigger.id, nextAccelerator)
        if (registrationChanged && previousAccelerator) this.#restore(trigger.id, previousAccelerator)
        throw error
      }
      try {
        await this.#persist(next)
      } catch (error) {
        await this.#syncMouseHookConfig(this.#triggers, false)
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
      await this.#syncMouseHookConfig(next, false)
      try {
        await this.#persist(next)
      } catch (error) {
        await this.#syncMouseHookConfig(this.#triggers, false)
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
      await this.#syncMouseHookConfig(this.#triggers, false)
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
      await this.#syncMouseHookConfig(next, false)
      try {
        await this.#persist(next)
      } catch (error) {
        await this.#syncMouseHookConfig(this.#triggers, false)
        for (const { trigger, accelerator } of registrations) this.#restore(trigger.id, accelerator)
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
          previous.type === 'hotkey' &&
          currentAccelerator &&
          this.#registered.get(previous.id) !== currentAccelerator
        ) {
          this.#requireSupported(previous, caller)
          await this.#assertNoConflict(previous)
          if (!this.#register(previous.id, currentAccelerator)) {
            throw new ZToolsError(errorCodes.triggerConflict, t('trigger.conflict.occupiedByOtherApp'))
          }
        }
        if (params.enabled && previous.type === 'hook' && !this.#isEffectivelyEnabled(previous)) {
          this.#requireSupported(previous, caller)
          await this.#assertNoConflict(previous)
          await this.#syncMouseHookConfig(this.#triggers, true)
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

      if (trigger.type === 'hotkey') {
        if (params.enabled && (!accelerator || !this.#register(trigger.id, accelerator))) {
          throw new ZToolsError(errorCodes.triggerConflict, t('trigger.conflict.occupiedByOtherApp'))
        }
        if (!params.enabled && accelerator) this.#unregister(trigger.id, accelerator)
      }

      const next = new Map(this.#triggers)
      next.set(trigger.id, trigger)
      try {
        await this.#syncMouseHookConfig(next, params.enabled)
      } catch (error) {
        if (trigger.type === 'hotkey') {
          if (params.enabled && accelerator) this.#unregister(trigger.id, accelerator)
          else if (!params.enabled && accelerator) this.#restore(trigger.id, accelerator)
        }
        throw error
      }
      try {
        await this.#persist(next)
      } catch (error) {
        await this.#syncMouseHookConfig(this.#triggers, false)
        if (trigger.type === 'hotkey') {
          if (params.enabled && accelerator) this.#unregister(trigger.id, accelerator)
          else if (accelerator) this.#restore(trigger.id, accelerator)
        }
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
      // 校验插件调用方是否有权查询指定 pluginId
      this.#effectivePluginId(params.pluginId, caller)
      const normalized = normalizedAccelerator(params.key, this.#platform)
      const requestedModifier = doubleModifierOf(params.key)
      const conflicts = [...this.#triggers.values()]
        .filter((trigger) => {
          if (!trigger.enabled) return false
          if (params.excludeTriggerId && trigger.id === params.excludeTriggerId) return false
          const key = acceleratorOf(trigger)
          if (key === undefined) return false
          if (requestedModifier !== undefined) {
            return doubleModifierOf(key) === requestedModifier
          }
          // 同插件不同触发器共用同一快捷键同样构成系统冲突，仅排除 excludeTriggerId 自身
          return normalizedAccelerator(key, this.#platform) === normalized
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

  setRecorderCaptureActive(active: boolean): void {
    if (this.#stopping || !active) {
      if (this.#recorderCaptureActive) {
        this.#lastRecorderReleaseAt = Date.now()
      }
      this.#recorderCaptureActive = false
      this.#releaseRecorderCapture()
      return
    }
    this.#recorderCaptureActive = true
    this.#acquireRecorderCapture()
  }

  isRecorderCaptureActive(): boolean {
    return this.#recorderCaptureActive
  }

  stop(): Promise<void> {
    this.#recorderCaptureActive = false
    this.#releaseRecorderCapture()
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    this.#pendingStartupConflicts = []
    this.#removeConflictSubscriptionListener?.()
    this.#removeConflictSubscriptionListener = undefined
    for (const remove of this.#removeInputListeners) remove()
    this.#removeInputListeners.length = 0
    for (const remove of this.#removeLifecycleListeners) remove()
    this.#removeLifecycleListeners.length = 0
    this.#stopPromise = this.#queue.catch(() => undefined).then(async () => {
      await this.#ready.catch(() => undefined)
      for (const [triggerId, accelerator] of this.#registered) {
        this.#unregister(triggerId, accelerator)
      }
      if (this.#keyboardAdapter) {
        await this.#keyboardAdapter.configureKeyboardDoubleTap([], true).catch(() => undefined)
        this.#keyboardConfig = { modifiers: [], fullscreenDnd: true }
      }
      if (this.#mouseAdapter) {
        await this.#mouseAdapter.configureMouseTrigger(null).catch(() => undefined)
        this.#mouseConfig = null
        this.#activeMouseTriggerId = undefined
      }
    })
    this.#queue = this.#stopPromise
    return this.#stopPromise
  }

  async #load(): Promise<void> {
    const document = await this.#store.read(TRIGGER_FILE)
    const isUninitializedDocument = document.triggers === undefined
    const values = document.triggers ?? []
    if (!Array.isArray(values)) {
      throw new ZToolsError(errorCodes.dataCorrupt, 'triggers.json 缺少 triggers 数组')
    }
    const loaded = new Map<string, StoredTrigger>()
    const order: TriggerOrderItem[] = []
    let retiredFound = false
    for (const [index, value] of values.entries()) {
      try {
        const trigger = parseStoredTrigger(value)
        if (isRetiredTrigger(trigger)) {
          retiredFound = true
          continue
        }
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
    let seededDefaultWake = false
    if (isUninitializedDocument && typeof this.options.initialWakeHotkey === 'string') {
      const wakeKey = this.options.initialWakeHotkey.trim()
      if (wakeKey && !loaded.has('global_wake_hotkey')) {
        const wakeValid = isDoubleModifier(wakeKey)
          ? this.#keyboardAdapter !== undefined
          : isValidElectronAccelerator(wakeKey) &&
            getGlobalHotkeyBlacklistReason(wakeKey, this.#platform) === null
        if (wakeValid) {
          const defaultWakeTrigger: StoredTrigger = {
            id: 'global_wake_hotkey',
            pluginId: 'system',
            type: 'hotkey',
            config: { key: wakeKey },
            action: { mode: 'builtin', target: 'toggle_main_window', params: {} },
            enabled: true,
            priority: 0,
            createTime: new Date().toISOString(),
            raw: {},
            actionShape: 'nested'
          }
          loaded.set(defaultWakeTrigger.id, defaultWakeTrigger)
          order.push({ triggerId: defaultWakeTrigger.id })
          seededDefaultWake = true
        }
      }
    }
    this.#document = document
    this.#order = order
    if (retiredFound || seededDefaultWake) {
      try {
        await this.#persist(loaded)
      } catch (error) {
        // 写回失败不影响本次运行：冷启动默认或清理状态已在内存中生效
        console.warn('初始化或清理 triggers.json 记录失败', error)
      }
    }
    this.#replaceTriggers(loaded)
    const startupConflicts = await this.#verifyAndCollectConflicts()
    this.#lastStartupConflicts = startupConflicts.map((item) => ({ ...item }))
    if (startupConflicts.length > 0) {
      this.#publishDetectedConflicts(startupConflicts, true)
    }
  }

  async #verifyAndCollectConflicts(): Promise<HotkeyConflictItem[]> {
    const conflicts: HotkeyConflictItem[] = []
    for (const trigger of this.#triggers.values()) {
      const accelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
      if (
        !accelerator ||
        trigger.type !== 'hotkey' ||
        (isDoubleModifier(accelerator)
          ? !this.#keyboardAdapter
          : !isValidElectronAccelerator(accelerator) ||
            getGlobalHotkeyBlacklistReason(accelerator, this.#platform) !== null) ||
        !hasRuntimeAction(trigger) ||
        !(await this.#isPluginEnabled(trigger.pluginId))
      ) continue

      if (isDoubleModifier(accelerator)) {
        this.#registered.set(trigger.id, accelerator)
        continue
      }

      const registeredMatches = this.#registered.get(trigger.id) === accelerator
      const osStillRegistered = typeof this.options.shortcuts.isRegistered === 'function'
        ? this.options.shortcuts.isRegistered(accelerator)
        : registeredMatches
      if (registeredMatches && osStillRegistered) {
        continue
      }
      if (registeredMatches && !osStillRegistered) {
        this.#registered.delete(trigger.id)
      }
      try {
        if (!this.#register(trigger.id, accelerator)) {
          console.warn(`Global shortcut unavailable: ${trigger.id}`)
          conflicts.push({
            type: 'system',
            key: accelerator,
            pluginId: trigger.pluginId,
            triggerId: trigger.id
          })
        }
      } catch {
        console.warn(`Global shortcut registration failed: ${trigger.id}`)
        conflicts.push({
          type: 'system',
          key: accelerator,
          pluginId: trigger.pluginId,
          triggerId: trigger.id
        })
      }
    }
    this.#keyboardConfig = undefined
    this.#mouseConfig = undefined
    await this.#syncKeyboardConfig()
    await this.#syncMouseHookConfig(this.#triggers, false)
    return conflicts
  }

  #publishDetectedConflicts(conflicts: readonly HotkeyConflictItem[], deferIfUndelivered: boolean): void {
    const payload = { conflicts: conflicts.map((item) => ({ ...item })) }
    let delivered = 0
    try {
      delivered = this.options.events.publishHost('hotkey_conflicts_detected', payload).delivered
    } catch {
      delivered = 0
    }
    if (!deferIfUndelivered) return
    if (delivered > 0) {
      this.#pendingStartupConflicts = []
      this.#removeConflictSubscriptionListener?.()
      this.#removeConflictSubscriptionListener = undefined
      return
    }
    this.#pendingStartupConflicts = conflicts.map((item) => ({ ...item }))
    if (!this.#removeConflictSubscriptionListener && this.options.events.onSubscriptionChanged) {
      this.#removeConflictSubscriptionListener = this.options.events.onSubscriptionChanged(
        'hotkey_conflicts_detected',
        (count) => {
          if (count > 0 && !this.#stopping && this.#pendingStartupConflicts.length > 0) {
            setImmediate(() => {
              this.flushStartupConflicts()
            })
          }
        }
      )
    }
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
    if (pluginId.toLowerCase() === 'system' || !this.options.state) return true
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
    if (trigger.type === 'hook') {
      return (
        trigger.enabled &&
        this.#activeMouseTriggerId === trigger.id &&
        this.#mouseConfig !== null &&
        this.#mouseConfig !== undefined
      )
    }
    const accelerator = trigger.enabled ? acceleratorOf(trigger) : undefined
    return accelerator !== undefined && this.#registered.get(trigger.id) === accelerator
  }

  #requireSupported(trigger: StoredTrigger, caller?: CallerIdentity): void {
    // 1. 插件调用方严格权限收敛：仅允许普通 hotkey 且动作只能打开自己的窗口
    if (caller?.type === 'plugin') {
      if (trigger.type !== 'hotkey') {
        throw new ZToolsError(errorCodes.permissionDenied, '插件只允许注册普通快捷键触发器')
      }
      const pluginAccelerator = acceleratorOf(trigger)
      if (pluginAccelerator && isDoubleModifier(pluginAccelerator)) {
        throw new ZToolsError(errorCodes.permissionDenied, '插件不允许注册双击修饰键触发器')
      }
      if (
        trigger.action.mode !== 'window' ||
        trigger.action.target.toLowerCase() !== trigger.pluginId.toLowerCase()
      ) {
        throw new ZToolsError(errorCodes.permissionDenied, '插件只能打开自己的窗口动作')
      }
    }

    // 2. 分类型校验支持情况、参数合法性与黑名单
    if (trigger.type === 'hook') {
      if (!this.#mouseAdapter) {
        throw new ZToolsError(errorCodes.notSupported, '鼠标触发器需要 NativeHost32 输入适配器')
      }
      if (
        trigger.config.kind === 'mouse' &&
        trigger.config.button === 'right' &&
        trigger.config.action === 'press'
      ) {
        throw new ZToolsError(errorCodes.invalidRequest, t('trigger.error.rightButtonLongPressOnly'))
      }
      if (!parseMouseHookConfig(trigger.config)) {
        throw new ZToolsError(errorCodes.invalidRequest, '鼠标触发器配置无效')
      }
      if (!hasRuntimeAction(trigger)) {
        throw new ZToolsError(errorCodes.notSupported, '该触发动作当前不受支持')
      }
      return
    }

    const accelerator = acceleratorOf(trigger)
    if (trigger.type !== 'hotkey') {
      throw new ZToolsError(errorCodes.notSupported, '当前阶段只支持全局快捷键与鼠标触发器')
    }
    if (!accelerator) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷键不能为空')
    }
    if (trigger.config.fullscreenDnd !== undefined && typeof trigger.config.fullscreenDnd !== 'boolean') {
      throw new ZToolsError(errorCodes.invalidRequest, 'fullscreenDnd 必须是布尔值')
    }
    if (isDoubleModifier(accelerator)) {
      if (!this.#keyboardAdapter) {
        throw new ZToolsError(errorCodes.notSupported, '双击修饰键触发器需要 NativeHost32 输入适配器')
      }
    } else {
      if (!isValidElectronAccelerator(accelerator)) {
        throw new ZToolsError(errorCodes.invalidRequest, '快捷键 Electron accelerator 格式无效')
      }
      const blacklistReason = getGlobalHotkeyBlacklistReason(accelerator, this.#platform)
      if (blacklistReason) {
        throw new ZToolsError(errorCodes.invalidRequest, blacklistReason)
      }
    }
    if (!hasRuntimeAction(trigger)) {
      throw new ZToolsError(errorCodes.notSupported, '该触发动作当前不受支持')
    }
  }

  async #assertNoConflict(candidate: StoredTrigger): Promise<void> {
    if (!candidate.enabled) return
    if (candidate.type === 'hook') {
      // 底层同一时间最多只允许启用 1 组鼠标触发器
      for (const trigger of this.#triggers.values()) {
        if (
          trigger.id !== candidate.id &&
          trigger.enabled &&
          trigger.type === 'hook' &&
          await this.#isPluginEnabled(trigger.pluginId)
        ) {
          throw new ZToolsError(
            errorCodes.triggerConflict,
            t('trigger.conflict.mouseSingleActive', { owner: triggerOwnerName(trigger) })
          )
        }
      }
      return
    }
    const accelerator = acceleratorOf(candidate)
    if (!accelerator) return
    const candidateModifier = doubleModifierOf(accelerator)
    const normalized = normalizedAccelerator(accelerator, this.#platform)
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
          : normalizedAccelerator(key, this.#platform) === normalized) &&
        await this.#isPluginEnabled(trigger.pluginId)
      ) {
        throw new ZToolsError(
          errorCodes.triggerConflict,
          t('trigger.conflict.hotkeyOccupied', { accelerator, owner: triggerOwnerName(trigger) })
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

  #isAcceleratorRegisteredByTrigger(accelerator: string): boolean {
    const target = normalizedAccelerator(accelerator, this.#platform)
    if (!target) return false
    for (const registeredAccelerator of this.#registered.values()) {
      if (normalizedAccelerator(registeredAccelerator, this.#platform) === target) {
        return true
      }
    }
    return false
  }

  #acquireRecorderCapture(): void {
    if (this.#stopping || !this.#recorderCaptureActive) return
    for (const accelerator of recorderSpaceAccelerators(this.#platform)) {
      if (this.#recorderCaptured.has(accelerator)) continue
      if (this.#isAcceleratorRegisteredByTrigger(accelerator)) continue
      try {
        const registered = this.options.shortcuts.register(accelerator, () => {
          this.#handleRecorderCapturedHotkey(accelerator)
        })
        if (registered) {
          this.#recorderCaptured.add(accelerator)
        }
      } catch {
        // 忽略单个组合键被外部独占时的异常
      }
    }
  }

  #releaseRecorderCapture(): void {
    if (this.#recorderCaptured.size === 0) return
    const captured = [...this.#recorderCaptured]
    this.#recorderCaptured.clear()
    for (const accelerator of captured) {
      if (this.#isAcceleratorRegisteredByTrigger(accelerator)) continue
      try {
        this.options.shortcuts.unregister(accelerator)
      } catch {
        // 忽略注销异常
      }
    }
  }

  #handleRecorderCapturedHotkey(accelerator: string): void {
    this.#recorderCaptureActive = false
    this.#releaseRecorderCapture()
    if (this.#stopping || typeof this.options.forwardHotkeyToRecorder !== 'function') return
    try {
      void Promise.resolve(this.options.forwardHotkeyToRecorder(accelerator)).catch(() => false)
    } catch {
      // 忽略转发异常
    }
  }

  #register(triggerId: string, accelerator: string): boolean {
    this.#releaseRecorderCapture()
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
    const accelerator = acceleratorOf(trigger)
    if (accelerator && typeof this.options.forwardHotkeyToRecorder === 'function') {
      if (this.#recorderCaptureActive || this.#recorderCaptured.size > 0) {
        this.#recorderCaptureActive = false
        this.#releaseRecorderCapture()
      }
      let maybeRecorded: Promise<boolean> | boolean = false
      try {
        maybeRecorded = this.options.forwardHotkeyToRecorder(accelerator)
      } catch {
        maybeRecorded = false
      }
      if (maybeRecorded === true) return
      if (maybeRecorded && typeof (maybeRecorded as Promise<boolean>).then === 'function') {
        void (maybeRecorded as Promise<boolean>)
          .catch(() => false)
          .then((recorded) => {
            if (recorded || this.#stopping || this.#triggers.get(triggerId) !== trigger || !trigger.enabled) {
              return
            }
            this.#fireAfterRecorderCheck(triggerId, trigger)
          })
        return
      }
    }
    this.#fireAfterRecorderCheck(triggerId, trigger)
  }

  #fireAfterRecorderCheck(triggerId: string, trigger: StoredTrigger): void {
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

  #handleNativeInput(event: NativeInputEvent): void {
    if (this.#stopping) return
    if (event.type === 'mouse-trigger') {
      const trigger = [...this.#triggers.values()].find((candidate) => {
        if (!candidate.enabled || candidate.type !== 'hook') return false
        if (!hasRuntimeAction(candidate)) return false
        const config = parseMouseHookConfig(candidate.config)
        return config !== undefined &&
          config.button === event.config.button &&
          config.action === event.config.action &&
          config.longPressMs === event.config.longPressMs
      })
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
      return
    }

    if (event.type !== 'keyboard-double-tap') return
    const trigger = [...this.#triggers.values()].find((candidate) =>
      candidate.enabled && hasRuntimeAction(candidate) &&
      doubleModifierOf(acceleratorOf(candidate) ?? '') === event.modifier
    )
    if (!trigger) return
    const doubleAccelerator = DOUBLE_MODIFIER_ACCELERATORS[event.modifier]
    const inRecorderCooldown = () =>
      this.#recorderCaptureActive || (Date.now() - this.#lastRecorderReleaseAt) < 600
    const checkRecorderAndDispatch = (): void => {
      if (inRecorderCooldown()) {
        if (this.#recorderCaptureActive && typeof this.options.forwardHotkeyToRecorder === 'function') {
          try {
            void Promise.resolve(this.options.forwardHotkeyToRecorder(doubleAccelerator)).catch(() => false)
          } catch {
            // 忽略转发异常
          }
          this.#lastRecorderReleaseAt = Date.now()
          this.#recorderCaptureActive = false
          this.#releaseRecorderCapture()
        }
        // 刚刚在前端 KeyDown 完成双击修饰键录制并退出录制态时，紧随而至的物理 KeyUp 不得误触发窗口唤醒或隐藏
        return
      }
      this.#dispatch(trigger)
    }

    if (!this.options.state || trigger.pluginId.toLowerCase() === 'system') {
      checkRecorderAndDispatch()
      return
    }
    void this.#isPluginEnabled(trigger.pluginId).then((enabled) => {
      if (enabled && !this.#stopping && this.#triggers.get(trigger.id) === trigger) {
        checkRecorderAndDispatch()
      }
    })
  }

  async #syncKeyboardConfig(): Promise<void> {
    const keyboard = this.#keyboardAdapter
    if (!keyboard) return
    const modifiers: NativeKeyboardModifier[] = []
    let fullscreenDnd = true
    for (const modifier of ['ctrl', 'alt', 'shift'] as const) {
      const trigger = [...this.#triggers.values()].find((candidate) =>
        candidate.enabled && hasRuntimeAction(candidate) &&
        doubleModifierOf(acceleratorOf(candidate) ?? '') === modifier
      )
      if (trigger && await this.#isPluginEnabled(trigger.pluginId)) {
        modifiers.push(modifier)
        if (trigger.config.fullscreenDnd === false) {
          fullscreenDnd = false
        }
      }
    }
    if (
      this.#keyboardConfig !== undefined &&
      this.#keyboardConfig.fullscreenDnd === fullscreenDnd &&
      this.#keyboardConfig.modifiers.length === modifiers.length &&
      this.#keyboardConfig.modifiers.every((modifier, index) => modifier === modifiers[index])
    ) return
    try {
      await keyboard.configureKeyboardDoubleTap(modifiers, fullscreenDnd)
      this.#keyboardConfig = { modifiers, fullscreenDnd }
    } catch (error) {
      console.warn('NativeHost32 双击修饰键配置失败', error)
    }
  }

  async #syncMouseHookConfig(
    triggersMap: ReadonlyMap<string, StoredTrigger>,
    throwOnError: boolean
  ): Promise<void> {
    const mouse = this.#mouseAdapter
    if (!mouse) return
    let desiredTriggerId: string | undefined
    let desiredConfig: NativeMouseTriggerConfig | null = null
    for (const candidate of triggersMap.values()) {
      if (!candidate.enabled || candidate.type !== 'hook') continue
      if (!hasRuntimeAction(candidate)) continue
      const parsed = parseMouseHookConfig(candidate.config)
      if (!parsed) continue
      if (await this.#isPluginEnabled(candidate.pluginId)) {
        desiredTriggerId = candidate.id
        desiredConfig = parsed
        break
      }
    }

    const currentConfig = this.#mouseConfig
    const sameConfig =
      currentConfig !== undefined &&
      this.#activeMouseTriggerId === desiredTriggerId &&
      ((currentConfig === null && desiredConfig === null) ||
        (currentConfig !== null &&
          desiredConfig !== null &&
          currentConfig.button === desiredConfig.button &&
          currentConfig.action === desiredConfig.action &&
          currentConfig.longPressMs === desiredConfig.longPressMs &&
          (currentConfig.fullscreenDnd !== false) === (desiredConfig.fullscreenDnd !== false)))
    if (sameConfig) return

    try {
      await mouse.configureMouseTrigger(desiredConfig)
      this.#mouseConfig = desiredConfig
      this.#activeMouseTriggerId = desiredTriggerId
    } catch (error) {
      if (throwOnError) throw error
      console.warn('NativeHost32 鼠标触发器配置失败', error)
    }
  }

  #dispatch(trigger: StoredTrigger): void {
    const mouseConfig = trigger.type === 'hook' ? parseMouseHookConfig(trigger.config) : undefined
    const keys = acceleratorOf(trigger) ?? (mouseConfig ? `${mouseConfig.button}:${mouseConfig.action}` : '')
    try {
      this.options.events.publishHost('hotkey_triggered', { id: trigger.id, keys })
    } catch {
      console.error('Failed to publish hotkey event')
    }
    if (trigger.action.mode === 'builtin' && trigger.action.target === 'toggle_main_window') {
      this.options.toggleMainWindow()
    } else if (trigger.action.mode === 'window') {
      try {
        void this.options.openPlugin({
          pluginId: trigger.action.target,
          payload: cloneObject(trigger.action.params)
        }).catch((error: unknown) => this.#publishActionFailure(trigger, error))
      } catch (error) {
        this.#publishActionFailure(trigger, error)
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
