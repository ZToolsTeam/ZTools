import { BrowserWindow, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { canCallReferenceMethod } from '../../contracts/reference-capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { normalizeOpenDialogProperties, parseDialogFilters } from '../services/window-service.js'
import type { ClipboardAdapter, ClipboardImageFactory } from '../services/clipboard-service.js'
import type { EventService } from '../services/event-service.js'
import type { FileSystemService } from '../services/file-system-service.js'
import { createElectronReferenceDialogProvider } from './electron-reference-dialog.js'
import { ElectronReferencePdfRenderer } from './electron-reference-pdf-renderer.js'
import { electronJournalSealer } from './path-write-journal-storage.js'
import {
  resolvePathAccessBroker,
  type PathAccessBrokerResolution,
  type PathAccessBrokerUnavailableReason
} from './path-access-broker.js'
import { MacRegionSelection, type RegionSelectionBackend } from './macos/region-selection.js'
import type { ReferenceImageFactory } from '../services/reference-image-service.js'
import type { ReferencePdfRenderer as ReferencePdfRendererPort } from '../services/reference-pdf-service.js'
import type { ScreenClipboardAdapters } from './screen-clipboard.js'
import type { ReferenceFileResources } from '../protocol/reference-file-resources.js'
import type { ReferenceRuntimeAttachment, IpcRouter } from '../ipc/router.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { createReferenceFileRuntime } from './reference-file-runtime.js'

const JOURNAL_SEALER_PREFLIGHT_TIMEOUT_MS = 5000
const RUNTIME_INITIALIZATION_TIMEOUT_MS = 30_000
const OWNED_CLEANUP_TIMEOUT_MS = 5000
const PREFLIGHT_TIMEOUT = Symbol('journal-sealer-timeout')
const PREFLIGHT_CANCELLED = Symbol('journal-sealer-cancelled')

type Runtime = Awaited<ReturnType<typeof createReferenceFileRuntime>>
type RuntimeCreator = (options: Parameters<typeof createReferenceFileRuntime>[0]) => Promise<Runtime>
type ReferenceRuntimeHost = Pick<IpcRouter, 'attachReferenceRuntime' | 'fileService' | 'eventService'> &
  Pick<IpcRouter, 'recordRuntimeDiagnosticFailure'> &
  Partial<Pick<IpcRouter, 'screenCaptureAuthorization'>>

export interface ElectronReferenceRuntimeOptions {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  readonly appPath: string
  readonly resourcesPath: string
  readonly dataRoot: string
  readonly signal: AbortSignal
  readonly regionPreloadPath?: string
  readonly router: ReferenceRuntimeHost
  readonly registry: WindowRegistry
  readonly screenClipboard: ScreenClipboardAdapters
  readonly clipboard: ClipboardAdapter
  readonly images: ClipboardImageFactory & ReferenceImageFactory
}

export type ElectronReferenceRuntimeUnavailableReason =
  | 'startup-cancelled'
  | 'helper-resolution-failed'
  | PathAccessBrokerUnavailableReason
  | 'journal-sealer-unavailable'
  | 'journal-sealer-timeout'
  | 'runtime-initialization-failed'
  | 'runtime-attach-failed'
  | 'cleanup-unconfirmed'

export type ElectronReferenceRuntimeResult =
  | {
      readonly available: true
      readonly runtime: Runtime
      readonly resources: ReferenceFileResources
      readonly helperArch: 'x64' | 'universal'
      readonly unavailableOptionalProviders: readonly string[]
    }
  | { readonly available: false; readonly reason: ElectronReferenceRuntimeUnavailableReason }

export interface ElectronReferenceRuntimeDependencies {
  /** Main-only test seams. Production always uses the fixed resolver and Electron wrappers below. */
  readonly resolveBroker?: typeof resolvePathAccessBroker
  readonly isJournalEncryptionAvailable?: () => Promise<boolean>
  readonly createReferenceRuntime?: RuntimeCreator
  readonly createPdfRenderer?: () => ReferencePdfRendererPort
  readonly createRegionSelection?: (preloadPath: string) => RegionSelectionBackend
  readonly journalPreflightTimeoutMs?: number
  readonly runtimeInitializationTimeoutMs?: number
  readonly cleanupTimeoutMs?: number
}

/** Resolve trusted platform resources, construct the runtime, and transfer its single owner to Router. */
export async function createAndAttachElectronReferenceRuntime(
  options: ElectronReferenceRuntimeOptions,
  dependencies: ElectronReferenceRuntimeDependencies = {}
): Promise<ElectronReferenceRuntimeResult> {
  if (options.signal.aborted) return unavailable('startup-cancelled')

  let resolution: PathAccessBrokerResolution
  try {
    resolution = (dependencies.resolveBroker ?? resolvePathAccessBroker)({
      platform: options.platform,
      isPackaged: options.isPackaged,
      appPath: options.appPath,
      resourcesPath: options.resourcesPath
    })
  } catch {
    return unavailable('helper-resolution-failed')
  }
  if (!resolution.available) return unavailable(resolution.reason)
  if (options.signal.aborted) return unavailable('startup-cancelled')

  const runtimeAbort = new AbortController()
  const signal = AbortSignal.any([options.signal, runtimeAbort.signal])
  const encryption = await checkJournalEncryptionAvailability(
    signal,
    dependencies.isJournalEncryptionAvailable ?? (() => safeStorage.isAsyncEncryptionAvailable()),
    timeout(dependencies.journalPreflightTimeoutMs, JOURNAL_SEALER_PREFLIGHT_TIMEOUT_MS)
  )
  if (encryption !== 'available') return unavailable(encryption)
  if (options.signal.aborted) return unavailable('startup-cancelled')

  const unavailableOptionalProviders: string[] = []
  // This composition intentionally does not enable the separately gated local Vision provider.
  unavailableOptionalProviders.push('local-vision-ocr')
  let regionSelection: RegionSelectionBackend | undefined
  if (resolution.platform === 'darwin') {
    const preloadPath = options.regionPreloadPath
    if (!preloadPath || !isRegularFile(preloadPath)) {
      unavailableOptionalProviders.push('region-selection')
    } else {
      try {
        regionSelection = (dependencies.createRegionSelection ??
          (value => new MacRegionSelection(value, { platform: 'darwin' })))(preloadPath)
      } catch {
        unavailableOptionalProviders.push('region-selection')
      }
    }
  }
  try {
    if (options.screenClipboard.fileClipboard.isAvailable?.() === false) {
      unavailableOptionalProviders.push('clipboard-file-native')
    }
  } catch {
    unavailableOptionalProviders.push('clipboard-file-native')
  }

  let pdfRenderer: ReferencePdfRendererPort | undefined
  try {
    const activePdfRenderer = (dependencies.createPdfRenderer ?? (() => new ElectronReferencePdfRenderer()))()
    pdfRenderer = activePdfRenderer
    const dialogProvider = createElectronReferenceDialogProvider(
      caller => resolveReferenceDialogWindow(options.registry, caller),
      parseDialogFilters,
      normalizeOpenDialogProperties
    )
    if (signal.aborted) {
      const cleanupFailed = await stopUnownedProviders(
        pdfRenderer,
        regionSelection,
        timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
      )
      return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : 'startup-cancelled')
    }

    const initialization = Promise.resolve().then(() =>
      (dependencies.createReferenceRuntime ?? createReferenceFileRuntime)({
      pathAccess: {
        executable: resolution.executable,
        dataRoot: options.dataRoot,
        platform: resolution.platform,
        sealer: electronJournalSealer
      },
      signal,
      registry: options.registry,
      authorize: canCallReferenceMethod,
      diagnostics: {
        record: (owner, failure) => options.router.recordRuntimeDiagnosticFailure(owner, failure)
      },
      events: options.router.eventService as EventService,
      legacyFiles: options.router.fileService as FileSystemService,
      dialogProvider,
      clipboard: options.clipboard,
      images: options.images,
      imageProcessor: options.images,
      pdfRenderer: activePdfRenderer,
      fileClipboard: options.screenClipboard.fileClipboard,
      screen: options.screenClipboard.screen,
      screenFallback: options.screenClipboard.screenCaptureFallback,
      ...(options.router.screenCaptureAuthorization
        ? { capabilityAuthorization: options.router.screenCaptureAuthorization }
        : {}),
      ...(regionSelection ? { regionSelection } : {})
      })
    )
    const settlement = initialization.then<RuntimeSettlement, RuntimeSettlement>(
      runtime => ({ status: 'fulfilled', runtime }),
      () => ({ status: 'rejected' })
    )
    const startup = await waitForRuntimeInitialization(
      settlement,
      signal,
      timeout(dependencies.runtimeInitializationTimeoutMs, RUNTIME_INITIALIZATION_TIMEOUT_MS)
    )
    if (startup.status !== 'settled') {
      if (startup.status === 'timeout') runtimeAbort.abort()
      const cleanupFailed = await cleanupLateInitialization(
        settlement,
        pdfRenderer,
        regionSelection,
        timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
      )
      const reason = startup.status === 'timeout' ? 'runtime-initialization-failed' : 'startup-cancelled'
      return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : reason)
    }
    if (startup.settlement.status === 'rejected') {
      const cleanupFailed = await stopUnownedProviders(
        pdfRenderer,
        regionSelection,
        timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
      )
      return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : 'runtime-initialization-failed')
    }

    const runtime = startup.settlement.runtime
    if (signal.aborted) {
      const cleanupFailed = await cleanupRuntime(
        runtime,
        pdfRenderer,
        regionSelection,
        timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
      )
      return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : 'startup-cancelled')
    }

    try {
      options.router.attachReferenceRuntime(runtime as ReferenceRuntimeAttachment)
    } catch {
      const cleanupFailed = await cleanupRuntime(
        runtime,
        pdfRenderer,
        regionSelection,
        timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
      )
      return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : 'runtime-attach-failed')
    }

    return {
      available: true,
      runtime,
      resources: runtime.resources,
      helperArch: resolution.arch,
      unavailableOptionalProviders: Object.freeze(unavailableOptionalProviders)
    }
  } catch {
    const cleanupFailed = await stopUnownedProviders(
      pdfRenderer,
      regionSelection,
      timeout(dependencies.cleanupTimeoutMs, OWNED_CLEANUP_TIMEOUT_MS)
    )
    return unavailable(cleanupFailed ? 'cleanup-unconfirmed' : 'runtime-initialization-failed')
  }
}

