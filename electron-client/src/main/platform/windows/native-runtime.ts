import fs from 'node:fs'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { NativeHostClient } from '../../native-host/native-host-client.js'
import { ServiceClient } from '../../service/service-client.js'
import type { PlatformNativeRuntime } from '../native-runtime.js'

export interface WindowsNativeRuntimeOptions {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  pluginRoot: string
  dataRoot: string
}

/** 一次性静默清理旧版客户端残留在用户 Plugins 目录下的 .ztools-native-host.xml（拒绝删除非普通文件或符号链接） */
function cleanupLegacyNativeHostManifest(pluginRoot: string): void {
  const legacyManifestPath = path.join(pluginRoot, '.ztools-native-host.xml')
  try {
    const stats = fs.lstatSync(legacyManifestPath, { throwIfNoEntry: false })
    if (!stats) return
    if (!stats.isFile() || stats.isSymbolicLink()) return
    fs.rmSync(legacyManifestPath, { force: true })
  } catch {
    // 静默清理，不阻塞原生运行时启动
  }
}

function resolveNativeHostPath(options: WindowsNativeRuntimeOptions): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'native', 'ZToolsNativeHost32.exe')
    : path.join(options.appPath, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe')
}

export function createWindowsNativeRuntime(
  options: WindowsNativeRuntimeOptions
): PlatformNativeRuntime {
  const nativeHostPath = resolveNativeHostPath(options)
  cleanupLegacyNativeHostManifest(options.pluginRoot)
  console.info('Electron Windows native runtime paths', {
    nativeHostPath,
    pluginRootExists: fs.existsSync(options.pluginRoot),
    nativeHostExists: fs.existsSync(nativeHostPath)
  })

  const resourcesRoot = options.isPackaged
    ? options.resourcesPath
    : path.join(options.appPath, 'resources')
  const nativeHost = new NativeHostClient(nativeHostPath, {
    pluginRoot: options.pluginRoot,
    dataRoot: options.dataRoot,
    resourcesRoot
  })
  const bridgeExecutable = options.isPackaged
    ? path.join(path.dirname(options.resourcesPath), 'ZToolsService.exe')
    : path.join(options.appPath, 'out', 'native', 'service-win32-ia32', 'ZToolsService.exe')
  const serviceClient = new ServiceClient({ bridgeExecutable })

  nativeHost.onLifecycleEvent((event) => {
    const serialized = JSON.stringify(event)
    if (event.type === 'restarted') {
      console.info(`NativeHost32 lifecycle: ${serialized}`)
    } else {
      console.warn(`NativeHost32 lifecycle: ${serialized}`)
    }
  })

  return {
    nativeHost,
    nativeInput: nativeHost,
    serviceClient,
    async start(signal?: AbortSignal) {
      if (signal?.aborted) return
      // NativeHost32 与 ZToolsService 相互独立，并行启动握手以缩短冷启动等待
      await Promise.all([
        (async () => {
          try {
            await nativeHost.start(undefined, signal)
          } catch (error) {
            if (signal?.aborted) return
            console.warn('NativeHost32 unavailable; continuing with JavaScript capabilities', error)
          }
        })(),
        (async () => {
          try {
            const serviceReady = await serviceClient.start(undefined, signal)
            if (!serviceReady && !signal?.aborted) {
              console.warn(`ZToolsService unavailable: ${JSON.stringify(serviceClient.diagnostics)}`)
            }
          } catch (error) {
            if (signal?.aborted) return
            if (error instanceof ZToolsError &&
                (error.code === errorCodes.serviceAuthentication || error.code === errorCodes.serviceProtocol)) {
              throw error
            }
            console.warn('ZToolsService unavailable; continuing without privileged capabilities', error)
          }
        })()
      ])
    }
  }
}
