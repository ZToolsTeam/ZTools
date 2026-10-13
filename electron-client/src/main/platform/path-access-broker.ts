import fs from 'node:fs'
import path from 'node:path'

export type PathAccessBrokerUnavailableReason =
  | 'unsupported-platform'
  | 'invalid-context'
  | 'not-found'
  | 'invalid-helper'

export type PathAccessBrokerResolution =
  | { available: true; executable: string; platform: 'win32' | 'darwin'; arch: 'x64' | 'universal' }
  | { available: false; reason: PathAccessBrokerUnavailableReason }

export interface PathAccessBrokerContext {
  platform: string
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

type BrokerFileSystem = Pick<typeof fs, 'lstatSync' | 'realpathSync' | 'openSync' | 'readSync' | 'closeSync'>

const PE_MACHINE_X64 = 0x8664
const MACHO_CPU_TYPE_X86_64 = 0x01000007
const MACHO_CPU_TYPE_ARM64 = 0x0100000c

function unavailable(reason: PathAccessBrokerUnavailableReason): PathAccessBrokerResolution {
  return { available: false, reason }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}

function missing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR'
}

function samePath(platform: 'win32' | 'darwin', left: string, right: string): boolean {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const normalizedLeft = paths.normalize(left)
  const normalizedRight = paths.normalize(right)
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function readAt(fileSystem: BrokerFileSystem, file: string, position: number, length: number): Buffer {
  const descriptor = fileSystem.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = fileSystem.readSync(descriptor, buffer, 0, length, position)
    if (read !== length) throw new Error('SHORT_READ')
    return buffer
  } finally {
    fileSystem.closeSync(descriptor)
  }
}

function verifyWindowsX64(fileSystem: BrokerFileSystem, file: string, size: number): boolean {
  if (size < 70) return false
  const dosHeader = readAt(fileSystem, file, 0, 64)
  if (dosHeader.toString('ascii', 0, 2) !== 'MZ') return false
  const peOffset = dosHeader.readUInt32LE(0x3c)
  if (peOffset < 64 || peOffset + 6 > size) return false
  const header = readAt(fileSystem, file, peOffset, 6)
  return header.toString('binary', 0, 4) === 'PE\0\0' && header.readUInt16LE(4) === PE_MACHINE_X64
}

function verifyMacUniversal(fileSystem: BrokerFileSystem, file: string, size: number): boolean {
  if (size < 48) return false
  const header = readAt(fileSystem, file, 0, 8)
  const magic = header.readUInt32BE(0)
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca
  const is64Bit = magic === 0xcafebabf || magic === 0xbfbafeca
  if (!littleEndian && magic !== 0xcafebabe && magic !== 0xcafebabf) return false
  const readUInt32 = (buffer: Buffer, offset: number) => littleEndian
    ? buffer.readUInt32LE(offset)
    : buffer.readUInt32BE(offset)
  const count = readUInt32(header, 4)
  const entrySize = is64Bit ? 32 : 20
  if (count !== 2 || 8 + count * entrySize > size) return false
  const architectures = readAt(fileSystem, file, 8, count * entrySize)
  const cpuTypes = new Set<number>()
  for (let index = 0; index < count; index += 1) {
    const cpuType = readUInt32(architectures, index * entrySize)
    cpuTypes.add(cpuType)
  }
  return cpuTypes.size === 2 && cpuTypes.has(MACHO_CPU_TYPE_X86_64) && cpuTypes.has(MACHO_CPU_TYPE_ARM64)
}

function inspectDirectoryChain(
  fileSystem: BrokerFileSystem,
  platform: 'win32' | 'darwin',
  anchor: string,
  relativeDirectories: string[]
): 'ok' | 'not-found' | 'invalid' {
  const paths = platform === 'win32' ? path.win32 : path.posix
  let current = paths.resolve(anchor)
  for (const directory of [current, ...relativeDirectories.map(segment => { current = paths.join(current, segment); return current })]) {
    let stats
    try { stats = fileSystem.lstatSync(directory) }
    catch (error) { return missing(error) ? 'not-found' : 'invalid' }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return 'invalid'
    try {
      if (!samePath(platform, fileSystem.realpathSync(directory), directory)) return 'invalid'
    } catch { return 'invalid' }
  }
  return 'ok'
}

/** Resolve only the platform-owned broker locations; Renderer data and environment overrides are never accepted. */
export function resolvePathAccessBroker(
  context: PathAccessBrokerContext,
  fileSystem: BrokerFileSystem = fs
): PathAccessBrokerResolution {
  if (context.platform !== 'win32' && context.platform !== 'darwin') return unavailable('unsupported-platform')
  if (typeof context.isPackaged !== 'boolean') return unavailable('invalid-context')

  const platform = context.platform
  const paths = platform === 'win32' ? path.win32 : path.posix
  const filename = platform === 'win32' ? 'ZToolsPathAccessBroker.exe' : 'ZToolsPathAccessBroker'
  const anchor = context.isPackaged ? context.resourcesPath : context.appPath
  if (typeof anchor !== 'string' || anchor.includes('\0') || !paths.isAbsolute(anchor)) return unavailable('invalid-context')

  const directorySegments = context.isPackaged
    ? ['native']
    : platform === 'win32'
      ? ['out', 'native', 'win32-x64', 'bin']
      : ['out', 'native', 'darwin-universal', 'path-access', 'native']
  const chain = inspectDirectoryChain(fileSystem, platform, anchor, directorySegments)
  if (chain === 'not-found') return unavailable('not-found')
  if (chain !== 'ok') return unavailable('invalid-helper')

  const executable = paths.resolve(anchor, ...directorySegments, filename)
  if (paths.basename(executable) !== filename || !paths.isAbsolute(executable)) return unavailable('invalid-context')
  let stats
  try { stats = fileSystem.lstatSync(executable) }
  catch (error) { return unavailable(missing(error) ? 'not-found' : 'invalid-helper') }
  if (!stats.isFile() || stats.isSymbolicLink()) return unavailable('invalid-helper')
  try {
    if (!samePath(platform, fileSystem.realpathSync(executable), executable)) return unavailable('invalid-helper')
    const validArchitecture = platform === 'win32'
      ? verifyWindowsX64(fileSystem, executable, stats.size)
      : verifyMacUniversal(fileSystem, executable, stats.size)
    if (!validArchitecture) return unavailable('invalid-helper')
  } catch {
    return unavailable('invalid-helper')
  }

  return {
    available: true,
    executable,
    platform,
    arch: platform === 'win32' ? 'x64' : 'universal'
  }
}
