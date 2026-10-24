import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  RuntimeCapabilityService,
  type CapabilityAuthorizationStatus,
  type CapabilityImplementationStatus,
  type CapabilityOsPermissionStatus,
  type RuntimeCapabilityDefinition
} from '../../src/main/services/runtime-capability-service.js'
import { createRuntimeCapabilityProviders } from '../../src/main/services/runtime-capability-providers.js'

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 2,
  pluginId: 'plugin.actual',
  pluginInstanceId: 'instance.actual'
}
const otherPluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 3,
  pluginId: 'plugin.other',
  pluginInstanceId: 'instance.other'
}

function definitions(...ids: RuntimeCapabilityDefinition['id'][]): RuntimeCapabilityDefinition[] {
  return ids.map((id) => ({ id }))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

test('runtime capability service accepts only IDs in the injected catalog', async () => {
  const service = new RuntimeCapabilityService(definitions('screen.capture'))
  const snapshot = await service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(snapshot.capability, 'screen.capture')

  await assert.rejects(
    service.getSnapshot({ capability: 'screen_capture' }, mainCaller),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    service.getSnapshot({ capability: 'clipboard.files.read' }, mainCaller),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('policy provider gets the trusted caller argument and stable ID, not renderer-supplied identity', async () => {
  let observedCaller: CallerIdentity | undefined
  let observedCapability: string | undefined
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getAuthorization(capability, caller) {
      observedCapability = capability
      observedCaller = caller
      return caller.pluginId === 'plugin.actual' ? 'granted' : 'denied'
    }
  })
  const rendererCaller = { type: 'main', webContentsId: 1 }
  const params = {
    capability: 'screen.capture',
    caller: rendererCaller
  } as unknown as { capability: string }

  const snapshot = await service.getSnapshot(params, pluginCaller)
  assert.equal(snapshot.authorization, 'granted')
  assert.equal(observedCapability, 'screen.capture')
  assert.deepEqual(observedCaller, pluginCaller)
  assert.notEqual(observedCaller, rendererCaller)
})

test('implementation, policy authorization, and OS permission remain independent axes', async () => {
  let implementation: CapabilityImplementationStatus = 'unsupported'
  let authorization: CapabilityAuthorizationStatus = 'denied'
  let osPermission: CapabilityOsPermissionStatus = 'granted'
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => implementation,
    getAuthorization: () => authorization,
    getOsPermission: () => osPermission
  })

  const first = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.deepEqual(
    [first.implementation, first.authorization, first.osPermission],
    ['unsupported', 'denied', 'granted']
  )

  implementation = 'supported'
  const implementationChange = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.deepEqual(
    [implementationChange.implementation, implementationChange.authorization, implementationChange.osPermission],
    ['supported', 'denied', 'granted']
  )

  authorization = 'granted'
  const authorizationChange = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.deepEqual(
    [authorizationChange.implementation, authorizationChange.authorization, authorizationChange.osPermission],
    ['supported', 'granted', 'granted']
  )

  osPermission = 'denied'
  const osPermissionChange = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.deepEqual(
    [osPermissionChange.implementation, osPermissionChange.authorization, osPermissionChange.osPermission],
    ['supported', 'granted', 'denied']
  )
})

test('missing OS permission provider reports unknown without prompting', async () => {
  let implementationReads = 0
  let authorizationReads = 0
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => {
      implementationReads += 1
      return 'supported'
    },
    getAuthorization: () => {
      authorizationReads += 1
      return 'granted'
    }
  })

  const snapshot = await service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(snapshot.osPermission, 'unknown')
  assert.equal(implementationReads, 1)
  assert.equal(authorizationReads, 1)
})

