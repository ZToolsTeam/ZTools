import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SealedJournalStore {
  read(): Promise<Buffer | undefined>
  /** Atomic native anchored replacement, including file flush and platform commit confirmation. */
  replace(bytes: Buffer): Promise<void>
}
export interface JournalSealer {
  seal(text: string): Promise<Buffer>
  open(bytes: Buffer): Promise<string>
}
export interface PathWriteRecord {
  readonly id: string
  readonly platform: 'win32' | 'darwin'
  readonly selectedPath: string
  readonly expectedBytes: number | null
  readonly createdAt: number
  readonly phase: 'intent' | 'staging' | 'committing' | 'unknown'
  readonly proof?: string
  readonly receivedBytes?: number
  readonly sha256?: string
}
const maximumBytes = 4 * 1024 * 1024
const maximumRecords = 256
const maximumStagedBytes = 4 * 1024 ** 3
const maximumSingleWriteBytes = 2 * 1024 ** 3
const fail = () => new Error('PATH_WRITE_JOURNAL_UNAVAILABLE')
// V1 writes send no payload until the intent's object proof is durably staged.
function isProoflessIntent(record: PathWriteRecord): boolean {
  return record.phase === 'intent' && record.proof === undefined && record.receivedBytes === undefined && record.sha256 === undefined
}
function stagedBytes(records: Map<string, PathWriteRecord>, recoveredIntents: ReadonlySet<string>): number {
  let total = 0
  for (const record of records.values()) {
    if (recoveredIntents.has(record.id) && isProoflessIntent(record)) continue
    total += record.expectedBytes ?? maximumSingleWriteBytes
  }
  return total
}
function checkedRecord(value: unknown): PathWriteRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['id', 'platform', 'selectedPath', 'expectedBytes', 'createdAt', 'phase', 'proof', 'receivedBytes', 'sha256'].includes(key)) ||
      typeof v.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.id) || !['win32', 'darwin'].includes(String(v.platform)) ||
      typeof v.selectedPath !== 'string' || !v.selectedPath || Buffer.byteLength(v.selectedPath) > 4096 || v.selectedPath.includes('\0') ||
      !(v.platform === 'win32' ? path.win32 : path.posix).isAbsolute(v.selectedPath) ||
      (v.expectedBytes !== null && (!Number.isSafeInteger(v.expectedBytes) || Number(v.expectedBytes) < 0 || Number(v.expectedBytes) > 2 * 1024 ** 3)) ||
      !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 ||
      !['intent', 'staging', 'committing', 'unknown'].includes(String(v.phase))) throw fail()
  if (v.proof !== undefined) {
    if (typeof v.proof !== 'string' || v.proof.length > 10924) throw fail()
    const proof = Buffer.from(v.proof, 'base64')
    if (proof.length < 6 || proof.length > 8192 || proof.toString('base64') !== v.proof ||
        proof.subarray(0, 4).toString('ascii') !== 'ZPW1' || proof[4] !== (v.platform === 'win32' ? 1 : 2)) throw fail()
  }
  if (['staging', 'committing'].includes(String(v.phase)) && v.proof === undefined) throw fail()
  if (v.receivedBytes !== undefined && (!Number.isSafeInteger(v.receivedBytes) || Number(v.receivedBytes) < 0 || Number(v.receivedBytes) > 2 * 1024 ** 3)) throw fail()
  if (v.sha256 !== undefined && (typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256))) throw fail()
  if (v.phase === 'committing' && (v.sha256 === undefined || v.receivedBytes === undefined ||
      (v.expectedBytes !== null && v.expectedBytes !== v.receivedBytes))) throw fail()
  if (v.phase === 'intent' && (v.proof !== undefined || v.receivedBytes !== undefined || v.sha256 !== undefined)) throw fail()
  return Object.freeze({ ...v }) as unknown as PathWriteRecord
}

/** Main-only sealed ledger. Corruption, unavailable OS sealing, and unconfirmed replacement all fail closed. */
export class PathWriteJournal {
  #records?: Map<string, PathWriteRecord>
  // Only clean V1 intents present at cold load are uncharged; live reserve() calls stay charged.
  #recoveredProoflessIntents = new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()
  #failed = false
  #queued = 0
  #closing?: Promise<void>
  constructor(private readonly store: SealedJournalStore, private readonly sealer: JournalSealer) {}

