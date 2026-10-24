import { isInternalPlugin, type CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export interface PluginPrincipal {
  readonly pluginId: string
  readonly instanceId: string
  /** window = 旧式插件窗口（主进程登记的身份）；session = 主窗口声明式插件的会话归属 */
  readonly kind: 'window' | 'session'
}

export interface PluginPermissionManifests {
  withPluginManifest<T>(pluginId: string, action: (manifest: Record<string, unknown>) => Promise<T>): Promise<T>
}

/** 调用来自哪个插件：插件窗口按注册身份，主窗口按会话归属；宿主自身返回 undefined */
export function resolvePluginPrincipal(caller: CallerIdentity): PluginPrincipal | undefined {
  if (caller.type === 'plugin') {
    return caller.pluginId
      ? { pluginId: caller.pluginId, instanceId: caller.pluginInstanceId ?? '', kind: 'window' }
      : undefined
  }
  if (caller.type === 'main' && caller.attributedPlugin) {
    return {
      pluginId: caller.attributedPlugin.pluginId,
      instanceId: caller.attributedPlugin.sessionId,
      kind: 'session'
    }
  }
  return undefined
}

/**
 * 是否是宿主自身发起的调用：主窗口、未归属到任何插件、也没带失效的插件会话令牌。
 * 插件窗口（无论是否带 pluginId）、主窗口里带有效插件会话的调用、带失效令牌的调用（插件关闭 / 下架 / 更新后
 * 迟到的请求）都不算宿主，用于决定登录凭据等只给宿主的敏感数据能否下发。
 */
export function isHostCaller(caller: CallerIdentity): boolean {
  return caller.type === 'main' && caller.attributedPlugin === undefined && caller.stalePluginSession !== true
}

/**
 * 需要归属的能力的统一闸门：
 * - 未归属调用（宿主自身或不带令牌的插件代码）一律 PLUGIN_IDENTITY_REQUIRED，不回落为宿主身份放行；
 * - 插件窗口：只有 internal-* 受信任插件免检，其余按 plugin.json 现读（顺带拦截已下架 / 禁用）；
 * - 会话归属：一律按会话打开时主进程读到的清单权限判定（会话随下架 / 更新失效），bundled 不等于受信任。
 */
export async function requirePluginPermission(
  caller: CallerIdentity,
  permission: string,
  manifests: PluginPermissionManifests
): Promise<PluginPrincipal> {
  const principal = resolvePluginPrincipal(caller)
  if (!principal) {
    throw new ZToolsError(errorCodes.pluginIdentityRequired, '该能力需要由已安装插件调用')
  }
  if (principal.kind === 'window') {
    if (isInternalPlugin(principal.pluginId)) return principal
    const permissions = await manifests.withPluginManifest(principal.pluginId, async manifest => manifest.permissions)
    if (!Array.isArray(permissions) || !permissions.includes(permission)) {
      throw new ZToolsError(
        errorCodes.pluginPermissionRequired,
        `插件需要在 plugin.json 声明 "${permission}" 权限`,
        { public: { permission } }
      )
    }
    return principal
  }
  if (!caller.attributedPlugin?.permissions.has(permission)) {
    throw new ZToolsError(
      errorCodes.pluginPermissionRequired,
      `插件需要在 plugin.json 声明 "${permission}" 权限`,
      { public: { permission } }
    )
  }
  return principal
}
