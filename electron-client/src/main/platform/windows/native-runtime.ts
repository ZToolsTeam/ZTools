import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
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

function provisionNativeHostManifest(pluginRoot: string, resourcesPath: string): {
  path: string
  sha256: string
} | undefined {
  const bundledManifestPath = path.join(resourcesPath, 'native', '.ztools-native-host.xml')
  const installedManifestPath = path.join(pluginRoot, '.ztools-native-host.xml')
  try {
    const bundledStats = fs.lstatSync(bundledManifestPath)
    if (!bundledStats.isFile() || bundledStats.isSymbolicLink() ||
        bundledStats.size <= 0 || bundledStats.size > 1024 * 1024) {
      console.warn(`NativeHost32 bundled manifest is invalid: ${bundledManifestPath}`)
      return undefined
    }
    const bundledManifest = fs.readFileSync(bundledManifestPath)
    fs.mkdirSync(pluginRoot, { recursive: true })
    try {
      fs.copyFileSync(
        bundledManifestPath,
        installedManifestPath,
        fs.constants.COPYFILE_EXCL
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const installedStats = fs.lstatSync(installedManifestPath)
    if (!installedStats.isFile() || installedStats.isSymbolicLink() ||
        installedStats.size !== bundledManifest.length ||
        !fs.readFileSync(installedManifestPath).equals(bundledManifest)) {
      console.warn('NativeHost32 installed manifest differs from the bundled trust anchor')
      return undefined
    }
    return {
      path: installedManifestPath,
      sha256: createHash('sha256').update(bundledManifest).digest('hex')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('NativeHost32 bundled manifest cannot be provisioned', error)
    }
    return undefined
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
  const trustResourcesPath = options.isPackaged ? options.resourcesPath : path.join(options.appPath, 'out')
  const nativeHostManifest = provisionNativeHostManifest(options.pluginRoot, trustResourcesPath)
  console.info('Electron Windows native runtime paths', {
    nativeHostPath,
    nativeHostManifestPath: nativeHostManifest?.path,
    nativeHostManifestTrusted: nativeHostManifest !== undefined,
    pluginRootExists: fs.existsSync(options.pluginRoot),
    nativeHostExists: fs.existsSync(nativeHostPath)
  })

  const nativeHost = new NativeHostClient(nativeHostPath, {
    pluginRoot: options.pluginRoot,
    ...(nativeHostManifest
      ? { trustedManifestSha256: nativeHostManifest.sha256 }
      : {})
  })
  const serviceClient = new ServiceClient({ dataRoot: options.dataRoot })

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
      try {
        await nativeHost.start(undefined, signal)
      } catch (error) {
        if (signal?.aborted) return
        console.warn('NativeHost32 unavailable; continuing with JavaScript capabilities', error)
      }
      if (signal?.aborted) return
      try {
        if (signal?.aborted) return
        const serviceReady = await serviceClient.start(undefined, signal)
        if (!serviceReady) {
          console.warn(`ZToolsService unavailable: ${JSON.stringify(serviceClient.diagnostics)}`)
        }
      } catch (error) {
        if (signal?.aborted) return
        console.warn('ZToolsService unavailable; continuing without privileged capabilities', error)
      }
    }
  }
}