test('production capability providers read only the existing screen TCC status and fail closed elsewhere', async () => {
  const reads: string[] = []
  const providers = createRuntimeCapabilityProviders({
    getScreenCapturePermissionStatus() {
      reads.push('screen-status')
      return 'granted'
    }
  }, 'macos')
  const service = new RuntimeCapabilityService(
    definitions('screen.capture', 'clipboard.files.read', 'system.hibernate'),
    providers
  )

  const screen = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.deepEqual(
    [screen.implementation, screen.authorization, screen.osPermission],
    ['supported', 'unknown', 'granted']
  )
  const clipboard = await service.getSnapshot({ capability: 'clipboard.files.read' }, pluginCaller)
  assert.deepEqual(
    [clipboard.implementation, clipboard.authorization, clipboard.osPermission],
    ['unavailable', 'unknown', 'unknown']
  )
  const hibernate = await service.getSnapshot({ capability: 'system.hibernate' }, pluginCaller)
  assert.equal(hibernate.implementation, 'unsupported')
  assert.deepEqual(reads, ['screen-status'])

  const unavailable = createRuntimeCapabilityProviders({
    getScreenCapturePermissionStatus: () => 'unavailable'
  }, 'macos')
  assert.equal(
    (await new RuntimeCapabilityService(definitions('screen.capture'), unavailable)
      .getSnapshot({ capability: 'screen.capture' }, pluginCaller)).osPermission,
    'unknown'
  )
  const readFailure = createRuntimeCapabilityProviders({
    getScreenCapturePermissionStatus: () => { throw new Error('TCC probe failure') }
  }, 'macos')
  assert.equal(
    (await new RuntimeCapabilityService(definitions('screen.capture'), readFailure)
      .getSnapshot({ capability: 'screen.capture' }, pluginCaller)).osPermission,
    'unknown'
  )
})

test('Windows screen capture reports that an OS permission is not required without probing macOS TCC', async () => {
  let windowsTccReads = 0
  const windowsProviders = createRuntimeCapabilityProviders({
    getScreenCapturePermissionStatus() {
      windowsTccReads += 1
      return 'granted'
    }
  }, 'windows')
  const windows = new RuntimeCapabilityService(
    definitions('screen.capture', 'clipboard.files.read', 'system.hibernate'),
    windowsProviders
  )

  const windowsScreen = await windows.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  const windowsClipboard = await windows.getSnapshot({ capability: 'clipboard.files.read' }, pluginCaller)
  const windowsHibernate = await windows.getSnapshot({ capability: 'system.hibernate' }, pluginCaller)
  assert.deepEqual(
    [windowsScreen.implementation, windowsScreen.authorization, windowsScreen.osPermission],
    ['supported', 'unknown', 'not-required']
  )
  assert.equal(windowsClipboard.implementation, 'supported')
  assert.equal(windowsClipboard.osPermission, 'unknown')
  assert.equal(windowsHibernate.implementation, 'unsupported')
  assert.equal(windowsTccReads, 0)
})

test('revision is stable without changes and increases when any axis changes', async () => {
  let implementation: CapabilityImplementationStatus = 'unavailable'
  let authorization: CapabilityAuthorizationStatus = 'unknown'
  let osPermission: CapabilityOsPermissionStatus = 'not-determined'
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => implementation,
    getAuthorization: () => authorization,
    getOsPermission: () => osPermission
  })
  const query = { capability: 'screen.capture' }

  const initial = await service.getSnapshot(query, mainCaller)
  const unchanged = await service.getSnapshot(query, mainCaller)
  implementation = 'supported'
  const implementationChange = await service.getSnapshot(query, mainCaller)
  authorization = 'granted'
  const authorizationChange = await service.getSnapshot(query, mainCaller)
  osPermission = 'granted'
  const osPermissionChange = await service.getSnapshot(query, mainCaller)

  assert.equal(unchanged.revision, initial.revision)
  assert.ok(implementationChange.revision > unchanged.revision)
  assert.ok(authorizationChange.revision > implementationChange.revision)
  assert.ok(osPermissionChange.revision > authorizationChange.revision)
})

test('authorization snapshots and revisions are isolated by caller identity', async () => {
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getAuthorization: (_capability, caller) => caller.pluginId === 'plugin.actual' ? 'granted' : 'denied'
  })
  const query = { capability: 'screen.capture' }

  const actualFirst = await service.getSnapshot(query, pluginCaller)
  const otherFirst = await service.getSnapshot(query, otherPluginCaller)
  const actualAgain = await service.getSnapshot(query, pluginCaller)
  const otherAgain = await service.getSnapshot(query, otherPluginCaller)

  assert.equal(actualFirst.authorization, 'granted')
  assert.equal(otherFirst.authorization, 'denied')
  assert.equal(actualAgain.revision, actualFirst.revision)
  assert.equal(otherAgain.revision, otherFirst.revision)
})

test('method caller gates apply only when a definition explicitly restricts that caller type', async () => {
  const policyCalls: string[] = []
  const service = new RuntimeCapabilityService([
    { id: 'screen.capture' },
    {
      id: 'system.hibernate',
      callerGate: { method: 'settings_get', methodGateCallers: ['plugin'] }
    }
  ], {
    getAuthorization(capability) {
      policyCalls.push(capability)
      return 'granted'
    }
  })

  const noGate = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  const restricted = await service.getSnapshot(
    { capability: 'system.hibernate' },
    pluginCaller
  )
  const notListedForGate = await service.getSnapshot(
    { capability: 'system.hibernate' },
    mainCaller
  )
  assert.equal(noGate.authorization, 'granted')
  assert.equal(restricted.authorization, 'denied')
  assert.equal(notListedForGate.authorization, 'granted')
  assert.deepEqual(policyCalls, ['screen.capture', 'system.hibernate'])
})

