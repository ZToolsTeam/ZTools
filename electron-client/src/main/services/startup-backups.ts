import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startupHash, startupRecord, type StartupSnapshot } from './startup-reader.js'

export interface StartupBackup {
  version: 1; id: string; createdAt: string; kind: 'toggle' | 'remove'
  file: string; label: string; scope: 'user-agent' | 'system-agent' | 'daemon'; domain: string
  original: string; revision: string; identity: string
  beforeEnabled: boolean; afterEnabled: boolean; originalOverride: boolean | null
  checksum: string
}
function digest(value: Omit<StartupBackup, 'checksum'>) { return startupHash(JSON.stringify(value)) }
const validId = (id: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)
function validateBackup(value: unknown, id: string): StartupBackup {
  if (!startupRecord(value)) throw new Error('启动项恢复记录格式无效')
  const { checksum, ...body } = value
  if (value.version !== 1 || !['toggle', 'remove'].includes(String(value.kind)) || value.id !== id ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !['file', 'label', 'scope', 'domain', 'original', 'revision', 'identity'].every(k => typeof value[k] === 'string') ||
      !['user-agent', 'system-agent', 'daemon'].includes(String(value.scope)) ||
      typeof value.beforeEnabled !== 'boolean' || typeof value.afterEnabled !== 'boolean' ||
      (value.originalOverride !== null && typeof value.originalOverride !== 'boolean') ||
      digest(body as unknown as Omit<StartupBackup, 'checksum'>) !== checksum) throw new Error('启动项恢复记录损坏，停止恢复')
  const bytes = Buffer.from(value.original as string, 'base64')
  if (bytes.length > 1024 * 1024 || bytes.toString('base64') !== value.original || startupHash(bytes) !== value.revision) throw new Error('启动配置备份校验失败')
  return value as unknown as StartupBackup
}

export class StartupBackupStore {
  constructor(readonly directory: string) {}
  async #prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new Error('启动项备份目录权限不安全，未修改自启状态')
  }
  async load(id: string): Promise<StartupBackup> {
    if (!validId(id)) throw new Error('启动项备份编号无效')
    await this.#prepare()
    const handle = await fs.open(path.join(this.directory, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || (info.mode & 0o077) || info.size > 2 * 1024 * 1024) throw new Error('启动项备份文件不安全或过大')
      const data = Buffer.alloc(2 * 1024 * 1024 + 1)
      let total = 0
      while (total < data.length) {
        const { bytesRead } = await handle.read(data, total, data.length - total, null)
        if (!bytesRead) break
        total += bytesRead
      }
      if (total > 2 * 1024 * 1024) throw new Error('启动项备份过大')
      return validateBackup(JSON.parse(data.subarray(0, total).toString('utf8')), id)
    } finally { await handle.close() }
  }
  async list() {
    await this.#prepare()
    const names = (await fs.readdir(this.directory)).filter(name => name.endsWith('.json'))
    if (names.length > 1024) throw new Error('启动项恢复记录超过 1024 条，请先归档')
    const result: Array<Pick<StartupBackup, 'id' | 'kind' | 'createdAt' | 'label' | 'beforeEnabled' | 'afterEnabled'>> = []
    for (const name of names) {
      const { id, kind, createdAt, label, beforeEnabled, afterEnabled } = await this.load(name.slice(0, -5))
      result.push({ id, kind, createdAt, label, beforeEnabled, afterEnabled })
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async save(snapshot: StartupSnapshot, enabled: boolean, kind: 'toggle' | 'remove' = 'toggle') {
    await this.#prepare()
    const { item } = snapshot
    const body: Omit<StartupBackup, 'checksum'> = {
      version: 1, id: randomUUID(), createdAt: new Date().toISOString(), kind,
      file: item.file, label: item.label, domain: item.domain, scope: item.scope,
      original: snapshot.bytes.toString('base64'), revision: snapshot.revision, identity: snapshot.identity,
      beforeEnabled: item.enabled, afterEnabled: enabled, originalOverride: snapshot.disabledOverride
    }
    const text = JSON.stringify({ ...body, checksum: digest(body) }), filename = path.join(this.directory, body.id + '.json')
    const temporary = path.join(this.directory, body.id + '.tmp'), file = await fs.open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(text); await file.sync() } finally { await file.close() }
      if (await fs.readFile(temporary, 'utf8') !== text) throw new Error('启动项备份读回不一致，未修改自启状态')
      // link 不覆盖已有目标；发布成功后才移除本次的临时文件。
      await fs.link(temporary, filename)
    } finally { await fs.unlink(temporary) }
    const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    const saved = await this.load(body.id)
    if (JSON.stringify(saved) !== text) throw new Error('启动项备份发布后校验失败，未修改自启状态')
    return saved
  }
}