  reserve(platform: 'win32' | 'darwin', selectedPath: string, expectedBytes: number | undefined): Promise<string> {
    return this.#run(async () => {
      if (this.#records!.size >= maximumRecords) throw new Error('PATH_WRITE_JOURNAL_QUOTA')
      const record = checkedRecord({ id: randomUUID(), platform, selectedPath, expectedBytes: expectedBytes ?? null,
        createdAt: Date.now(), phase: 'intent' })
      const next = new Map(this.#records); next.set(record.id, record)
      if (stagedBytes(next, this.#recoveredProoflessIntents) > maximumStagedBytes) throw new Error('PATH_WRITE_JOURNAL_QUOTA')
      await this.#persist(next); return record.id
    })
  }

  staged(id: string, proof: Buffer): Promise<void> {
    return this.#change(id, 'intent', record => checkedRecord({ ...record, phase: 'staging', proof: proof.toString('base64') }))
  }

  committing(id: string, receivedBytes: number, sha256: string): Promise<void> {
    return this.#change(id, 'staging', record => checkedRecord({ ...record, phase: 'committing', receivedBytes, sha256 }))
  }

  committed(id: string): Promise<void> {
    return this.#run(async () => {
      if (this.#records!.get(id)?.phase !== 'committing') throw fail()
      const next = new Map(this.#records); next.delete(id); await this.#persist(next)
    })
  }

  interrupted(id: string): Promise<void> {
    return this.#run(async () => {
      const record = this.#records!.get(id); if (!record) throw fail()
      const updated = checkedRecord({ ...record, phase: 'unknown' })
      const next = new Map(this.#records); next.set(id, updated)
      const recoveredIntents = new Set(this.#recoveredProoflessIntents); recoveredIntents.delete(id)
      if (stagedBytes(next, recoveredIntents) > maximumStagedBytes) throw new Error('PATH_WRITE_JOURNAL_QUOTA')
      await this.#persist(next); this.#recoveredProoflessIntents = recoveredIntents
    })
  }

  pending(): Promise<readonly PathWriteRecord[]> {
    return this.#run(async () => Object.freeze([...this.#records!.values()]))
  }

  /** Call after cancelling writers, before stopping the separate store broker. Never erase unresolved records. */
  close(timeoutMs = 10_000): Promise<void> {
    if (this.#closing) return this.#closing
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return Promise.reject(fail())
    const queue = this.#queue
    this.#closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([queue, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { this.#failed = true; reject(fail()) }, timeoutMs)
        })])
        if (this.#failed) throw fail()
      } finally { if (timer) clearTimeout(timer) }
    })()
    return this.#closing
  }

  #change(id: string, phase: PathWriteRecord['phase'], update: (record: PathWriteRecord) => PathWriteRecord): Promise<void> {
    return this.#run(async () => {
      const record = this.#records!.get(id); if (!record || record.phase !== phase) throw fail()
      const updated = update(record)
      const next = new Map(this.#records); next.set(id, updated)
      const recoveredIntents = new Set(this.#recoveredProoflessIntents)
      if (!isProoflessIntent(updated)) recoveredIntents.delete(id)
      if (stagedBytes(next, recoveredIntents) > maximumStagedBytes) throw new Error('PATH_WRITE_JOURNAL_QUOTA')
      await this.#persist(next); this.#recoveredProoflessIntents = recoveredIntents
    })
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#failed) return Promise.reject(fail())
    if (this.#queued >= maximumRecords) return Promise.reject(new Error('PATH_WRITE_JOURNAL_QUOTA'))
    this.#queued++
    const result = this.#queue.then(async () => {
      if (this.#failed) throw fail()
      if (!this.#records) await this.#load()
      if (this.#failed) throw fail()
      return operation()
    }).finally(() => { this.#queued-- })
    this.#queue = result.catch(() => {})
    return result
  }

  async #load(): Promise<void> {
    try {
      const bytes = await this.store.read()
      if (!bytes) { this.#records = new Map(); return }
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximumBytes) throw fail()
      const plaintext = await this.sealer.open(bytes)
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > maximumBytes) throw fail()
      const decoded = JSON.parse(plaintext) as { schemaVersion?: unknown; records?: unknown }
      if (!decoded || typeof decoded !== 'object' || Object.keys(decoded).some(key => !['schemaVersion', 'records'].includes(key)) ||
          decoded.schemaVersion !== 1 || !Array.isArray(decoded.records) || decoded.records.length > maximumRecords) throw fail()
      const records = decoded.records.map(checkedRecord)
      if (new Set(records.map(record => record.id)).size !== records.length) throw fail()
      const loaded = new Map(records.map(record => [record.id, record]))
      const recoveredIntents = new Set(records.filter(isProoflessIntent).map(record => record.id))
      if (stagedBytes(loaded, recoveredIntents) > maximumStagedBytes) throw fail()
      this.#records = loaded; this.#recoveredProoflessIntents = recoveredIntents
    } catch { this.#failed = true; throw fail() }
  }

  async #persist(next: Map<string, PathWriteRecord>): Promise<void> {
    try {
      const plaintext = JSON.stringify({ schemaVersion: 1, records: [...next.values()] })
      if (Buffer.byteLength(plaintext) > maximumBytes) throw fail()
      const encrypted = await this.sealer.seal(plaintext)
      if (this.#failed) throw fail()
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > maximumBytes) throw fail()
      await this.store.replace(encrypted)
      if (this.#failed) throw fail()
      this.#records = next
    } catch { this.#failed = true; throw fail() }
  }
}
