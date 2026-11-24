import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { validateFolderSyncRequest, type FolderSyncRequest, type SyncDiff } from '../../contracts/folder-sync.js'
import type { PathAccessAdapter } from '../platform/path-access.js'
import { isProtectedSystemPath } from './host-plugins/shared-utils.js'
import { assertSameTree, buildSyncDiffs, changed, ensureParents, fingerprint, moveWithoutReplace, readFingerprint, sameFile, scanTree, segmentsOf, SYNC_BACKUPS, verifiedCopy, type SyncRoot, type SyncTree } from './folder-sync-files.js'

interface Authorization { resolveAuthorizedPath(value: string, caller: CallerIdentity, access: 'read' | 'write', allowMissing: boolean): Promise<string> }
interface Plan {
  id: string; caller: CallerIdentity; adapter: PathAccessAdapter; roots: [SyncRoot, SyncRoot]; trees: [SyncTree, SyncTree]
  request: Extract<FolderSyncRequest, { action: 'compare' }>; diffs: SyncDiff[]; timer: ReturnType<typeof setTimeout>
}
const ownerKey = (caller: CallerIdentity) => `${caller.webContentsId}:${caller.pluginId ?? ''}`
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** 一个窗口只能有一份待执行清单；执行只能消费该窗口已经看过的清单。 */
export class FolderSyncService {
  #plans = new Map<string, Plan>()
  #jobs = new Map<string, { id: string; controller: AbortController; adapter?: PathAccessAdapter }>()
  #stopped = false
  constructor(private readonly authorization: Authorization, private readonly makeAdapter: () => PathAccessAdapter,
    private readonly protectedRoots: readonly string[] = []) {}

