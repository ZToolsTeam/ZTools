import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface SystemVolume {
  path: string
  label: string
  fileSystem: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  /** 同一 APFS 容器的卷共享容量，汇总时只能计入一次。 */
  capacityGroup: string
}
export interface SystemVolumeSnapshot { volumes: SystemVolume[]; partial: boolean; errors: string[] }
interface MountedVolume { path: string; label: string; fileSystem: string; capacityGroup: string }
export interface VolumeDependencies {
  run(file: string, args: string[], input?: string): Promise<string>
  statfs(path: string): Promise<{ blocks: number; bsize: number; bfree: number; bavail: number }>
}
const dependencies: VolumeDependencies = {
  run(file, args, input) {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout))
      child.stdin?.on('error', () => { /* 子进程退出由回调报告。 */ })
      child.stdin?.end(input)
    })
  },
  statfs: (target) => fs.statfs(target)
}

function isUserFacingMacMount(mount: unknown): mount is string {
  if (typeof mount !== 'string' || !mount.startsWith('/') || /[\0\r\n]/.test(mount)) return false
  if (mount === '/') return true
  if (!mount.startsWith('/Volumes/')) return false
  const name = mount.slice('/Volumes/'.length).replace(/\/+$/, '')
  return name.length > 0 && !name.includes('/') && !name.startsWith('.') && !name.startsWith('com.apple.TimeMachine.')
}

export function parseMacVolumes(data: unknown): MountedVolume[] {
  const root = data as { AllDisksAndPartitions?: unknown[] }
  if (!Array.isArray(root?.AllDisksAndPartitions)) throw new Error('挂载卷列表格式无效')
  const mounted = new Map<string, MountedVolume>()
  const visit = (value: unknown, group = '', fsType = '') => {
    if (!value || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    const apfs = row.Content === 'Apple_APFS_Container'
    const nextGroup = apfs ? String(row.DeviceIdentifier || '') : group
    const nextFs = apfs ? 'APFS' : fsType || (row.Content === 'Apple_HFS' ? 'HFS+' : '')
    const add = (mount: unknown) => {
      if (!isUserFacingMacMount(mount)) return
      mounted.set(mount, { path: mount, label: String(row.VolumeName || mount), fileSystem: nextFs, capacityGroup: nextGroup || String(row.DeviceIdentifier || mount) })
    }
    add(row.MountPoint)
    if (Array.isArray(row.MountedSnapshots)) {
      for (const snapshot of row.MountedSnapshots) {
        if (snapshot && typeof snapshot === 'object' && (snapshot as { SnapshotMountPoint?: unknown }).SnapshotMountPoint === '/') add('/')
      }
    }
    for (const key of ['Partitions', 'APFSVolumes']) {
      if (Array.isArray(row[key])) for (const item of row[key]) visit(item, nextGroup, nextFs)
    }
  }
  for (const disk of root.AllDisksAndPartitions) visit(disk)
  return [...mounted.values()]
}

export async function listSystemVolumes(platform: NodeJS.Platform = process.platform, deps: VolumeDependencies = dependencies): Promise<SystemVolumeSnapshot> {
  if (platform === 'win32') {
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const text = await deps.run(executable, ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Volume | Where-Object { $_.Name -and $_.Name -notlike '\\\\?\\Volume*' -and $_.Capacity -gt 0 } | Select-Object Name,Label,FileSystem,Capacity,FreeSpace,DeviceID) | ConvertTo-Json -Compress"])
    const body = text.replace(/^\uFEFF/, '').trim()
    // PowerShell 5.1 对空数组 ConvertTo-Json 不输出任何内容
    if (!body) throw new Error('没有读取到已挂载卷')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new Error('挂载卷列表输出不是有效 JSON') }
    const rows: unknown[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    const volumes: SystemVolume[] = []
    const errors: string[] = []
    for (const value of rows) {
      if (!value || typeof value !== 'object') { errors.push('挂载卷数据无效'); continue }
      const row = value as Record<string, unknown>
      if (typeof row.Name === 'string' && /^\\\\[?.]\\volume\{/i.test(row.Name)) continue
      // null（如 BitLocker 锁定卷读不到剩余空间）不能按 0 处理，否则会显示成“已用 100%”
      const totalBytes = typeof row.Capacity === 'number' ? row.Capacity : Number.NaN, availableBytes = typeof row.FreeSpace === 'number' ? row.FreeSpace : Number.NaN
      const name = typeof row.Name === 'string' ? row.Name : ''
      if (!name || !path.win32.isAbsolute(name)) { errors.push('挂载卷路径无效'); continue }
      if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) { errors.push(`${name}: 卷容量读取失败`); continue }
      volumes.push({ path: name, label: String(row.Label || name), fileSystem: String(row.FileSystem || ''), totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, capacityGroup: String(row.DeviceID || name) })
    }
    if (!volumes.length) throw new Error(errors.join('；') || '没有读取到已挂载卷')
    return { volumes, partial: errors.length > 0, errors }
  }
  if (platform !== 'darwin') throw new Error('当前平台不支持挂载卷枚举')
  const plist = await deps.run('/usr/sbin/diskutil', ['list', '-plist'])
  const mounts = parseMacVolumes(JSON.parse(await deps.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], plist)))
  const errors: string[] = []
  const volumes: SystemVolume[] = []
  await Promise.all(mounts.map(async mount => {
    try {
      const stat = await deps.statfs(mount.path)
      const totalBytes = stat.blocks * stat.bsize, availableBytes = stat.bavail * stat.bsize
      const usedBytes = Math.max(0, totalBytes - stat.bfree * stat.bsize)
      if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) throw new Error('卷容量无效')
      volumes.push({ ...mount, totalBytes, usedBytes, availableBytes })
    } catch (error) { errors.push(`${mount.path}: ${error instanceof Error ? error.message : String(error)}`) }
  }))
  if (!volumes.length) throw new Error(errors.join('；') || '没有读取到已挂载卷')
  volumes.sort((a, b) => a.path.localeCompare(b.path))
  return { volumes, partial: errors.length > 0, errors }
}
