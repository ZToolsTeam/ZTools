export const MAC_PLUGIN_BASELINE_IDS = Object.freeze([
  'calculator', 'calendar', 'chinese-number-converter', 'color-picker', 'crypto-tool',
  'exchange-rate', 'text-formatter', 'timestamp', 'todo', 'translator',
  'unit-converter', 'uuid-generator', 'world-clock'
])

export function isPluginTarget(url, pluginId) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'ztools:' && parsed.hostname === 'plugins' && !parsed.username && !parsed.password &&
      !parsed.port && decodeURIComponent(parsed.pathname).split('/')[1] === pluginId
  } catch { return false }
}

// Serialized into the actual installed plugin renderer. No database or business action.
export async function collectMacPluginBaseline(pluginId) {
  const deadline = Date.now() + 10_000
  while ((!window.ztools?.isElectron?.() || !document.body?.children.length) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const sdk = window.ztools
  if (!sdk?.isElectron?.()) return { isElectron: false }
  let invalidCapabilityCode = null
  try { await sdk.sys.getCapability('not.registered') }
  catch (error) { invalidCapabilityCode = typeof error?.code === 'string' ? error.code : null }
  return {
    pluginId, url: location.href, isElectron: sdk.isElectron(), identity: await sdk.sys.getRuntimeIdentity(),
    nodeType: typeof process, requireType: typeof require, invalidCapabilityCode,
    dom: { ready: document.readyState, children: document.body?.children.length ?? 0,
      width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
  }
}

export function validateMacPluginBaseline(value, pluginId, expectedArch, appVersion) {
  const fail = code => ({ status: 'FAIL', code })
  if (!MAC_PLUGIN_BASELINE_IDS.includes(pluginId) || value?.pluginId !== pluginId ||
      !isPluginTarget(value?.url, pluginId) || value?.isElectron !== true) return fail('WRONG_PLUGIN_HOST')
  if (value.nodeType !== 'undefined' || value.requireType !== 'undefined') return fail('PLUGIN_ISOLATION_MISMATCH')
  if (value.identity?.contractVersion !== 1 || value.identity.target?.platform !== 'macos' ||
      value.identity.target?.runtime !== 'electron' || value.identity.target?.arch !== 'universal' ||
      value.identity.process?.arch !== expectedArch || value.identity.appVersion !== appVersion) return fail('PLUGIN_RUNTIME_MISMATCH')
  if (!['interactive', 'complete'].includes(value.dom?.ready) || !Number.isSafeInteger(value.dom.children) || value.dom.children <= 0 ||
      !Number.isSafeInteger(value.dom.width) || value.dom.width <= 0 || !Number.isSafeInteger(value.dom.height) || value.dom.height <= 0) return fail('PLUGIN_DOM_NOT_READY')
  if (value.invalidCapabilityCode !== 'INVALID_REQUEST') return fail('PLUGIN_ERROR_CONTRACT_MISMATCH')
  return { status: 'MANUAL_PENDING', checks: 'PASS', scope: 'installed-plugin-renderer-baseline', pluginId,
    processArch: expectedArch, dom: value.dom,
    pending: ['business-success', 'business-error', 'business-cancel', 'restart-persistence', 'two-architecture-final-package'] }
}

export async function runMacPluginBaseline(mainPage, options, { targets, connect, timeoutMs = 15_000 } = {}) {
  const { pluginId, expectedArch, appVersion } = options
  if (!MAC_PLUGIN_BASELINE_IDS.includes(pluginId)) return { status: 'FAIL', code: 'PLUGIN_BASELINE_NOT_PREPARED' }
  let pluginPage, attempted = false, result
  try {
    attempted = true
    const opened = await mainPage.call('Runtime.evaluate', {
      expression: `window.ztools.plugin.open(${JSON.stringify(pluginId)})`, awaitPromise: true, returnByValue: true
    })
    if (opened.exceptionDetails || opened.result?.value?.success === false) throw new Error('PLUGIN_OPEN_FAILED')
    const deadline = Date.now() + timeoutMs
    let target
    do {
      target = (await targets()).find(item => item.type === 'page' && isPluginTarget(item.url, pluginId))
      if (target) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    if (!target) throw new Error('INSTALLED_PLUGIN_TARGET_TIMEOUT')
    pluginPage = await connect(target.webSocketDebuggerUrl)
    const collected = await pluginPage.call('Runtime.evaluate', {
      expression: `(${collectMacPluginBaseline.toString()})(${JSON.stringify(pluginId)})`, awaitPromise: true, returnByValue: true
    })
    if (collected.exceptionDetails) throw new Error('PLUGIN_COLLECTION_FAILED')
    result = validateMacPluginBaseline(collected.result?.value, pluginId, expectedArch, appVersion)
  } catch (error) {
    result = { status: 'FAIL', code: /^[A-Z_]+$/.test(error?.message) ? error.message : 'PLUGIN_BASELINE_FAILED' }
  } finally {
    pluginPage?.dispose()
    if (attempted) {
      try {
        const closed = await mainPage.call('Runtime.evaluate', {
          expression: `window.ztools.plugin.close(${JSON.stringify(pluginId)})`, awaitPromise: true, returnByValue: true
        })
        if (closed.exceptionDetails || closed.result?.value?.success === false) throw new Error('PLUGIN_CLOSE_FAILED')
      } catch { result = { status: 'FAIL', code: 'PLUGIN_CLOSE_FAILED', originalCode: result?.code ?? null } }
    }
  }
  return result
}
