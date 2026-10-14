import path from 'node:path'

export type PortablePlatform = 'win32' | 'linux' | 'darwin'
export type PortableRuntimeMode = 'production' | 'development' | 'test'
export type CapabilityState = 'supported' | 'unsupported' | 'degraded' | 'requires-user-action'

export interface PortableRuntimePaths {
  platform: PortablePlatform
  mode: PortableRuntimeMode
  appDataRoot: string
  installRoot: string
  productRoot: string
  businessDataRoot: string
  browserProfileRoot: string
  cacheRoot: string
  transactionRoot: string
  backupRoot: string
  ownerId: string
}

export interface PortableRuntimePathOptions {
  platform: PortablePlatform
  mode: PortableRuntimeMode
  appDataRoot: string
  installRoot: string
  userDataRoot?: string
  businessDataRoot?: string
  ownerId?: string
}

export interface PluginIdConflict {
  comparisonKey: string
  pluginIds: string[]
}

export interface ExternalPathPortability {
  originalPath: string
  relativePath?: string
  state: 'portable-relative' | 'requires-relink' | 'absolute-preserved'
  reason?: string
}

export interface PlatformCapability {
  state: CapabilityState
  reason: string
}

export interface PlatformCapabilities {
  platform: PortablePlatform
  arch: string
  nativeHost: PlatformCapability
  dllPlugins: PlatformCapability
  privilegedService: PlatformCapability
  browserProfileImport: PlatformCapability
  encryptedCredentials: PlatformCapability
}

interface PathApi {
  isAbsolute(value: string): boolean
  normalize(value: string): string
  join(...values: string[]): string
  dirname(value: string): string
  relative(from: string, to: string): string
}

function getPathApi(platform: PortablePlatform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix
}

function requireAbsolute(api: PathApi, name: string, value: string): string {
  if (!value || !api.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`)
  }
  return api.normalize(value)
}

function defaultProductRoot(api: PathApi, options: PortableRuntimePathOptions): string {
  if (options.mode === 'production') {
    return api.join(options.appDataRoot, 'ZTools')
  }
  if (options.businessDataRoot) {
    return api.dirname(requireAbsolute(api, 'businessDataRoot', options.businessDataRoot))
  }
  return api.join(options.userDataRoot ?? api.join(options.appDataRoot, 'ZTools-Electron'), options.mode)
}

export function resolvePortableRuntimePaths(options: PortableRuntimePathOptions): PortableRuntimePaths {
  const api = getPathApi(options.platform)
  const appDataRoot = requireAbsolute(api, 'appDataRoot', options.appDataRoot)
  const installRoot = requireAbsolute(api, 'installRoot', options.installRoot)
  const productRoot = requireAbsolute(api, 'productRoot', defaultProductRoot(api, options))
  const businessDataRoot = requireAbsolute(
    api,
    'businessDataRoot',
    options.mode === 'production'
      ? api.join(appDataRoot, 'ZTools', 'Data')
      : (options.businessDataRoot ?? api.join(productRoot, 'Data')),
  )

  return {
    platform: options.platform,
    mode: options.mode,
    appDataRoot,
    installRoot,
    productRoot,
    businessDataRoot,
    browserProfileRoot: api.join(productRoot, 'ElectronProfile'),
    cacheRoot: api.join(productRoot, 'Cache'),
    transactionRoot: api.join(productRoot, 'Migration', 'Transactions'),
    backupRoot: api.join(productRoot, 'Migration', 'Backups'),
    ownerId: options.ownerId ?? 'unknown-owner',
  }
}

export function pluginIdComparisonKey(platform: PortablePlatform, pluginId: string): string {
  const normalized = pluginId.trim()
  if (!normalized) {
    throw new Error('pluginId must not be empty')
  }
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function findPluginIdConflicts(platform: PortablePlatform, pluginIds: readonly string[]): PluginIdConflict[] {
  const groups = new Map<string, string[]>()
  for (const pluginId of pluginIds) {
    const key = pluginIdComparisonKey(platform, pluginId)
    const group = groups.get(key) ?? []
    if (!group.includes(pluginId)) {
      group.push(pluginId)
    }
    groups.set(key, group)
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([comparisonKey, ids]) => ({ comparisonKey, pluginIds: [...ids].sort() }))
    .sort((left, right) => left.comparisonKey.localeCompare(right.comparisonKey))
}

export function classifyExternalPath(
  platform: PortablePlatform,
  root: string,
  externalPath: string,
): ExternalPathPortability {
  const api = getPathApi(platform)
  const normalizedRoot = requireAbsolute(api, 'root', root)
  const normalizedExternalPath = requireAbsolute(api, 'externalPath', externalPath)
  const relativePath = api.relative(normalizedRoot, normalizedExternalPath)
  const parentPrefix = platform === 'win32' ? '..\\' : '../'
  const isOutsideRoot = relativePath === '..' || relativePath.startsWith(parentPrefix) || api.isAbsolute(relativePath)
  if (!isOutsideRoot) {
    return {
      originalPath: externalPath,
      relativePath: relativePath || '.',
      state: 'portable-relative',
    }
  }
  return {
    originalPath: externalPath,
    state: 'requires-relink',
    reason: 'path is outside the portable data root',
  }
}

function capability(state: CapabilityState, reason: string): PlatformCapability {
  return { state, reason }
}

export function getPlatformCapabilities(
  platform: PortablePlatform,
  arch: string,
  options: { nativeHost?: boolean; dllPlugins?: boolean; privilegedService?: boolean; encryptedCredentials?: boolean } = {},
): PlatformCapabilities {
  const hasNativeHost = options.nativeHost ?? true
  const hasDllPlugins = options.dllPlugins ?? true
  const hasPrivilegedService = options.privilegedService ?? true
  const hasEncryptedCredentials = options.encryptedCredentials ?? false
  const windowsX86Host = platform === 'win32' && (arch === 'ia32' || arch === 'x64')

  return {
    platform,
    arch,
    nativeHost: hasNativeHost
      ? windowsX86Host
        ? capability('supported', 'Windows native host contract is available')
        : capability('unsupported', 'native host is only available on Windows')
      : capability('unsupported', 'package does not contain a native host'),
    dllPlugins: hasDllPlugins
      ? platform === 'win32'
        ? capability('supported', 'Windows DLL plugin contract is available')
        : capability('unsupported', 'DLL plugins require the Windows loader contract')
      : capability('unsupported', 'package does not contain DLL plugin support'),
    privilegedService: hasPrivilegedService
      ? platform === 'win32'
        ? capability('requires-user-action', 'service install requires an elevated Windows transaction')
        : capability('unsupported', 'privileged service is only available on Windows')
      : capability('unsupported', 'package does not contain the privileged service'),
    browserProfileImport: platform === 'win32'
      ? capability('supported', 'Electron profile storage is isolated per plugin session')
      : capability('degraded', 'browser profile import requires a platform-specific adapter'),
    encryptedCredentials: hasEncryptedCredentials
      ? capability('requires-user-action', 'encrypted credentials are never copied as portable ciphertext')
      : capability('supported', 'no encrypted credential material is included'),
  }
}

export function classifyCredentialPortability(input: {
  encrypted: boolean
  sourcePlatform: PortablePlatform
  targetPlatform: PortablePlatform
}): PlatformCapability {
  if (!input.encrypted) {
    return capability('supported', 'credential record contains no machine-bound ciphertext')
  }
  if (input.sourcePlatform === input.targetPlatform) {
    return capability('requires-user-action', 'credential must be reauthenticated on the target machine or profile')
  }
  return capability('unsupported', 'machine-bound credential ciphertext is not portable across platforms')
}
