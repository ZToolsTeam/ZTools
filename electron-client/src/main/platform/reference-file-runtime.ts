import { ReferenceRegionCaptureService } from '../services/reference-region-capture-service.js'
import type { RegionSelectionBackend } from './macos/region-selection.js'
import { ReferenceOcrService } from '../services/reference-ocr-service.js'
import { createReferenceOcrHandlers } from '../ipc/reference-ocr-handlers.js'
import type { VisionBackend } from './macos/vision-runner.js'
import { ReferenceGifService } from '../services/reference-gif-service.js'
import { ReferenceBrowserSnapshotService } from '../services/reference-browser-snapshot-service.js'
import { createReferenceBrowserSnapshotHandlers } from '../ipc/reference-browser-snapshot-handlers.js'
import { createReferenceClipboardHandlers } from '../ipc/reference-clipboard-handlers.js'
import { createReferenceScreenHandlers } from '../ipc/reference-screen-handlers.js'
import { ReferenceZipExtractionService } from '../services/reference-zip-extraction-service.js'
import { ReferenceZipCompressionService } from '../services/reference-zip-compression-service.js'
import { ReferenceZipService } from '../services/reference-zip-service.js'
import { createReferenceZipHandlers } from '../ipc/reference-zip-handlers.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { runCleanupActions, type ApplicationCleanupAction } from '../application-lifecycle.js'
import { createPathAccessRuntime } from './path-access-runtime.js'
import { ReferenceCacheRoots } from './reference-cache-roots.js'
import { ReferenceCacheService } from '../services/reference-cache-service.js'
import { ReferenceDirectoryLocations } from '../services/reference-directory-locations.js'
import { ReferenceRequestTracker } from '../services/reference-request-tracker.js'
import { ReferenceClipboardFilesService } from '../services/reference-clipboard-files-service.js'
import { PathReferenceDialogs, type ReferenceDialogProvider } from '../services/path-reference-dialogs.js'
import { ReferenceFileDropService } from '../services/reference-file-drop-service.js'
import { ClipboardService, type ClipboardAdapter, type ClipboardImageFactory, type FileClipboardAdapter } from '../services/clipboard-service.js'
import { ScreenService, type ScreenAdapter, type ScreenCaptureFallback } from '../services/screen-service.js'
import { NetworkService, type NetworkServiceOptions } from '../services/network-service.js'
import type { FileSystemService } from '../services/file-system-service.js'
import type { EventService } from '../services/event-service.js'
import type { RuntimeCapabilityAuthorizationService } from '../services/runtime-capability-authorization-service.js'
import type { RuntimeDiagnosticFailureStore } from '../services/runtime-diagnostics.js'
import { ReferenceIpcEndpoint } from '../ipc/reference-endpoint.js'
import { createReferenceFileHandlers } from '../ipc/reference-file-handlers.js'
import { createReferenceProducerHandlers } from '../ipc/reference-producer-handlers.js'
import { ReferenceFileResources } from '../protocol/reference-file-resources.js'
import { ReferencePdfService, type ReferencePdfRenderer } from '../services/reference-pdf-service.js'
import { ReferenceImageService, type ReferenceImageFactory } from '../services/reference-image-service.js'
import { createReferenceImageHandlers } from '../ipc/reference-image-handlers.js'
import { createReferenceRecoveryHandlers } from '../ipc/reference-recovery-handlers.js'
import { createReferenceNetworkHandlers } from '../ipc/reference-network-handlers.js'