  async stop() {
    this.#stopped = true
    const adapters = new Set<PathAccessAdapter>()
    for (const job of this.#jobs.values()) { job.controller.abort(); if (job.adapter) adapters.add(job.adapter) }
    for (const plan of this.#plans.values()) { clearTimeout(plan.timer); adapters.add(plan.adapter) }
    this.#plans.clear()
    await Promise.all([...adapters].map(adapter => adapter.stop()))
  }
  async closeOwner(webContentsId: number) {
    for (const [key, job] of this.#jobs) if (key.startsWith(`${webContentsId}:`)) job.controller.abort()
    for (const [key, plan] of this.#plans) if (plan.caller.webContentsId === webContentsId) await this.#discard(key)
  }
  cancel(id: string, caller: CallerIdentity) {
    const job = this.#jobs.get(ownerKey(caller)), matches = job?.id === id
    if (matches) job.controller.abort()
    return { success: true, cancelRequested: matches }
  }
  async #discard(key: string) {
    const plan = this.#plans.get(key)
    if (plan) { this.#plans.delete(key); clearTimeout(plan.timer); await plan.adapter.stop() }
  }
  #assertWritable(file: string) {
    const normalized = path.resolve(file).toLowerCase()
    if (isProtectedSystemPath(file) || this.protectedRoots.some(root => normalized === path.resolve(root).toLowerCase() || normalized.startsWith(path.resolve(root).toLowerCase() + path.sep))) throw new Error('Cannot sync to system critical directories or client data directories')
  }
  async #authorize(root: SyncRoot, relative: string, caller: CallerIdentity) {
    const file = path.join(root.path, relative)
    this.#assertWritable(file)
    const allowed = await this.authorization.resolveAuthorizedPath(file, caller, 'write', true)
    if (allowed !== file) throw changed()
  }
  async execute(value: unknown, caller: CallerIdentity, outerSignal: AbortSignal) {
    validateFolderSyncRequest(value)
    const key = ownerKey(caller)
    if (this.#stopped || this.#jobs.has(key) || this.#jobs.size >= 4) throw new Error('Folder sync is busy; wait for the current operation to finish')
    const job: { id: string; controller: AbortController; adapter?: PathAccessAdapter } = { id: value.operationId, controller: new AbortController() }
    this.#jobs.set(key, job)
    const signal = AbortSignal.any([outerSignal, job.controller.signal])
    try {
      signal.throwIfAborted()
      if (value.action === 'compare') {
        await this.#discard(key)
        if (this.#plans.size >= 4) throw new Error('Too many pending folder sync plans; close another sync window and retry')
        const adapter = this.makeAdapter(); job.adapter = adapter
        try {
          const plan = await this.#compare(value, caller, adapter, signal)
          this.#plans.set(key, plan)
          return { success: true, ok: true, planId: plan.id, diffs: plan.diffs }
        } catch (error) { await adapter.stop(); throw error }
      }
      const plan = this.#plans.get(key)
      if (!plan || plan.id !== value.planId) throw new Error('Sync plan has expired; compare again')
      const selected = value.selectedRelPaths.map(name => plan.diffs.find(diff => diff.relPath === name))
      if (selected.some(diff => !diff || diff.direction === 'conflict')) throw new Error('Plan contains invalid items or unresolved two-way conflicts')
      this.#plans.delete(key); clearTimeout(plan.timer); job.adapter = plan.adapter
      try { return await this.#apply(plan, selected as SyncDiff[], signal) }
      finally { await plan.adapter.stop() }
    } finally { this.#jobs.delete(key) }
  }
  async #compare(request: Extract<FolderSyncRequest, { action: 'compare' }>, caller: CallerIdentity, adapter: PathAccessAdapter, signal: AbortSignal): Promise<Plan> {
    if (request.syncMode === 'mirror' && (adapter.platform !== 'darwin' || !adapter.trash)) throw new Error('Safe mirror trash is not supported on this platform; use incremental or two-way sync')
    const paths: string[] = []
    for (const input of [request.sourceDir, request.targetDir]) paths.push(await this.authorization.resolveAuthorizedPath(input, caller, 'read', false))
    const [left, right] = paths.map(file => path.resolve(file).normalize('NFC').toLowerCase()) as [string, string]
    if (left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)) throw new Error('Source and target directories cannot be the same or nested inside each other')
    this.#assertWritable(paths[1]!)
    if (request.syncMode === 'two-way') this.#assertWritable(paths[0]!)
    const roots = [] as SyncRoot[]
    for (let i = 0; i < 2; i++) {
      const write = i === 1 || request.syncMode === 'two-way'
      if (write) await this.authorization.resolveAuthorizedPath(paths[i]!, caller, 'write', false)
      roots.push({ path: paths[i]!, object: await adapter.pin(paths[i]!, 'directory', write ? ['read', 'list', 'write'] : ['read', 'list'], signal) })
    }
    const pair = roots as [SyncRoot, SyncRoot]
    const trees: [SyncTree, SyncTree] = [await scanTree(adapter, pair[0], request.ignoreDevJunk, signal), await scanTree(adapter, pair[1], request.ignoreDevJunk, signal)]
    const diffs = buildSyncDiffs(trees[0], trees[1], request.syncMode, pair)
    signal.throwIfAborted()
    const id = randomUUID(), key = ownerKey(caller)
    const timer = setTimeout(() => { if (this.#plans.get(key)?.id === id) void this.#discard(key).catch(error => console.error('Failed to release folder sync plan', error)) }, 5 * 60_000)
    timer.unref()
    return { id, caller, adapter, roots: pair, trees, request, diffs, timer }
  }
  async #prepareRecovery(plan: Plan, index: number, items: SyncDiff[], signal: AbortSignal) {
    const root = plan.roots[index]!, base = `${SYNC_BACKUPS}/${plan.id}`
    await this.#authorize(root, base, plan.caller)
    await plan.adapter.createDirectory(root.object, [SYNC_BACKUPS], signal)
    if ((await plan.adapter.createDirectory(root.object, segmentsOf(base), signal)).status !== 'created') throw new Error('Backup directory already exists; compare again')
    const text = ['ZTools Folder Sync Recovery Record', `Original directory: ${root.path}`, 'backup/ stores original file copies from comparison; original/ preserves files moved out during execution; incoming/ holds staged copies not yet committed.',
      'To recover, stop syncing first and copy the needed files back to the same relative paths inside the original directory. Clean up this directory manually after verifying; backups are never deleted automatically.', '',
      ...items.filter(item => (item.direction === 'dst-to-src' ? 0 : 1) === index).map(item => `${item.actionBadge}\t${item.relPath}`)].join('\n')
    const save = await plan.adapter.deriveSave(root.object, [SYNC_BACKUPS, plan.id, 'RECOVERY_README.txt'], signal)
    try { await plan.adapter.save(save, Buffer.from(text), false, signal) } finally { await plan.adapter.release(save) }
    return base
  }
  async #apply(plan: Plan, items: SyncDiff[], signal: AbortSignal) {
    const { adapter, roots, trees } = plan
    const recoveryPaths: string[] = [], failures: { relPath: string; error: string }[] = []
    let syncedCount = 0, deletedCount = 0, transferredBytes = 0, current = 'pre-execution-verification'
    try {
      for (let i = 0; i < 2; i++) assertSameTree(trees[i]!, await scanTree(adapter, roots[i]!, plan.request.ignoreDevJunk, signal))
      for (const item of items) await this.#authorize(roots[item.direction === 'dst-to-src' ? 0 : 1], item.relPath, plan.caller)
      const recovery = new Map<number, string>()
      for (const index of new Set(items.map(item => item.direction === 'dst-to-src' ? 0 : 1))) {
        const base = `${SYNC_BACKUPS}/${plan.id}`
        recoveryPaths.push(path.join(roots[index]!.path, base))
        recovery.set(index, await this.#prepareRecovery(plan, index, items, signal))
      }
      for (const item of items) {
        current = item.relPath; signal.throwIfAborted()
        const destinationIndex = item.direction === 'dst-to-src' ? 0 : 1, sourceIndex = 1 - destinationIndex
        const destination = roots[destinationIndex], source = roots[sourceIndex]!, base = recovery.get(destinationIndex)!
        const original = trees[destinationIndex].files.get(item.relPath), incoming = trees[sourceIndex]!.files.get(item.relPath)
        await this.#authorize(destination, item.relPath, plan.caller)
        if (original) await verifiedCopy(adapter, destination, item.relPath, destination, `${base}/backup/${item.relPath}`, original, signal)
        if (incoming && item.direction !== 'delete-dst') await verifiedCopy(adapter, source, item.relPath, destination, `${base}/incoming/${item.relPath}`, incoming, signal)
        // 镜像执行前再次确认源端没有该路径，不能把扫描后的新增误当成缺失。
        if (item.direction === 'delete-dst') await this.#assertAbsent(adapter, source, item.relPath, signal)
        let moved = false
        try {
          if (original) {
            if (!sameFile(original, await readFingerprint(adapter, destination, item.relPath, signal))) throw changed()
            await moveWithoutReplace(adapter, destination, item.relPath, `${base}/original/${item.relPath}`, signal); moved = true
            if (!sameFile(original, await readFingerprint(adapter, destination, `${base}/original/${item.relPath}`, signal))) throw changed()
          }
          if (item.direction === 'delete-dst') {
            const trashObject = await adapter.deriveRead(destination.object, segmentsOf(`${base}/original/${item.relPath}`), signal)
            try {
              if (!adapter.trash) throw new Error('Safe trash helper is unavailable')
              if (!original || !sameFile(original, await fingerprint(adapter, trashObject, signal))) throw changed()
              await adapter.trash(trashObject, signal)
            } finally { await adapter.release(trashObject) }
            deletedCount++
          } else {
            const staged = await readFingerprint(adapter, destination, `${base}/incoming/${item.relPath}`, signal)
            if (!incoming || staged.hash !== incoming.hash || staged.size !== incoming.size) throw changed()
            await ensureParents(adapter, destination, segmentsOf(item.relPath), signal)
            await moveWithoutReplace(adapter, destination, `${base}/incoming/${item.relPath}`, item.relPath, signal)
            const written = await readFingerprint(adapter, destination, item.relPath, signal)
            if (written.hash !== incoming.hash || written.size !== incoming.size) throw changed()
            syncedCount++; transferredBytes += item.sizeBytes
          }
        } catch (error) {
          if (moved) {
            try { await moveWithoutReplace(adapter, destination, `${base}/original/${item.relPath}`, item.relPath, AbortSignal.timeout(10_000)) }
            catch {
              // 停止或超时会让原生文件组件整代失效，原组件上的恢复必然失败：换新组件重新固定目标目录后再恢复
              try { await this.#restoreWithFreshAdapter(plan, destination, `${base}/original/${item.relPath}`, item.relPath) }
              catch (restoreError) { throw new Error(`${message(error)}; in-place restore not confirmed: ${message(restoreError)}. Check backup directory: ${path.join(destination.path, base)}`) }
            }
          }
          throw error
        }
      }
    } catch (error) { failures.push({ relPath: current, error: message(error) }) }
    return { success: true, ok: failures.length === 0, syncedCount, deletedCount, transferredBytes, failures, recoveryPaths,
      remainingCount: items.length - syncedCount - deletedCount, error: failures[0]?.error }
  }
  async #restoreWithFreshAdapter(plan: Plan, destination: SyncRoot, from: string, to: string) {
    await this.#authorize(destination, to, plan.caller)
    const fresh = this.makeAdapter()
    try {
      const object = await fresh.pin(destination.path, 'directory', ['read', 'list', 'write'], AbortSignal.timeout(10_000))
      await moveWithoutReplace(fresh, { path: destination.path, object }, from, to, AbortSignal.timeout(10_000))
    } finally { await fresh.stop() }
  }
  async #assertAbsent(adapter: PathAccessAdapter, root: SyncRoot, relative: string, signal: AbortSignal) {
    const parts = segmentsOf(relative)
    for (let i = 0; i < parts.length; i++) {
      const found = (await adapter.list(root.object, parts.slice(0, i), signal, true)).find(entry => entry.name.normalize('NFC').toLowerCase() === parts[i]!.normalize('NFC').toLowerCase())
      if (!found) return
      if (!found.isDirectory || i === parts.length - 1) throw changed()
    }
    throw changed()
  }
}
