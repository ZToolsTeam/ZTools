import path from 'node:path'

export interface ExtensionDirectories {
  codeDir: string
  supportDir: string
  cacheDir: string
  preferencesFile: string
}

/**
 * 严格分离扩展代码目录与数据/偏好目录 (M2-6)
 * - 代码目录: <数据根>/extensions/<id>
 * - 支持/缓存/数据目录: <数据根>/extension-support/<id>
 */
export function resolveExtensionDirectories(
  extensionId: string,
  dataRoot: string
): ExtensionDirectories {
  const sanitizedId = extensionId.replace(/[^a-zA-Z0-9_.-]/g, '_')
  const codeDir = path.join(dataRoot, 'extensions', sanitizedId)
  const supportDir = path.join(dataRoot, 'extension-support', sanitizedId)
  const cacheDir = path.join(supportDir, 'cache')
  const preferencesFile = path.join(supportDir, 'preferences.json')

  return {
    codeDir,
    supportDir,
    cacheDir,
    preferencesFile
  }
}
