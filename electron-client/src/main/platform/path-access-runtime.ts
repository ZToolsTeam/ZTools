import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { runCleanupActions, type ApplicationCleanupAction } from '../application-lifecycle.js'
import { PathGrantService, type PathGrantOwnerLifecycle } from '../services/path-grant-service.js'
import { AnchoredFileSystemService } from '../services/anchored-file-system-service.js'
import { PathWriteRecoveryService, type RecoveryAdapter } from '../services/path-write-recovery-service.js'
import { NativePathAccessAdapter } from './native-path-access.js'
import { OwnedPathAccessProvider } from './owned-path-access.js'
import type { PathAccessAdapter } from './path-access.js'
import { PathWriteJournal, type JournalSealer } from './path-write-journal.js'
import { AnchoredJournalStore } from './path-write-journal-store.js'

export interface PathAccessRuntime {
  grants: PathGrantService
  fileSystem: AnchoredFileSystemService
  recovery: PathWriteRecoveryService
  stop(): Promise<void>
}
type RuntimeAdapter = PathAccessAdapter & RecoveryAdapter
const failed = () => new ZToolsError(errorCodes.fileError, '原生文件运行时初始化或退出未确认')
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
function ensureActive(signal: AbortSignal): void { if (signal.aborted) throw failed() }
function settleCleanup(actions: readonly ApplicationCleanupAction[]): Promise<PromiseSettledResult<void>[]> {
  return Promise.allSettled(actions.map(action => {
    try { return Promise.resolve(action()) }
    catch (error) { return Promise.reject(error) }
  }))
}

/** Main-only composition. Bootstrap activation accompanies the entire SDK/consumer migration. */
export async function createPathAccessRuntime(options: {
  executable: string
  dataRoot: string
  platform: 'win32' | 'darwin'
  sealer: JournalSealer
  signal?: AbortSignal
  owners?: PathGrantOwnerLifecycle
}, dependencies: { createAdapter?: (journal?: PathWriteJournal) => RuntimeAdapter } = {}): Promise<PathAccessRuntime> {
  const paths = options.platform === 'win32' ? path.win32 : path.posix
  if (!['win32', 'darwin'].includes(options.platform) || !paths.isAbsolute(options.dataRoot) ||
      !paths.isAbsolute(options.executable) || options.dataRoot.includes('\0') || options.executable.includes('\0') ||
      Buffer.byteLength(options.dataRoot) > 4096 || (!dependencies.createAdapter && options.platform !== process.platform)) throw failed()
  const signal = options.signal ?? new AbortController().signal
  const create = dependencies.createAdapter ?? ((journal?: PathWriteJournal) => new NativePathAccessAdapter(options.executable, 5000, journal ? { writeJournal: journal } : {}))
  const scope = createCleanupScope()
  let storeAdapter: RuntimeAdapter | undefined, recoveryAdapter: RuntimeAdapter | undefined
  let provider: OwnedPathAccessProvider | undefined, grants: PathGrantService | undefined
  let journal: PathWriteJournal | undefined, recovery: PathWriteRecoveryService | undefined
  let stopping: Promise<void> | undefined
  try {
    ensureActive(signal)
    storeAdapter = create()
    scope.own(() => storeAdapter?.stop())
    ensureActive(signal)
    if (storeAdapter.platform !== options.platform) throw failed()
    const dataRoot = await storeAdapter.pin(options.dataRoot, 'directory', ['read', 'write', 'list'], signal)
    let journalRoot
    try {
      ensureActive(signal)
      await storeAdapter.createDirectory(dataRoot, ['FileWriteJournal'], signal)
      ensureActive(signal)
      journalRoot = await storeAdapter.deriveDirectory(dataRoot, ['FileWriteJournal'], signal)
      ensureActive(signal)
    } finally { await storeAdapter.release(dataRoot) }
    ensureActive(signal)
    journal = new PathWriteJournal(new AnchoredJournalStore(storeAdapter, journalRoot), options.sealer)
    scope.own(() => journal?.close())
    // Reject corrupt/unknown journals before a writer can start or overwrite prior evidence.
    await journal.pending()
    ensureActive(signal)
    recoveryAdapter = create()
    scope.own(() => recovery ? recovery.stop() : recoveryAdapter?.stop())
    ensureActive(signal)
    if (recoveryAdapter.platform !== options.platform) throw failed()
    provider = new OwnedPathAccessProvider(options.platform, () => create(journal))
    scope.own(() => grants ? grants.stop() : provider?.stop())
    ensureActive(signal)
    grants = new PathGrantService(provider, Date.now, 5000, options.owners)
    recovery = new PathWriteRecoveryService(journal, recoveryAdapter)
    ensureActive(signal)
    const fileSystem = new AnchoredFileSystemService(grants)
    ensureActive(signal)
    const runtime: PathAccessRuntime = {
      grants, fileSystem, recovery,
      stop() {
        if (!stopping) stopping = (async () => {
          // Invoke both service stops synchronously before awaiting either drain so both ingress paths close together.
          const services = await settleCleanup([() => grants!.stop(), () => recovery!.stop()])
          // If listener removal failed before grants.stop reached its provider, still make a best-effort release attempt.
          let providerFallbackFailed = false
          if (services[0]?.status === 'rejected') {
            try { await runCleanupActions([() => provider?.stop()]) }
            catch { providerFallbackFailed = true }
          }
          let remainingCleanupFailed = false
          try { await runCleanupActions([() => journal?.close(), () => storeAdapter?.stop()]) }
          catch { remainingCleanupFailed = true }
          if (services.some(result => result.status === 'rejected') || providerFallbackFailed || remainingCleanupFailed) throw failed()
        })()
        return stopping
      }
    }
    scope.commit()
    return runtime
  } catch {
    try { await scope.dispose() } catch { /* Keep the native initialization error sanitized. */ }
    throw failed()
  }
}
