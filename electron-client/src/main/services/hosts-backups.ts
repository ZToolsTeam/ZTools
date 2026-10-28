import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostsRecord, HOSTS_MAX_BYTES } from '../../contracts/hosts-manager.js'
import { hostsRevision } from './hosts-provider.js'
export interface HostsBackup { id: string; createdAt: string; before: string; after: string; checksum: string }
export class HostsBackups {
  constructor(private readonly directory: string) {}
  async #ensure() {
    await fs.mkdir(this.directory, { mode: 0o700, recursive: true })
    const stat = await fs.lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Hosts 备份目录权限不安全')
  }
  async load(id: string): Promise<HostsBackup> {
    await this.#ensure()
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Hosts 备份编号无效')
    const handle = await fs.open(path.join(this.directory, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * HOSTS_MAX_BYTES || (stat.mode & 0o077)) throw new Error('Hosts 备份文件不安全或过大')
      const value: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!hostsRecord(value) || value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.before !== 'string' || typeof value.after !== 'string' || Buffer.byteLength(value.before) > HOSTS_MAX_BYTES || Buffer.byteLength(value.after) > HOSTS_MAX_BYTES || value.checksum !== hostsRevision(JSON.stringify([value.id, value.createdAt, value.before, value.after]))) throw new Error('Hosts 备份校验失败，原文件未修改')
      return value as unknown as HostsBackup
    } finally { await handle.close() }
  }
  async list() {
    await this.#ensure()
    const files = (await fs.readdir(this.directory)).filter(v => v.endsWith('.json'))
    if (files.length > 4096) throw new Error('Hosts 备份过多，请先归档')
    const records = []
    for (const file of files) { const { id, createdAt } = await this.load(file.slice(0, -5)); records.push({ id, createdAt }) }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async save(before: string, after: string) {
    await this.#ensure()
    const id = randomUUID(), createdAt = new Date().toISOString(), value = { id, createdAt, before, after, checksum: hostsRevision(JSON.stringify([id, createdAt, before, after])) }
    const file = path.join(this.directory, id + '.json'), handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    return this.load(id)
  }
}
