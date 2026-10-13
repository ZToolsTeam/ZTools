import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { createMacosScreenClipboardAdapters } from '../../src/main/platform/macos/screen-clipboard.js'
import { createPlatformScreenClipboardAdapters } from '../../src/main/platform/screen-clipboard.js'
import { createWindowsScreenClipboardAdapters } from '../../src/main/platform/windows/screen-clipboard.js'
import { clipboardFailure as windowsClipboardFailure, WindowsFileClipboardAdapter } from '../../src/main/platform/windows/file-clipboard.js'
import { screenFailure as windowsScreenFailure, WindowsScreenCaptureFallback } from '../../src/main/platform/windows/screen-capture-fallback.js'
import type { ScreenClipboardAdapters } from '../../src/main/platform/screen-clipboard.js'

function createAdapters(): ScreenClipboardAdapters {
  return {
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getPrimaryDisplay: () => ({
        id: 1,
        label: 'primary',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        workArea: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
        rotation: 0,
        touchSupport: 'unknown'
      }),
      getAllDisplays: () => [],
      getDisplayNearestPoint: () => ({
        id: 1,
        label: 'primary',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        workArea: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
        rotation: 0,
        touchSupport: 'unknown'
      }),
      getDisplayMatching: () => ({
        id: 1,
        label: 'primary',
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        workArea: { x: 0, y: 0, width: 100, height: 100 },
        scaleFactor: 1,
        rotation: 0,
        touchSupport: 'unknown'
      }),
      getSources: async () => [],
      createFromBitmap: () => ({
        getSize: () => ({ width: 1, height: 1 }),
        resize: () => ({
          getSize: () => ({ width: 1, height: 1 }),
          resize: () => { throw new Error('not used') },
          toBitmap: () => Buffer.alloc(0),
          toPNG: () => Buffer.alloc(0)
        }),
        toBitmap: () => Buffer.alloc(0),
        toPNG: () => Buffer.alloc(0)
      })
    },
    screenCaptureFallback: { capture: async () => Buffer.alloc(0) },
    fileClipboard: {
      readFiles: async () => [],
      writeFiles: async () => {}
    }
  }
}

test('Windows PowerShell adapters do not expose stderr or spawn error details', () => {
  const clipboardError = windowsClipboardFailure(new Error('PowerShell failed for C:\\Users\\alice\\private.txt'))
  assert.equal(clipboardError.code, errorCodes.clipboardError)
  assert.equal(clipboardError.message, '剪贴板操作失败')

  const screenError = windowsScreenFailure(new Error('GDI failed for display capture at C:\\Users\\alice'))
  assert.equal(screenError.code, errorCodes.screenError)
  assert.equal(screenError.message, '屏幕操作失败')
})

