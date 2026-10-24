import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const id = 'a'.repeat(43), ref = { grantId: id, kind: 'file', displayName: 'region.png', operations: ['read'] }
function stripModuleSyntax(source: string) {
  return source.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('import ')) return ''
    if (/^export\s+default\b/.test(trimmed) || /^export\s*\{/.test(trimmed)) return ''
    return line.replace(/^(\s*)export\s+/, '$1')
  }).join('\n')
}
function fixture(version = 2, initialAuthorization: 'not-requested' | 'granted' = 'not-requested') {
  const methods = { screen_capture_region() {}, filesystem_revoke() {} }
  const source = ['fs-reference', 'runtime-capability', 'screen'].map(name => stripModuleSyntax(fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8'))).join('\n')
  let response: unknown = { success: true, reference: ref, fileUrl: `ztools://file/${id}/region.png`, size: 10, width: 10, height: 10 }
  const calls: { method: string; params: unknown; options: unknown }[] = []
  const capabilityCalls: { method: string; capability: string; timeout?: number; signal?: AbortSignal }[] = []
  let authorization = initialAuthorization
  const transport = {
    supportsAbortSignal: true,
    isElectronEnvironment: () => true,
    call: async (method: string, params: unknown, options: unknown) => {
      calls.push({ method, params, options })
      return method === 'filesystem_revoke' ? { success: true } : response
    }
  }
  const sys = {
    transport,
    getCapability: async (capability: string) => {
      capabilityCalls.push({ method: 'get', capability })
      return { authorization }
    },
    requestCapability: async (request: { capability: string }, options: { signal?: AbortSignal; timeout?: number }) => {
      capabilityCalls.push({ method: 'request', capability: request.capability,
        ...(options.signal ? { signal: options.signal } : {}), ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) })
      if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'CALLER_DESTROYED' })
      authorization = 'granted'
      return { authorization }
    }
  }
  const Constructor = vm.runInNewContext(source + '\nScreenAPI', {
    window: { __ztoolsElectron: { contractVersion: version, transport: { methods, cancellations: methods } } }, TextEncoder
  }) as new (transport: unknown, sys: unknown) => { captureRegionReference(options?: unknown): Promise<unknown> }
  return { api: new Constructor(transport, sys), calls, capabilityCalls, response: (value: unknown) => { response = value } }
}
test('interactive region SDK calls only its method port with real cancellation and bounded chooser timeout', async () => {
  const f = fixture(), signal = new AbortController().signal, result = await f.api.captureRegionReference({ signal })
  assert.ok(Object.isFrozen(result)); assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0]?.params)), {}); assert.equal(f.calls[0]?.method, 'screen_capture_region'); assert.equal((f.calls[0]?.options as { signal: AbortSignal }).signal, signal); assert.equal((f.calls[0]?.options as { timeout: number }).timeout, 120000)
  assert.deepEqual(f.capabilityCalls.map(call => call.method), ['get', 'request'])
  assert.equal(f.capabilityCalls[0]?.capability, 'screen.capture')
  assert.equal(f.capabilityCalls[1]?.signal, signal)
  assert.equal(f.capabilityCalls[1]?.timeout, 120000)
})
test('region SDK Esc is an explicit empty outcome; malformed canceled responses release any delivered reference', async () => {
  const f = fixture(); f.response({ success: true, cancelled: true }); assert.equal(await f.api.captureRegionReference(), undefined)
  f.response({ success: true, cancelled: true, reference: ref }); await assert.rejects(f.api.captureRegionReference(), { code: 'SCREEN_ERROR' }); assert.equal(f.calls.at(-1)?.method, 'filesystem_revoke')
})
test('region SDK requires contract2 and refuses paths or preabort before contacting Main', async () => {
  const f = fixture(1, 'granted'); await assert.rejects(f.api.captureRegionReference(), { code: 'NOT_SUPPORTED' }); assert.equal(f.calls.length, 0)
  const newer = fixture(2, 'granted'), c = new AbortController(); c.abort(); await assert.rejects(newer.api.captureRegionReference({ signal: c.signal }), { code: 'CALLER_DESTROYED' }); await assert.rejects(newer.api.captureRegionReference({ outputPath: 'C:/private' }), { code: 'INVALID_REQUEST' }); assert.equal(newer.calls.length, 0)
})
