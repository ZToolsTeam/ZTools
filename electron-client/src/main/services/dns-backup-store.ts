import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validDnsServers, validNetworkService } from '../../contracts/dns-benchmark.js'

export interface DnsBackup { version: 1; id: string; service: string; device: string; servers: string[]; createdAt: string }
export class DnsBackupStore {
  constructor(private readonly directory: string) {}
  async #directory() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('DNS 备份目录不安全，未修改系统配置')
  }
  #pointer(service: string) { return path.join(this.directory, `${createHash('sha256').update(service).digest('hex')}.latest`) }
  async #read(file: string): Promise<string> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 16384) throw new Error('DNS 备份不是有效的小型普通文件')
      const contents = await handle.readFile('utf8')
      if (Buffer.byteLength(contents) > 16384) throw new Error('DNS 备份内容超过限制')
      return contents
    } finally { await handle.close() }
  }
  async load(service: string, id: string): Promise<DnsBackup> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('DNS 备份编号无效')
    await this.#directory()
    const record = JSON.parse(await this.#read(path.join(this.directory, `${id}.json`))) as Partial<DnsBackup> | null
    if (!record || record.version !== 1 || record.id !== id || record.service !== service || !validNetworkService(record.service) ||
        typeof record.device !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(record.device) || !validDnsServers(record.servers) ||
        typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('DNS 备份损坏或不属于该网络服务，已停止恢复')
    return record as DnsBackup
  }
  async latest(service: string): Promise<DnsBackup | null> {
    await this.#directory()
    let id: string
    try { id = (await this.#read(this.#pointer(service))).trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    return this.load(service, id)
  }
  async save(service: string, device: string, servers: string[]): Promise<DnsBackup> {
    if (!validNetworkService(service) || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(device) || !validDnsServers(servers)) throw new Error('无法备份无效的 DNS 配置')
    await this.#directory()
    const record: DnsBackup = { version: 1, id: randomUUID(), service, device, servers: [...servers], createdAt: new Date().toISOString() }
    const file = path.join(this.directory, `${record.id}.json`), data = JSON.stringify(record)
    const handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(data, 'utf8'); await handle.sync() } finally { await handle.close() }
    if (await this.#read(file) !== data) throw new Error('DNS 备份校验失败，未修改系统配置')
    const pointer = this.#pointer(service), temporary = path.join(this.directory, `${record.id}.latest-tmp`)
    const pointerHandle = await fs.open(temporary, 'wx', 0o600)
    try { await pointerHandle.writeFile(record.id, 'utf8'); await pointerHandle.sync() } finally { await pointerHandle.close() }
    await fs.rename(temporary, pointer)
    const saved = await this.latest(service)
    if (saved?.id !== record.id) throw new Error('DNS 恢复索引校验失败，未修改系统配置')
    return record
  }
}
