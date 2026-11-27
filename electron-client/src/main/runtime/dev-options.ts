import path from 'node:path'

export interface DevRuntimeOptions {
  /** 通过 --data-root= 指定的绝对业务数据根目录（生产与测试/开发均可显式指定） */
  readonly requestedDataRoot?: string
  /** 与业务数据目录同级的独立 Electron userData 目录，用于彻底隔离单例锁与本地存储 */
  readonly isolatedUserDataRoot?: string
  /** 是否处于非打包态的独立开发数据目录隔离模式 */
  readonly isDevIsolated: boolean
  /** 仅非打包态生效：是否允许显示并打开位于本地数据目录中的 draft 草稿插件 */
  readonly devAllowDrafts: boolean
  /** 仅非打包态生效：用于验签本地预置 CommonLibs V2 工具池的额外开发公钥文件路径 */
  readonly devCommonLibsPublicKeysPath?: string
}

export interface ParseDevRuntimeOptionsContext {
  readonly isPackaged: boolean
  readonly cwd?: string
}

function readArgValue(argv: readonly string[], prefix: string): string | undefined {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const item = argv[i]
    if (typeof item === 'string' && item.startsWith(prefix)) {
      const value = item.slice(prefix.length).trim()
      if (value.length > 0) return value
    }
  }
  return undefined
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag)
}

function resolveCliPath(raw: string, cwd: string): string {
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw)
}

/**
 * 解析启动期数据目录隔离与开发调试选项。
 * 安全红线：当 isPackaged === true（正式安装包）时，强制忽略全部 --dev-* 开关，
 * 绝不在生产构建中放行草稿插件或加载额外开发公钥。
 */
export function parseDevRuntimeOptions(
  argv: readonly string[],
  context: ParseDevRuntimeOptionsContext
): DevRuntimeOptions {
  const cwd = context.cwd ?? process.cwd()
  const rawDataRoot = readArgValue(argv, '--data-root=')
  const requestedDataRoot = rawDataRoot ? resolveCliPath(rawDataRoot, cwd) : undefined

  if (context.isPackaged) {
    // 打包态 100% 保持线上既有行为：仅保留原有 --data-root 解析，绝不改动 userData 路径，绝不启用任何 --dev-* 开关
    return {
      ...(requestedDataRoot ? { requestedDataRoot } : {}),
      isDevIsolated: false,
      devAllowDrafts: false
    }
  }

  const isolatedUserDataRoot = requestedDataRoot
    ? path.join(path.dirname(requestedDataRoot), 'UserData')
    : undefined

  const rawDevCommonLibsKeys = readArgValue(argv, '--dev-commonlibs-public-keys=')
  const devCommonLibsPublicKeysPath = rawDevCommonLibsKeys
    ? resolveCliPath(rawDevCommonLibsKeys, cwd)
    : undefined
  const devAllowDrafts = hasFlag(argv, '--dev-allow-drafts') && !hasFlag(argv, '--dev-exclude-drafts')
  const isDevIsolated = Boolean(requestedDataRoot || devCommonLibsPublicKeysPath || devAllowDrafts)

  return {
    ...(requestedDataRoot ? { requestedDataRoot } : {}),
    ...(isolatedUserDataRoot ? { isolatedUserDataRoot } : {}),
    isDevIsolated,
    devAllowDrafts,
    ...(devCommonLibsPublicKeysPath ? { devCommonLibsPublicKeysPath } : {})
  }
}
