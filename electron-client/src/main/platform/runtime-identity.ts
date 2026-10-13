import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  NATIVE_HOST_PROTOCOL_VERSION,
  RUNTIME_IDENTITY_CONTRACT_VERSION
} from '../../contracts/protocol-versions.js'
import type { RuntimeIdentity, RuntimeIdentityArchitecture, RuntimeIdentityTarget } from '../../contracts/runtime-identity.js'
import { resolveRuntimeArchitecture } from './runtime-architecture.js'

export interface RuntimeIdentityInput {
  target: RuntimeIdentityTarget
  appVersion: string
  platform: NodeJS.Platform
  processArch: string
  productVersion: string
  kernelVersion: string
  runningUnderARM64Translation: boolean | null
  processorArchitecture?: string | undefined
  processorArchitew6432?: string | undefined
  nativeHostState?: string | null | undefined
  nativeHostProtocolVersion?: number | null | undefined
}

function failUnsupported(message: string): never {
  throw new ZToolsError(errorCodes.notSupported, message)
}

function normalizeArchitecture(value: string): RuntimeIdentityArchitecture {
  switch (value) {
    case 'ia32':
    case 'x64':
    case 'arm64':
      return value
    default:
      return 'unknown'
  }
}

function normalizeOsArchitecture(value: string): RuntimeIdentityArchitecture {
  switch (value) {
    case 'x86': return 'ia32'
    case 'x64':
    case 'arm64':
      return value
    default:
      return 'unknown'
  }
}

function resolveTarget(
  target: RuntimeIdentityTarget,
  platform: NodeJS.Platform,
  processArch: RuntimeIdentityArchitecture
): RuntimeIdentityTarget {
  const expectedPlatform = platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : undefined
  if (!expectedPlatform || target.platform !== expectedPlatform || target.runtime !== 'electron') {
    return failUnsupported('Runtime identity is unsupported for this platform or runtime')
  }

  if (expectedPlatform === 'windows') {
    if (target.arch !== 'ia32' && target.arch !== 'x64') {
      return failUnsupported('Runtime identity is unsupported for this Windows architecture')
    }
    if (target.arch !== processArch) {
      return failUnsupported('Runtime target does not match the current Windows Electron process')
    }
    return {
      id: `windows-electron-${target.arch}`,
      platform: 'windows',
      runtime: 'electron',
      arch: target.arch
    }
  }

  if (processArch !== 'x64' && processArch !== 'arm64') {
    return failUnsupported('Runtime identity is unsupported for this macOS process architecture')
  }
  if (target.arch !== processArch && target.arch !== 'universal') {
    return failUnsupported('Runtime target does not match the current macOS Electron slice')
  }
  return target
}

function translationMode(
  platform: NodeJS.Platform,
  processArch: RuntimeIdentityArchitecture,
  osArch: RuntimeIdentityArchitecture,
  wow64: boolean | null,
  runningUnderARM64Translation: boolean | null
): RuntimeIdentity['process']['translationMode'] {
  switch (platform) {
    case 'win32':
      if (wow64 === true) return 'compatibility'
      if (wow64 === false) return 'native'
      return 'unknown'
    case 'darwin':
      if (runningUnderARM64Translation === true && processArch === 'x64' && osArch === 'arm64') {
        return 'translated'
      }
      if (runningUnderARM64Translation === false && processArch === osArch) return 'native'
      return 'unknown'
    default:
      return 'unknown'
  }
}

function resolveNativeHost(
  platform: NodeJS.Platform,
  state: string | null | undefined,
  processArch: RuntimeIdentityArchitecture,
  protocolVersion: number | null | undefined
): RuntimeIdentity['nativeHost'] {
  if (platform === 'darwin') {
    if (state === undefined || state === null) {
      return { state: 'not-applicable', arch: 'unknown', protocolVersion: null }
    }
    if (state === 'ready' && (processArch === 'x64' || processArch === 'arm64') &&
        Number.isSafeInteger(protocolVersion) && Number(protocolVersion) > 0) {
      return { state: 'available', arch: processArch, protocolVersion: Number(protocolVersion) }
    }
    if (['idle', 'awaiting-hello', 'crashed', 'closed', 'restarting', 'stopping', 'unavailable'].includes(state)) {
      return { state: 'unavailable', arch: 'unknown', protocolVersion: null }
    }
    return { state: 'unknown', arch: 'unknown', protocolVersion: null }
  }
  if (platform !== 'win32') {
    return { state: 'unknown', arch: 'unknown', protocolVersion: null }
  }
  if (state === 'ready') {
    return {
      state: 'available',
      arch: 'ia32',
      protocolVersion: NATIVE_HOST_PROTOCOL_VERSION
    }
  }
  if (state === undefined || state === null || [
    'idle', 'awaiting-hello', 'crashed', 'closed', 'restarting', 'stopping'
  ].includes(state)) {
    return { state: 'unavailable', arch: 'unknown', protocolVersion: null }
  }
  return { state: 'unknown', arch: 'unknown', protocolVersion: null }
}

function nonEmptyVersion(value: string): string {
  const version = value.trim()
  return version || 'unknown'
}

export function createRuntimeIdentity(input: RuntimeIdentityInput): RuntimeIdentity {
  const processArch = normalizeArchitecture(input.processArch)
  if (processArch === 'unknown') {
    return failUnsupported('Runtime identity is unsupported for this Electron process architecture')
  }
  const target = resolveTarget(input.target, input.platform, processArch)
  const architecture = resolveRuntimeArchitecture({
    platform: input.platform,
    processArch: input.processArch,
    runningUnderARM64Translation: input.runningUnderARM64Translation,
    processorArchitecture: input.processorArchitecture,
    processorArchitew6432: input.processorArchitew6432
  })
  const osArch = normalizeOsArchitecture(architecture.nativeOsArch)

  return {
    contractVersion: RUNTIME_IDENTITY_CONTRACT_VERSION,
    appVersion: input.appVersion,
    target,
    os: {
      productVersion: nonEmptyVersion(input.productVersion),
      kernelVersion: nonEmptyVersion(input.kernelVersion),
      arch: osArch
    },
    process: {
      arch: processArch,
      translationMode: translationMode(
        input.platform,
        processArch,
        osArch,
        architecture.wow64,
        input.runningUnderARM64Translation
      )
    },
    nativeHost: resolveNativeHost(input.platform, input.nativeHostState, processArch, input.nativeHostProtocolVersion)
  }
}
