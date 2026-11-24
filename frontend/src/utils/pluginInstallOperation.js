import { resolveErrorMessage } from '@/utils/errorMessage'
import { t } from '@/i18n'

/** 在发起安装前监听通知，以宿主任务标识匹配结果；漏收通知时查询终态。 */
export async function runPluginInstall({ pluginId, start, events, getStatus }) {
  if (typeof events?.on !== 'function' || typeof events?.off !== 'function') {
    throw new Error(t('pluginInstall.eventsUnavailable'))
  }
  let operationId = ''
  let timer = null
  let settled = false
  const earlyResults = new Map()
  let resolveResult
  let rejectResult
  const completion = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const cleanup = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    events.off('plugin_install_complete', onEvent)
    earlyResults.clear()
  }
  const finish = (payload) => {
    if (settled) return
    settled = true
    cleanup()
    if (payload.success === true) resolveResult(payload)
    else rejectResult(Object.assign(new Error(resolveErrorMessage(payload, 'pluginInstall.failed')), { code: payload.errorCode }))
  }
  const onEvent = (evt) => {
    const payload = evt?.payload && typeof evt.payload === 'object' ? evt.payload : evt
    if (payload?.pluginId !== pluginId || typeof payload.operationId !== 'string' ||
      typeof payload.success !== 'boolean' || settled) return
    if (!operationId) {
      earlyResults.set(payload.operationId, payload)
      if (earlyResults.size > 64) earlyResults.delete(earlyResults.keys().next().value)
    } else if (payload.operationId === operationId) finish(payload)
  }
  const checkStatus = async () => {
    try {
      const result = await getStatus(pluginId, operationId)
      if (settled) return
      if (result?.operationId !== operationId || result?.pluginId !== pluginId) {
        throw new Error(t('pluginInstall.statusMismatch'))
      }
      if (result.status === 'completed' && typeof result.success === 'boolean') finish(result)
      else if (result.status === 'running') timer = setTimeout(checkStatus, 30_000)
      else throw new Error(t('pluginInstall.resultNotFound'))
    } catch (cause) {
      if (settled) return
      settled = true
      cleanup()
      rejectResult(Object.assign(new Error(t('pluginInstall.statusUnknown')), {
        code: 'INSTALL_STATUS_UNKNOWN', cause
      }))
    }
  }
  events.on('plugin_install_complete', onEvent)
  try {
    // 订阅确认后才发起任务，避免主进程尚未开始转发事件。
    await events.subscribe?.('plugin_install_complete')
    const started = await start()
    if (!started || started.success === false) throw new Error(resolveErrorMessage(started, 'pluginInstall.executionFailed'))
    if (!started.operationId) return started
    operationId = started.operationId
    const early = earlyResults.get(operationId)
    earlyResults.clear()
    if (early) finish(early)
    else timer = setTimeout(checkStatus, 30_000)
    return await completion
  } finally {
    settled = true
    cleanup()
  }
}
