import { describe, it, expect, vi } from 'vitest'
import { createScreenPermissionController, SCREEN_PERMISSION_EVENT } from '../screenPermissionController'

const record = (permission, revision = 1) => ({ contractVersion: 1, capability: 'screen.capture',
  implementation: 'supported', authorization: 'unknown', osPermission: permission, revision,
  target: { platform: 'macos', runtime: 'electron', arch: 'arm64' } })
function fixture(getCapability = vi.fn().mockResolvedValue(record('denied'))) {
  let listener
  const sdk = { sys: { getCapability }, events: { on: vi.fn((key, callback) => { listener = callback }), off: vi.fn() } }
  const changed = vi.fn(), controller = createScreenPermissionController(sdk, changed)
  return { sdk, changed, controller, emit: payload => listener(payload) }
}
describe('screen permission observer', () => {
  it('reads actual Main state; ignores page/plugin notices and never converts unknown authorization to granted', async () => {
    const f = fixture()
    await f.controller.start()
    expect(f.sdk.events.on).toHaveBeenCalledWith(SCREEN_PERMISSION_EVENT, expect.any(Function))
    for (const kind of ['plugin', 'page']) f.emit({ source: { kind }, payload: { capability: 'screen.capture', revision: 9 } })
    expect(f.sdk.sys.getCapability).toHaveBeenCalledTimes(1)
    expect(f.changed.mock.lastCall[0].snapshot.authorization).toBe('unknown')
  })
  it('accepts the explicit not-requested authorization state without prompting', async () => {
    const f = fixture(vi.fn().mockResolvedValue({ ...record('not-required'), authorization: 'not-requested' }))
    await f.controller.start()
    expect(f.changed.mock.lastCall[0].snapshot.authorization).toBe('not-requested')
    expect(f.sdk.sys.getCapability).toHaveBeenCalledOnce()
  })
  it('coalesces concurrent refreshes and shows the re-queried status rather than event claims', async () => {
    let resolve
    const query = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done }))
      .mockResolvedValue(record('denied', 2))
    const f = fixture(query), initial = f.controller.start()
    f.emit({ source: { kind: 'host' }, payload: { capability: 'screen.capture', revision: 2, osPermission: 'granted' } })
    void f.controller.refresh(); void f.controller.refresh()
    resolve(record('granted', 1)); await initial
    expect(query).toHaveBeenCalledTimes(2)
    expect(f.changed.mock.lastCall[0].snapshot.osPermission).toBe('denied')
  })
  it('unsubscribes exactly once and discards an in-flight response after unmount', async () => {
    let resolve
    const f = fixture(vi.fn(() => new Promise(done => { resolve = done })))
    const pending = f.controller.start(), before = f.changed.mock.calls.length
    f.controller.stop(); f.controller.stop(); resolve(record('granted')); await pending
    expect(f.sdk.events.off).toHaveBeenCalledTimes(1)
    expect(f.changed).toHaveBeenCalledTimes(before)
  })
  it('rejects malformed statuses and replaces stale success with a clear query failure', async () => {
    const query = vi.fn().mockResolvedValueOnce(record('granted')).mockResolvedValueOnce(record('invented', 2))
    const f = fixture(query); await f.controller.start(); await f.controller.refresh()
    expect(f.changed.mock.lastCall[0].snapshot).toBeNull()
    expect(f.changed.mock.lastCall[0].error).toBeTruthy()
  })
  it('keeps manual status checks usable if subscription setup throws and tolerates teardown failure', async () => {
    const f = fixture()
    f.sdk.events.on.mockImplementationOnce(() => { throw new Error('subscription unavailable') })
    await f.controller.start()
    expect(f.changed.mock.lastCall[0].snapshot.osPermission).toBe('denied')
    f.controller.stop()
    expect(f.sdk.events.off).not.toHaveBeenCalled()
    const second = fixture()
    await second.controller.start()
    second.sdk.events.off.mockImplementationOnce(() => { throw new Error('already destroyed') })
    expect(() => second.controller.stop()).not.toThrow()
    second.controller.stop()
    expect(second.sdk.events.off).toHaveBeenCalledTimes(1)
  })
})
