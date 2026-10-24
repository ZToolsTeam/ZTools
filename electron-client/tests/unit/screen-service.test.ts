import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import type { ReferenceCacheService } from '../../src/main/services/reference-cache-service.js'
import type { RuntimeCapabilityAuthorizationService } from '../../src/main/services/runtime-capability-authorization-service.js'
import {
  ScreenService,
  type ScreenAdapter,
  type ScreenCaptureFallback,
  type ScreenCapturePermissionStatus,
  type ScreenDisplay,
  type ScreenImage
} from '../../src/main/services/screen-service.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'sample', pluginInstanceId: 'instance-2' }

class FakeImage implements ScreenImage {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly bitmap: Buffer
  ) {}

  getSize(_scaleFactor?: number): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  resize(options: { width: number; height: number; quality: 'best' }): ScreenImage {
    assert.deepEqual(options, { width: this.width, height: this.height, quality: 'best' })
    return this
  }

  toBitmap(_options?: { scaleFactor: number }): Buffer {
    return this.bitmap
  }

  toPNG(): Buffer {
    return this.bitmap
  }
}

function pixel(value: number): Buffer {
  return Buffer.from([value, value, value, 255])
}

function display(id: number, x: number, label: string): ScreenDisplay {
  return {
    id,
    label,
    bounds: { x, y: 0, width: 2, height: 1 },
    workArea: { x, y: 0, width: 2, height: 1 },
    scaleFactor: id === 1 ? 1.5 : 1,
    rotation: 0,
    touchSupport: 'unknown',
    // 左屏模拟 ProMotion 内建屏（Electron 原始值带小数）；右屏模拟系统未报告 / 报告异常值
    ...(id === 1
      ? { displayFrequency: 120.0006103515625, colorDepth: 30, depthPerComponent: 10 }
      : { displayFrequency: 0, colorDepth: Number.NaN, depthPerComponent: -8 })
  }
}

function createService(
  sourceOverrides?: { displayId: string; image: ScreenImage }[],
  permissionStatus?: ScreenCapturePermissionStatus | (() => ScreenCapturePermissionStatus),
  sourceFailure?: unknown,
  referenceCache?: Pick<ReferenceCacheService, 'writeGeneratedCacheFile' | 'revokeReference'>,
  onSources?: (displays: ScreenDisplay[]) => void | Promise<void>,
  capabilityAuthorization?: Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>
): {
  service: ScreenService
  written: Buffer[]
  sourceCalls(): number
} {
  const displays = [display(1, -2, 'Left'), display(2, 0, 'Primary')]
  const written: Buffer[] = []
  let sourceCalls = 0
  const files = {
    async writeGeneratedCacheFile(_relativePath: string, data: Buffer) {
      written.push(Buffer.from(data))
      return { path: 'C:\\cache\\screen.png', size: data.byteLength }
    }
  } as unknown as FileSystemService
  const sources = sourceOverrides ?? [
    { displayId: '1', image: new FakeImage(2, 1, Buffer.concat([pixel(10), pixel(20)])) },
    { displayId: '2', image: new FakeImage(2, 1, Buffer.concat([pixel(30), pixel(40)])) }
  ]
  const adapter: ScreenAdapter = {
    getCursorScreenPoint: () => ({ x: -1, y: 7 }),
    getPrimaryDisplay: () => displays[1] as ScreenDisplay,
    getAllDisplays: () => displays,
    getDisplayNearestPoint: (point) => point.x < 0 ? displays[0] as ScreenDisplay : displays[1] as ScreenDisplay,
    getDisplayMatching: (rect) => rect.x < 0 ? displays[0] as ScreenDisplay : displays[1] as ScreenDisplay,
    async getSources(thumbnailSize) {
      sourceCalls += 1
      await onSources?.(displays)
      assert.deepEqual(thumbnailSize, { width: 3, height: 2 })
      if (sourceFailure !== undefined) throw sourceFailure
      return sources
    },
    createFromBitmap: (buffer, size) => new FakeImage(size.width, size.height, Buffer.from(buffer)),
    ...(permissionStatus === undefined
      ? {}
      : {
          getScreenCapturePermissionStatus: () => typeof permissionStatus === 'function'
            ? permissionStatus()
            : permissionStatus
        })
  }
  return { service: new ScreenService(files, adapter, undefined, referenceCache, capabilityAuthorization), written, sourceCalls: () => sourceCalls }
}

