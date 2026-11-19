import { ref } from 'vue'
import { getHotkey } from '@/api/apiserver'
import { DEFAULT_GLOBAL_WAKE_HOTKEY } from '@/api/native'
import { isDoubleModifierHotkey } from '@/utils/hotkeyRecorder'

export { DEFAULT_GLOBAL_WAKE_HOTKEY }

export const GLOBAL_WAKE_TRIGGER_ID = 'global_wake_hotkey'
export const MOUSE_WAKE_TRIGGER_ID = 'mouse_wake_hook'
export const DEFAULT_MOUSE_LONG_PRESS_MS = 300
export const MIN_MOUSE_LONG_PRESS_MS = 200
export const MAX_MOUSE_LONG_PRESS_MS = 500

/**
 * Windows 鼠标快捷唤醒选项（严格禁止右键单击，避免破坏系统上下文菜单）
 */
export const MOUSE_WAKE_OPTIONS = Object.freeze([
  { value: 'off', label: '关闭' },
  { value: 'middle:press', label: '中键单击', button: 'middle', action: 'press' },
  { value: 'middle:long', label: '中键长按', button: 'middle', action: 'long' },
  { value: 'right:long', label: '右键长按', button: 'right', action: 'long' },
  { value: 'backward:press', label: '后退侧键单击', button: 'backward', action: 'press' },
  { value: 'backward:long', label: '后退侧键长按', button: 'backward', action: 'long' },
  { value: 'forward:press', label: '前进侧键单击', button: 'forward', action: 'press' },
  { value: 'forward:long', label: '前进侧键长按', button: 'forward', action: 'long' }
])

const MOUSE_WAKE_OPTION_MAP = new Map(
  MOUSE_WAKE_OPTIONS.filter((item) => item.value !== 'off').map((item) => [item.value, item])
)

/**
 * 将鼠标长按阈值钳制为 200~500ms 之间的整数，满足宿主端契约校验
 */
export function clampMouseLongPressMs(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_MOUSE_LONG_PRESS_MS
  return Math.min(MAX_MOUSE_LONG_PRESS_MS, Math.max(MIN_MOUSE_LONG_PRESS_MS, Math.round(num)))
}

/**
 * 从单个触发器或触发器列表中解析鼠标唤醒设置状态
 */
export function parseMouseWakeTrigger(triggerOrList) {
  const trigger = Array.isArray(triggerOrList)
    ? triggerOrList.find((item) => item?.id === MOUSE_WAKE_TRIGGER_ID)
    : triggerOrList

  if (!trigger || trigger.id !== MOUSE_WAKE_TRIGGER_ID || trigger.enabled === false) {
    return {
      exists: false,
      mode: 'off',
      longPressMs: DEFAULT_MOUSE_LONG_PRESS_MS,
      fullscreenDnd: true
    }
  }
  const config = isRecord(trigger.config) ? trigger.config : {}
  const modeKey = `${config.button || ''}:${config.action || ''}`
  const option = MOUSE_WAKE_OPTION_MAP.get(modeKey)
  return {
    exists: true,
    mode: option ? option.value : 'off',
    longPressMs: clampMouseLongPressMs(config.longPressMs),
    fullscreenDnd: config.fullscreenDnd !== false
  }
}

export function buildMouseWakeTrigger({
  mode = 'off',
  longPressMs = DEFAULT_MOUSE_LONG_PRESS_MS,
  fullscreenDnd = true
} = {}) {
  const option = MOUSE_WAKE_OPTION_MAP.get(mode)
  if (!option) return null
  return {
    id: MOUSE_WAKE_TRIGGER_ID,
    pluginId: 'system',
    type: 'hook',
    enabled: true,
    config: {
      kind: 'mouse',
      button: option.button,
      action: option.action,
      longPressMs: clampMouseLongPressMs(longPressMs),
      fullscreenDnd: Boolean(fullscreenDnd)
    },
    action: {
      mode: 'builtin',
      target: 'toggle_main_window',
      params: {}
    }
  }
}