test('authorization remains unknown when the policy provider is missing or fails', async () => {
  const withoutProvider = new RuntimeCapabilityService(definitions('screen.capture'))
  const providerFailure = new RuntimeCapabilityService(definitions('screen.capture'), {
    getAuthorization: () => { throw new Error('policy store unavailable') }
  })

  const noProviderSnapshot = await withoutProvider.getSnapshot(
    { capability: 'screen.capture' },
    pluginCaller
  )
  assert.deepEqual(
    [noProviderSnapshot.implementation, noProviderSnapshot.authorization, noProviderSnapshot.osPermission],
    ['unavailable', 'unknown', 'unknown']
  )
  assert.equal(
    (await providerFailure.getSnapshot({ capability: 'screen.capture' }, pluginCaller)).authorization,
    'unknown'
  )
})

test('implementation and OS provider failures remain distinct from explicit platform support states', async () => {
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => { throw new Error('implementation probe unavailable') },
    getOsPermission: () => { throw new Error('permission probe unavailable') }
  })

  const snapshot = await service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(snapshot.implementation, 'unavailable')
  assert.equal(snapshot.authorization, 'unknown')
  assert.equal(snapshot.osPermission, 'unknown')
})

test('late older concurrent reads cannot overwrite the newer permission revision', async () => {
  const reads = [
    deferred<CapabilityOsPermissionStatus>(),
    deferred<CapabilityOsPermissionStatus>()
  ]
  let readIndex = 0
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => 'supported',
    getOsPermission: () => {
      const index = readIndex++
      return reads[index]?.promise ?? 'granted'
    }
  })

  const olderRead = service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  const newerRead = service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  reads[1]!.resolve('granted')
  const newer = await newerRead
  reads[0]!.resolve('denied')
  const older = await olderRead

  assert.equal(newer.osPermission, 'granted')
  assert.equal(older.osPermission, 'granted')
  assert.equal(older.revision, newer.revision)
  const next = await service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(next.osPermission, 'granted')
  assert.equal(next.revision, newer.revision)
  service.stop()
})

test('closing an owner aborts a pending read and removes its cached snapshot', async () => {
  const lateRead = deferred<CapabilityOsPermissionStatus>()
  let firstRead = true
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getImplementation: () => 'supported',
    getOsPermission: () => {
      if (firstRead) {
        firstRead = false
        return lateRead.promise
      }
      return 'granted'
    }
  })

  const pending = service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  service.closeOwner(pluginCaller)
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.callerDestroyed
  )
  lateRead.resolve('denied')
  const fresh = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.equal(fresh.osPermission, 'granted')
  assert.equal(fresh.revision, 1)

  service.closeOwner(pluginCaller.webContentsId)
  const afterClose = await service.getSnapshot({ capability: 'screen.capture' }, pluginCaller)
  assert.equal(afterClose.revision, 2)
  service.stop()
})

test('an aborted capability read settles even when a provider ignores its signal', async () => {
  const lateRead = deferred<CapabilityOsPermissionStatus>()
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getOsPermission: () => lateRead.promise
  })
  const controller = new AbortController()
  const pending = service.getSnapshot({ capability: 'screen.capture' }, mainCaller, controller.signal)
  controller.abort(errorCodes.requestTimeout)

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.callerDestroyed
  )
  lateRead.resolve('granted')
  const afterLateResolution = await service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  assert.equal(afterLateResolution.osPermission, 'granted')
  assert.equal(afterLateResolution.revision, 1)
  service.stop()
})

test('stop aborts active reads and prevents new snapshots', async () => {
  const lateRead = deferred<CapabilityOsPermissionStatus>()
  const service = new RuntimeCapabilityService(definitions('screen.capture'), {
    getOsPermission: () => lateRead.promise
  })
  const pending = service.getSnapshot({ capability: 'screen.capture' }, mainCaller)
  service.stop()

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.appStopping
  )
  lateRead.resolve('denied')
  await assert.rejects(
    service.getSnapshot({ capability: 'screen.capture' }, mainCaller),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.appStopping
  )
})
