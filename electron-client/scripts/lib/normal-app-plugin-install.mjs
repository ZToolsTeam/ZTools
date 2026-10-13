// This helper is evaluated through CDP in an isolated normal App, using public APIs only.
export async function awaitPublicPluginInstall({ plugin, events, pluginId, zipUrl, options,
  timeoutMs, expectedIsUpdate, clock = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args)
  } }) {
  if (typeof plugin?.install !== 'function' ||
      ['on', 'off', 'subscribe', 'unsubscribe'].some(method => typeof events?.[method] !== 'function')) {
    throw new Error('PLUGIN_INSTALL_PUBLIC_API_MISSING')
  }
  const eventName = 'plugin_install_complete'
  let accepted
  let settle
  let subscribed = false
  let listening = false
  const buffered = []
  const outcome = new Promise(resolve => { settle = resolve })
  let expire
  const deadline = new Promise(resolve => { expire = resolve })
  const bounded = async work => {
    const result = await Promise.race([Promise.resolve(work).then(value => ({ value })), deadline])
    if (result.timedOut) throw new Error('PLUGIN_INSTALL_COMPLETION_TIMEOUT')
    return result.value
  }
  const consider = completion => {
    if (completion.operationId !== accepted.operationId) return
    if (completion.success !== true || completion.isUpdate !== expectedIsUpdate || completion.version !== options.version) {
      settle({ error: 'PLUGIN_INSTALL_COMPLETION_FAILED', completion })
    } else settle({ completion })
  }
  const handler = envelope => {
    const completion = envelope?.payload ?? envelope
    if (completion?.pluginId !== pluginId || typeof completion.operationId !== 'string' || !completion.operationId) return
    if (accepted) consider(completion)
    else if (buffered.length < 16) buffered.push(completion)
    else settle({ error: 'PLUGIN_INSTALL_EVENT_BUFFER_EXCEEDED' })
  }
  const timer = clock.setTimeout(() => {
    settle({ error: 'PLUGIN_INSTALL_COMPLETION_TIMEOUT' })
    expire({ timedOut: true })
  }, timeoutMs)
  try {
    events.on(eventName, handler)
    listening = true
    // on() registers the type listener; the awaited public subscription is an IPC fence.
    const subscription = await bounded(events.subscribe(eventName))
    subscribed = subscription?.success === true
    if (!subscribed) throw new Error('PLUGIN_INSTALL_EVENT_SUBSCRIBE_FAILED')
    accepted = await bounded(plugin.install(pluginId, zipUrl, options))
    if (accepted?.success !== true || typeof accepted.operationId !== 'string' || !accepted.operationId ||
        accepted.isUpdate !== expectedIsUpdate) throw new Error('PLUGIN_INSTALL_NOT_ACCEPTED')
    for (const completion of buffered) consider(completion)
    const result = await outcome
    if (result.error) {
      const error = new Error(result.error)
      error.installCompletion = result.completion
      throw error
    }
    return { accepted, completion: result.completion }
  } finally {
    clock.clearTimeout(timer)
    try {
      if (listening) events.off(eventName, handler)
    } finally {
      if (subscribed) {
        const removed = await bounded(events.unsubscribe(eventName))
        if (removed?.success === false) throw new Error('PLUGIN_INSTALL_EVENT_UNSUBSCRIBE_FAILED')
      }
    }
  }
}

export function publicPluginInstallExpression({ pluginId, zipUrl, version, checksum, fileSize,
  expectedIsUpdate = false, timeoutMs = 90_000 }) {
  let url
  try { url = new URL(zipUrl) } catch { throw new Error('PLUGIN_INSTALL_ARGUMENT_INVALID') }
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(pluginId) ||
      url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash ||
      typeof version !== 'string' || !/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
      typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum) ||
      !Number.isSafeInteger(fileSize) || fileSize <= 0 || typeof expectedIsUpdate !== 'boolean' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) {
    throw new Error('PLUGIN_INSTALL_ARGUMENT_INVALID')
  }
  return `(${awaitPublicPluginInstall.toString()})({
    plugin: window.ztools?.plugin, events: window.ztools?.events,
    pluginId: ${JSON.stringify(pluginId)}, zipUrl: ${JSON.stringify(zipUrl)},
    options: ${JSON.stringify({ version, checksum, fileSize })},
    expectedIsUpdate: ${expectedIsUpdate}, timeoutMs: ${timeoutMs}
  })`
}