test('platform factory selects an explicit implementation and does not fall back on macOS', () => {
  const windowsAdapters = createAdapters()
  const macosAdapters = createAdapters()
  let windowsCreated = 0
  let macosCreated = 0

  const selectedWindows = createPlatformScreenClipboardAdapters('win32', {
    windows: () => {
      windowsCreated += 1
      return windowsAdapters
    },
    macos: () => {
      macosCreated += 1
      return macosAdapters
    }
  })
  assert.equal(selectedWindows, windowsAdapters)
  assert.equal(windowsCreated, 1)
  assert.equal(macosCreated, 0)

  windowsCreated = 0
  assert.throws(
    () => createPlatformScreenClipboardAdapters('darwin', {
      windows: () => {
        windowsCreated += 1
        return windowsAdapters
      }
    }),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.equal(windowsCreated, 0)

  const selectedMac = createPlatformScreenClipboardAdapters('darwin', {
    windows: () => windowsAdapters,
    macos: () => {
      macosCreated += 1
      return macosAdapters
    }
  })
  assert.equal(selectedMac, macosAdapters)
  assert.equal(macosCreated, 1)

  assert.throws(
    () => createPlatformScreenClipboardAdapters('linux', { windows: () => windowsAdapters }),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
})

test('Windows platform factory preserves Electron screen mappings and Windows fallbacks', async () => {
  const calls: unknown[] = []
  const image = { toPNG: () => Buffer.from('png') }
  const display = {
    id: 3,
    label: 'display-3',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 800, height: 580 },
    scaleFactor: 1,
    rotation: 0,
    touchSupport: 'unknown'
  }
  const adapters = createWindowsScreenClipboardAdapters({
    screen: {
      getCursorScreenPoint: () => ({ x: 15, y: 20 }),
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getDisplayNearestPoint: (point: { x: number; y: number }) => {
        calls.push(['nearest', point])
        return display
      },
      getDisplayMatching: (rect: { x: number; y: number; width: number; height: number }) => {
        calls.push(['matching', rect])
        return display
      }
    },
    desktopCapturer: {
      getSources: async (options: {
        types: Array<'screen'>
        thumbnailSize: { width: number; height: number }
      }) => {
        calls.push(['sources', options])
        return [{ display_id: '3', thumbnail: image }]
      }
    },
    nativeImage: {
      createFromBitmap: (
        buffer: Buffer,
        options: { width: number; height: number; scaleFactor: number }
      ) => {
        calls.push(['bitmap', buffer, options])
        return image
      }
    }
  } as unknown as Parameters<typeof createWindowsScreenClipboardAdapters>[0])

  assert.deepEqual(adapters.screen.getCursorScreenPoint(), { x: 15, y: 20 })
  assert.equal(adapters.screen.getPrimaryDisplay(), display)
  assert.deepEqual(adapters.screen.getAllDisplays(), [display])
  assert.equal(adapters.screen.getDisplayNearestPoint({ x: 2, y: 4 }), display)
  assert.equal(adapters.screen.getDisplayMatching({ x: 1, y: 2, width: 5, height: 6 }), display)
  assert.deepEqual(await adapters.screen.getSources({ width: 400, height: 300 }), [
    { displayId: '3', image }
  ])
  assert.equal(adapters.screen.createFromBitmap(Buffer.from('bmp'), { width: 2, height: 3 }), image)
  assert.deepEqual(calls, [
    ['nearest', { x: 2, y: 4 }],
    ['matching', { x: 1, y: 2, width: 5, height: 6 }],
    ['sources', { types: ['screen'], thumbnailSize: { width: 400, height: 300 } }],
    ['bitmap', Buffer.from('bmp'), { width: 2, height: 3, scaleFactor: 1 }]
  ])
  assert.ok(adapters.screenCaptureFallback instanceof WindowsScreenCaptureFallback)
  assert.ok(adapters.fileClipboard instanceof WindowsFileClipboardAdapter)
})

test('macOS factory reuses Electron screen capture and explicitly rejects missing adapters', async () => {
  const calls: unknown[] = []
  const permissionCalls: unknown[] = []
  const image = { toPNG: () => Buffer.from('mac-png') }
  const display = {
    id: 7,
    label: 'Built-in Display',
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 876 },
    scaleFactor: 2,
    rotation: 0,
    touchSupport: 'unknown'
  }
  const platformAdapters = createPlatformScreenClipboardAdapters('darwin', {
    windows: () => { throw new Error('Windows adapter must not be selected') },
    macos: () => createMacosScreenClipboardAdapters({
      screen: {
        getCursorScreenPoint: () => ({ x: 20, y: 30 }),
        getPrimaryDisplay: () => display,
        getAllDisplays: () => [display],
        getDisplayNearestPoint: () => display,
        getDisplayMatching: () => display
      },
      desktopCapturer: {
        getSources: async (options: {
          types: Array<'screen'>
          thumbnailSize: { width: number; height: number }
        }) => {
          calls.push(options)
          return [{ display_id: '7', thumbnail: image }]
        }
      },
      nativeImage: {
        createFromBitmap: () => image
      },
      systemPreferences: {
        getMediaAccessStatus: (mediaType: 'screen') => {
          permissionCalls.push(mediaType)
          return 'granted'
        }
      }
    } as unknown as Parameters<typeof createMacosScreenClipboardAdapters>[0])
  })

  assert.equal(platformAdapters.screen.getScreenCapturePermissionStatus?.(), 'granted')
  assert.deepEqual(permissionCalls, ['screen'])
  assert.equal(platformAdapters.screen.getPrimaryDisplay(), display)
  assert.deepEqual(platformAdapters.screen.getAllDisplays(), [display])
  assert.deepEqual(await platformAdapters.screen.getSources({ width: 720, height: 450 }), [
    { displayId: '7', image }
  ])
  assert.deepEqual(calls, [{
    types: ['screen'],
    thumbnailSize: { width: 720, height: 450 }
  }])

  const isNotSupported = (error: unknown): boolean =>
    error instanceof ZToolsError && error.code === errorCodes.notSupported
  await assert.rejects(platformAdapters.fileClipboard.readFiles(), isNotSupported)
  await assert.rejects(platformAdapters.fileClipboard.writeFiles(['/tmp/example']), isNotSupported)
  await assert.rejects(
    platformAdapters.screenCaptureFallback.capture(
      { x: 0, y: 0, width: 10, height: 10 },
      new AbortController().signal
    ),
    isNotSupported
  )
  assert.equal(platformAdapters.fileClipboard instanceof WindowsFileClipboardAdapter, false)
  assert.equal(platformAdapters.screenCaptureFallback instanceof WindowsScreenCaptureFallback, false)
})

test('macOS screen permission adapter fails closed when Electron status API is unavailable or throws', () => {
  const baseElectron = {
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getPrimaryDisplay: () => ({ id: 1 }),
      getAllDisplays: () => [],
      getDisplayNearestPoint: () => ({ id: 1 }),
      getDisplayMatching: () => ({ id: 1 })
    },
    desktopCapturer: { getSources: async () => [] },
    nativeImage: { createFromBitmap: () => ({}) }
  }
  const unavailable = createMacosScreenClipboardAdapters(
    baseElectron as unknown as Parameters<typeof createMacosScreenClipboardAdapters>[0]
  )
  assert.equal(unavailable.screen.getScreenCapturePermissionStatus?.(), 'unavailable')

  const failed = createMacosScreenClipboardAdapters({
    ...baseElectron,
    systemPreferences: { getMediaAccessStatus: () => { throw new Error('status unavailable') } }
  } as unknown as Parameters<typeof createMacosScreenClipboardAdapters>[0])
  assert.equal(failed.screen.getScreenCapturePermissionStatus?.(), 'unknown')

  for (const status of ['not-determined', 'granted', 'denied', 'restricted', 'unknown'] as const) {
    const mapped = createMacosScreenClipboardAdapters({
      ...baseElectron,
      systemPreferences: { getMediaAccessStatus: () => status }
    } as unknown as Parameters<typeof createMacosScreenClipboardAdapters>[0])
    assert.equal(mapped.screen.getScreenCapturePermissionStatus?.(), status)
  }

  const unrecognized = createMacosScreenClipboardAdapters({
    ...baseElectron,
    systemPreferences: { getMediaAccessStatus: () => 'future-status' }
  } as unknown as Parameters<typeof createMacosScreenClipboardAdapters>[0])
  assert.equal(unrecognized.screen.getScreenCapturePermissionStatus?.(), 'unknown')
})
