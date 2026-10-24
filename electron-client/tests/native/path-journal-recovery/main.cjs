const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const [mode, output, broker, compiled] = process.argv.slice(2)
if (!['write', 'recover'].includes(mode) || !output || !broker || !compiled ||
    ![output, broker, compiled].every(value => path.isAbsolute(value)) || process.platform !== 'win32' || process.arch !== 'x64') process.exit(2)

const runId = path.basename(output)
const isolatedAppData = path.join(output, 'isolated-appdata')
const userData = path.join(isolatedAppData, 'ZTools')
const dataRoot = path.join(userData, 'Data')
const journalRoot = path.join(dataRoot, 'FileWriteJournal')
const targetRoot = path.join(output, 'private-paths', `F04_PRIVATE_SELECTED_PATH_${runId}`)
const privateMarker = `F04_PRIVATE_SELECTED_PATH_${runId}`
for (const directory of [isolatedAppData, userData, dataRoot, journalRoot, targetRoot, path.join(output, 'logs')]) fs.mkdirSync(directory, { recursive: true })
app.setPath('appData', isolatedAppData)
app.setPath('userData', userData)
app.setPath('sessionData', userData)
app.setPath('logs', path.join(output, 'logs'))

const rawPaths = {
  noProof: path.join(targetRoot, 'no-proof.txt'),
  staging: path.join(targetRoot, 'staging.txt'),
  unresolvedRecord: path.join(targetRoot, 'unresolved-record.txt'),
  unresolvedActual: path.join(targetRoot, 'unresolved-actual.txt'),
  committed: path.join(targetRoot, 'committed.txt'),
  cancelled: path.join(targetRoot, 'cancelled.txt')
}
const sealedFile = path.join(journalRoot, 'file-write-journal.bin')
const stageBytes = Buffer.from('保留的合成暂存内容', 'utf8')
const unresolvedBytes = Buffer.from('证明路径错配', 'utf8')
const committedBytes = Buffer.from('已提交但记录移除未确认', 'utf8')
const cancellationBytes = Buffer.from('预取消不得写入', 'utf8')
const ownedAdapters = new Set()
let NativePathAccessAdapter
let journalToClose
let recoveryService
let phase = 'startup'

function makeAdapter(executable, writeJournal) {
  if (!NativePathAccessAdapter) throw new Error('NATIVE_ADAPTER_NOT_LOADED')
  const adapter = new NativePathAccessAdapter(executable, 5_000, writeJournal ? { writeJournal } : {})
  ownedAdapters.add(adapter)
  return adapter
}

function containsBytes(haystack, text) {
  return haystack.includes(Buffer.from(text, 'utf8')) || haystack.includes(Buffer.from(text, 'utf16le'))
}

function assertSealedPathsAbsent(bytes) {
  assert.ok(bytes.length > 36)
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'ZPJ1')
  assert.equal(rawPaths && Object.values(rawPaths).some(value => containsBytes(bytes, value)), false)
  assert.equal(containsBytes(bytes, privateMarker), false)
}

