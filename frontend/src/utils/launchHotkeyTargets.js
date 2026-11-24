import { t } from '@/i18n'

/** 从触发器中识别插件启动快捷键目标。 */
export function getLaunchHotkeyTarget(trigger) {
  if (!trigger || trigger.type !== 'hotkey') return null

  const mode = trigger.action?.mode || trigger.actionMode || ''
  const target = trigger.action?.target || trigger.actionTarget || ''

  if (mode === 'window' && target) {
    return {
      id: String(target),
      kind: 'plugin',
      ownerId: String(trigger.pluginId || target)
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
  const targetId = typeof target?.id === 'string' ? target.id.trim() : ''
  if (!target || target.kind !== 'plugin' || !targetId) {
    throw new Error(t('hotkey.launchModal.pluginOnly'))
  }

  return {
    pluginId: targetId,
    type: 'hotkey',
    enabled: true,
    config: { key: hotkey },
    actionMode: 'window',
    actionTarget: targetId,
    actionParams: {}
  }
}
