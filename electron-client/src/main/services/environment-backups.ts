import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { environmentRecord, type EnvironmentScope } from '../../contracts/environment-manager.js'
import { environmentRevision, runEnvironmentCommand, type EnvironmentState } from './environment-provider.js'

export interface EnvironmentBackup { version: 1; id: string; source: EnvironmentScope; createdAt: string; summary: string; before: EnvironmentState; after: EnvironmentState; checksum: string }
const PRIVATE_PATHS_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
if($request.initialize) {
  $directory=[string]$request.paths[0]
  $security=New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true,$false)
  foreach($sid in $allowed) {
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $security.AddAccessRule($rule)
  }
  if(-not [System.IO.Directory]::Exists($directory)) {
    $security.SetOwner([System.Security.Principal.SecurityIdentifier]::new($allowed[0]))
    [void][System.IO.Directory]::CreateDirectory($directory,$security)
  } else {
    $attributes=[System.IO.File]::GetAttributes($directory)
    if(($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Backup directory cannot be a link' }
    $owner=(Get-Acl -LiteralPath $directory).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    # 只初始化当前用户的空目录；已有备份必须通过原有 ACL 校验，不替其背书。
    if($owner -eq $allowed[0] -and [System.IO.Directory]::GetFileSystemEntries($directory).Length -eq 0) {
      [System.IO.Directory]::SetAccessControl($directory,$security)
    }
  }
}
foreach($file in $request.paths) {
  if(([System.IO.File]::GetAttributes($file) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Backup path cannot be a link' }
  $acl=Get-Acl -LiteralPath $file
  $descriptor=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
  if($null -eq $descriptor.DiscretionaryAcl -or $allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Backup owner or DACL is not private' }
  foreach($rule in $acl.Access) {
    if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Backup access is not private' }
  }
}
[Console]::Out.Write('private')
`
async function assertPrivateWindowsPaths(paths: string[], initialize = false) {
  if (process.platform !== 'win32') return
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = await runEnvironmentCommand(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PRIVATE_PATHS_SCRIPT, 'utf16le').toString('base64')], JSON.stringify({ paths, initialize }), AbortSignal.timeout(15000))
  if (result !== 'private') throw new Error('环境变量备份访问权限未确认')
}
function checksum(record: Omit<EnvironmentBackup, 'checksum'>) { return createHash('sha256').update(JSON.stringify(record)).digest('hex') }
function state(value: unknown): value is EnvironmentState {
  return environmentRecord(value) && (value.source === 'user' || value.source === 'system') && typeof value.location === 'string' && typeof value.exists === 'boolean' && typeof value.raw === 'string' && Buffer.byteLength(value.raw) <= 1024 * 1024
}
export class EnvironmentBackupStore {
  constructor(private readonly directory: string) {}
  async #ensure() {
    if (process.platform === 'win32') await assertPrivateWindowsPaths([this.directory], true)
    else await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('环境变量备份目录权限不安全，未修改配置')
  }
  async load(id: string): Promise<EnvironmentBackup> {
    await this.#ensure()
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('环境变量备份编号无效')
    await assertPrivateWindowsPaths([this.directory, path.join(this.directory, `${id}.json`)])
    return this.#read(id)
  }
  async #read(id: string): Promise<EnvironmentBackup> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('环境变量备份编号无效')
    const handle = await fs.open(path.join(this.directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('环境变量备份不是受保护的普通文件')
      const bytes = await handle.readFile()
      if (bytes.length > 16 * 1024 * 1024) throw new Error('环境变量备份过大')
      const record: unknown = JSON.parse(bytes.toString('utf8'))
      if (!environmentRecord(record) || record.version !== 1 || record.id !== id || !state(record.before) || !state(record.after) || record.source !== record.before.source || record.source !== record.after.source || record.before.location !== record.after.location || typeof record.summary !== 'string' || record.summary.length > 2048 || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.checksum !== 'string') throw new Error('环境变量备份格式损坏，停止恢复')
      const { checksum: saved, ...body } = record
      if (checksum(body as Omit<EnvironmentBackup, 'checksum'>) !== saved) throw new Error('环境变量备份校验失败，停止恢复')
      return record as unknown as EnvironmentBackup
    } finally { await handle.close() }
  }
  async list() {
    await this.#ensure()
    const names = (await fs.readdir(this.directory)).filter(name => name.endsWith('.json'))
    if (names.length > 4096) throw new Error('环境变量备份数量超过限制，请先归档旧备份')
    await assertPrivateWindowsPaths([this.directory, ...names.map(name => path.join(this.directory, name))])
    const records: Array<Pick<EnvironmentBackup, 'id' | 'source' | 'createdAt' | 'summary'> & { location: string }> = []
    for (const name of names) {
      const record = await this.#read(name.slice(0, -5))
      records.push({ id: record.id, source: record.source, createdAt: record.createdAt, summary: record.summary, location: record.before.location })
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async save(before: EnvironmentState, after: EnvironmentState, summary: string) {
    await this.#ensure()
    await assertPrivateWindowsPaths([this.directory])
    const body = { version: 1 as const, id: randomUUID(), source: before.source, createdAt: new Date().toISOString(), summary, before, after }
    const backup: EnvironmentBackup = { ...body, checksum: checksum(body) }, contents = JSON.stringify(backup)
    const temporary = path.join(this.directory, `${backup.id}.tmp`), final = path.join(this.directory, `${backup.id}.json`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(contents, 'utf8'); await handle.sync() } finally { await handle.close() }
    const verify = await fs.open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { if (await verify.readFile('utf8') !== contents) throw new Error('备份临时文件读回失败，未修改配置') } finally { await verify.close() }
    await fs.rename(temporary, final)
    if (process.platform !== 'win32') {
      const directory = await fs.open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await directory.sync() } finally { await directory.close() }
    }
    const saved = await this.load(backup.id)
    if (environmentRevision(saved.before) !== environmentRevision(before) || environmentRevision(saved.after) !== environmentRevision(after)) throw new Error('环境变量备份读回不一致，未修改配置')
    return backup
  }
}