function snapshotScratchObjects() {
  return fs.readdirSync(targetRoot).filter(name => name.startsWith('.ztools-save-')).sort().map(name => {
    const bytes = fs.readFileSync(path.join(targetRoot, name))
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

function snapshotSelectedTargets() {
  return Object.entries(rawPaths).map(([key, selectedPath]) => {
    try {
      const bytes = fs.readFileSync(selectedPath)
      return { key, exists: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return { key, exists: false }
    }
  })
}

async function importModule(file) {
  return import(pathToFileURL(path.join(compiled, file)).href)
}

function summarizeFailure(error) {
  if (error?.name === 'AssertionError') return 'ASSERTION'
  const value = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code :
    typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message) ? error.message :
    typeof error?.name === 'string' && /^[A-Za-z]+$/.test(error.name) ? error.name.toUpperCase() :
    typeof error === 'string' && /^[A-Z0-9_]+$/.test(error) ? error : 'FIXTURE_FAILURE'
  return value
}

async function runWritePhase() {
  phase = 'write.import-modules';
  ({ NativePathAccessAdapter } = await importModule('src/main/platform/native-path-access.js'))
  const { createJournalSealer } = await importModule('src/main/platform/path-write-journal-crypto.js')
  const { PathWriteJournal } = await importModule('src/main/platform/path-write-journal.js')
  const { AnchoredJournalStore } = await importModule('src/main/platform/path-write-journal-store.js')
  const sealer = createJournalSealer(safeStorage)
  phase = 'write.async-safe-storage'
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true)
  phase = 'write.pin-journal-root'
  const storeAdapter = makeAdapter(broker)
  const rootObject = await storeAdapter.pin(journalRoot, 'directory', ['read', 'write', 'list'], new AbortController().signal)
  const baseStore = new AnchoredJournalStore(storeAdapter, rootObject)
  let commitPath, committingPersisted = false, removalFaultInjected = false
  const store = {
    read: () => baseStore.read(),
    async replace(bytes) {
      if (commitPath) {
        const snapshot = JSON.parse(await sealer.open(bytes))
        const record = snapshot.records.find(item => item.selectedPath === commitPath)
        if (record?.phase === 'committing') committingPersisted = true
        else if (committingPersisted && !record && !removalFaultInjected) {
          removalFaultInjected = true
          throw Object.assign(new Error('synthetic post-commit ledger replacement interruption'), { code: 'INJECTED_COMMIT_RECORD_REMOVAL_INTERRUPTION' })
        }
      }
      return baseStore.replace(bytes)
    }
  }
  const { errorCodes } = await importModule('src/contracts/errors.js')
  let journal = new PathWriteJournal(store, sealer)
  journalToClose = journal
  phase = 'write.no-proof-intent'
  let checks = 0
  const noProofId = await journal.reserve('win32', rawPaths.noProof, undefined); checks++

  const stageWriter = makeAdapter(broker, journal)
  phase = 'write.interrupt-staging'
  const stageTarget = await stageWriter.pin(rawPaths.staging, 'save', ['write'], new AbortController().signal)
  async function* interruptStage() {
    yield stageBytes
    await stageWriter.stop()
    throw Object.assign(new Error('synthetic owned broker interruption'), { code: 'SYNTHETIC_BROKER_INTERRUPTION' })
  }
  await assert.rejects(stageWriter.streamSave(stageTarget, stageBytes.length, interruptStage(), false, new AbortController().signal),
    error => error?.code === errorCodes.fileError)
  const stageRecord = (await journal.pending()).find(record => record.selectedPath === rawPaths.staging)
  assert.ok(stageRecord?.proof); assert.equal(stageRecord.phase, 'unknown'); checks += 2

  const scratchBeforeUnresolved = new Set(fs.readdirSync(targetRoot).filter(name => name.startsWith('.ztools-save-')))
  const unresolvedWriter = makeAdapter(broker, journal)
  phase = 'write.unresolved-external-stage-name-mismatch'
  const unresolvedTarget = await unresolvedWriter.pin(rawPaths.unresolvedRecord, 'save', ['write'], new AbortController().signal)
  async function* interruptUnresolvedStage() {
    yield unresolvedBytes
    await unresolvedWriter.stop()
    throw Object.assign(new Error('synthetic owned broker interruption'), { code: 'SYNTHETIC_BROKER_INTERRUPTION' })
  }
  await assert.rejects(unresolvedWriter.streamSave(unresolvedTarget, unresolvedBytes.length, interruptUnresolvedStage(), false, new AbortController().signal),
    error => error?.code === errorCodes.fileError)
  const createdScratch = fs.readdirSync(targetRoot).filter(name => name.startsWith('.ztools-save-') && !scratchBeforeUnresolved.has(name))
  assert.equal(createdScratch.length, 1)
  const movedScratchBytes = fs.readFileSync(path.join(targetRoot, createdScratch[0]))
  const retainedScratchName = `.ztools-save-retained-${runId}`
  fs.renameSync(path.join(targetRoot, createdScratch[0]), path.join(targetRoot, retainedScratchName))
  assert.deepEqual(createHash('sha256').update(fs.readFileSync(path.join(targetRoot, retainedScratchName))).digest(),
    createHash('sha256').update(movedScratchBytes).digest())
  const unresolvedRecords = await journal.pending()
  const unresolvedRecord = unresolvedRecords.find(record => record.selectedPath === rawPaths.unresolvedRecord)
  assert.ok(unresolvedRecord?.proof); assert.equal(unresolvedRecord.phase, 'unknown'); checks += 2

  const cancelWriter = makeAdapter(broker, journal)
  phase = 'write.pre-cancel'
  const cancelTarget = await cancelWriter.pin(rawPaths.cancelled, 'save', ['write'], new AbortController().signal)
  const recordsBeforeCancel = await journal.pending()
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
  async function* cancelledBytes() { yield cancellationBytes }
  await assert.rejects(cancelWriter.streamSave(cancelTarget, cancellationBytes.length, cancelledBytes(), false, alreadyCancelled.signal),
    error => error?.code === errorCodes.fileError)
  assert.deepEqual(await journal.pending(), recordsBeforeCancel)
  assert.equal(fs.existsSync(rawPaths.cancelled), false); checks += 2

  commitPath = rawPaths.committed
  phase = 'write.commit-with-injected-ledger-fault'
  const commitWriter = makeAdapter(broker, journal)
  const commitTarget = await commitWriter.pin(rawPaths.committed, 'save', ['write'], new AbortController().signal)
  await assert.rejects(commitWriter.save(commitTarget, committedBytes, false, new AbortController().signal),
    error => error?.code === errorCodes.fileWriteOutcomeUnknown)
  assert.equal(committingPersisted, true); assert.equal(removalFaultInjected, true)
  assert.equal(fs.readFileSync(rawPaths.committed).toString('utf8'), committedBytes.toString('utf8')); checks += 3

  journal = new PathWriteJournal(store, sealer)
  phase = 'write.reload-journal'
  journalToClose = journal
  const records = await journal.pending()
  assert.equal(records.length, 4)
  const byPath = new Map(records.map(record => [record.selectedPath, record]))
  assert.equal(byPath.get(rawPaths.noProof)?.phase, 'intent'); assert.equal(byPath.get(rawPaths.noProof)?.proof, undefined)
  assert.equal(byPath.get(rawPaths.staging)?.phase, 'unknown'); assert.ok(byPath.get(rawPaths.staging)?.proof)
  assert.equal(byPath.get(rawPaths.unresolvedRecord)?.phase, 'unknown'); assert.ok(byPath.get(rawPaths.unresolvedRecord)?.proof)
  assert.equal(byPath.get(rawPaths.committed)?.phase, 'committing'); assert.ok(byPath.get(rawPaths.committed)?.proof); checks += 9
  const ids = {
    noProof: byPath.get(rawPaths.noProof).id,
    staging: byPath.get(rawPaths.staging).id,
    unresolved: byPath.get(rawPaths.unresolvedRecord).id,
    committedObject: byPath.get(rawPaths.committed).id
  }
  fs.writeFileSync(path.join(output, 'case-ids.json'), `${JSON.stringify(ids)}\n`, { flag: 'wx' })
  const encrypted = fs.readFileSync(sealedFile)
  phase = 'write.assert-encrypted-paths'
  assertSealedPathsAbsent(encrypted); checks++
  const hasStagingScratch = fs.readdirSync(targetRoot).some(name => name.startsWith('.ztools-save-'))
  assert.equal(hasStagingScratch, true); checks++

  return { status: 'PASS', mode: 'write', runId, pid: process.pid, tests: checks, recordCount: records.length,
    recordIds: ids, recordPhases: { noProof: 'intent', staging: 'unknown', unresolved: 'unknown', committedObject: 'committing' },
    cancellation: { type: 'pre-aborted-signal', noJournalRecord: true, noOutput: true },
    brokerInterruption: { type: 'owned-broker-stop-after-native-stage-append', noScratchDeletion: true },
    unresolved: { type: 'synthetic-external-stage-name-mismatch', movedScratchRetained: true },
    committedObject: { nativeCommitVisible: true, ledgerFault: 'synthetic final record-removal replace failure', phasePersistedBeforeFault: true },
    rawPathInSealedStore: false, sealedHeader: 'ZPJ1', scratchObjectsObserved: true,
    realAsyncOsSealing: true, realNativeBroker: true, productionZToolsAcceptance: false }
}

async function runRecoveryPhase() {
  phase = 'recover.import-modules';
  ({ NativePathAccessAdapter } = await importModule('src/main/platform/native-path-access.js'))
  const { createJournalSealer } = await importModule('src/main/platform/path-write-journal-crypto.js')
  const { PathWriteJournal } = await importModule('src/main/platform/path-write-journal.js')
  const { AnchoredJournalStore } = await importModule('src/main/platform/path-write-journal-store.js')
  const { PathWriteRecoveryService } = await importModule('src/main/services/path-write-recovery-service.js')
  const { errorCodes } = await importModule('src/contracts/errors.js')
  const sealer = createJournalSealer(safeStorage)
  phase = 'recover.async-safe-storage';
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true)
  phase = 'recover.pin-journal-root';
  const adapter = makeAdapter(broker)
  const rootObject = await adapter.pin(journalRoot, 'directory', ['read', 'write', 'list'], new AbortController().signal)
  const journal = new PathWriteJournal(new AnchoredJournalStore(adapter, rootObject), sealer)
  journalToClose = journal
  const recovery = new PathWriteRecoveryService(journal, adapter)
  recoveryService = recovery
  const caseIds = JSON.parse(fs.readFileSync(path.join(output, 'case-ids.json'), 'utf8'))
  const caller = { type: 'main', webContentsId: 501 }
  const recordsBefore = await journal.pending()
  phase = 'recover.journal-read';
  assert.equal(recordsBefore.length, 4)
  const rawBefore = fs.readFileSync(sealedFile)
  assertSealedPathsAbsent(rawBefore)
  const selectedTargetsBefore = snapshotSelectedTargets()
  const scratchBefore = snapshotScratchObjects()
  phase = 'recover.list'
  const entries = await recovery.list(caller)
  assert.equal(entries.length, 4)
  assert.equal(JSON.stringify(entries).includes(privateMarker), false)
  assert.equal(JSON.stringify(entries).includes(path.resolve(output)), false)
  for (const entry of entries) assert.equal(Object.hasOwn(entry, 'selectedPath') || Object.hasOwn(entry, 'proof'), false)

  const expected = {
    noProof: { phase: 'intent', state: 'unresolved', reason: 'no-object-proof', size: undefined },
    staging: { phase: 'unknown', state: 'staging', reason: undefined, size: stageBytes.length },
    unresolved: { phase: 'unknown', state: 'unresolved', reason: undefined, size: undefined },
    committedObject: { phase: 'committing', state: 'committed-object', reason: undefined, size: committedBytes.length }
  }
  phase = 'recover.reject-mismatched-proof'
  const unresolvedProof = Buffer.from(recordsBefore.find(record => record.selectedPath === rawPaths.unresolvedRecord).proof, 'base64')
  const mismatchedObject = await adapter.pin(rawPaths.unresolvedActual, 'save', ['write'], new AbortController().signal)
  await assert.rejects(adapter.observeWrite(mismatchedObject, unresolvedProof, new AbortController().signal),
    error => error?.code === errorCodes.fileError)
  await adapter.release(mismatchedObject)
  const mismatchedProofRejected = true
  const businessStates = []
  for (const key of ['noProof', 'staging', 'unresolved', 'committedObject']) {
    phase = `recover.inspect.${key}`
    const result = await recovery.inspect(caseIds[key], caller)
    assert.equal(result.businessResult, 'unconfirmed')
    assert.equal(result.phase, expected[key].phase)
    assert.equal(result.observation.state, expected[key].state)
    if (expected[key].reason) assert.equal(result.observation.reason, expected[key].reason)
    if (expected[key].size !== undefined) assert.equal(result.observation.size, expected[key].size)
    assert.equal(JSON.stringify(result).includes(privateMarker), false)
    assert.equal(JSON.stringify(result).includes(path.resolve(output)), false)
    assert.equal(JSON.stringify(result).includes('ZPW1'), false)
    businessStates.push({ key, phase: result.phase, observation: result.observation, businessResult: result.businessResult })
  }

  const recordsAfter = await journal.pending()
  assert.deepEqual(recordsAfter, recordsBefore)
  const rawAfter = fs.readFileSync(sealedFile)
  assert.deepEqual(createHash('sha256').update(rawAfter).digest(), createHash('sha256').update(rawBefore).digest())
  assertSealedPathsAbsent(rawAfter)
  assert.ok(scratchBefore.length >= 2)
  assert.equal(fs.existsSync(rawPaths.noProof), false)
  assert.equal(fs.existsSync(rawPaths.staging), false)
  assert.equal(fs.existsSync(rawPaths.unresolvedRecord), false)
  assert.equal(fs.existsSync(rawPaths.unresolvedActual), false)
  assert.equal(fs.existsSync(rawPaths.cancelled), false)
  const selectedTargetsAfter = snapshotSelectedTargets()
  assert.deepEqual(selectedTargetsAfter, selectedTargetsBefore)
  const scratchAfter = snapshotScratchObjects()
  assert.deepEqual(scratchAfter, scratchBefore)
  const checks = 4 + 1 + entries.length + 2 + (businessStates.length * 6) + 3 + 1 + 6 + 1
  await journal.close()
  await recovery.stop()
  const index = ownedAdapters.size
  const stopped = await Promise.allSettled([...ownedAdapters].map(item => item.stop()))
  assert.equal(stopped.every(item => item.status === 'fulfilled'), true)
  return { status: 'PASS', mode: 'recover', runId, pid: process.pid, tests: checks, recordCount: recordsBefore.length,
    businessStates, mismatchedProofRejected, journalUnchanged: true, noAutomaticReplay: true, noScratchMutation: true,
    scratchObjectsRetained: scratchBefore.length, rawPathInSealedStore: false,
    realAsyncOsSealing: true, realNativeBroker: true, productionZToolsAcceptance: false,
    cleanupConfirmed: true, ownedAdaptersStopped: index }
}

app.whenReady().then(async () => {
  let result, failure, cleanupConfirmed = true
  try {
    phase = 'electron.identity.version'
    const electronVersion = process.versions.electron
    assert.equal(electronVersion, '43.4.1')
    phase = 'electron.identity.arch'
    assert.equal(process.arch, 'x64')
    phase = 'electron.identity.user-data'
    let actualUserDataPath
    try { actualUserDataPath = app.getPath('userData') }
    catch { throw Object.assign(new Error('userData read failed'), { code: 'USER_DATA_PATH_READ_FAILED' }) }
    if (typeof actualUserDataPath !== 'string') {
      throw Object.assign(new Error('userData result invalid'), { code: 'USER_DATA_PATH_INVALID' })
    }
    const normalizeWindowsPath = value => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    if (actualUserDataPath.includes('\0') || normalizeWindowsPath(actualUserDataPath) !== normalizeWindowsPath(userData)) {
      throw Object.assign(new Error('isolated userData mismatch'), { code: 'ISOLATED_USER_DATA_MISMATCH' })
    }
    result = mode === 'write' ? await runWritePhase() : await runRecoveryPhase()
  } catch (error) {
    try { fs.writeFileSync(path.join(output, `${mode}.failure.stack.txt`), String(error?.stack ?? error), { flag: 'wx' }) } catch {}
    failure = `${phase}:${summarizeFailure(error)}`
  } finally {
    try { if (journalToClose) await journalToClose.close() } catch { cleanupConfirmed = false; failure ??= 'JOURNAL_CLOSE_UNCONFIRMED' }
    if (recoveryService) {
      try { await recoveryService.stop() } catch { cleanupConfirmed = false; failure ??= 'RECOVERY_SERVICE_STOP_UNCONFIRMED' }
    }
    const stopped = await Promise.allSettled([...ownedAdapters].map(adapter => adapter.stop()))
    if (stopped.some(item => item.status === 'rejected')) { cleanupConfirmed = false; failure ??= 'OWNED_BROKER_STOP_UNCONFIRMED' }
  }
  if (failure) {
    console.error(JSON.stringify({ status: 'FAIL', mode, runId, failureCode: failure, pid: process.pid,
      cleanupConfirmed, productionZToolsAcceptance: false, realAsyncOsSealing: true, realNativeBroker: true }))
    app.exit(1)
    return
  }
  console.log(JSON.stringify({ ...result, cleanupConfirmed: true }))
  app.exit(0)
}).catch(() => {
  console.error(JSON.stringify({ status: 'FAIL', mode, runId, failureCode: 'ELECTRON_READY_FAILED', pid: process.pid,
    cleanupConfirmed: false, productionZToolsAcceptance: false }))
  app.exit(1)
})
