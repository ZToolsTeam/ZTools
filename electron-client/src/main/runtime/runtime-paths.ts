import { execFileSync } from 'node:child_process'
import path from 'node:path'

export type RuntimeMode = 'production' | 'development' | 'test'

export interface RuntimePaths {
  mode: RuntimeMode
  installRoot: string
  businessDataRoot: string
  browserProfileRoot: string
  cacheRoot: string
  transactionRoot: string
  backupRoot: string
  logRoot: string
  ownerId: string
}

export interface RuntimePathsOptions {
  mode: RuntimeMode
  appDataRoot: string
  installRoot: string
  productRoot?: string
  userDataRoot?: string
  businessDataRoot?: string
  ownerId?: string
}

function requireAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} 必须是绝对路径`)
  return path.normalize(value)
}

function productRootFor(options: RuntimePathsOptions): string {
  if (options.productRoot) return options.productRoot
  if (options.mode === 'production') return path.join(options.appDataRoot, 'ZTools')
  if (options.businessDataRoot) return path.dirname(options.businessDataRoot)
  return path.join(
    options.userDataRoot ?? path.join(options.appDataRoot, 'ZTools-Electron'),
    options.mode
  )
}

export function resolveRuntimePaths(options: RuntimePathsOptions): RuntimePaths {
  const appDataRoot = requireAbsolute('appDataRoot', options.appDataRoot)
  const installRoot = requireAbsolute('installRoot', options.installRoot)
  const normalizedProductRoot = requireAbsolute(
    'productRoot',
    productRootFor({ ...options, appDataRoot, installRoot })
  )
  const businessDataRoot = options.businessDataRoot ?? (
    options.mode === 'production'
      ? path.join(appDataRoot, 'ZTools', 'Data')
      : path.join(normalizedProductRoot, 'Data')
  )
  const normalizedDataRoot = requireAbsolute('businessDataRoot', businessDataRoot)

  return {
    mode: options.mode,
    installRoot,
    businessDataRoot: normalizedDataRoot,
    browserProfileRoot: path.join(normalizedProductRoot, 'ElectronProfile'),
    cacheRoot: path.join(normalizedProductRoot, 'Cache'),
    transactionRoot: path.join(normalizedProductRoot, 'Migration', 'Transactions'),
    backupRoot: path.join(normalizedProductRoot, 'Migration', 'Backups'),
    logRoot: path.join(normalizedProductRoot, 'Logs'),
    ownerId: options.ownerId ?? resolveOwnerId()
  }
}

export function runtimePathsForBusinessDataRoot(
  businessDataRoot: string,
  ownerId = 'test-owner'
): RuntimePaths {
  const normalizedDataRoot = requireAbsolute('businessDataRoot', businessDataRoot)
  return resolveRuntimePaths({
    mode: 'test',
    appDataRoot: path.dirname(normalizedDataRoot),
    installRoot: path.dirname(normalizedDataRoot),
    businessDataRoot: normalizedDataRoot,
    ownerId
  })
}

export function legacyCefProfileRoot(paths: Pick<RuntimePaths, 'installRoot'>): string {
  return path.join(paths.installRoot, 'CEF Libraries', 'cache')
}

export function resolveOwnerId(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== 'win32') {
    return `${platform}:${environment.USERNAME ?? environment.USER ?? 'unknown'}`
  }

  try {
    const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true
    })
    const sid = output.match(/"(S-1-[0-9-]+)"\s*$/m)?.[1]
    if (sid) return sid
  } catch {
    // Keep startup deterministic when the identity helper is unavailable.
  }

  const account = [environment.USERDOMAIN, environment.USERNAME]
    .filter((value): value is string => Boolean(value))
    .join('\\')
  return account ? `windows-account:${account}` : 'windows-account:unknown'
}
