export const LOCAL_APP_ACTION_TARGET = 'launch_local_app'

/** 从触发器中识别“插件/本地软件启动快捷键”目标。 */
export function getLaunchHotkeyTarget(trigger) {
  if (!trigger || trigger.type !== 'hotkey') return null

  const mode = trigger.action?.mode || trigger.actionMode || ''
  const target = trigger.action?.target || trigger.actionTarget || ''
  const params = trigger.action?.params || trigger.actionParams || {}

  if (mode === 'window' && target) {
    return {
      id: String(target),
      kind: 'plugin',
      ownerId: String(trigger.pluginId || target)
    }
  }

  if (mode === 'builtin' && target === LOCAL_APP_ACTION_TARGET && params.appId) {
    return {
      id: String(params.appId),
      kind: 'localApp',
      ownerId: String(trigger.pluginId || params.appId)
    }
  }

  return null
}

export function buildLaunchHotkeyMap(triggers, shouldExclude = () => false) {
  const map = {}
  if (!Array.isArray(triggers)) return map

  for (const trigger of triggers) {
    if (shouldExclude(trigger)) continue
    const target = getLaunchHotkeyTarget(trigger)
    if (!target) continue
    const previousTriggerIds = map[target.id]?.triggerIds || []
    map[target.id] = {
      triggerId: trigger.id,
      triggerIds: [...previousTriggerIds, trigger.id],
      key: trigger.config?.key || '',
      kind: target.kind,
      ownerId: target.ownerId
    }
  }
  return map
}

export function buildLaunchHotkeyRegistration(target, hotkey) {
  if (target.kind === 'localApp') {
    return {
      pluginId: target.id,
      type: 'hotkey',
      enabled: true,
      config: { key: hotkey },
      actionMode: 'builtin',
      actionTarget: LOCAL_APP_ACTION_TARGET,
      actionParams: { appId: target.id }
    }
  }

  return {
    pluginId: target.id,
    type: 'hotkey',
    enabled: true,
    config: { key: hotkey },
    actionMode: 'window',
    actionTarget: target.id,
    actionParams: {}
  }
}
