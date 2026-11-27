import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import {
  TOOL_RUNTIME_CONTRACT_VERSION,
  TOOL_RUNTIME_ERROR_CODES,
  type CommonLibCleanRequest,
  type CommonLibCleanResult,
  type CommonLibListResult,
  type ToolCapabilityDescriptor,
  type ToolDomainId,
  type ToolRuntimeCapabilitiesSnapshot,
  type ToolRuntimeEnsureRequest,
  type ToolRuntimeEnsureResult,
  type ToolTaskCancelRequest,
  type ToolTaskCancelResult
} from '../../contracts/tool-runtime/common.js'
import {
  getToolPrimitiveCatalogEntry,
  isKnownToolPrimitiveId,
  TOOL_RUNTIME_ADMIN_IPC_METHODS,
  TOOL_RUNTIME_CORE_IPC_METHODS,
  TOOL_RUNTIME_IPC_METHODS,
  type ToolPrimitiveId,
  type ToolRuntimeIpcMethod
} from '../../contracts/tool-runtime/registry.js'
import type { PluginPermissionManifests } from '../ipc/plugin-principal.js'
import { resolvePluginPrincipal } from '../ipc/plugin-principal.js'
import {
  COMMONLIBS_DIR_NAME,
  CommonLibsManager,
  type CommonLibsCatalogSource,
  type CommonLibsGcOptions,
  type CommonLibsManagerOptions,
  type CommonLibStaticReferenceInfo,
  type CommonLibStaticReferenceMap
} from './core/commonlibs-manager.js'
import type { CommonLibsTrustBundle } from './core/commonlibs-trust.js'
import { ConcurrencyLimiter, type ConcurrencyLimiterOptions } from './core/concurrency-limiter.js'
import type {
  ToolDomainRegistration,
  ToolRuntimeCoreContext,
  ToolRuntimeIpcHandler
} from './core/domain-types.js'
import { createToolRuntimeError, isPlainObject } from './core/errors.js'
import { GuardedProcessRunner } from './core/guarded-process.js'
import { PathSlotGuard, type PathSlotGuardOptions } from './core/path-slot-guard.js'
import { ToolTaskManager, type ToolProgressEmitter } from './core/task-manager.js'
import { createDownloadDomain, type DownloadDomainDriver } from './domains/download/index.js'
import { createMediaDomain, type MediaDomainDriver } from './domains/media/index.js'

/**
 * 宿主薄原语与公共引擎工具池单一注册中心（ToolRuntimeRegistry）：
 * - 统一装配 CommonLibsManager / GuardedProcessRunner / PathSlotGuard / ConcurrencyLimiter / TaskManager；
 * - 启动期对域、原语 ID、IPC 方法名与域前缀执行 Fail-Fast 冲突校验；
 * - 对外一次性派生全部 14 个 tool_* IPC 处理器供 router.ts 单点展开挂载；
 * - 负责静态能力依赖映射、低优先级延迟 GC（不阻塞冷启动）以及窗口销毁/插件卸载级联清理。
 */

const RESERVED_CORE_AND_ADMIN_METHODS: ReadonlySet<string> = new Set<string>([
  ...TOOL_RUNTIME_CORE_IPC_METHODS,
  ...TOOL_RUNTIME_ADMIN_IPC_METHODS
])

export interface SignedNativeCommonLibDependency {
  readonly pluginId: string
  readonly toolIds: readonly string[]
}

