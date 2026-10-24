const CAPABILITY_REQUEST_TIMEOUT_MS = 120_000

function permissionError(message = '屏幕访问未获授权。如需使用，请关闭并重新打开该插件以再次发起授权申请。') {
  return Object.assign(new Error(message), { code: 'PERMISSION_DENIED' })
}

/** SDK convenience only; Main repeats the authorization check before every capture operation. */
export async function ensureRuntimeCapability(sys, capability, options = {}) {
  const transport = sys?.transport
  if (typeof transport?.isElectronEnvironment !== 'function' || !transport.isElectronEnvironment()) return
  const current = await sys.getCapability(capability)
  if (current?.authorization === 'granted') return
  if (current?.authorization !== 'not-requested') throw permissionError()
  const requested = await sys.requestCapability({ capability }, {
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: CAPABILITY_REQUEST_TIMEOUT_MS
  })
  if (requested?.authorization !== 'granted') throw permissionError()
}