test('screen capture authorization gates source acquisition and cache writes', async () => {
  let leaseRequests = 0
  const { service, sourceCalls, written } = createService(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { beginOperation() { leaseRequests += 1; throw new ZToolsError(errorCodes.permissionDenied, 'not granted') } } as unknown as Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>
  )
  await assert.rejects(service.capture({}, caller, new AbortController().signal), { code: errorCodes.permissionDenied })
  assert.equal(leaseRequests, 1)
  assert.equal(sourceCalls(), 0)
  assert.deepEqual(written, [])
})

test('plugin capture fails closed when the authorization service is missing', async () => {
  const { service, sourceCalls, written } = createService()
  await assert.rejects(service.capture({}, pluginCaller, new AbortController().signal), { code: errorCodes.notSupported })
  assert.equal(sourceCalls(), 0)
  assert.deepEqual(written, [])

  let referenceWrites = 0
  const referenceCache = {
    async writeGeneratedCacheFile() { referenceWrites += 1; throw new Error('must not reach cache') },
    async revokeReference() { throw new Error('must not reach cache') }
  }
  const reference = createService(undefined, undefined, undefined, referenceCache)
  await assert.rejects(reference.service.captureReference({}, pluginCaller, new AbortController().signal), { code: errorCodes.notSupported })
  assert.equal(reference.sourceCalls(), 0)
  assert.equal(referenceWrites, 0)
})

test('revoking screen authorization during source acquisition blocks later cache writes', async () => {
  const leaseAbort = new AbortController()
  let finishSources!: () => void
  let leaseReleased = 0
  const sourceGate = new Promise<void>(resolve => { finishSources = resolve })
  const { service, sourceCalls, written } = createService(
    undefined,
    undefined,
    undefined,
    undefined,
    async () => await sourceGate,
    {
      beginOperation() {
        return {
          signal: leaseAbort.signal,
          assertCurrent() {
            if (leaseAbort.signal.aborted) throw new ZToolsError(errorCodes.permissionDenied, 'revoked')
          },
          release() { leaseReleased += 1 }
        }
      }
    } as unknown as Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>
  )
  const pending = service.capture({}, caller, new AbortController().signal)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(sourceCalls(), 1)
  leaseAbort.abort(errorCodes.permissionDenied)
  finishSources()
  await assert.rejects(pending, { code: errorCodes.permissionDenied })
  assert.equal(leaseReleased, 1)
  assert.deepEqual(written, [])
})

test('screen capture composes a negative-coordinate region across displays', async () => {
  const { service, written } = createService()
  const result = await service.capture(
    { rect: { x: -1, y: 0, width: 2, height: 1 } },
    caller,
    new AbortController().signal
  )
  assert.deepEqual(result, {
    success: true,
    tempFile: 'C:\\cache\\screen.png',
    width: 2,
    height: 1
  })
  assert.deepEqual(written[0], Buffer.concat([pixel(20), pixel(30)]))
})

test('screen capture maps identified sources by display ID regardless of source order', async () => {
  const { service, written } = createService([
    { displayId: '2', image: new FakeImage(2, 1, Buffer.concat([pixel(30), pixel(40)])) },
    { displayId: '1', image: new FakeImage(2, 1, Buffer.concat([pixel(10), pixel(20)])) }
  ])

  await service.capture(
    { rect: { x: -1, y: 0, width: 2, height: 1 } },
    caller,
    new AbortController().signal
  )

  assert.deepEqual(written[0], Buffer.concat([pixel(20), pixel(30)]))
})

test('screen capture refuses ambiguous unidentified sources across multiple displays', async () => {
  const { service } = createService([
    { displayId: '', image: new FakeImage(2, 1, Buffer.concat([pixel(10), pixel(20)])) },
    { displayId: '', image: new FakeImage(2, 1, Buffer.concat([pixel(30), pixel(40)])) }
  ])

  await assert.rejects(
    service.capture(
      { rect: { x: -1, y: 0, width: 2, height: 1 } },
      caller,
      new AbortController().signal
    ),
    (error) => error instanceof ZToolsError && error.code === errorCodes.screenError
  )
})

test('screen capture pairs one unidentified source only when one display remains unmatched', async () => {
  const { service, written } = createService([
    { displayId: '2', image: new FakeImage(2, 1, Buffer.concat([pixel(30), pixel(40)])) },
    { displayId: '', image: new FakeImage(2, 1, Buffer.concat([pixel(10), pixel(20)])) }
  ])

  await service.capture(
    { rect: { x: -1, y: 0, width: 2, height: 1 } },
    caller,
    new AbortController().signal
  )

  assert.deepEqual(written[0], Buffer.concat([pixel(20), pixel(30)]))
})