export interface ToolRuntimeRegistryOptions {
  /** 业务数据根目录（CommonLibs 固定落于 <dataRoot>/CommonLibs，绝不触碰 Libraries） */
  readonly dataRoot: string
  /** 包含 commonlibs-public-keys.json / commonlibs-revocations.json 的资源目录 */
  readonly resourcesDir?: string
  /** 禁止写入的宿主受保护根目录集合 */
  readonly protectedRoots?: readonly string[]
  readonly platform?: NodeJS.Platform
  readonly processArch?: string
  readonly runningUnderARM64Translation?: boolean | null
  readonly homeDir?: string
  readonly trustBundle?: CommonLibsTrustBundle
  readonly allowedOrigins?: readonly string[]
  readonly catalogUrl?: string
  readonly catalogSigUrl?: string
  readonly fallbackCatalogBaseUrls?: readonly string[]
  readonly maxDownloadRetries?: number
  readonly retryBaseDelayMs?: number
  readonly catalogSource?: CommonLibsCatalogSource
  readonly fetchImpl?: typeof fetch
  readonly pathGrants?: PathSlotGuardOptions['pathGrants']
  readonly authorizeExplicitPath?: PathSlotGuardOptions['authorizeExplicitPath']
  readonly skipDiskStatForSimulatedPlatform?: boolean
  readonly manifests?: PluginPermissionManifests
  readonly listInstalledManifests?: () => Promise<readonly Record<string, unknown>[]>
  /** 读取已安装普通权限官方签名原生插件的已验签 CommonLibs 工具依赖（供 GC 静态引用与清单展示） */
  readonly listSignedNativeCommonLibs?: () => Promise<readonly SignedNativeCommonLibDependency[]>
  readonly onProgress?: ToolProgressEmitter
  readonly onAnalyticsEvent?: CommonLibsManagerOptions['onAnalyticsEvent']
  readonly concurrency?: ConcurrencyLimiterOptions
  readonly mediaDriver?: MediaDomainDriver
  readonly downloadDriver?: DownloadDomainDriver
  /** 可选自定义域注册表（用于扩展域或在测试中验证冲突 Fail-Fast 校验） */
  readonly domains?: readonly ToolDomainRegistration[]
  readonly now?: () => number
}

function toSnapshotPlatform(platform: NodeJS.Platform): 'windows' | 'macos' | 'other' {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'other'
}

export class ToolRuntimeRegistry {
  readonly #platform: NodeJS.Platform
  readonly #commonLibs: CommonLibsManager
  readonly #processRunner: GuardedProcessRunner
  readonly #pathGuard: PathSlotGuard
  readonly #limiter: ConcurrencyLimiter
  readonly #tasks: ToolTaskManager
  readonly #domains = new Map<ToolDomainId, ToolDomainRegistration>()
  readonly #primitiveOwners = new Map<ToolPrimitiveId, ToolDomainRegistration>()
  readonly #domainHandlers = new Map<string, ToolRuntimeIpcHandler>()
  readonly #listInstalledManifests?: () => Promise<readonly Record<string, unknown>[]>
  readonly #listSignedNativeCommonLibs?: () => Promise<readonly SignedNativeCommonLibDependency[]>
  #idleGcTimer: ReturnType<typeof setTimeout> | undefined
  #stopped = false

