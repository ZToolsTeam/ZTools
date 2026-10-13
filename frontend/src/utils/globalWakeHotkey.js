import { getHotkey } from '@/api/apiserver'

export const DEFAULT_GLOBAL_WAKE_HOTKEY = 'Ctrl+Shift+Z'

const GLOBAL_WAKE_TRIGGER_ID = 'global_wake_hotkey'

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

function buildGlobalWakeTrigger(hotkey) {
  return {
    id: GLOBAL_WAKE_TRIGGER_ID,
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: hotkey },
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

  return {
    id: GLOBAL_WAKE_TRIGGER_ID,
    pluginId: typeof existing.pluginId === 'string' && existing.pluginId
      ? existing.pluginId
      : 'system',
    type: typeof existing.type === 'string' ? existing.type : 'hotkey',
    enabled: existing.enabled !== false,
    config: { key },
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

export async function syncGlobalWakeHotkey({
  hotkey,
  useDefaultWhenEmpty = false
} = {}) {
  const hasExplicitHotkey = typeof hotkey === 'string'
  let targetHotkey = normalizeHotkey(hotkey)

  if (!hasExplicitHotkey) {
    targetHotkey = normalizeHotkey(await getHotkey())
  }

  if (!targetHotkey && useDefaultWhenEmpty) {
    targetHotkey = DEFAULT_GLOBAL_WAKE_HOTKEY
  }

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
    if (!existing) return { success: true, hotkey: '' }
    if (typeof triggerApi.unregister !== 'function') {
      return failureResult('trigger_unavailable', '', '注销快捷键 API 不可用')
    }

    try {
      const result = await triggerApi.unregister(GLOBAL_WAKE_TRIGGER_ID)
      if (isSuccessfulResponse(result)) return { success: true, hotkey: '' }
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

  const existingKey = normalizeHotkey(existing?.config?.key)
  const alreadyActive = existing &&
    existing.enabled !== false &&
    existing.effectiveEnabled !== false

  if (alreadyActive && existingKey === targetHotkey) {
    return { success: true, hotkey: targetHotkey }
  }

  let result
  try {
    // The fixed ID is an upsert on both hosts. Register first so a rejected
    // update never deletes the currently configured trigger beforehand.
    result = await triggerApi.register(buildGlobalWakeTrigger(targetHotkey))
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

  return { success: true, hotkey: targetHotkey }
}
