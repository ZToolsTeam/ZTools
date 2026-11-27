import { isInternalPlugin, type CallerIdentity } from '../../../contracts/capabilities.js'
import type {
  ToolCapabilityStatus,
  ToolDomainId,
  ToolRuntimePermission
} from '../../../contracts/tool-runtime/common.js'
import type { ToolPrimitiveId } from '../../../contracts/tool-runtime/registry.js'
import {
  isHostCaller,
  requirePluginPermission,
  resolvePluginPrincipal,
  type PluginPermissionManifests
} from '../../ipc/plugin-principal.js'
import type { CommonLibsManager } from './commonlibs-manager.js'
import type { ConcurrencyLimiter } from './concurrency-limiter.js'
import type { GuardedProcessRunner } from './guarded-process.js'
import type { PathSlotGuard } from './path-slot-guard.js'
import type { ToolTaskManager, ToolTaskProgressPayload } from './task-manager.js'

export type ToolRuntimeIpcHandler = (
  params: unknown,
  caller: CallerIdentity,
  signal: AbortSignal
) => Promise<unknown>

/** 能力域执行层共享的宿主核心底座上下文 */
export interface ToolRuntimeCoreContext {
  readonly platform: NodeJS.Platform
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  readonly pathGuard: PathSlotGuard
  readonly limiter: ConcurrencyLimiter
  readonly tasks: ToolTaskManager
  readonly manifests?: PluginPermissionManifests
}

/** 单个能力域向 ToolRuntimeRegistry 提交的标准注册清单 */
export interface ToolDomainRegistration {
  readonly domain: ToolDomainId
  readonly primitiveIds: readonly ToolPrimitiveId[]
  readonly handlers: Readonly<Record<string, ToolRuntimeIpcHandler>>
  getCapabilityStatus(primitiveId: ToolPrimitiveId): Promise<ToolCapabilityStatus>
  ensureCapability(
    primitiveId: ToolPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{
    readonly status: ToolCapabilityStatus
    readonly provisioned: boolean
  }>
  getOptionalExtensions?(primitiveId: ToolPrimitiveId): readonly string[]
  /** 返回当前平台该原语静态映射的 CommonLibs 工具 ID 列表（供 GC 静态引用追踪） */
  getStaticToolIds(primitiveId: ToolPrimitiveId): readonly string[]
  stop?(): Promise<void> | void
}

/**
 * 统一薄原语权限校验：
 * - 宿主自身（未归属插件的主窗口）及官方受信任 internal-* 内置插件放行；
 * - 其余独立插件窗口与主窗口声明式插件会话强制校验 plugin.json 声明的所需权限；
 * - 若未注入 manifests（仅离线单测场景），仍对已归属声明式插件检查其会话权限集合。
 */
export async function enforceToolRuntimePermission(
  caller: CallerIdentity,
  permission: ToolRuntimePermission,
  manifests?: PluginPermissionManifests
): Promise<{ readonly pluginKey: string; readonly pluginId?: string }> {
  if (isHostCaller(caller)) {
    return { pluginKey: 'host' }
  }
  if (caller.type === 'plugin' && isInternalPlugin(caller.pluginId)) {
    return {
      pluginKey: caller.pluginId ?? 'internal',
      ...(caller.pluginId ? { pluginId: caller.pluginId } : {})
    }
  }
  if (manifests) {
    const principal = await requirePluginPermission(caller, permission, manifests)
    return { pluginKey: principal.pluginId, pluginId: principal.pluginId }
  }
  const principal = resolvePluginPrincipal(caller)
  if (!principal) {
    // 兜底交由 requirePluginPermission 抛出标准 PLUGIN_IDENTITY_REQUIRED
    await requirePluginPermission(caller, permission, {
      withPluginManifest: async () => {
        throw new Error('Manifests unavailable')
      }
    })
  }
  if (caller.type === 'main' && caller.attributedPlugin) {
    await requirePluginPermission(caller, permission, {
      withPluginManifest: (_pluginId, action) => action({})
    })
  }
  return {
    pluginKey: principal?.pluginId ?? `wc:${caller.webContentsId}`,
    ...(principal?.pluginId ? { pluginId: principal.pluginId } : {})
  }
}