/**
 * 当前生效的全局唤醒快捷键，供界面提示使用（空字符串表示用户已关闭全局唤醒）。
 * 界面不能写死默认值：用户改过快捷键后，提示的键按下去可能打开的是别的功能。
 */
export const currentGlobalWakeHotkey = ref(DEFAULT_GLOBAL_WAKE_HOTKEY)

/** 从配置读取当前唤醒快捷键；未设置时 getHotkey 已返回默认值，空串表示用户已关闭 */
export async function refreshCurrentGlobalWakeHotkey() {
  try {
    currentGlobalWakeHotkey.value = normalizeHotkey(await getHotkey())
  } catch (err) {
    console.warn('[globalWakeHotkey] 读取当前唤醒快捷键失败:', err)
  }
  return currentGlobalWakeHotkey.value
}

function normalizeHotkey(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExplicitFailure(result) {
  return result === false ||
    result?.success === false ||
    result?.data?.success === false ||
    Boolean(result?.error || result?.data?.error)
}

function isSuccessfulResponse(result) {
  if (result === true) return true
  if (!isRecord(result) || isExplicitFailure(result)) return false
  return result.success === true ||
    result.data?.success === true ||
    typeof result.triggerId === 'string' ||
    typeof result.data?.triggerId === 'string'
}

function responseErrorMessage(result) {
  const error = result?.error || result?.data?.error
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  return ''
}

function errorMessage(error) {
  if (typeof error?.message === 'string') return error.message
  return typeof error === 'string' ? error : ''
}

function getTriggerList(result) {
  if (isExplicitFailure(result)) {
    throw new Error(responseErrorMessage(result) || '读取触发器列表失败')
  }
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.data)) return result.data
  throw new Error('触发器列表响应无效')
}

function buildGlobalWakeTrigger(hotkey, fullscreenDnd) {
  const config =
    typeof fullscreenDnd === 'boolean' && isDoubleModifierHotkey(hotkey)
      ? { key: hotkey, fullscreenDnd }
      : { key: hotkey }

  return {
    id: GLOBAL_WAKE_TRIGGER_ID,
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config,
    actionMode: 'builtin',
    actionTarget: 'toggle_main_window',
    actionParams: {}
  }
}

function buildRestoreTrigger(existing) {
  const key = normalizeHotkey(existing?.config?.key)
  if (!key) return null

  const action = isRecord(existing.action) ? existing.action : {}
  const actionParams = isRecord(action.params)
    ? action.params
    : isRecord(existing.actionParams)
      ? existing.actionParams
      : {}

  const config =
    typeof existing?.config?.fullscreenDnd === 'boolean'
      ? { key, fullscreenDnd: existing.config.fullscreenDnd }
      : { key }

  return {
    id: GLOBAL_WAKE_TRIGGER_ID,
    pluginId: typeof existing.pluginId === 'string' && existing.pluginId
      ? existing.pluginId
      : 'system',
    type: typeof existing.type === 'string' ? existing.type : 'hotkey',
    enabled: existing.enabled !== false,
    config,
    action: {
      mode: typeof action.mode === 'string'
        ? action.mode
        : typeof existing.actionMode === 'string'
          ? existing.actionMode
          : 'builtin',
      target: typeof action.target === 'string'
        ? action.target
        : typeof existing.actionTarget === 'string'
          ? existing.actionTarget
          : 'toggle_main_window',
      params: actionParams
    },
    ...(Number.isInteger(existing.priority) ? { priority: existing.priority } : {})
  }
}

async function restoreExistingTrigger(triggerApi, existing) {
  const previous = buildRestoreTrigger(existing)
  if (!previous) return true

  try {
    return isSuccessfulResponse(await triggerApi.register(previous))
  } catch {
    return false
  }
}

function failureResult(reason, hotkey, message = '', rollbackFailed = false) {
  return {
    success: false,
    reason,
    hotkey,
    ...(message ? { message } : {}),
    ...(rollbackFailed ? { rollbackFailed: true } : {})
  }
}