// The public update API returns only a boolean; the terminal event is the only public
// surface that exposes the operation ID and its exact asynchronous failure code.
export async function awaitPublicPluginUpdateFailure({ update, events, pluginId, info,
  expectedErrorCode, timeoutMs = 90_000, clock = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args)
  } }) {
  if (typeof update?.downloadPlugin !== 'function' ||
      ['on', 'off', 'subscribe', 'unsubscribe'].some(method => typeof events?.[method] !== 'function')) {
    throw new Error('PLUGIN_UPDATE_PUBLIC_API_MISSING')
  }
  const eventName = 'plugin_install_complete'
  let requested = false
  let apiAccepted = false
  let subscribed = false
  let listening = false
  const buffered = []
  let settle
  const outcome = new Promise(resolve => { settle = resolve })
  const consider = completion => {
    if (completion.pluginId !== pluginId || completion.isUpdate !== true) return
    if (typeof completion.operationId !== 'string' || !completion.operationId) {
      settle({ error: 'PLUGIN_UPDATE_TERMINAL_OPERATION_ID_MISSING', completion })
    } else if (completion.success === false && completion.errorCode === expectedErrorCode) {
      settle({ completion })
    } else settle({ error: 'PLUGIN_UPDATE_COMPLETION_UNEXPECTED', completion })
  }
  const handler = envelope => {
    const completion = envelope?.payload ?? envelope
    if (completion?.pluginId !== pluginId || completion?.isUpdate !== true) return
    if (!requested) return
    if (apiAccepted) consider(completion)
    else if (buffered.length < 16) buffered.push(completion)
    else settle({ error: 'PLUGIN_UPDATE_EVENT_BUFFER_EXCEEDED' })
  }
  let expire
  const deadline = new Promise((_, reject) => { expire = reject })
  const timer = clock.setTimeout(() => {
    settle({ error: 'PLUGIN_UPDATE_COMPLETION_TIMEOUT' })
    expire(new Error('PLUGIN_UPDATE_COMPLETION_TIMEOUT'))
  }, timeoutMs)
  const bounded = async work => {
    const result = await Promise.race([Promise.resolve(work).then(value => ({ value })), deadline])
    return result.value
  }
  try {
    events.on(eventName, handler)
    listening = true
    const subscription = await bounded(events.subscribe(eventName))
    subscribed = subscription?.success === true
    if (!subscribed) throw new Error('PLUGIN_UPDATE_EVENT_SUBSCRIBE_FAILED')
    requested = true
    const accepted = await bounded(update.downloadPlugin(pluginId, info))
    if (accepted !== true) throw new Error('PLUGIN_UPDATE_NOT_ACCEPTED')
    apiAccepted = true
    for (const completion of buffered) consider(completion)
    const result = await Promise.race([outcome, deadline])
    if (result.error) {
      const error = new Error(result.error)
      error.updateCompletion = result.completion
      throw error
    }
    return { publicApiAccepted: true, operationId: result.completion.operationId,
      operationIdSource: 'plugin_install_complete terminal event; downloadPlugin returns no accepted operationId',
      completion: result.completion }
  } finally {
    clock.clearTimeout(timer)
    try {
      if (listening) events.off(eventName, handler)
    } finally {
      if (subscribed) {
        let cleanupTimer
        const cleanupDeadline = new Promise((_, reject) => {
          cleanupTimer = clock.setTimeout(() => reject(new Error('PLUGIN_UPDATE_EVENT_CLEANUP_TIMEOUT')), 5000)
        })
        try {
          const removed = await Promise.race([Promise.resolve(events.unsubscribe(eventName)), cleanupDeadline])
          if (removed?.success === false) throw new Error('PLUGIN_UPDATE_EVENT_UNSUBSCRIBE_FAILED')
        } finally { clock.clearTimeout(cleanupTimer) }
      }
    }
  }
}

export function publicPluginUpdateFailureExpression({ pluginId, downloadUrl, version, checksum, fileSize,
  expectedErrorCode = 'NOT_SUPPORTED', timeoutMs = 90_000 }) {
  let url
  try { url = new URL(downloadUrl) } catch { throw new Error('PLUGIN_UPDATE_ARGUMENT_INVALID') }
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(pluginId) ||
      url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash ||
      typeof version !== 'string' || !/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ||
      typeof checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(checksum) ||
      !Number.isSafeInteger(fileSize) || fileSize <= 0 ||
      typeof expectedErrorCode !== 'string' || !/^[A-Z0-9_]{1,96}$/.test(expectedErrorCode) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) {
    throw new Error('PLUGIN_UPDATE_ARGUMENT_INVALID')
  }
  return `(${awaitPublicPluginUpdateFailure.toString()})({
    update: window.ztools?.update, events: window.ztools?.events,
    pluginId: ${JSON.stringify(pluginId)},
    info: ${JSON.stringify({ downloadUrl, version, checksum, fileSize })},
    expectedErrorCode: ${JSON.stringify(expectedErrorCode)}, timeoutMs: ${timeoutMs}
  })`
}
