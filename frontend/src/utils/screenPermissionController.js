const implementations = new Set(['supported', 'unsupported', 'unavailable'])
const authorizations = new Set(['not-requested', 'granted', 'denied', 'unknown'])
const permissions = new Set(['not-required', 'not-determined', 'granted', 'denied', 'restricted', 'unknown'])
export const SCREEN_PERMISSION_EVENT = 'runtime_permission_changed'

function readSnapshot(value) {
  if (!value || ![1, 2].includes(value.contractVersion) || value.capability !== 'screen.capture' ||
      !implementations.has(value.implementation) || !authorizations.has(value.authorization) ||
      !permissions.has(value.osPermission) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      value.target?.runtime !== 'electron' || !['windows', 'macos'].includes(value.target.platform) ||
      !['ia32', 'x64', 'arm64'].includes(value.target.arch)) throw new Error('INVALID_PERMISSION_SNAPSHOT')
  return Object.freeze({ contractVersion: value.contractVersion, capability: value.capability,
    implementation: value.implementation, authorization: value.authorization, osPermission: value.osPermission,
    revision: value.revision, target: Object.freeze({ ...value.target }) })
}

/** Read-only UI observer: notifications trigger a fresh Main query, never grant permission. */
export function createScreenPermissionController(sdk, onChange) {
  let stopped = false, started = false, pending = null, refreshAgain = false, snapshot = null
  const publish = state => { if (!stopped) onChange(state) }
  const refresh = () => {
    if (stopped) return Promise.resolve()
    if (pending) { refreshAgain = true; return pending }
    publish({ loading: true, snapshot, error: '' })
    pending = (async () => {
      do {
        refreshAgain = false
        try {
          const next = readSnapshot(await sdk.sys.getCapability('screen.capture'))
          if (stopped) return
          if (!snapshot || next.revision >= snapshot.revision) snapshot = next
          publish({ loading: false, snapshot, error: '' })
        } catch {
          snapshot = null
          publish({ loading: false, snapshot, error: '无法读取当前权限状态，请稍后重试。' })
        }
      } while (refreshAgain && !stopped)
    })().finally(() => { pending = null })
    return pending
  }
  const onEvent = envelope => {
    if (stopped || envelope?.source?.kind !== 'host' || envelope.payload?.capability !== 'screen.capture' ||
        !Number.isSafeInteger(envelope.payload.revision) || envelope.payload.revision < 1 ||
        (snapshot && envelope.payload.revision <= snapshot.revision)) return
    void refresh()
  }
  return {
    start() {
      if (stopped || started) return Promise.resolve()
      try {
        sdk.events.on(SCREEN_PERMISSION_EVENT, onEvent)
        started = true
      } catch {
        publish({ loading: false, snapshot: null, error: '无法监听权限变更，请手动重新检查。' })
      }
      return refresh()
    },
    refresh,
    stop() {
      if (stopped) return
      stopped = true; refreshAgain = false
      if (started) {
        try { sdk.events.off(SCREEN_PERMISSION_EVENT, onEvent) } catch { /* teardown remains idempotent */ }
      }
      snapshot = null
    }
  }
}