function unavailable(reason: ElectronReferenceRuntimeUnavailableReason): ElectronReferenceRuntimeResult {
  return { available: false, reason }
}

function resolveReferenceDialogWindow(registry: WindowRegistry, caller: CallerIdentity): BrowserWindow {
  if (registry.getSdkApiLane(caller) !== 2) {
    throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面无效')
  }
  const contents = registry.getWebContents(caller.webContentsId)
  const window = contents ? BrowserWindow.fromWebContents(contents) : null
  if (!contents || contents.isDestroyed() || !window || window.isDestroyed()) {
    throw new ZToolsError(errorCodes.callerDestroyed, '调用者窗口已销毁')
  }
  return window
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath)
    return path.isAbsolute(filePath) && stats.isFile() && !stats.isSymbolicLink()
  } catch { return false }
}

type RuntimeSettlement = { readonly status: 'fulfilled'; readonly runtime: Runtime } | { readonly status: 'rejected' }
type StartupWait = { readonly status: 'settled'; readonly settlement: RuntimeSettlement } |
  { readonly status: 'cancelled' | 'timeout' }

function timeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 && value <= 120_000 ? value : fallback
}

function waitForRuntimeInitialization(
  settlement: Promise<RuntimeSettlement>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<StartupWait> {
  if (signal.aborted) return Promise.resolve({ status: 'cancelled' })
  return new Promise(resolve => {
    let settled = false
    const finish = (result: StartupWait): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish({ status: 'cancelled' })
    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    void settlement.then(value => finish({ status: 'settled', settlement: value }))
  })
}

async function cleanupLateInitialization(
  settlement: Promise<RuntimeSettlement>,
  pdfRenderer: ReferencePdfRendererPort | undefined,
  regionSelection: RegionSelectionBackend | undefined,
  cleanupTimeoutMs: number
): Promise<boolean> {
  const cleanup = settlement.then(async result => {
    if (result.status === 'fulfilled') {
      const runtimeStop = await stopRuntime(result.runtime, cleanupTimeoutMs)
      const providersFailed = runtimeStop === 'failed'
        ? await stopUnownedProviders(pdfRenderer, regionSelection, cleanupTimeoutMs)
        : false
      return runtimeStop !== 'complete' || providersFailed
    }
    return stopUnownedProviders(pdfRenderer, regionSelection, cleanupTimeoutMs)
  })
  return awaitCleanupFailureWithin(cleanup, cleanupTimeoutMs)
}

async function cleanupRuntime(
  runtime: Runtime,
  pdfRenderer: ReferencePdfRendererPort | undefined,
  regionSelection: RegionSelectionBackend | undefined,
  cleanupTimeoutMs: number
): Promise<boolean> {
  const runtimeStop = await stopRuntime(runtime, cleanupTimeoutMs)
  if (runtimeStop === 'complete') return false
  if (runtimeStop === 'timeout') return true
  await stopUnownedProviders(pdfRenderer, regionSelection, cleanupTimeoutMs)
  return true
}

async function stopRuntime(runtime: Runtime, cleanupTimeoutMs: number): Promise<'complete' | 'failed' | 'timeout'> {
  return awaitWithin(Promise.resolve().then(() => runtime.stop()), cleanupTimeoutMs)
}

async function stopUnownedProviders(
  pdfRenderer: ReferencePdfRendererPort | undefined,
  regionSelection: RegionSelectionBackend | undefined,
  cleanupTimeoutMs: number
): Promise<boolean> {
  const actions = [
    ...(pdfRenderer ? [() => pdfRenderer.stop()] : []),
    ...(regionSelection ? [() => regionSelection.stop()] : [])
  ]
  const results = await Promise.all(actions.map(action =>
    awaitWithin(Promise.resolve().then(action), cleanupTimeoutMs)))
  return results.some(result => result !== 'complete')
}

async function awaitCleanupFailureWithin(promise: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const settled = promise.then(failed => failed === true, () => true)
  let timer: NodeJS.Timeout | undefined
  const timeoutResult = new Promise<true>(resolve => { timer = setTimeout(() => resolve(true), timeoutMs) })
  try { return await Promise.race([settled, timeoutResult]) }
  finally { if (timer) clearTimeout(timer) }
}

async function awaitWithin(promise: Promise<unknown>, timeoutMs: number): Promise<'complete' | 'failed' | 'timeout'> {
  const settled = promise.then((): 'complete' => 'complete', (): 'failed' => 'failed')
  let timer: NodeJS.Timeout | undefined
  const timeoutResult = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  try { return await Promise.race([settled, timeoutResult]) }
  finally { if (timer) clearTimeout(timer) }
}

async function checkJournalEncryptionAvailability(
  signal: AbortSignal,
  isAvailable: () => Promise<boolean>,
  timeoutMs: number
): Promise<'available' | 'startup-cancelled' | 'journal-sealer-unavailable' | 'journal-sealer-timeout'> {
  if (signal.aborted) return 'startup-cancelled'
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const result = await Promise.race([
      Promise.resolve().then(isAvailable),
      new Promise<typeof PREFLIGHT_TIMEOUT>(resolve => {
        timer = setTimeout(() => resolve(PREFLIGHT_TIMEOUT), timeoutMs)
      }),
      new Promise<typeof PREFLIGHT_CANCELLED>(resolve => {
        onAbort = () => resolve(PREFLIGHT_CANCELLED)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    ])
    if (result === PREFLIGHT_TIMEOUT) return 'journal-sealer-timeout'
    if (result === PREFLIGHT_CANCELLED || signal.aborted) return 'startup-cancelled'
    return result === true ? 'available' : 'journal-sealer-unavailable'
  } catch {
    return signal.aborted ? 'startup-cancelled' : 'journal-sealer-unavailable'
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