  constructor(options: ToolRuntimeRegistryOptions) {
    this.#platform = options.platform ?? process.platform
    if (options.listInstalledManifests) {
      this.#listInstalledManifests = options.listInstalledManifests
    }
    if (options.listSignedNativeCommonLibs) {
      this.#listSignedNativeCommonLibs = options.listSignedNativeCommonLibs
    }

    const commonLibsDir = path.resolve(options.dataRoot, COMMONLIBS_DIR_NAME)
    this.#processRunner = new GuardedProcessRunner({
      activeProcessesFile: path.join(commonLibsDir, '.active-processes.json'),
      platform: this.#platform
    })

    this.#commonLibs = new CommonLibsManager({
      dataRoot: options.dataRoot,
      ...(options.resourcesDir !== undefined ? { resourcesDir: options.resourcesDir } : {}),
      ...(options.trustBundle !== undefined ? { trustBundle: options.trustBundle } : {}),
      platform: this.#platform,
      ...(options.processArch !== undefined ? { processArch: options.processArch } : {}),
      ...(options.runningUnderARM64Translation !== undefined
        ? { runningUnderARM64Translation: options.runningUnderARM64Translation }
        : {}),
      ...(options.allowedOrigins !== undefined ? { allowedOrigins: options.allowedOrigins } : {}),
      ...(options.catalogUrl !== undefined ? { catalogUrl: options.catalogUrl } : {}),
      ...(options.catalogSigUrl !== undefined ? { catalogSigUrl: options.catalogSigUrl } : {}),
      ...(options.fallbackCatalogBaseUrls !== undefined
        ? { fallbackCatalogBaseUrls: options.fallbackCatalogBaseUrls }
        : {}),
      ...(options.maxDownloadRetries !== undefined
        ? { maxDownloadRetries: options.maxDownloadRetries }
        : {}),
      ...(options.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: options.retryBaseDelayMs } : {}),
      ...(options.catalogSource !== undefined ? { catalogSource: options.catalogSource } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      processRunner: this.#processRunner,
      ...(options.onAnalyticsEvent !== undefined ? { onAnalyticsEvent: options.onAnalyticsEvent } : {}),
      ...(options.now !== undefined ? { now: options.now } : {})
    })

    const defaultProtectedRoots = [
      options.dataRoot,
      commonLibsDir,
      path.resolve(options.dataRoot, 'Libraries'),
      path.resolve(options.dataRoot, 'Plugins'),
      ...(options.protectedRoots ?? [])
    ]

    this.#pathGuard = new PathSlotGuard({
      platform: this.#platform,
      protectedRoots: Array.from(new Set(defaultProtectedRoots)),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.pathGrants !== undefined ? { pathGrants: options.pathGrants } : {}),
      ...(options.authorizeExplicitPath !== undefined
        ? { authorizeExplicitPath: options.authorizeExplicitPath }
        : {}),
      ...(options.skipDiskStatForSimulatedPlatform !== undefined
        ? { skipDiskStatForSimulatedPlatform: options.skipDiskStatForSimulatedPlatform }
        : {})
    })

    this.#limiter = new ConcurrencyLimiter(options.concurrency)
    this.#tasks = new ToolTaskManager({
      ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
      ...(options.now !== undefined ? { now: options.now } : {})
    })

    const coreContext: ToolRuntimeCoreContext = {
      platform: this.#platform,
      commonLibs: this.#commonLibs,
      processRunner: this.#processRunner,
      pathGuard: this.#pathGuard,
      limiter: this.#limiter,
      tasks: this.#tasks,
      ...(options.manifests !== undefined ? { manifests: options.manifests } : {})
    }

    const registrations = options.domains ?? [
      createMediaDomain(coreContext, {
        ...(options.mediaDriver !== undefined ? { driver: options.mediaDriver } : {})
      }),
      createDownloadDomain(coreContext, {
        ...(options.downloadDriver !== undefined ? { driver: options.downloadDriver } : {})
      })
    ]

    this.#registerDomainsFailFast(registrations)
  }

  get commonLibs(): CommonLibsManager {
    return this.#commonLibs
  }

  get processRunner(): GuardedProcessRunner {
    return this.#processRunner
  }

  get pathGuard(): PathSlotGuard {
    return this.#pathGuard
  }

  get taskManager(): ToolTaskManager {
    return this.#tasks
  }

  /** 返回所有已注册薄原语的实时能力状态快照（tool_runtime_capabilities） */
  async getCapabilitiesSnapshot(): Promise<ToolRuntimeCapabilitiesSnapshot> {
    const capabilities: ToolCapabilityDescriptor[] = []
    for (const [primitiveId, registration] of this.#primitiveOwners.entries()) {
      const catalog = getToolPrimitiveCatalogEntry(primitiveId)
      const status = await registration.getCapabilityStatus(primitiveId)
      const optionalExtensions = registration.getOptionalExtensions?.(primitiveId) ?? []
      capabilities.push({
        primitiveId: catalog.primitiveId,
        domain: catalog.domain,
        summary: catalog.summary,
        ipcMethods: [...catalog.ipcMethods],
        requiredPermissions: [...catalog.requiredPermissions],
        status,
        optionalExtensions: [...optionalExtensions]
      })
    }
    return {
      contractVersion: TOOL_RUNTIME_CONTRACT_VERSION,
      platform: toSnapshotPlatform(this.#platform),
      domains: Array.from(this.#domains.keys()),
      capabilities
    }
  }

  /** 按需预热指定薄原语能力（tool_runtime_ensure） */
  async ensureCapability(
    request: ToolRuntimeEnsureRequest,
    caller: CallerIdentity,
    signal?: AbortSignal
  ): Promise<ToolRuntimeEnsureResult> {
    if (!isPlainObject(request) || typeof request.primitiveId !== 'string') {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'tool_runtime_ensure requires a string primitiveId',
        { fields: ['primitiveId'] }
      )
    }
    const unknownKeys = Object.keys(request).filter((key) => key !== 'primitiveId')
    if (unknownKeys.length > 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `tool_runtime_ensure contains unknown fields: ${unknownKeys.join(', ')}`,
        { fields: unknownKeys }
      )
    }
    if (!isKnownToolPrimitiveId(request.primitiveId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
        `Unknown tool primitiveId: ${request.primitiveId}`,
        { fields: ['primitiveId'] }
      )
    }
    const primitiveId: ToolPrimitiveId = request.primitiveId
    const registration = this.#primitiveOwners.get(primitiveId)
    if (!registration) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
        `Primitive "${primitiveId}" is not registered on this host`,
        { primitiveId }
      )
    }

    return this.#tasks.runManagedTask(
      {
        primitiveId,
        caller,
        ...(signal ? { upstreamSignal: signal } : {}),
        autoCompleteIfProgressed: true
      },
      async ({ task, emitProgress }) => {
        const result = await registration.ensureCapability(primitiveId, task.signal, emitProgress)
        if (result.provisioned) {
          emitProgress({ phase: 'completed', percent: 100 })
        }
        const pluginId = resolvePluginPrincipal(caller)?.pluginId
        if (pluginId) {
          for (const toolId of registration.getStaticToolIds(primitiveId)) {
            this.#commonLibs.recordLease(toolId, pluginId)
          }
        }
        return {
          primitiveId,
          status: result.status,
          provisioned: result.provisioned
        }
      }
    )
  }

  /** 按归属校验取消活跃工具任务（tool_task_cancel） */
  cancelTask(request: ToolTaskCancelRequest, caller: CallerIdentity): ToolTaskCancelResult {
    if (!isPlainObject(request) || typeof request.taskId !== 'string' || request.taskId.length === 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'tool_task_cancel requires a non-empty taskId',
        { fields: ['taskId'] }
      )
    }
    const unknownKeys = Object.keys(request).filter((key) => key !== 'taskId')
    if (unknownKeys.length > 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `tool_task_cancel contains unknown fields: ${unknownKeys.join(', ')}`,
        { fields: unknownKeys }
      )
    }
    return this.#tasks.cancelTask(request.taskId, caller)
  }

  /** 查询本地公共引擎工具池清单（tool_commonlibs_list，仅主窗口特权可调） */
  async listCommonLibs(): Promise<CommonLibListResult> {
    const staticRefs = await this.#resolveCurrentStaticReferences()
    return this.#commonLibs.listInventory(staticRefs)
  }

  /** 手动清理无引用/已撤销公共工具包或触发一次 GC（tool_commonlibs_clean，仅主窗口特权可调） */
  async cleanCommonLibs(request: CommonLibCleanRequest = {}): Promise<CommonLibCleanResult> {
    if (!isPlainObject(request)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'tool_commonlibs_clean request must be an object'
      )
    }
    const allowedKeys = new Set(['toolId', 'runGc'])
    const unknownKeys = Object.keys(request).filter((key) => !allowedKeys.has(key))
    if (unknownKeys.length > 0) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `tool_commonlibs_clean contains unknown fields: ${unknownKeys.join(', ')}`,
        { fields: unknownKeys }
      )
    }
    if (request.toolId !== undefined && (typeof request.toolId !== 'string' || request.toolId.length === 0)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'toolId must be a non-empty string',
        { fields: ['toolId'] }
      )
    }
    if (request.runGc !== undefined && typeof request.runGc !== 'boolean') {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'runGc must be a boolean',
        { fields: ['runGc'] }
      )
    }
    const staticRefs = await this.#resolveCurrentStaticReferences()
    return this.#commonLibs.cleanManual(request, staticRefs)
  }

  /**
   * 合并解析两路静态 CommonLibs 工具引用：
   * 1) 声明式插件清单中的 `requiredCapabilities` → 当前平台薄原语 Driver 映射的工具 ID；
   * 2) 普通权限官方签名原生插件经离线验签后的 `native-trust.json.commonLibs` 依赖。
   */
  resolveStaticCommonLibReferences(
    installedManifests: readonly Record<string, unknown>[],
    signedNativeDependencies: readonly SignedNativeCommonLibDependency[] = []
  ): CommonLibStaticReferenceMap {
    const result = new Map<string, { capabilities: Set<string>; plugins: Set<string> }>()
    for (const manifest of installedManifests) {
      const pluginId = typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : undefined
      if (!pluginId) continue
      const rawCaps = manifest.requiredCapabilities
      if (!Array.isArray(rawCaps)) continue
      for (const cap of rawCaps) {
        if (typeof cap !== 'string' || !isKnownToolPrimitiveId(cap)) continue
        const owner = this.#primitiveOwners.get(cap)
        if (!owner) continue
        const toolIds = owner.getStaticToolIds(cap)
        for (const toolId of toolIds) {
          let ref = result.get(toolId)
          if (!ref) {
            ref = { capabilities: new Set<string>(), plugins: new Set<string>() }
            result.set(toolId, ref)
          }
          ref.capabilities.add(cap)
          ref.plugins.add(pluginId)
        }
      }
    }
    for (const dep of signedNativeDependencies) {
      const pluginId = typeof dep.pluginId === 'string' ? dep.pluginId.trim() : ''
      if (!pluginId || !Array.isArray(dep.toolIds)) continue
      for (const rawToolId of dep.toolIds) {
        const toolId = typeof rawToolId === 'string' ? rawToolId.trim() : ''
        if (!toolId) continue
        let ref = result.get(toolId)
        if (!ref) {
          ref = { capabilities: new Set<string>(), plugins: new Set<string>() }
          result.set(toolId, ref)
        }
        ref.plugins.add(pluginId)
      }
    }
    return result as ReadonlyMap<string, CommonLibStaticReferenceInfo>
  }

  /** 一次性导出全部 tool_* IPC 处理器映射，供 IpcRouter 单点展开挂载 */
  getIpcHandlers(): Record<ToolRuntimeIpcMethod, ToolRuntimeIpcHandler> {
    const handlers: Record<string, ToolRuntimeIpcHandler> = {
      tool_runtime_capabilities: async () => this.getCapabilitiesSnapshot(),
      tool_runtime_ensure: async (params, caller, signal) =>
        this.ensureCapability(params as ToolRuntimeEnsureRequest, caller, signal),
      tool_task_cancel: async (params, caller) =>
        this.cancelTask(params as ToolTaskCancelRequest, caller),
      tool_commonlibs_list: async () => this.listCommonLibs(),
      tool_commonlibs_clean: async (params) =>
        this.cleanCommonLibs((params ?? {}) as CommonLibCleanRequest)
    }
    for (const [method, handler] of this.#domainHandlers.entries()) {
      handlers[method] = handler
    }
    // 校验总表完整性，防止漏挂载任何契约声明的方法
    for (const method of TOOL_RUNTIME_IPC_METHODS) {
      if (typeof handlers[method] !== 'function') {
        throw new Error(`ToolRuntimeRegistry is missing IPC handler for "${method}"`)
      }
    }
    return handlers as Record<ToolRuntimeIpcMethod, ToolRuntimeIpcHandler>
  }

  /** 窗口销毁时自动取消该窗口名下全部活跃工具任务 */
  closeOwner(webContentsId: number): void {
    this.#tasks.cancelOwnerTasks(webContentsId)
  }

  /** 插件卸载或禁用时清理其动态工具租约并取消该插件活跃任务 */
  clearPluginLeases(pluginId: string): void {
    this.#tasks.cancelPluginTasks(pluginId)
    this.#commonLibs.clearPluginLeases(pluginId)
  }

  /** 立即执行一次孤儿进程回收与静默 GC */
  async runIdleGc(options?: CommonLibsGcOptions): Promise<CommonLibCleanResult> {
    await this.#processRunner.reapOrphanProcesses()
    const staticRefs = await this.#resolveCurrentStaticReferences()
    return this.#commonLibs.runGc(staticRefs, options)
  }

  /** 启动后低优先级延迟触发孤儿回收与静默 GC（使用 unref，不阻塞冷启动与进程退出） */
  scheduleIdleGc(delayMs = 30_000): void {
    if (this.#stopped || this.#idleGcTimer) return
    this.#idleGcTimer = setTimeout(() => {
      this.#idleGcTimer = undefined
      if (this.#stopped) return
      void this.runIdleGc().catch((error: unknown) => {
        console.warn('CommonLibs 后台静默 GC 执行失败', error)
      })
    }, Math.max(0, delayMs))
    this.#idleGcTimer.unref?.()
  }

  /** 停止注册中心：取消延迟 GC、终止活跃任务与子进程并释放各域资源 */
  async stop(): Promise<void> {
    this.#stopped = true
    if (this.#idleGcTimer) {
      clearTimeout(this.#idleGcTimer)
      this.#idleGcTimer = undefined
    }
    this.#tasks.stop()
    this.#limiter.stop()
    const stops: Promise<unknown>[] = [this.#processRunner.stop()]
    for (const domain of this.#domains.values()) {
      if (domain.stop) {
        stops.push(Promise.resolve().then(() => domain.stop?.()))
      }
    }
    await Promise.allSettled(stops)
  }

  #registerDomainsFailFast(registrations: readonly ToolDomainRegistration[]): void {
    for (const registration of registrations) {
      if (this.#domains.has(registration.domain)) {
        throw new Error(`Duplicate tool domain registration: "${registration.domain}"`)
      }
      this.#domains.set(registration.domain, registration)

      const expectedPrefix = `tool_${registration.domain}_`
      const declaredMethods = new Set<string>()

      for (const primitiveId of registration.primitiveIds) {
        if (this.#primitiveOwners.has(primitiveId)) {
          throw new Error(`Duplicate tool primitiveId registration: "${primitiveId}"`)
        }
        if (!isKnownToolPrimitiveId(primitiveId)) {
          throw new Error(`Unregistered tool primitiveId in contract catalog: "${primitiveId}"`)
        }
        const catalog = getToolPrimitiveCatalogEntry(primitiveId)
        if (catalog.domain !== registration.domain) {
          throw new Error(
            `Primitive "${primitiveId}" belongs to domain "${catalog.domain}", cannot be registered by "${registration.domain}"`
          )
        }
        this.#primitiveOwners.set(primitiveId, registration)
        for (const method of catalog.ipcMethods) {
          declaredMethods.add(method)
        }
      }

      for (const [methodName, handler] of Object.entries(registration.handlers)) {
        if (RESERVED_CORE_AND_ADMIN_METHODS.has(methodName)) {
          throw new Error(
            `Domain "${registration.domain}" cannot override reserved core/admin IPC method "${methodName}"`
          )
        }
        if (!methodName.startsWith(expectedPrefix)) {
          throw new Error(
            `Domain "${registration.domain}" attempted to register cross-domain IPC method "${methodName}" (expected prefix "${expectedPrefix}")`
          )
        }
        if (this.#domainHandlers.has(methodName)) {
          throw new Error(`Duplicate tool IPC method registration: "${methodName}"`)
        }
        this.#domainHandlers.set(methodName, handler)
      }

      for (const method of declaredMethods) {
        if (!Object.prototype.hasOwnProperty.call(registration.handlers, method)) {
          throw new Error(
            `Domain "${registration.domain}" is missing declared IPC handler "${method}"`
          )
        }
      }
    }
  }

  async #resolveCurrentStaticReferences(): Promise<CommonLibStaticReferenceMap> {
    if (!this.#listInstalledManifests && !this.#listSignedNativeCommonLibs) {
      return new Map()
    }
    let manifests: readonly Record<string, unknown>[] = []
    if (this.#listInstalledManifests) {
      try {
        manifests = await this.#listInstalledManifests()
      } catch (error) {
        console.warn('读取已安装插件清单以计算 CommonLibs 静态引用失败', error)
      }
    }
    let signedNativeDeps: readonly SignedNativeCommonLibDependency[] = []
    if (this.#listSignedNativeCommonLibs) {
      try {
        signedNativeDeps = await this.#listSignedNativeCommonLibs()
      } catch (error) {
        console.warn('读取已签名原生插件 CommonLibs 静态引用失败', error)
      }
    }
    return this.resolveStaticCommonLibReferences(manifests, signedNativeDeps)
  }
}