/** Main composition point. Bootstrap registration/SDK2 activation waits for all remaining consumers. */
export async function createReferenceFileRuntime(options: {
  pathAccess: Omit<Parameters<typeof createPathAccessRuntime>[0], 'owners' | 'signal'>
  signal?: AbortSignal
  registry: WindowRegistry
  authorize(method: ReferenceMethod, caller: CallerIdentity): boolean
  events: EventService
  legacyFiles: FileSystemService
  dialogProvider: ReferenceDialogProvider
  clipboard: ClipboardAdapter
  images: ClipboardImageFactory
  imageProcessor?: ReferenceImageFactory
  pdfRenderer?: ReferencePdfRenderer
  localOcr?: VisionBackend
  regionSelection?: RegionSelectionBackend
  fileClipboard: FileClipboardAdapter
  screen: ScreenAdapter
  capabilityAuthorization?: Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>
  diagnostics?: Pick<RuntimeDiagnosticFailureStore, 'record'>
  screenFallback?: ScreenCaptureFallback
  network?: Omit<NetworkServiceOptions, 'fileService' | 'pathGrants'>
}, dependencies: { createPathRuntime?: typeof createPathAccessRuntime } = {}) {
  const owners = {
    isActive: (owner: number) => !!options.registry.get(owner) && !!options.registry.getWebContents(owner),
    get: (owner: number) => options.registry.get(owner),
    onRemoved: (listener: (owner: number) => void) => options.registry.onRemoved(listener)
  }
  const signal = options.signal ?? new AbortController().signal
  const scope = createCleanupScope()
  let pathRuntime: Awaited<ReturnType<typeof createPathAccessRuntime>> | undefined
  let roots: ReferenceCacheRoots | undefined, locations: ReferenceDirectoryLocations | undefined,
    requests: ReferenceRequestTracker | undefined, clipboard: ClipboardService | undefined,
    regionCapture: ReferenceRegionCaptureService | undefined, ocr: ReferenceOcrService | undefined,
    sqlite: ReferenceBrowserSnapshotService | undefined, zip: ReferenceZipService | undefined,
    zipExtraction: ReferenceZipExtractionService | undefined, zipCompression: ReferenceZipCompressionService | undefined,
    imageProcessor: ReferenceImageService | undefined, gifProcessor: ReferenceGifService | undefined,
    pdfProcessor: ReferencePdfService | undefined, resources: ReferenceFileResources | undefined,
    drops: ReferenceFileDropService | undefined
  try {
    ensureActive(signal)
    pathRuntime = await (dependencies.createPathRuntime ?? createPathAccessRuntime)({ ...options.pathAccess, signal, owners })
    scope.own(() => pathRuntime?.stop())
    if (options.regionSelection) scope.own(() => regionCapture ? undefined : options.regionSelection?.stop())
    if (options.pdfRenderer) scope.own(() => pdfProcessor ? undefined : options.pdfRenderer?.stop())
    ensureActive(signal)
    const activePathRuntime = pathRuntime
    roots = new ReferenceCacheRoots(options.pathAccess.dataRoot, options.pathAccess.platform, activePathRuntime.grants, owners)
    scope.own(() => roots?.stop())
    const privateRoots = roots
    const cache = new ReferenceCacheService(activePathRuntime.grants, (caller, requestSignal) => privateRoots.rootForCaller(caller, requestSignal))
    locations = new ReferenceDirectoryLocations(activePathRuntime.grants, owners)
    scope.own(() => locations?.stop())
    requests = new ReferenceRequestTracker(owners)
    scope.own(() => requests?.stop())
    const filesClipboard = new ReferenceClipboardFilesService(options.fileClipboard, activePathRuntime.grants)
    const dialogs = new PathReferenceDialogs(options.dialogProvider, activePathRuntime.grants)
    clipboard = new ClipboardService(options.legacyFiles, options.events, options.clipboard, options.images,
      options.fileClipboard, 750, filesClipboard, { cache, grants: activePathRuntime.grants },
      caller => options.registry.getSdkApiLane(caller) === 2)
    scope.own(() => clipboard?.stop())
    const screen = new ScreenService(options.legacyFiles, options.screen, options.screenFallback, cache, options.capabilityAuthorization)
    regionCapture = options.regionSelection ? new ReferenceRegionCaptureService(screen, options.regionSelection) : undefined
    if (regionCapture) scope.own(() => regionCapture?.stop())
    const network = new NetworkService(options.registry, { ...options.network, pathGrants: activePathRuntime.grants })
    ocr = options.localOcr ? new ReferenceOcrService(activePathRuntime.grants, options.localOcr) : undefined
    if (ocr) scope.own(() => ocr?.stop())
    sqlite = new ReferenceBrowserSnapshotService(activePathRuntime.grants)
    scope.own(() => sqlite?.stop())
    zipCompression = new ReferenceZipCompressionService(activePathRuntime.grants)
    scope.own(() => zipCompression?.stop())
    zip = new ReferenceZipService(activePathRuntime.grants)
    scope.own(() => zip?.stop())
    zipExtraction = new ReferenceZipExtractionService(zip, activePathRuntime.grants)
    scope.own(() => zipExtraction?.stop())
    pdfProcessor = options.imageProcessor && options.pdfRenderer ? new ReferencePdfService(activePathRuntime.grants, options.imageProcessor, options.pdfRenderer) : undefined
    if (pdfProcessor) scope.own(() => pdfProcessor?.stop())
    imageProcessor = options.imageProcessor ? new ReferenceImageService(activePathRuntime.grants, options.imageProcessor, cache) : undefined
    if (imageProcessor) scope.own(() => imageProcessor?.stop())
    gifProcessor = options.imageProcessor ? new ReferenceGifService(activePathRuntime.grants, options.imageProcessor, {}, cache) : undefined
    if (gifProcessor) scope.own(() => gifProcessor?.stop())
    const handlers = { ...createReferenceFileHandlers(activePathRuntime.fileSystem, cache, locations),
      ...createReferenceProducerHandlers({ dialogs, clipboardFiles: filesClipboard, clipboard, screen, ...(regionCapture ? { region: regionCapture } : {}), grants: activePathRuntime.grants }),
      ...(ocr ? createReferenceOcrHandlers(ocr) : {}), ...createReferenceBrowserSnapshotHandlers(sqlite), ...createReferenceClipboardHandlers(clipboard), ...createReferenceScreenHandlers(screen), ...createReferenceZipHandlers(zip, zipCompression, zipExtraction), ...createReferenceNetworkHandlers(network), ...createReferenceRecoveryHandlers(activePathRuntime.recovery), ...(imageProcessor ? createReferenceImageHandlers(imageProcessor, pdfProcessor, gifProcessor) : {}) }
    resources = new ReferenceFileResources(options.registry, activePathRuntime.grants)
    scope.own(() => resources?.stop())
    drops = new ReferenceFileDropService(options.registry, activePathRuntime.grants)
    scope.own(() => drops?.stop())
    const endpoint = new ReferenceIpcEndpoint(options.registry, requests, handlers, options.authorize, drops, options.diagnostics)
    ensureActive(signal)
    const ownedClipboard = clipboard, ownedRequests = requests, ownedLocations = locations
    let runtimePhase: 'ready' | 'ingress-closed' | 'draining' | 'cleaning' | 'stopped' | 'failed' = 'ready'
    const ingressCloseErrors: unknown[] = []
    let clipboardStopped = false
    let draining: Promise<void> | undefined, stopping: Promise<void> | undefined
    const closeIngress = () => {
      if (runtimePhase !== 'ready') return
      runtimePhase = 'ingress-closed'
      for (const close of [
        () => endpoint.closeIngress(),
        () => resources!.closeIngress(),
        () => {
          ownedClipboard.stop()
          clipboardStopped = true
        }
      ]) {
        try { close() } catch (error) { ingressCloseErrors.push(error) }
      }
    }
    const drain = () => {
      closeIngress()
      if (!draining) {
        runtimePhase = 'draining'
        draining = Promise.resolve().then(() => endpoint.drain()).catch(() => { throw failed() })
      }
      return draining
    }
    const runtime = {
      endpoint, drops, resources, recovery: activePathRuntime.recovery, grants: activePathRuntime.grants,
      fileSystem: activePathRuntime.fileSystem, cache, dialogs, clipboard, screen, network, imageProcessor, pdfProcessor, gifProcessor, ocr, regionCapture, sqlite, zip, zipCompression, zipExtraction,
      closeIngress,
      drain,
      stop(): Promise<void> {
        if (!stopping) {
          closeIngress()
          stopping = (async () => {
            const ingress = await settleCleanup([drain])
            runtimePhase = 'cleaning'
            const producers = await settleCleanup([
            () => resources!.stop(), () => zipExtraction!.stop(), () => zip!.stop(),
              () => zipCompression!.stop(), () => { if (!clipboardStopped) ownedClipboard.stop() },
              () => imageProcessor?.stop(), () => pdfProcessor?.stop(),
              () => ownedRequests.stop(), () => drops!.stop(), () => sqlite!.stop(),
              () => gifProcessor?.stop(), () => ocr?.stop(), () => regionCapture?.stop()
            ])
            const locationsCleanup = await settleCleanup([() => ownedLocations.stop()])
            const cacheCleanup = await settleCleanup([() => privateRoots.stop()])
            const nativeCleanup = await settleCleanup([() => activePathRuntime.stop()])
            if (ingressCloseErrors.length > 0 || [...ingress, ...producers, ...locationsCleanup, ...cacheCleanup, ...nativeCleanup].some(result => result.status === 'rejected')) {
              runtimePhase = 'failed'
              throw failed()
            }
            runtimePhase = 'stopped'
          })()
        }
        return stopping
      }
    }
    scope.commit()
    return runtime
  } catch {
    try { await scope.dispose() } catch { /* Keep native and provider details out of renderer-facing errors. */ }
    throw failed()
  }
}
function createCleanupScope() {
  const actions: ApplicationCleanupAction[] = []
  let cleanup: Promise<void> | undefined
  return {
    own(action: ApplicationCleanupAction): void { actions.push(action) },
    commit(): void { actions.length = 0 },
    dispose(): Promise<void> {
      if (!cleanup) cleanup = runCleanupActions([...actions].reverse())
      return cleanup
    }
  }
}
function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ZToolsError(errorCodes.appStopping, '文件引用运行时正在取消初始化')
}
// Invoke through promises so a synchronous failure cannot skip later owned cleanup.
function settleCleanup(actions: Array<() => void | Promise<void>>): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(actions.map(action => Promise.resolve().then(action)))
}
function failed(): ZToolsError { return new ZToolsError(errorCodes.fileError, '文件引用运行时初始化或退出未确认') }
