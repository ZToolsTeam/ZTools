import type { PlatformNativeRuntime } from '../native-runtime.js'
import { MacNativeHostClient } from './native-host-client.js'
import { readMacNativeRuntimePolicy, resolveMacNativeRuntimeReadiness } from './native-runtime-policy.js'

export interface MacosNativeRuntimeOptions {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly pluginRoot: string
  readonly processArchitecture: NodeJS.Architecture
  readonly runningUnderTranslation: boolean
}

export function createMacosNativeRuntime(options: MacosNativeRuntimeOptions): PlatformNativeRuntime {
  const policy = readMacNativeRuntimePolicy(options.resourcesPath, {
    platform: 'darwin',
    isPackaged: options.isPackaged
  })
  const readiness = resolveMacNativeRuntimeReadiness(policy, options.processArchitecture, options.isPackaged)
  const nativeHost = readiness.available && readiness.policy
    ? new MacNativeHostClient(options, readiness.policy)
    : null
  return {
    nativeHost,
    serviceClient: null,
    async start(signal?: AbortSignal) {
      if (!nativeHost) {
        console.info('macOS native host is unavailable', { reasons: readiness.reasons })
        return
      }
      try {
        await nativeHost.start(signal)
      } catch (error) {
        console.error('macOS native host trust/start check failed closed', error instanceof Error ? error.message : 'UNKNOWN')
      }
    }
  }
}