test('screen display methods preserve bounds, primary state and DIP metadata', () => {
  const { service } = createService()
  assert.deepEqual(service.getCursorScreenPoint(), { success: true, x: -1, y: 7 })
  const displays = service.getAllDisplays().displays
  assert.equal(displays[0]?.bounds.x, -2)
  assert.equal(displays[0]?.scaleFactor, 1.5)
  assert.equal(displays[1]?.primary, true)
  assert.equal(service.getDisplayNearestPoint({ point: { x: -1, y: 0 } }).display.id, 1)
})

test('screen display methods expose real refresh rate and color depth and report unknown values as null', () => {
  const { service } = createService()
  const [left, primary] = service.getAllDisplays().displays
  assert.equal(left?.displayFrequency, 120)
  assert.equal(left?.colorDepth, 30)
  assert.equal(left?.depthPerComponent, 10)
  assert.equal(primary?.displayFrequency, null)
  assert.equal(primary?.colorDepth, null)
  assert.equal(primary?.depthPerComponent, null)
  assert.equal(service.getPrimaryDisplay().display.displayFrequency, null)
  assert.equal(service.getDisplayNearestPoint({ point: { x: -1, y: 0 } }).display.colorDepth, 30)
  // 宿主返回值必须可序列化（null 而不是 NaN / undefined）
  assert.deepEqual(JSON.parse(JSON.stringify(primary)).colorDepth, null)
})

