import assert from 'node:assert/strict'
import test from 'node:test'
import { ReferenceFileResources } from '../../src/main/protocol/reference-file-resources.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { PathResourceLease } from '../../src/main/services/path-grant-service.js'

function fixture() {
  const session = {} as Electron.Session
  const target = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://plugins/example/index.html' } }
  let caller: CallerIdentity | undefined = { type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'one' }
  let acceptedOwner: number | undefined, lane: 1 | 2 = 2
  const registry = { get: (owner: number) => owner === 42 ? caller : undefined,
    getWebContents: (owner: number) => owner === 42 ? target : undefined, getSession: () => session, getSdkApiLane: () => lane } as unknown as WindowRegistry
  const resources = new ReferenceFileResources(registry, { ownsResourceUrl: url => url === 'ztools://file/owned/name.txt', canLoadResource: (url, owner) => {
    acceptedOwner = owner; return url === 'ztools://file/owned/name.txt'
  }, openResource: async (): Promise<PathResourceLease> => { throw new Error('unused resource port') } })
  const details = { url: 'ztools://file/owned/name.txt', method: 'GET', webContentsId: 42,
    webContents: target as unknown as Electron.WebContents, frame: target.mainFrame as Electron.WebFrameMain }
  return { resources, details, session, target, owner: () => acceptedOwner, setLane: (value: 1 | 2) => { lane = value }, setCaller: (value: CallerIdentity | undefined) => { caller = value } }
}

test('resource owner guard binds real registry WebContents, main frame and session before checking grant ownership', () => {
  const f = fixture()
  assert.equal(f.resources.allowsNativeRequest(f.details, f.session), true); assert.equal(f.owner(), 42)
  const { webContentsId: _owner, ...missingOwner } = f.details
  for (const details of [missingOwner, { ...f.details, webContentsId: 99 },
    { ...f.details, webContents: { ...f.target } as unknown as Electron.WebContents },
    { ...f.details, frame: null }, { ...f.details, frame: { ...f.target.mainFrame } as Electron.WebFrameMain },
    { ...f.details, method: 'POST' }, { ...f.details, url: 'ztools://file/foreign/name.txt' }]) {
    assert.equal(f.resources.allowsNativeRequest(details, f.session), false)
  }
  assert.equal(f.resources.allowsNativeRequest(f.details, {} as Electron.Session), false)
  f.resources.stop(); assert.equal(f.resources.allowsNativeRequest(f.details, f.session), false)
})

test('resource guard rejects foreign pages, plugin generations and missing callers without using referrers', () => {
  const f = fixture()
  for (const url of ['https://example.invalid/', 'ztools://plugins/other/index.html', 'ztools://web/index.html',
    'ztools://user@plugins/example/index.html', 'ztools://plugins/%xx/index.html']) {
    f.target.mainFrame.url = url; assert.equal(f.resources.allowsNativeRequest(f.details, f.session), false)
  }
  f.target.mainFrame.url = 'ztools://plugins/example/index.html'
  f.setCaller({ type: 'plugin', webContentsId: 42, pluginId: 'example' }); assert.equal(f.resources.allowsNativeRequest(f.details, f.session), false)
  f.setCaller(undefined); assert.equal(f.resources.allowsNativeRequest(f.details, f.session), false)
  f.setCaller({ type: 'main', webContentsId: 42 }); f.target.mainFrame.url = 'ztools://web/index.html'
  assert.equal(f.resources.allowsNativeRequest({ ...f.details, method: 'HEAD' }, f.session), true)
})

test('resource stop propagates cancellation into pending native resource acquisition and refuses late requests', async () => {
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  let signal: AbortSignal | undefined, calls = 0
  const resources = new ReferenceFileResources({} as WindowRegistry, { ownsResourceUrl: () => true, canLoadResource: () => false,
    openResource: async (_url, incoming): Promise<PathResourceLease> => {
      calls++; signal = incoming; started()
      await new Promise<void>((_, reject) => incoming.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      throw new Error('unreachable')
    } })
  const response = resources.respond(new Request('ztools://file/owned/name.txt'))
  await entered; resources.closeIngress(); resources.closeIngress(); resources.stop()
  assert.equal(signal!.aborted, true); assert.equal((await response).status, 404)
  assert.equal((await resources.respond(new Request('ztools://file/owned/name.txt'))).status, 404); assert.equal(calls, 1)
})

test('resource domains follow the registered owner lane and reject cross-lane access', () => {
  const f = fixture(), files = { canLoadFileCapability: (_url: string, owner: number) => owner === 42 }
  assert.equal(f.resources.claimsUrl(f.details.url), true)
  assert.equal(f.resources.claimsUrl('ztools://file/unknown/name.txt'), false)
  assert.equal(f.resources.allowsLegacyRequest(f.details, f.session, files), false)
  f.setLane(1)
  assert.equal(f.resources.allowsNativeRequest(f.details, f.session), false)
  assert.equal(f.resources.allowsLegacyRequest(f.details, f.session, files), true)
  assert.equal(f.resources.allowsLegacyRequest({ ...f.details, frame: null }, f.session, files), false)
  f.setCaller(undefined)
  assert.equal(f.resources.allowsLegacyRequest(f.details, f.session, files), false)
  f.resources.stop(); assert.equal(f.resources.claimsUrl(f.details.url), false)
})