export async function syncGlobalWakeHotkey({ hotkey, fullscreenDnd } = {}) {
  // 不传 hotkey 时按配置同步：未设置得到默认值，用户关闭得到空串（注销），读取失败抛错且不改动现有注册
  const targetHotkey = typeof hotkey === 'string'
    ? normalizeHotkey(hotkey)
    : normalizeHotkey(await getHotkey())

  const triggerApi = window.ztools?.trigger
  if (
    !triggerApi ||
    typeof triggerApi.list !== 'function' ||
    typeof triggerApi.register !== 'function'
  ) {
    return failureResult('trigger_unavailable', targetHotkey)
  }

  let existing
  try {
    const triggers = getTriggerList(await triggerApi.list())
    existing = triggers.find((trigger) => trigger?.id === GLOBAL_WAKE_TRIGGER_ID)
  } catch (error) {
    return failureResult('trigger_list_failed', targetHotkey, errorMessage(error))
  }

  if (!targetHotkey) {
    if (!existing) {
      currentGlobalWakeHotkey.value = ''
      return { success: true, hotkey: '' }
    }
    if (typeof triggerApi.unregister !== 'function') {
      return failureResult('trigger_unavailable', '', '注销快捷键 API 不可用')
    }

    try {
      const result = await triggerApi.unregister(GLOBAL_WAKE_TRIGGER_ID)
      if (isSuccessfulResponse(result)) {
        currentGlobalWakeHotkey.value = ''
        return { success: true, hotkey: '' }
      }
      const restored = await restoreExistingTrigger(triggerApi, existing)
      return failureResult(
        'trigger_unregister_failed',
        '',
        responseErrorMessage(result),
        !restored
      )
    } catch (error) {
      const restored = await restoreExistingTrigger(triggerApi, existing)
      return failureResult(
        'trigger_unregister_failed',
        '',
        errorMessage(error),
        !restored
      )
    }
  }

  // 未显式传 fullscreenDnd 时保留原有双击修饰键上的免打扰状态，防止启动同步意外覆盖
  const effectiveFullscreenDnd = isDoubleModifierHotkey(targetHotkey)
    ? typeof fullscreenDnd === 'boolean'
      ? fullscreenDnd
      : typeof existing?.config?.fullscreenDnd === 'boolean'
        ? existing.config.fullscreenDnd
        : undefined
    : undefined

  const existingKey = normalizeHotkey(existing?.config?.key)
  const existingDnd = typeof existing?.config?.fullscreenDnd === 'boolean'
    ? existing.config.fullscreenDnd
    : undefined
  const dndMatches =
    effectiveFullscreenDnd === undefined || existingDnd === effectiveFullscreenDnd
  const alreadyActive = existing &&
    existing.enabled !== false &&
    existing.effectiveEnabled !== false &&
    dndMatches

  if (alreadyActive && existingKey === targetHotkey) {
    currentGlobalWakeHotkey.value = targetHotkey
    return { success: true, hotkey: targetHotkey }
  }

  let result
  try {
    // 固定 ID 在宿主端执行 upsert：先注册新配置，失败时不提前删掉现有触发器
    result = await triggerApi.register(buildGlobalWakeTrigger(targetHotkey, effectiveFullscreenDnd))
  } catch (error) {
    const restored = await restoreExistingTrigger(triggerApi, existing)
    return failureResult(
      'trigger_register_failed',
      targetHotkey,
      errorMessage(error),
      !restored
    )
  }

  if (!isSuccessfulResponse(result)) {
    const restored = await restoreExistingTrigger(triggerApi, existing)
    return failureResult(
      'trigger_register_failed',
      targetHotkey,
      responseErrorMessage(result),
      !restored
    )
  }

  currentGlobalWakeHotkey.value = targetHotkey
  return { success: true, hotkey: targetHotkey }
}

/**
 * 同步鼠标快捷唤醒触发器（mouse_wake_hook）
 */