test('screen capture rejects regions above the ia32 pixel budget', async () => {
  const { service } = createService()
  await assert.rejects(
    service.capture(
      { rect: { x: 0, y: 0, width: 8192, height: 8192 } },
      caller,
      new AbortController().signal
    ),
    (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
  )
})

test('screen capture lets Electron handle a first-use not-determined permission request', async () => {
  let permissionReads = 0
  const { service, sourceCalls, written } = createService(
    undefined,
    () => (++permissionReads === 1 ? 'not-determined' : 'granted')
  )
  const result = await service.capture({}, caller, new AbortController().signal)

  assert.equal(result.success, true)
  assert.equal(permissionReads, 2)
  assert.equal(sourceCalls(), 1)
  assert.equal(written.length, 1)
})

test('screen capture refuses to use sources if first-use TCC authorization is still not granted', async () => {
  const { service, sourceCalls, written } = createService(undefined, 'not-determined')

  await assert.rejects(
    service.capture({}, caller, new AbortController().signal),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  assert.equal(sourceCalls(), 1)
  assert.deepEqual(written, [])
})

test('screen capture blocks denied, restricted, unknown, and unavailable macOS permission states', async () => {
  for (const status of ['denied', 'restricted', 'unknown', 'unavailable'] as const) {
    const { service, sourceCalls, written } = createService(undefined, status)
    const expectedCode = status === 'unknown'
      ? errorCodes.screenError
      : status === 'unavailable'
        ? errorCodes.notSupported
        : errorCodes.permissionDenied
    await assert.rejects(
      service.capture({}, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError &&
        error.code === expectedCode &&
        error.message.includes(`TCC 状态：${status}`)
    )
    assert.equal(sourceCalls(), 0, `TCC=${status} must not call desktopCapturer.getSources`)
    assert.deepEqual(written, [])
  }
})

test('screen capture re-reads TCC and translates source failures after explicit permission revocation', async () => {
  for (const status of ['not-determined', 'denied', 'restricted'] as const) {
    let permissionReads = 0
    const { service, sourceCalls } = createService(
      undefined,
      () => (++permissionReads === 1 ? 'granted' : status),
      new Error('desktopCapturer failed')
    )

    await assert.rejects(
      service.capture({}, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.permissionDenied &&
        error.message.includes(`TCC 状态：${status}`)
    )
    assert.equal(permissionReads, 2)
    assert.equal(sourceCalls(), 1)
  }
})

test('screen capture preserves source errors when the post-failure TCC status is not explicit denial', async () => {
  for (const status of ['granted', 'unknown', 'unavailable'] as const) {
    let permissionReads = 0
    const { service, sourceCalls } = createService(
      undefined,
      () => (++permissionReads === 1 ? 'granted' : status),
      new Error('desktopCapturer failed')
    )

    await assert.rejects(
      service.capture({}, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.screenError &&
        error.message === '屏幕操作失败' &&
        !error.message.includes('desktopCapturer failed')
    )
    assert.equal(permissionReads, 2)
    assert.equal(sourceCalls(), 1)
  }
})

test('screen capture proceeds when read-only macOS permission status is granted', async () => {
  const { service, sourceCalls, written } = createService(undefined, 'granted')
  await service.capture({}, caller, new AbortController().signal)
  assert.equal(sourceCalls(), 1)
  assert.equal(written.length, 1)
})

test('screen capture uses the bounded GDI fallback when Electron returns an empty thumbnail', async () => {
  const written: Buffer[] = []
  const files = {
    async writeGeneratedCacheFile(_relativePath: string, data: Buffer) {
      written.push(Buffer.from(data))
      return { path: 'C:\\cache\\fallback.png', size: data.byteLength }
    }
  } as unknown as FileSystemService
  const targetDisplay = display(1, 0, 'Primary')
  const adapter: ScreenAdapter = {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getPrimaryDisplay: () => targetDisplay,
    getAllDisplays: () => [targetDisplay],
    getDisplayNearestPoint: () => targetDisplay,
    getDisplayMatching: () => targetDisplay,
    getSources: async () => [{ displayId: '1', image: new FakeImage(0, 0, Buffer.alloc(0)) }],
    createFromBitmap: (buffer, size) => new FakeImage(size.width, size.height, buffer)
  }
  const fallback: ScreenCaptureFallback = {
    async capture(rect) {
      assert.deepEqual(rect, { x: 0, y: 0, width: 2, height: 1 })
      return Buffer.from('png-fallback')
    }
  }
  const service = new ScreenService(files, adapter, fallback)
  assert.deepEqual(
    await service.capture({}, caller, new AbortController().signal),
    { success: true, tempFile: 'C:\\cache\\fallback.png', width: 2, height: 1 }
  )
  assert.deepEqual(written, [Buffer.from('png-fallback')])
})

test('reference screen capture shares permission/composition logic and stores only through native cache references', async () => {
  const reference = { grantId: 'a'.repeat(43), displayName: 'screen.png', kind: 'file' as const, operations: ['read' as const] }
  const saved: Buffer[] = []
  const cache: Pick<ReferenceCacheService, 'writeGeneratedCacheFile' | 'revokeReference'> = {
    writeGeneratedCacheFile: async (bytes, owner, extension, signal) => {
      assert.equal(owner.webContentsId, 1); assert.equal(extension, 'png'); assert.equal(signal!.aborted, false)
      saved.push(bytes); return { success: true, reference, fileUrl: 'ztools://file/ref/screen.png', size: bytes.length }
    }, revokeReference: async () => { throw new Error('unexpected') }
  }
  const f = createService(undefined, 'granted', undefined, cache)
  const result = await f.service.captureReference({ rect: { x: -1, y: 0, width: 2, height: 1 } }, caller, new AbortController().signal)
  assert.deepEqual(saved[0], Buffer.concat([pixel(20), pixel(30)])); assert.equal(f.written.length, 0)
  assert.equal(result.reference, reference); assert.equal(result.width, 2); assert.ok(!Object.hasOwn(result, 'tempFile'))
  const denied = createService(undefined, 'denied', undefined, cache)
  await assert.rejects(denied.service.captureReference({}, caller, new AbortController().signal), { code: 'PERMISSION_DENIED' })
  assert.equal(denied.sourceCalls(), 0); assert.equal(saved.length, 1)
})

test('reference screen capture refuses missing storage without legacy fallback and releases a late cancelled reference', async () => {
  const missing = createService()
  await assert.rejects(missing.service.captureReference({}, caller, new AbortController().signal), { code: 'NATIVE_HOST_UNAVAILABLE' })
  assert.equal(missing.sourceCalls(), 0); assert.equal(missing.written.length, 0)
  const controller = new AbortController(), revoked: string[] = []
  const reference = { grantId: 'a'.repeat(43), displayName: 'screen.png', kind: 'file' as const, operations: ['read' as const] }
  const f = createService(undefined, 'granted', undefined, {
    writeGeneratedCacheFile: async () => { controller.abort(); return { success: true, reference, fileUrl: 'ztools://file/ref/screen.png', size: 16 } },
    revokeReference: async ref => { revoked.push(ref.grantId) }
  })
  await assert.rejects(f.service.captureReference({}, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.deepEqual(revoked, [reference.grantId]); assert.equal(f.written.length, 0)
})


test('screen acquisition rejects display geometry, scale or membership changes during getSources before writing any cache', async () => {
  for (const changed of [
    (displays: ScreenDisplay[]) => { displays[0]!.bounds.x = -3 },
    (displays: ScreenDisplay[]) => { displays[0]!.scaleFactor = 2 },
    (displays: ScreenDisplay[]) => { displays.splice(0, 1) }
  ]) {
    const f = createService(undefined, undefined, undefined, undefined, changed)
    await assert.rejects(f.service.capture({}, caller, new AbortController().signal), { code: errorCodes.screenError })
    assert.equal(f.written.length, 0)
  }
})
