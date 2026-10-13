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
    throw new ZToolsError(errorCodes.notSupported, '当前系统不支持运行时能力查询')
  }

  if (publicPlatform === 'windows' && arch !== 'ia32' && arch !== 'x64') {
    throw new ZToolsError(errorCodes.notSupported, '当前 Windows Electron 进程架构不支持运行时能力查询')
  }
  if (arch !== 'ia32' && arch !== 'x64' && arch !== 'arm64') {
    throw new ZToolsError(errorCodes.notSupported, '当前 Electron 进程架构不支持运行时能力查询')
  }
  if (publicPlatform === 'macos' && arch === 'ia32') {
    throw new ZToolsError(errorCodes.notSupported, 'macOS Electron 不支持 ia32 进程架构')
  }

  return { platform: publicPlatform, runtime: 'electron', arch }
}
