import os from 'node:os'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
export interface HardwareSummary {
  platform: 'windows' | 'macos'; osVersion: string; processArch: 'ia32' | 'x64' | 'arm64'
  cpuModels: string[]; logicalCpuCount: number; totalMemory: number
  fieldAvailability: { cpuModels: boolean; logicalCpuCount: boolean; totalMemory: boolean; osVersion: boolean }
}
/** OS-reported logical CPU and physical memory only; no sensor, serial number, native machine architecture or file paths. */
export function readHardwareSummary(platform: NodeJS.Platform, productVersion?: string, snapshot = { cpus: os.cpus(), totalMemory: os.totalmem(), release: os.release(), processArch: process.arch }): HardwareSummary {
  if (platform !== 'win32' && platform !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '当前平台未提供硬件概要')
  if (!Array.isArray(snapshot.cpus) || snapshot.cpus.length > 65536 || !Number.isSafeInteger(snapshot.totalMemory) || snapshot.totalMemory < 0 || !['ia32', 'x64', 'arm64'].includes(snapshot.processArch)) throw new ZToolsError(errorCodes.internalError, '硬件概要读取失败')
  const cpuModels = [...new Set(snapshot.cpus.map(cpu => typeof cpu.model === 'string' ? cpu.model.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512) : '').filter(Boolean))].slice(0, 32)
  const rawVersion = platform === 'darwin' ? productVersion : snapshot.release
  const osVersion = typeof rawVersion === 'string' && /^\d+(?:\.\d+){1,3}$/.test(rawVersion) ? rawVersion : ''
  return { platform: platform === 'darwin' ? 'macos' : 'windows', osVersion, processArch: snapshot.processArch as HardwareSummary['processArch'], cpuModels, logicalCpuCount: snapshot.cpus.length, totalMemory: snapshot.totalMemory, fieldAvailability: { cpuModels: cpuModels.length > 0, logicalCpuCount: snapshot.cpus.length > 0, totalMemory: snapshot.totalMemory > 0, osVersion: !!osVersion } }
}
