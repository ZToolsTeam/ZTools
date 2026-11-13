import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { OrdinaryNativeRuntimePort } from '../native-host/dll-client-port.js'
import type { ServiceClient } from '../service/service-client.js'
import type { NativeHostLifecycleEvent, NativeInputEvent } from '../native-host/native-host-client.js'

/** 原生输入通道（键盘双击修饰键、输入注入等由调用方按能力探测使用） */
export interface NativeInputAdapter {
  readonly state: string
  onInputEvent(listener: (event: NativeInputEvent) => void): () => void
  onLifecycleEvent(listener: (event: NativeHostLifecycleEvent) => void): () => void
}

export interface PlatformNativeRuntime {
  nativeHost: OrdinaryNativeRuntimePort | null
  serviceClient: ServiceClient | null
  nativeInput?: NativeInputAdapter | null
  start(signal?: AbortSignal): Promise<void>
}

export interface PlatformNativeRuntimeFactories {
  windows(): PlatformNativeRuntime
  macos(): PlatformNativeRuntime
}

export function createPlatformNativeRuntime(
  platform: NodeJS.Platform,
  factories: PlatformNativeRuntimeFactories
): PlatformNativeRuntime {
  switch (platform) {
    case 'win32':
      return factories.windows()
    case 'darwin':
      return factories.macos()
    default:
      throw new ZToolsError(errorCodes.notSupported, `Unsupported operating system: ${platform}`)
  }
}