export async function syncMouseWakeHook({
  mode = 'off',
  longPressMs = DEFAULT_MOUSE_LONG_PRESS_MS,
  fullscreenDnd = true
} = {}) {
  const triggerApi = window.ztools?.trigger
  if (!triggerApi || typeof triggerApi.register !== 'function') {
    return failureResult('trigger_unavailable', '')
  }

  if (!mode || mode === 'off') {
    if (typeof triggerApi.list === 'function') {
      try {
        const triggers = getTriggerList(await triggerApi.list())
        const existing = triggers.find((t) => t?.id === MOUSE_WAKE_TRIGGER_ID)
        if (!existing) return { success: true, mode: 'off' }
      } catch (err) {
        return failureResult('trigger_list_failed', '', errorMessage(err))
      }
    }
    if (typeof triggerApi.unregister !== 'function') {
      return failureResult('trigger_unavailable', '', '注销鼠标触发器 API 不可用')
    }
    try {
      const res = await triggerApi.unregister(MOUSE_WAKE_TRIGGER_ID)
      if (isSuccessfulResponse(res)) return { success: true, mode: 'off' }
      return failureResult('trigger_unregister_failed', '', responseErrorMessage(res))
    } catch (err) {
      return failureResult('trigger_unregister_failed', '', errorMessage(err))
    }
  }

  const payload = buildMouseWakeTrigger({ mode, longPressMs, fullscreenDnd })
  if (!payload) {
    return failureResult('invalid_mouse_mode', '', '不支持的鼠标触发模式')
  }

  try {
    const res = await triggerApi.register(payload)
    if (isSuccessfulResponse(res)) {
      return { success: true, mode, longPressMs: payload.config.longPressMs }
    }
    return failureResult('trigger_register_failed', '', responseErrorMessage(res))
  } catch (err) {
    return failureResult('trigger_register_failed', '', errorMessage(err))
  }
}

/**
 * 将「全屏游戏 / 演示免打扰」开关状态同步到所有双击修饰键与鼠标唤醒触发器
 */
export async function syncFullscreenDndToTriggers(enabled) {
  const triggerApi = window.ztools?.trigger
  if (!triggerApi || typeof triggerApi.list !== 'function' || typeof triggerApi.register !== 'function') {
    return failureResult('trigger_unavailable', '')
  }

  let triggers
  try {
    triggers = getTriggerList(await triggerApi.list())
  } catch (err) {
    return failureResult('trigger_list_failed', '', errorMessage(err))
  }

  const nextDnd = Boolean(enabled)
  const targets = triggers.filter((trigger) => {
    if (!trigger) return false
    if (trigger.id === MOUSE_WAKE_TRIGGER_ID && trigger.type === 'hook') return true
    if (trigger.type === 'hotkey' && isDoubleModifierHotkey(trigger?.config?.key)) return true
    return false
  })

  for (const trigger of targets) {
    const prevDnd = trigger?.config?.fullscreenDnd !== false
    if (prevDnd === nextDnd) continue

    const action = isRecord(trigger.action) ? trigger.action : {}
    const actionParams = isRecord(action.params)
      ? action.params
      : isRecord(trigger.actionParams)
        ? trigger.actionParams
        : {}

    const updatedPayload = {
      id: trigger.id,
      pluginId: trigger.pluginId || 'system',
      type: trigger.type,
      enabled: trigger.enabled !== false,
      config: {
        ...(isRecord(trigger.config) ? trigger.config : {}),
        fullscreenDnd: nextDnd
      },
      action: {
        mode: action.mode || trigger.actionMode || 'builtin',
        target: action.target || trigger.actionTarget || 'toggle_main_window',
        params: actionParams
      },
      ...(Number.isInteger(trigger.priority) ? { priority: trigger.priority } : {})
    }

    try {
      const res = await triggerApi.register(updatedPayload)
      if (!isSuccessfulResponse(res)) {
        return failureResult('trigger_register_failed', '', responseErrorMessage(res))
      }
    } catch (err) {
      return failureResult('trigger_register_failed', '', errorMessage(err))
    }
  }

  return { success: true, updatedCount: targets.length, fullscreenDnd: nextDnd }
}
