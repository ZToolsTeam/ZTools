import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RuntimeCapabilityTarget } from '../../contracts/runtime-capability.js'

export function getRuntimeCapabilityTarget(
  platform: NodeJS.Platform,
  arch: string
): RuntimeCapabilityTarget {
  const publicPlatform = platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : undefined
  if (!publicPlatform) {
    throw new ZToolsError(errorCodes.notSupported, 'Runtime capability query is not supported on this operating system')
  }

  if (publicPlatform === 'windows' && arch !== 'ia32' && arch !== 'x64') {
    throw new ZToolsError(errorCodes.notSupported, 'Runtime capability query is not supported on this Windows Electron architecture')
  }
  if (arch !== 'ia32' && arch !== 'x64' && arch !== 'arm64') {
    throw new ZToolsError(errorCodes.notSupported, 'Runtime capability query is not supported on this Electron architecture')
  }
  if (publicPlatform === 'macos' && arch === 'ia32') {
    throw new ZToolsError(errorCodes.notSupported, 'macOS Electron does not support ia32 architecture')
  }

  return { platform: publicPlatform, runtime: 'electron', arch }
}
