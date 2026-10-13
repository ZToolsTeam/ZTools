import fs from 'node:fs'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RuntimeIdentityTarget } from '../../contracts/runtime-identity.js'
import type { RuntimeCapabilityTarget } from '../../contracts/runtime-capability.js'

export const RUNTIME_TARGET_MANIFEST_FILE = 'ztools-runtime-target.json'
export const RUNTIME_TARGET_MANIFEST_VERSION = 1 as const
const MAX_MANIFEST_BYTES = 4096

interface RuntimeTargetManifest {
  manifestVersion: typeof RUNTIME_TARGET_MANIFEST_VERSION
  target: {
    platform: 'macos'
    runtime: 'electron'
    arch: 'universal' | 'x64' | 'arm64'
  }
}

interface RuntimeTargetManifestFileSystem {
  lstatSync: typeof fs.lstatSync
  realpathSync: typeof fs.realpathSync
  readFileSync: typeof fs.readFileSync
}

function unsupported(message: string): never {
  throw new ZToolsError(errorCodes.notSupported, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function readMacRuntimeTargetManifest(
  resourcesPath: string,
  { fsApi = fs }: { fsApi?: RuntimeTargetManifestFileSystem } = {}
): RuntimeTargetManifest {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) {
    return unsupported('Packaged macOS runtime target manifest requires an absolute resources path')
  }

  const resourcesRoot = path.resolve(resourcesPath)
  const manifestPath = path.resolve(resourcesRoot, RUNTIME_TARGET_MANIFEST_FILE)
  if (path.dirname(manifestPath) !== resourcesRoot || !isWithinDirectory(resourcesRoot, manifestPath)) {
    return unsupported('Packaged macOS runtime target manifest path is outside Electron resources')
  }

  try {
    const resourcesStat = fsApi.lstatSync(resourcesRoot)
    if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
      return unsupported('Packaged macOS Electron resources must be a real directory')
    }
    const canonicalResourcesRoot = fsApi.realpathSync(resourcesRoot)
    const canonicalManifestPath = path.resolve(canonicalResourcesRoot, RUNTIME_TARGET_MANIFEST_FILE)
    if (path.dirname(canonicalManifestPath) !== canonicalResourcesRoot ||
        !isWithinDirectory(canonicalResourcesRoot, canonicalManifestPath)) {
      return unsupported('Packaged macOS runtime target manifest path is outside Electron resources')
    }

    const manifestStat = fsApi.lstatSync(canonicalManifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
      return unsupported('Packaged macOS runtime target manifest must be a small regular file')
    }
    if (fsApi.realpathSync(canonicalManifestPath) !== canonicalManifestPath ||
        !isWithinDirectory(canonicalResourcesRoot, canonicalManifestPath)) {
      return unsupported('Packaged macOS runtime target manifest escapes Electron resources')
    }

    const raw = fsApi.readFileSync(canonicalManifestPath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) {
      return unsupported('Packaged macOS runtime target manifest exceeds the size limit')
    }
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || !hasExactKeys(parsed, ['manifestVersion', 'target']) ||
        parsed.manifestVersion !== RUNTIME_TARGET_MANIFEST_VERSION || !isRecord(parsed.target) ||
        !hasExactKeys(parsed.target, ['arch', 'platform', 'runtime']) ||
        parsed.target.platform !== 'macos' || parsed.target.runtime !== 'electron' ||
        (parsed.target.arch !== 'universal' && parsed.target.arch !== 'x64' && parsed.target.arch !== 'arm64')) {
      return unsupported('Packaged macOS runtime target manifest is invalid or unsupported')
    }
    return parsed as unknown as RuntimeTargetManifest
  } catch {
    return unsupported('Packaged macOS runtime target manifest is missing or unreadable')
  }
}

export function resolveRuntimeIdentityTarget({
  target,
  platform,
  processArch,
  isPackaged,
  resourcesPath,
  fsApi
}: {
  target: RuntimeCapabilityTarget
  platform: NodeJS.Platform
  processArch: string
  isPackaged: boolean
  resourcesPath: string
  fsApi?: RuntimeTargetManifestFileSystem
}): RuntimeIdentityTarget {
  const expectedPlatform = platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : undefined
  if (!expectedPlatform || target.platform !== expectedPlatform || target.runtime !== 'electron') {
    return unsupported('Runtime identity is unsupported for this platform or runtime')
  }

  if (expectedPlatform === 'windows') {
    if (target.arch !== 'ia32' && target.arch !== 'x64') {
      return unsupported('Runtime identity is unsupported for this Windows architecture')
    }
    if (target.arch !== processArch) {
      return unsupported('Runtime target does not match the current Windows Electron process')
    }
    return {
      id: `windows-electron-${target.arch}`,
      platform: 'windows',
      runtime: 'electron',
      arch: target.arch
    }
  }

  if ((processArch !== 'x64' && processArch !== 'arm64') || target.arch !== processArch) {
    return unsupported('Runtime target does not match the current macOS Electron process slice')
  }
  if (!isPackaged) {
    return { platform: 'macos', runtime: 'electron', arch: processArch }
  }

  const manifest = readMacRuntimeTargetManifest(resourcesPath, fsApi ? { fsApi } : {})
  if (manifest.target.arch !== 'universal' && manifest.target.arch !== processArch) {
    return unsupported('Packaged macOS runtime target does not match the current Electron process slice')
  }
  return { ...manifest.target }
}
