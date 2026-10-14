import { bindNativeThemeEvents } from '../platform/native-theme-events.js'
import {
  app,
  BrowserWindow,
  clipboard as electronClipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  nativeImage,
  Notification,
  powerSaveBlocker,
  shell as electronShell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { FILE_DROP_CHANNEL, FileDropService } from '../services/file-drop-service.js'
import os from 'node:os'
import path from 'node:path'
import {
  canCall,
  isAllowedMethod,
  isInternalPlugin,
  isPlatformSupportedMethod,
  isPrivilegedMethod,
  type AllowedMethod,
  type CallerIdentity
} from '../../contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import {
  RUNTIME_CAPABILITY_CONTRACT_VERSION,
  SDK_HOST_MAXIMUM_CONTRACT_VERSION
} from '../../contracts/protocol-versions.js'
import { SDK_LANE_HANDSHAKE_CHANNEL } from '../../contracts/sdk-lane-handshake.js'
import { parseReferenceCancellation, REFERENCE_CANCEL_CHANNEL } from '../../contracts/reference-transport.js'
import {
  parseRuntimeCapabilityRequestCancellation,
  RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL
} from '../../contracts/runtime-capability-request-cancel.js'
import {
  NETWORK_REQUEST_CANCEL_CHANNEL
} from '../../contracts/network-request-cancel.js'
import {
  DEFAULT_TIMEOUT_MS,
  IPC_CALL_CHANNEL,
  parseRequest,
  type ZToolsRequest,
  type ZToolsResponse
} from '../../contracts/ipc.js'
import {
  validateMethodParams,
  type AnalyticsReportParams,
  type ClipboardCopyTextParams,
  type ClipboardFileParams,
  type ClipboardFilesParams,
  type ClipboardImageParams,
  type ConfigGetParams,
  type ConfigSetParams,
  type CredentialV1KeyParams,
  type CredentialV1SetParams,
  type DatabaseBatchParams,
  type DatabaseGetParams,
  type DatabaseKeyParams,
  type DatabasePutParams,
  type DatabaseQueryParams,
  type DatabaseSecurePutParams,
  type DllPluginCallParams,
  type DllPluginClearTaskParams,
  type DllPluginTaskParams,
  type EventEnvelopeParams,
  type EventKeyParams,
  type FileCacheReadChunkParams,
  type FileCacheWriteStartParams,
  type FileCacheParams,
  type FileCombineParams,
  type FileCopyParams,
  type FileFindParams,
  type FilePathParams,
  type FileReadChunkParams,
  type FileReadParams,
  type FileWriteChunkParams,
  type FileWriteHandleParams,
  type FileWriteParams,
  type FileWriteStartParams,
  type NetworkGetCookieParams,
  type NetworkHttpRequestParams,
  type NetworkSetCookieParams,
  type NetworkSetProxyParams,
  type NetworkTransferParams,
  type PluginDataRestoreParams,
  type ProcessExistsParams,
  type ProcessFindParams,
  type ProcessKillByNameParams,
  type ProcessKillParams,
  type ProcessPidParams,
  type PluginInstallParams,
  type PluginIconRefreshParams,
  type PluginKeyParams,
  type PluginOpenParams,
  type PluginWindowCloseParams,
  type ProcessStartParams,
  type ProcessWaitParams,
  type RuntimeCapabilityGrantRevokeParams,
  type RuntimeCapabilityQueryParams,
  type ScreenCaptureParams,
  type ScreenPointParams,
  type ScreenRectParams,
  type SettingsGetParams,
  type SettingsSetParams,
  type ShellOpenExternalParams,
  type ShellPathParams,
  type SystemDarkModeParams,
  type SystemAutostartParams,
  type SystemDiskUsageParams,
  type SystemFileIconParams,
  type SystemSearchFilesParams,
  type SystemForceParams,
  type SystemKeyComboParams,
  type SystemKeyParams,
  type SystemMouseClickParams,
  type SystemMouseMoveParams,
  type SystemMouseWheelParams,
  type SystemNotifyParams,
  type SystemPathParams,
  type SystemPreventSleepParams,
  type SystemShutdownParams,
  type SystemTextParams,
  type TriggerConflictParams,
  type TriggerListParams,
  type TriggerRegisterParams,
  type TriggerSetEnabledParams,
  type UpdateCheckParams,
  type UpdatePackageParams,
  type UserSetTokenParams,
  type WindowCloseConfirmParams,
  type WindowDialogParams,
  type WindowSetAlwaysOnTopParams,
  type WindowSetHeightParams,
  type WindowSetOpacityParams,
  type WindowSetSizeParams,
  type WindowUrlParams
} from '../../contracts/method-params.js'
import {
  createNativeRuntimeDiagnosticsFallback,
  getRuntimeDiagnostics,
  RuntimeDiagnosticFailureStore,
  sanitizeRuntimeDiagnosticDetails
} from '../services/runtime-diagnostics.js'
import type { RuntimeDiagnosticFailureInput } from '../services/runtime-diagnostics.js'
import type { CoreServices } from '../services/core-services.js'
import type { FeatureFlagKey, FeatureFlags } from '../services/config-service.js'
import { EventService } from '../services/event-service.js'
import { FileSystemService } from '../services/file-system-service.js'
import { ClipboardService } from '../services/clipboard-service.js'
import { DatabaseService } from '../services/database-service.js'
import { electronCredentialProtection } from '../platform/electron-credential-protection.js'
import { DllPluginService } from '../services/dll-plugin-service.js'
import type { NativeInputInjectionAdapter } from '../native-host/native-host-client.js'
import { NativeMediaPathPolicy } from '../services/native-media-policy.js'
import { NetworkService } from '../services/network-service.js'
import { NetworkRequestCancellationService } from '../services/network-request-cancellation-service.js'
import { NetworkRequestCancellationEndpoint } from './network-request-cancellation-endpoint.js'
import { PluginInstallService } from '../services/plugin-install-service.js'
import { resolvePluginRuntimeTarget } from '../services/plugin-runtime-target-resolver.js'
import { ProcessService, type ProcessDiscoveryAdapter } from '../services/process-service.js'
import { PluginIconService } from '../services/plugin-icon-service.js'
import { PluginShortcutService } from '../services/plugin-shortcut-service.js'
import { PluginStateService } from '../services/plugin-state-service.js'
import {
  RuntimeCapabilityService,
  type RuntimeCapabilityProviders
} from '../services/runtime-capability-service.js'
import { createRuntimeCapabilityProviders } from '../services/runtime-capability-providers.js'
import { RUNTIME_CAPABILITY_CATALOG } from '../services/runtime-capability-catalog.js'
import { RUNTIME_PERMISSION_CHANGED_EVENT, type RuntimeCapabilityRecord } from '../../contracts/runtime-capability.js'
import { createRuntimeIdentity } from '../platform/runtime-identity.js'
import { resolveRuntimeIdentityTarget } from '../platform/runtime-identity-target.js'
import { createPathSemanticsAdapter } from '../platform/path-semantics.js'
import type { PathSemanticsAdapter } from '../platform/path-semantics.js'
import { ScreenService } from '../services/screen-service.js'
import type { ScreenClipboardAdapters } from '../platform/screen-clipboard.js'
import { createElectronGlobalShortcutAdapter } from '../platform/common/electron-global-shortcut.js'
import type { SystemPlatformAdapter } from '../platform/system.js'
import { ShellService } from '../services/shell-service.js'
import { RuntimePermissionMonitorService } from '../services/runtime-permission-monitor-service.js'
import { RuntimeCapabilityAuthorizationService } from '../services/runtime-capability-authorization-service.js'
import { RuntimeCapabilityPromptService } from '../services/runtime-capability-prompt-service.js'
import { RuntimeCapabilityRequestCancellationService } from '../services/runtime-capability-request-cancellation-service.js'
import { LoginItemConfigService } from '../services/login-item-config-service.js'
import type { MacosLoginItemAdapter } from '../platform/macos/login-item.js'
import { SystemService } from '../services/system-service.js'
import { TriggerService, type KeyboardDoubleTapAdapter } from '../services/trigger-service.js'
import { AutostartService } from '../services/autostart-service.js'
import { WindowService } from '../services/window-service.js'
import {
  createSuperPanelInputService,
  type SuperPanelInputService
} from '../super-panel/input-service.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { PluginWindowManager } from '../windows/plugin-window-manager.js'
import { constructWithRouterRollback, type RouterConstructionScope } from './router-construction.js'
import type { ReferenceFileResources } from '../protocol/reference-file-resources.js'
import type { ReferenceIpcEndpoint } from './reference-endpoint.js'
import {
  createSdkLaneHandshakeReply,
  dispatchTrustedSdkLaneCall,
  getTrustedSdkLaneContext,
  isCurrentTrustedSdkLaneContext,
  selectTrustedSdkLaneDispatch,
  type TrustedSdkLaneContext
} from './sdk-lane-dispatch.js'
import { PluginSessionManager } from '../windows/plugin-session-manager.js'
import type { UpdateProgress } from '../services/update-service.js'
import type { ResourceRoot } from '../protocol/ztools-protocol.js'

type Handler = (params: unknown, caller: CallerIdentity, signal: AbortSignal) => Promise<unknown>
interface PendingLegacyCall {
  readonly method: string
  readonly controller: AbortController
}
export interface ReferenceRuntimeAttachment {
  readonly resources?: ReferenceFileResources
  readonly endpoint: Pick<ReferenceIpcEndpoint, 'call' | 'cancel' | 'acceptDrop'>
  closeIngress(): void
  drain(): Promise<void>
  stop(): Promise<void>
}

type RouterAppAdapter = Pick<
  typeof app,
  'getPath' | 'isPackaged' | 'runningUnderARM64Translation' | 'getFileIcon'
>

export interface IpcRouterOptions {
  pluginResources: {
    webRoot: ResourceRoot
    pluginRoot: string
  }
  toggleMainWindow(): void
  toggleSuperPanel(trigger: 'keyboard_hotkey' | 'mouse_hotkey'): void
  getPanelLocalApps(): Promise<Array<{ id: string; name: string }>>
  launchLocalApp?(appId: string): Promise<void>
  closeConfirmationResolved(): void
  screenClipboardAdapters: ScreenClipboardAdapters
  systemPlatformAdapter: SystemPlatformAdapter
  processDiscoveryAdapter: ProcessDiscoveryAdapter
  pathSemanticsAdapter?: PathSemanticsAdapter
  runtimeCapabilityProviders?: RuntimeCapabilityProviders
  loginItems?: MacosLoginItemAdapter
  reloadMainWindow?: () => Promise<void>
  pluginState?: PluginStateService
  onDarkModeChanged?: (enabled: boolean) => void
}

const credentialV1Methods = new Set([
  'credential_v1_status',
  'credential_v1_set',
  'credential_v1_get',
  'credential_v1_delete'
])

/** Only DLL-call failures log request-derived identifiers; credential payloads are never inspected. */
export function getIpcFailureLogIdentifierFields(
  request: ZToolsRequest | undefined
): { readonly dllId?: string; readonly functionName?: string } {
  if (request && credentialV1Methods.has(request.method)) return {}
  const params = request?.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return {}
  const identifiers = params as Record<string, unknown>
  return {
    ...(typeof identifiers.plugin === 'string' ? { dllId: identifiers.plugin } : {}),
    ...(typeof identifiers.func === 'string' ? { functionName: identifiers.func } : {})
  }
}

function deferredCapability(capability: string, phase: 'M3' | 'M3/M4' | 'M4' | 'M5' | 'M6'): never {
  throw new ZToolsError(
    errorCodes.notSupported,
    `${capability} 尚未启用，等待 ${phase} 安全链路完成`
  )
}

/**
 * 校验来源 WebContents 实例与页面 URL。
 * - 主程序 WebContents 必须来自 ztools://web/；
 * - 普通与内置插件 WebContents 必须来自匹配的 ztools://plugins/<pluginId>/；
 * - 针对官方受信任内置插件强化协议与域隔离校验。
 */
export function validateCallerWebContents(
  caller: CallerIdentity,
  sender?: { getURL?(): string; session?: unknown }
): void {
  if (!sender || typeof sender.getURL !== 'function') return
  const senderUrl = sender.getURL()
  if (!senderUrl || senderUrl === '' || senderUrl === 'about:blank') return

  try {
    const parsed = new URL(senderUrl)
    if (caller.type === 'main') {
      if (parsed.protocol === 'ztools:' && parsed.hostname !== 'web') {
        throw new ZToolsError(errorCodes.permissionDenied, '主程序 WebContents 来源无效')
      }
    } else if (caller.type === 'plugin' && caller.pluginId) {
      if (parsed.protocol !== 'ztools:') {
        throw new ZToolsError(errorCodes.permissionDenied, '插件 WebContents 来源协议非法')
      }
      if (parsed.hostname === 'plugins') {
        const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
        const targetPluginId = segments[0]
        if (targetPluginId && targetPluginId.toLowerCase() !== caller.pluginId.toLowerCase()) {
          throw new ZToolsError(errorCodes.permissionDenied, 'WebContents 来源 URL 与注册插件身份不匹配')
        }
      } else if (isInternalPlugin(caller.pluginId)) {
        // 内置插件若使用 ztools 协议，只允许 plugins 或 web（宿主面板融合模式）
        if (parsed.hostname !== 'web') {
          throw new ZToolsError(errorCodes.permissionDenied, '内置插件来源 URL 协议非法')
        }
      } else {
        throw new ZToolsError(errorCodes.permissionDenied, '第三方插件页面必须运行在 plugins 域')
      }
    }
  } catch (err) {
    if (err instanceof ZToolsError) throw err
  }
}

/**
 * 拦截第三方插件伪造 pluginId 参数攻击场景。
 * 第三方插件在调用非 plugin_open API 时，禁止在入参中显式指定其它插件 ID。
 */
export function assertNoPluginIdSpoofing(caller: CallerIdentity, request: ZToolsRequest): void {
  if (caller.type !== 'plugin' || isInternalPlugin(caller.pluginId)) return
  if (request.method === 'plugin_open') return

  if (typeof request.params === 'object' && request.params !== null) {
    const raw = request.params as Record<string, unknown>
    if ('pluginId' in raw && typeof raw.pluginId === 'string' && caller.pluginId) {
      if (raw.pluginId.toLowerCase() !== caller.pluginId.toLowerCase()) {
        throw new ZToolsError(errorCodes.permissionDenied, '调用方 pluginId 与注册身份不匹配')
      }
    }
  }
}

/**
 * 统一鉴权引擎：来源校验、防参数伪造以及特权方法安全分级鉴权。
 */
export function authorizeIpcRequest(
  caller: CallerIdentity,
  request: ZToolsRequest,
  sender?: { getURL?(): string; session?: unknown }
): asserts request is ZToolsRequest & { method: AllowedMethod } {
  // 1. 基础合法方法校验
  if (!isAllowedMethod(request.method)) {
    throw new ZToolsError(errorCodes.methodNotFound, `未知方法: ${request.method}`)
  }

  // 2. 基础调用角色 capability 校验
  if (!canCall(request.method, caller)) {
    throw new ZToolsError(errorCodes.permissionDenied, `调用者无权访问: ${request.method}`)
  }

  // 3. WebContents 来源 URL 与会话安全隔离校验
  validateCallerWebContents(caller, sender)

  // 4. 参数伪造攻击防御
  assertNoPluginIdSpoofing(caller, request)

  // 5. 特权方法严格安全隔离校验：第三方插件统一拦截
  if (isPrivilegedMethod(request.method)) {
    if (caller.type === 'plugin' && !isInternalPlugin(caller.pluginId)) {
      throw new ZToolsError(
        errorCodes.permissionDenied,
        `第三方插件无权调用特权方法: ${request.method}`
      )
    }
  }
}

/**
 * 供测试与安全审计验证请求鉴权结果的公开帮助函数。
 */
export function dispatchAuthorizedIpcRequest(
  caller: CallerIdentity,
  request: ZToolsRequest,
  sender?: { getURL?(): string; session?: unknown }
): { success: true } | { success: false; error: { code: string; message: string } } {
  try {
    authorizeIpcRequest(caller, request, sender)
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: toPublicError(error)
    }
  }
}

export class IpcRouter {
  readonly #diagnosticFailures = new RuntimeDiagnosticFailureStore()
  readonly #pending = new Map<number, Map<string, PendingLegacyCall>>()
  readonly #capabilityRequestCancellations = new RuntimeCapabilityRequestCancellationService()
  readonly #networkRequestCancellations = new NetworkRequestCancellationService()
  readonly #networkRequestCancellationEndpoint: NetworkRequestCancellationEndpoint
  readonly #handlers: Record<AllowedMethod, Handler>
  readonly #services: CoreServices
  readonly #events: EventService
  readonly #files: FileSystemService
  readonly #windows: WindowService
  readonly #clipboard: ClipboardService
  readonly #database: DatabaseService
  readonly #dllPlugins: DllPluginService
  readonly #plugins: PluginInstallService
  readonly #pluginState: PluginStateService
  readonly #pluginIcons: PluginIconService
  readonly #pluginShortcuts: PluginShortcutService
  readonly #pluginSessions: PluginSessionManager
  readonly #pluginWindows: PluginWindowManager
  readonly #processes: ProcessService
  readonly #runtimeCapabilities: RuntimeCapabilityService
  readonly #capabilityAuthorization: RuntimeCapabilityAuthorizationService
  readonly #capabilityPrompt: RuntimeCapabilityPromptService
  readonly #permissionMonitor: RuntimePermissionMonitorService
  readonly #stopPermissionOwnerEvents: () => void
  readonly #triggers: TriggerService
  readonly #superPanelInput: SuperPanelInputService | null
  readonly #system: SystemService
  readonly #stopThemeEvents: () => void
  #referenceRuntime: ReferenceRuntimeAttachment | undefined
  #sdkLaneHandshakeListener: ((event: IpcMainEvent, ...args: unknown[]) => void) | undefined
  #registered = false
  readonly #autostart: AutostartService
  readonly #removeUpdateProgressListener!: () => void
  #stopping = false
  #lastDarkMode: boolean | undefined
  #stopPromise: Promise<void> | undefined

  get fileService(): FileSystemService {
    return this.#files
  }

  get eventService(): EventService {
    return this.#events
  }

  get screenCaptureAuthorization(): RuntimeCapabilityAuthorizationService {
    return this.#capabilityAuthorization
  }

  /** Attach the fully constructed Main-owned reference runtime before IPC registration. */
  attachReferenceRuntime(runtime: ReferenceRuntimeAttachment): void {
    if (this.#registered || this.#stopping || this.#referenceRuntime) {
      throw new Error('Reference runtime must be attached once before Router registration')
    }
    this.#referenceRuntime = runtime
  }

  /** Internal composition hook for SDK2 endpoint failures; owner always comes from WindowRegistry. */
  recordRuntimeDiagnosticFailure(owner: CallerIdentity | undefined, failure: RuntimeDiagnosticFailureInput): void {
    this.#diagnosticFailures.record(owner, failure)
  }

  ready(): Promise<void> {
    return this.#superPanelInput?.ready ?? Promise.resolve()
  }

  listInstalledPlugins(): Promise<{ success: true; data: Record<string, unknown>[] }> {
    return this.#plugins.list()
  }

  openPlugin(params: PluginOpenParams): Promise<unknown> {
    this.#services.frecency?.recordUsage(params.pluginId)
    return this.#pluginWindows.open(params).then((result) => {
      const opened = result as { success?: boolean; pluginId?: string; instanceId?: string; windowInstanceStatus?: string }
      if (opened.success === true && opened.pluginId) {
        this.#services.analytics.reportHost('plugin_open', opened.pluginId, this.#services.webVersion, {
          instanceId: opened.instanceId,
          status: opened.windowInstanceStatus
        })
        void this.#services.user.getAccessToken().then((token) => {
          this.#services.analytics.reportPluginRecord('active', opened.pluginId as string, token)
        }).catch(() => undefined)
      }
      return result
    })
  }

  publishLaunchIntent(payload: unknown): void {
    this.#events.publishHost('launch_intent', payload)
  }

  publishDarkModeChange(enabled: boolean): void {
    if (this.#lastDarkMode === enabled) return
    this.#lastDarkMode = enabled
    this.#events.publishHost('system.DarkModeChange', { isDark: enabled })
  }

  refreshPermissionOwner(webContentsId: number): Promise<void> {
    const owner = this.registry.get(webContentsId)
    return owner && !this.#stopping ? this.#permissionMonitor.refreshOwner(owner) : Promise.resolve()
  }

  refreshPermissionSubscribers(): Promise<void> {
    return this.#stopping ? Promise.resolve() : this.#permissionMonitor.refreshSubscribedOwners()
  }

  requestCloseConfirmation(origin: 'closeButton' | 'trayMenu'): boolean {
    return this.#events.publishHost('ui_close_confirm_request', { origin }).delivered > 0
  }

  static create(
    registry: WindowRegistry,
    services: CoreServices,
    options: IpcRouterOptions,
    mainApp: RouterAppAdapter = app
  ): Promise<IpcRouter> {
    return constructWithRouterRollback((scope) =>
      new IpcRouter(registry, services, options, mainApp, scope)
    )
  }

  private constructor(
    private readonly registry: WindowRegistry,
    services: CoreServices,
    options: IpcRouterOptions,
    mainApp: RouterAppAdapter,
    constructionScope: RouterConstructionScope
  ) {
    this.#services = services
    this.#files = constructionScope.own(
      new FileSystemService(
        registry,
        services.runtimePaths.cacheRoot,
        Date.now,
        options.pathSemanticsAdapter ?? createPathSemanticsAdapter(process.platform)
      ),
      (files) => files.stop()
    )
    const files = this.#files
    const windows = constructionScope.own(new WindowService(files, registry), owned => owned.stop())
    this.#windows = windows
    const network = new NetworkService(registry, { fileService: files })
    this.#networkRequestCancellationEndpoint = new NetworkRequestCancellationEndpoint(
      registry,
      this.#networkRequestCancellations,
      () => this.#stopping,
      (webContentsId, messageId) => this.#pending.get(webContentsId)?.get(messageId)?.method
    )
    const shell = new ShellService(files, electronShell)
    this.#processes = constructionScope.own(
      new ProcessService(
        registry,
        files,
        Date.now,
        process.platform,
        options.processDiscoveryAdapter
      ),
      (processes) => processes.stop()
    )
    const processes = this.#processes
    const runtimeTarget = options.systemPlatformAdapter.getRuntimeTarget()
    const nativePlatform = runtimeTarget.platform === 'macos' ? 'darwin' : 'win32'
    const keyboardCandidate: unknown = services.nativeInput
    const keyboardPort = nativePlatform === 'win32' && keyboardCandidate !== null && typeof keyboardCandidate === 'object' &&
      ['configureKeyboardDoubleTap', 'onInputEvent', 'onLifecycleEvent']
        .every(method => typeof (keyboardCandidate as Record<string, unknown>)[method] === 'function')
      ? keyboardCandidate as KeyboardDoubleTapAdapter : undefined
    const pluginRuntimeTarget = { platform: nativePlatform, runtime: 'electron', arch: process.arch }
    const macNativeCatalogLookup = (pluginId: string, componentId: string) =>
      services.nativeHost?.getApprovedMacComponent?.(pluginId, componentId)
    let runtimeAuthorization: RuntimeCapabilityAuthorizationService | undefined
    const baseRuntimeCapabilityProviders = createRuntimeCapabilityProviders(
      options.screenClipboardAdapters.screen,
      runtimeTarget.platform,
      options.runtimeCapabilityProviders,
      () => options.screenClipboardAdapters.fileClipboard.isAvailable?.() === true
    )
    this.#runtimeCapabilities = constructionScope.own(new RuntimeCapabilityService(
      RUNTIME_CAPABILITY_CATALOG,
      {
        ...baseRuntimeCapabilityProviders,
        getAuthorization(capability, caller, signal) {
          if (capability === 'screen.capture' && (caller.type === 'plugin' || caller.type === 'main')) {
            return runtimeAuthorization?.getAuthorizationStatus(capability, caller) ?? 'unknown'
          }
          return baseRuntimeCapabilityProviders.getAuthorization?.(capability, caller, signal) ?? 'unknown'
        }
      }
    ), (capabilities) => capabilities.stop())
    const runtimeCapabilities = this.#runtimeCapabilities
    this.#events = constructionScope.own(
      new EventService(registry),
      (events) => events.stop()
    )
    const events = this.#events
    const publishUpdateComplete = (payload: unknown): void => {
      try {
        if (!this.#stopping) events.publishHost('update_complete', payload)
      } catch (error) {
        if (!this.#stopping) console.warn('发布更新完成事件失败:', error)
      }
    }
    this.#removeUpdateProgressListener = constructionScope.own(services.update.onProgress((progress: UpdateProgress) => {
      try {
        events.publishHost('update_download_progress', progress)
      } catch (error) {
        if (!this.#stopping) console.warn('发布更新进度事件失败:', error)
      }
    }), dispose => dispose())
    this.#pluginState = options.pluginState ?? new PluginStateService(services.dataRoot)
    this.#permissionMonitor = constructionScope.own(
      new RuntimePermissionMonitorService(events, runtimeCapabilities),
      (monitor) => monitor.stop()
    )
    this.#stopPermissionOwnerEvents = constructionScope.own(
      registry.onRemoved((id) => {
        this.#permissionMonitor.closeOwner(id)
        this.#capabilityRequestCancellations.closeOwner(id)
      }),
      (dispose) => dispose()
    )
    this.#triggers = constructionScope.own(
      new TriggerService({
        dataRoot: services.dataRoot,
        shortcuts: createElectronGlobalShortcutAdapter(globalShortcut),
        events,
        state: this.#pluginState,
        openPlugin: (params) => this.openPlugin(params),
        ...(keyboardPort ? { keyboard: keyboardPort } : {}),
        toggleMainWindow: options.toggleMainWindow,
        toggleSuperPanel: (trigger) => options.toggleSuperPanel(trigger),
        ...(options.launchLocalApp ? { launchLocalApp: options.launchLocalApp } : {})
      }),
      (triggers) => triggers.stop()
    )
    const triggers = this.#triggers
    this.#plugins = constructionScope.own(
      new PluginInstallService(services.dataRoot, events, {
        state: this.#pluginState,
        analytics: (event, pluginId, data) => services.analytics.reportHost(event, pluginId, services.webVersion, data),
        runtimeTarget: pluginRuntimeTarget,
        referenceRuntimeReady: () => this.#referenceRuntime !== undefined && !this.#stopping,
        ...(nativePlatform === 'darwin' ? { macNativeCatalogLookup } : {}),
        async preparePluginReplace(manifest, signal) {
          if (nativePlatform === 'darwin') {
            const selected = resolvePluginRuntimeTarget(manifest, pluginRuntimeTarget, {
              sdkContractVersion: SDK_HOST_MAXIMUM_CONTRACT_VERSION, macNativeCatalogLookup
            })
            if (selected.nativeComponents.length === 0) return () => undefined
            if (!services.nativeHost) throw new ZToolsError(errorCodes.nativeHostUnavailable, '可信 Mac Native Host 未配置')
            if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '插件更新已取消')
            const release = await services.nativeHost.acquirePluginMaintenance(manifest.id)
            if (signal.aborted) { release(); throw new ZToolsError(errorCodes.callerDestroyed, '插件更新已取消') }
            return release
          }
          if (!manifest.dllloader) return () => undefined
          if (manifest.requireAdmin) {
            throw new ZToolsError(errorCodes.notSupported, '管理员 DLL 更新需要认证 Service 卸载能力')
          }
          if (!services.nativeHost) throw new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 未配置')
          const release = await services.nativeHost.acquirePluginMaintenance(manifest.id)
          try {
            if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '插件更新已取消')
            const fileName = path.basename(manifest.dllloader.replaceAll('\\', '/'))
            const dllId = fileName.slice(0, -4)
            await services.nativeHost.unloadDll(manifest.id, dllId)
            return release
          } catch (error) { release(); throw error }
        }
      }),
      (plugins) => plugins.stop()
    )
    const plugins = this.#plugins
    const capabilityPrompt = constructionScope.own(
      new RuntimeCapabilityPromptService(registry),
      prompt => prompt.stop()
    )
    this.#capabilityPrompt = capabilityPrompt
    this.#capabilityAuthorization = constructionScope.own(
      new RuntimeCapabilityAuthorizationService(registry, capabilityPrompt, {
        resolvePluginName: async pluginId => plugins.withPluginManifest(pluginId, async manifest => manifest.name),
        onChanged: (owner, revision) => {
          if (this.#stopping) return
          void this.#permissionMonitor.refreshOwner(owner).catch(() => undefined)
          for (const subscriber of events.subscribers(RUNTIME_PERMISSION_CHANGED_EVENT)) {
            if (subscriber.type !== 'main') continue
            try {
              events.publishHostToOwner(RUNTIME_PERMISSION_CHANGED_EVENT, {
                capability: 'screen.capture', revision
              }, subscriber)
            } catch { /* A stale panel can refresh explicitly; Main remains authoritative. */ }
          }
        }
      }),
      authorization => authorization.stop()
    )
    runtimeAuthorization = this.#capabilityAuthorization
    this.#database = constructionScope.own(
      new DatabaseService(path.join(services.dataRoot, 'LevelDB'), electronCredentialProtection),
      (database) => database.stop()
    )
    const database = this.#database
    this.#dllPlugins = constructionScope.own(
      new DllPluginService(
        plugins,
        services.nativeHost,
        services.serviceClient,
        events,
        registry,
        undefined,
        new NativeMediaPathPolicy(files),
        database,
        nativePlatform,
        this.#capabilityAuthorization
      ),
      (dllPlugins) => dllPlugins.stop()
    )
    const dllPlugins = this.#dllPlugins
    this.#pluginSessions = new PluginSessionManager({
      ...options.pluginResources,
      files,
      browserProfileRoot: services.runtimePaths.browserProfileRoot,
      getReferenceResources: () => this.#referenceRuntime?.resources
    })
    this.#pluginWindows = constructionScope.own(
      new PluginWindowManager({ registry, manifests: plugins,
        sessions: this.#pluginSessions, state: this.#pluginState, events,
        pluginRoot: options.pluginResources.pluginRoot, isDarkMode: () => nativeTheme.shouldUseDarkColors,
        requestExit: (owner, isKill) => this.#stopping
          ? Promise.resolve('STOPPED')
          : events.requestPluginExit(owner, isKill)
      }),
      (pluginWindows) => pluginWindows.stop()
    )
    const pluginWindows = this.#pluginWindows
    const openPlugin = (params: PluginOpenParams): Promise<unknown> => this.openPlugin(params)
    this.#pluginShortcuts = new PluginShortcutService(
      plugins,
      mainApp.getPath('desktop'),
      mainApp.getPath('exe'),
      (shortcutPath, shortcut) => electronShell.writeShortcutLink(shortcutPath, shortcut)
    )
    this.#pluginIcons = new PluginIconService(plugins, this.#pluginState)
    const pluginState = this.#pluginState
    const pluginShortcuts = this.#pluginShortcuts
    const pluginIcons = this.#pluginIcons
    this.#superPanelInput = constructionScope.own(
      createSuperPanelInputService(
        services.config,
        this.#triggers,
        services.nativeInput ?? null,
        (trigger) => options.toggleSuperPanel(trigger)
      ),
      (superPanelInput) => superPanelInput.stop()
    )
    const superPanelInput = this.#superPanelInput
    const nativeInputCandidate: unknown = services.nativeInput
    const inputInjection = nativePlatform === 'win32' && nativeInputCandidate !== null && typeof nativeInputCandidate === 'object' &&
      ['getForegroundWindow', 'restoreForegroundWindow', 'injectKeyPress', 'injectKeyCombo', 'injectText', 'injectMouseMove', 'injectMouseClick', 'injectMouseWheel']
        .every(method => typeof (nativeInputCandidate as Record<string, unknown>)[method] === 'function')
      ? nativeInputCandidate as NativeInputInjectionAdapter : undefined
    const screens = new ScreenService(
      files,
      options.screenClipboardAdapters.screen,
      options.screenClipboardAdapters.screenCaptureFallback,
      undefined,
      this.#capabilityAuthorization
    )
    this.#clipboard = constructionScope.own(
      new ClipboardService(
        files,
        events,
        electronClipboard,
        nativeImage,
        options.screenClipboardAdapters.fileClipboard,
        750,
        undefined,
        undefined,
        caller => registry.getSdkApiLane(caller) === 1,
        nativePlatform === 'win32' ? async entry => {
          await database.recordClipboard(entry)
          if (entry.type === 'text') {
            await services.clipboardHistory.recordItem({ content: entry.text, format_type: 'text' })
          }
        } : undefined,
        registry,
        inputInjection
      ),
      (clipboard) => clipboard.stop()
    )
    const clipboard = this.#clipboard
    this.#system = constructionScope.own(new SystemService(files, registry, {
      appName: 'ZTools',
      appVersion: services.appVersion,
      isDev: !mainApp.isPackaged,
      ...(options.systemPlatformAdapter.getProductVersion
        ? { getProductVersion: options.systemPlatformAdapter.getProductVersion }
        : {}),
      paths: {
        app: path.dirname(mainApp.getPath('exe')),
        home: mainApp.getPath('home'),
        appData: mainApp.getPath('appData'),
        userData: options.systemPlatformAdapter.userDataPath,
        desktop: mainApp.getPath('desktop'),
        documents: mainApp.getPath('documents'),
        downloads: mainApp.getPath('downloads'),
        music: mainApp.getPath('music'),
        pictures: mainApp.getPath('pictures'),
        videos: mainApp.getPath('videos')
      },
      isDarkMode: () => nativeTheme.shouldUseDarkColors,
      setDarkMode: (enabled) => {
        nativeTheme.themeSource = enabled ? 'dark' : 'light'
        void services.config.set('user_settings.json', 'ui.theme', enabled ? 'dark' : 'light', true)
          .catch((error: unknown) => console.warn('保存主题设置失败:', error))
        this.publishDarkModeChange(enabled)
        options.onDarkModeChanged?.(enabled)
      },
      async showNotification(params, caller) {
        if (params.modal) {
          const contents = registry.getWebContents(caller.webContentsId)
          const parent = contents ? BrowserWindow.fromWebContents(contents) : null
          const messageBoxOptions = {
            type: 'info' as const,
            title: params.title || 'ZTools',
            message: params.message,
            buttons: ['确定'],
            noLink: true
          }
          if (parent) await dialog.showMessageBox(parent, messageBoxOptions)
          else await dialog.showMessageBox(messageBoxOptions)
          return
        }
        if (!Notification.isSupported()) {
          throw new ZToolsError(errorCodes.notSupported, '当前系统不支持桌面通知')
        }
        new Notification({ title: params.title || 'ZTools', body: params.message }).show()
      },
      async getFileIcon(filePath) {
        return (await mainApp.getFileIcon(filePath, { size: 'large' })).toDataURL()
      },
      getNativeId: () => options.systemPlatformAdapter.getNativeId(),
      startPreventSleep: () => powerSaveBlocker.start('prevent-display-sleep'),
      stopPreventSleep: (id) => powerSaveBlocker.stop(id)
    }), (system) => system.stop())
    const system = this.#system
    const config = new LoginItemConfigService(services.config, options.loginItems)
    this.#autostart = new AutostartService({
      executablePath: mainApp.getPath('exe'),
      adapter: {
        getLoginItemSettings: (settings) => app.getLoginItemSettings({
          path: settings.path,
          args: [...settings.args]
        }),
        setLoginItemSettings: (settings) => app.setLoginItemSettings({
          openAtLogin: settings.openAtLogin,
          openAsHidden: settings.openAsHidden,
          path: settings.path,
          args: [...settings.args]
        })
      }
    })
    const autostart = this.#autostart
    const capabilityAuthorization = this.#capabilityAuthorization
    const diagnosticFailures = this.#diagnosticFailures
    this.#handlers = {
      async app_ready(params) {
        return { accepted: true, params }
      },
      async diagnostics_get(params, caller) {
        const requestIds = (params as { readonly requestIds?: readonly string[] }).requestIds ?? []
        const requestFailures = diagnosticFailures.read(caller, requestIds)
        if (caller.type === 'plugin' && !isInternalPlugin(caller.pluginId)) {
          return { schemaVersion: 1, requestFailures }
        }
        const nativeRuntimeFallback = createNativeRuntimeDiagnosticsFallback(process.platform)
        const details = sanitizeRuntimeDiagnosticDetails({
          nativeHost: services.nativeHost?.diagnostics ?? nativeRuntimeFallback.nativeHost,
          service: services.serviceClient?.diagnostics ?? nativeRuntimeFallback.service,
          superPanelInput: superPanelInput?.diagnostics ?? nativeRuntimeFallback.superPanelInput
        })
        return {
          schemaVersion: 1,
          ...getRuntimeDiagnostics(),
          ...details,
          requestFailures
        }
      },
      async config_get(params) {
        const input = params as ConfigGetParams
        const value = await config.get(input.file, input.path, input.default)
        return { success: true, value }
      },
      async config_set(params) {
        const input = params as ConfigSetParams
        await config.set(input.file, input.path, input.value, input.sync_enabled)
        return { success: true }
      },
      async settings_get(params) {
        const input = params as SettingsGetParams
        const value = await config.getSetting(input.key)
        return { success: true, key: input.key, value }
      },
      async settings_set(params) {
        const input = params as SettingsSetParams
        const value = await config.setSetting(input.key, input.value)
        return { success: true, key: input.key, value }
      },
      async features_get(params) {
        const input = (params ?? {}) as { key?: string }
        if (input.key) {
          const value = await services.config.getFeature(input.key as FeatureFlagKey)
          return { success: true, key: input.key, enabled: value }
        }
        const features = await services.config.getFeatures()
        return { success: true, features }
      },
      async features_set(params) {
        const input = params as { key?: string; enabled?: boolean; features?: Partial<FeatureFlags> }
        if (input.key && typeof input.enabled === 'boolean') {
          const enabled = await services.config.setFeature(input.key as FeatureFlagKey, input.enabled)
          return { success: true, key: input.key, enabled }
        }
        if (input.features && typeof input.features === 'object') {
          const updated = await services.config.setFeatures(input.features)
          return { success: true, features: updated }
        }
        throw new ZToolsError(errorCodes.invalidRequest, '未提供有效的 feature 更新参数')
      },
      async user_get_info() {
        return services.user.getInfo()
      },
      async user_set_token(params) {
        await services.user.setToken(params as UserSetTokenParams)
        return { success: true }
      },
      async user_logout() {
        await services.user.logout()
        return { success: true }
      },
      async analytics_report(params, caller) {
        services.analytics.report(params as AnalyticsReportParams, caller)
        return { success: true }
      },
      async plugin_list_get() {
        return plugins.list()
      },
      async plugin_refresh() {
        return plugins.list()
      },
      async plugin_toggle(params) {
        const input = params as PluginKeyParams
        return plugins.withPluginDirectory(input.pluginId, async (manifest) => {
          const enabled = await pluginState.toggleEnabled(manifest.id, manifest.enabled !== false)
          await triggers.syncPluginEnabled(manifest.id, enabled)
          if (!enabled) await pluginWindows.closePlugin(manifest.id)
          return { success: true, pluginId: manifest.id, enabled }
        })
      },
      async plugin_revoke(params) {
        const input = params as { pluginId: string; revoked: boolean; reason?: string }
        await plugins.markRevoked(input.pluginId, input.revoked, input.reason)
        if (input.revoked) {
          await pluginWindows.closePlugin(input.pluginId)
          await dllPlugins.unloadPlugin(input.pluginId)
          await triggers.syncPluginEnabled(input.pluginId, false)
        }
        return { success: true, pluginId: input.pluginId, revoked: input.revoked }
      },
      async plugin_window_close(params, caller) {
        const input = params as PluginWindowCloseParams
        if (
          caller.type === 'plugin' &&
          (caller.pluginId?.toLowerCase() !== input.pluginId.toLowerCase() ||
            (input.instanceId !== undefined && input.instanceId !== caller.pluginInstanceId))
        ) {
          throw new ZToolsError(errorCodes.permissionDenied, '插件只能关闭自己的窗口')
        }
        return pluginWindows.close(input.pluginId, input.instanceId)
      },
      async plugin_create_shortcut(params, caller) {
        const input = params as PluginKeyParams
        if (caller.type === 'plugin' && caller.pluginId?.toLowerCase() !== input.pluginId.toLowerCase()) {
          throw new ZToolsError(errorCodes.permissionDenied, '插件只能为自己创建快捷方式')
        }
        return pluginShortcuts.create(input.pluginId)
      },
      async plugin_refresh_icon(params, caller) {
        const input = params as PluginIconRefreshParams
        if (caller.type === 'plugin' && caller.pluginId?.toLowerCase() !== input.pluginId.toLowerCase()) {
          throw new ZToolsError(errorCodes.permissionDenied, '插件只能刷新自己的图标')
        }
        return pluginIcons.refresh(input.pluginId, input.iconUrl)
      },
      async plugin_open(params) {
        return openPlugin(params as PluginOpenParams)
      },
      async plugin_install(params) {
        const input = params as PluginInstallParams
        await pluginWindows.closePlugin(input.pluginId)
        await dllPlugins.unloadPlugin(input.pluginId)
        return plugins.startInstall(input, false)
      },
      async plugin_update(params) {
        const input = params as PluginInstallParams
        await pluginWindows.closePlugin(input.pluginId)
        await dllPlugins.unloadPlugin(input.pluginId)
        return plugins.startInstall(input, true)
      },
      async plugin_uninstall(params) {
        const input = params as PluginKeyParams
        await pluginWindows.closePlugin(input.pluginId)
        await dllPlugins.unloadPlugin(input.pluginId)
        await triggers.removePlugin(input.pluginId)
        await pluginShortcuts.remove(input.pluginId)
        return plugins.uninstall(input)
      },
      async plugin_data_list(params) {
        return plugins.listPreservedData((params as PluginKeyParams).pluginId)
      },
      async plugin_data_restore(params) {
        const input = params as PluginDataRestoreParams
        await pluginWindows.closePlugin(input.pluginId)
        return plugins.restorePreservedData(input.pluginId, input.preservationId, input.assets)
      },
      async update_check(params) {
        return services.update.check(params as UpdateCheckParams)
      },
      async update_get_version() {
        return {
          success: true,
          appVersion: services.appVersion,
          webVersion: services.webResources?.version ?? services.webVersion
        }
      },
      async update_download_start(params) {
        return services.update.download(params as UpdatePackageParams)
      },
      async update_install_start(params, _caller, signal) {
        const input = params as UpdatePackageParams
        try {
          const result = await services.update.install(input, signal)
          if (result.reloadRequired && services.webResources) {
            const operationId = result.operationId
            if (options.reloadMainWindow) {
              setTimeout(() => {
                void options.reloadMainWindow?.()
                  .then(async () => {
                    await services.webResources?.confirm(operationId)
                    publishUpdateComplete({
                      type: 'web',
                      success: true,
                      operationId,
                      version: result.version
                    })
                  })
                  .catch(async (error: unknown) => {
                    const message = error instanceof Error ? error.message : 'Web 主界面健康检查失败'
                    await services.webResources?.rollback(operationId).catch((rollbackError: unknown) => {
                      console.error('Web 更新失败后的回滚失败', rollbackError)
                    })
                    services.update.refreshWebVersion()
                    await options.reloadMainWindow?.().catch(() => undefined)
                    publishUpdateComplete({
                      type: 'web',
                      success: false,
                      operationId,
                      message
                    })
                    console.error('Web 更新页面健康检查失败', { operationId, error })
                  })
              }, 0)
            } else {
              await services.webResources.confirm(operationId)
            }
          }
          return result
        } catch (error) {
          if (input.type === 'web') {
            publishUpdateComplete({
              type: 'web',
              success: false,
              message: error instanceof Error ? error.message : 'Web 更新失败'
            })
          }
          throw error
        }
      },
      async update_cancel() {
        return services.update.cancel()
      },
      async privileged_execute() {
        return deferredCapability('特权命令执行', 'M3')
      },
      async builtin_reg_write() {
        return deferredCapability('特权注册表写入', 'M3')
      },
      async builtin_reg_delete() {
        return deferredCapability('特权注册表删除', 'M3')
      },
      async builtin_file_write() {
        return deferredCapability('特权文件写入', 'M3')
      },
      async builtin_restart_explorer() {
        return deferredCapability('特权 Explorer 重启', 'M3')
      },
      async trigger_register(params, caller) {
        return triggers.register(params as TriggerRegisterParams, caller)
      },
      async trigger_unregister(params, caller) {
        return triggers.unregister((params as { triggerId: string }).triggerId, caller)
      },
      async trigger_list(params, caller) {
        return triggers.list(params as TriggerListParams, caller)
      },
      async trigger_set_enabled(params, caller) {
        return triggers.setEnabled(params as TriggerSetEnabledParams, caller)
      },
      async trigger_check_conflict(params, caller) {
        return triggers.checkConflict(params as TriggerConflictParams, caller)
      },
      async system_notify(params, caller) {
        return system.notify(params as SystemNotifyParams, caller)
      },
      async system_set_dark_mode(params) {
        return system.setDarkMode((params as SystemDarkModeParams).dark)
      },
      async get_system_info(_params, caller) {
        return system.getInfo(caller)
      },
      async system_get_native_id() {
        return system.getNativeId()
      },
      async system_get_app_name() {
        return system.getAppName()
      },
      async system_get_app_version() {
        return system.getAppVersion()
      },
      async system_get_autostart() {
        return autostart.get()
      },
      async system_set_autostart(params) {
        return autostart.set((params as SystemAutostartParams).enabled)
      },
      async system_get_path(params, caller) {
        return system.getPath(params as SystemPathParams, caller)
      },
      async system_get_file_icon(params, caller) {
        return system.getFileIcon(params as SystemFileIconParams, caller)
      },
      async system_search_files(params) {
        const p = params as SystemSearchFilesParams
        const limit = p.limit ?? 20
        return services.sidecars.searchFiles(p.query, limit)
      },
      async system_read_current_folder(_params, caller) {
        return system.readCurrentFolder(caller)
      },
      async system_read_current_browser_url() {
        return system.readCurrentBrowserUrl()
      },
      async system_is_dev() {
        return system.isDev()
      },
      async system_get_platform() {
        return system.getPlatform()
      },
      async system_get_runtime_identity() {
        const target = resolveRuntimeIdentityTarget({
          target: runtimeTarget,
          platform: process.platform,
          processArch: process.arch,
          isPackaged: mainApp.isPackaged,
          resourcesPath: process.resourcesPath
        })
        return createRuntimeIdentity({
          target,
          appVersion: services.appVersion,
          platform: process.platform,
          processArch: process.arch,
          productVersion: process.getSystemVersion(),
          kernelVersion: os.release(),
          runningUnderARM64Translation: mainApp.runningUnderARM64Translation,
          processorArchitecture: process.env.PROCESSOR_ARCHITECTURE,
          processorArchitew6432: process.env.PROCESSOR_ARCHITEW6432,
          nativeHostState: services.nativeHost?.diagnostics.state ?? null,
          nativeHostProtocolVersion: services.nativeHost?.diagnostics.protocolVersion ?? null
        })
      },
      async runtime_capability_get(params, caller) {
        const snapshot = await runtimeCapabilities.getSnapshot(
          params as RuntimeCapabilityQueryParams,
          caller
        )
        const record: RuntimeCapabilityRecord = {
          contractVersion: RUNTIME_CAPABILITY_CONTRACT_VERSION,
          target: runtimeTarget,
          ...snapshot
        }
        return record
      },
      async runtime_capability_request(params, caller, signal) {
        const request = params as RuntimeCapabilityQueryParams
        await capabilityAuthorization.requestCapability(request.capability as RuntimeCapabilityRecord['capability'], caller, signal)
        const snapshot = await runtimeCapabilities.getSnapshot(request, caller, signal)
        const record: RuntimeCapabilityRecord = { contractVersion: RUNTIME_CAPABILITY_CONTRACT_VERSION, target: runtimeTarget, ...snapshot }
        return record
      },
      async runtime_capability_revoke(params, caller) {
        return capabilityAuthorization.revokeCapability(
          (params as RuntimeCapabilityQueryParams).capability as RuntimeCapabilityRecord['capability'], caller
        )
      },
      async runtime_capability_grants_list(_params, caller) {
        return { success: true, grants: capabilityAuthorization.listGrants(caller) }
      },
      async runtime_capability_grant_revoke(params, caller) {
        return capabilityAuthorization.revokeGrant((params as RuntimeCapabilityGrantRevokeParams).grantId, caller)
      },
      async system_shutdown(params) {
        return system.shutdown(params as SystemShutdownParams)
      },
      async system_restart(params) {
        return system.restart(params as SystemForceParams)
      },
      async system_logout(params) {
        return system.logout(params as SystemForceParams)
      },
      async system_lock() {
        return system.lock()
      },
      async system_sleep() {
        return system.sleep()
      },
      async system_hibernate() {
        return system.hibernate()
      },
      async system_prevent_sleep(params, caller) {
        return system.setPreventSleep(params as SystemPreventSleepParams, caller)
      },
      async system_simulate_key_press(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('按键注入', 'M5')
        await inputInjection.injectKeyPress((params as SystemKeyParams).key, signal)
        return { success: true }
      },
      async system_simulate_key_combo(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('组合键注入', 'M5')
        await inputInjection.injectKeyCombo((params as SystemKeyComboParams).keys, signal)
        return { success: true }
      },
      async system_simulate_text(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('文本输入注入', 'M5')
        await inputInjection.injectText((params as SystemTextParams).text, signal)
        return { success: true }
      },
      async system_simulate_mouse_move(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('鼠标移动注入', 'M5')
        const input = params as SystemMouseMoveParams
        await inputInjection.injectMouseMove(input.x, input.y, signal)
        return { success: true }
      },
      async system_simulate_mouse_click(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('鼠标点击注入', 'M5')
        const input = params as SystemMouseClickParams
        await inputInjection.injectMouseClick(input.button, input.x, input.y, signal)
        return { success: true }
      },
      async system_simulate_mouse_wheel(params, _caller, signal) {
        if (!inputInjection) return deferredCapability('鼠标滚轮注入', 'M5')
        await inputInjection.injectMouseWheel((params as SystemMouseWheelParams).delta, signal)
        return { success: true }
      },
      async system_get_hardware_summary() { return system.getHardwareSummary() },
      async system_get_cpu_usage() {
        return system.getCpuUsage()
      },
      async system_get_memory_usage() {
        return system.getMemoryUsage()
      },
      async system_get_disk_usage(params) {
        return system.getDiskUsage(params as SystemDiskUsageParams)
      },
      async system_get_network_stats() {
        return system.getNetworkStats()
      },
      async system_get_battery_status() {
        return system.getBatteryStatus()
      },
      async system_reload_hotkeys() {
        if (!superPanelInput) return deferredCapability('超级面板热键重载', 'M5')
        await superPanelInput.reload()
        return { success: true }
      },
      async system_get_panel_local_apps() {
        return { success: true, data: await options.getPanelLocalApps() }
      },
      async dllplugin_list(_params, caller) {
        return dllPlugins.list(caller)
      },
      async dllplugin_call(params, caller, signal) {
        return dllPlugins.call(params as DllPluginCallParams, caller, signal)
      },
      async dllplugin_call_async(params, caller) {
        return dllPlugins.callAsync(params as DllPluginCallParams, caller)
      },
      async dllplugin_call_with_callback(params, caller) {
        return dllPlugins.callWithCallback(params as DllPluginCallParams, caller)
      },
      async dllplugin_query_task(params, caller) {
        return dllPlugins.queryTask(params as DllPluginTaskParams, caller)
      },
      async dllplugin_cancel_task(params, caller) {
        return dllPlugins.cancelTask(params as DllPluginTaskParams, caller)
      },
      async dllplugin_clear_callback_task(params, caller) {
        return dllPlugins.clearCallbackTask(params as DllPluginClearTaskParams, caller)
      },
      async event_subscribe(params, caller) {
        return events.subscribe(params as EventKeyParams, caller)
      },
      async event_unsubscribe(params, caller) {
        return events.unsubscribe(params as EventKeyParams, caller)
      },
      async event_publish(params, caller) {
        return events.publish(params as EventEnvelopeParams, caller)
      },
      async event_request(params, caller) {
        return events.request(params as EventEnvelopeParams, caller)
      },
      async network_http_request(params, caller, signal) {
        return network.request(params as NetworkHttpRequestParams, caller, signal)
      },
      async network_http_download(params, caller, signal) {
        return network.download(params as NetworkTransferParams, caller, signal)
      },
      async network_http_upload(params, caller, signal) {
        return network.upload(params as NetworkTransferParams, caller, signal)
      },
      async network_set_cookie(params, caller) {
        return network.setCookie(params as NetworkSetCookieParams, caller)
      },
      async network_get_cookie(params, caller) {
        return network.getCookie(params as NetworkGetCookieParams, caller)
      },
      async network_clear_cookies(_params, caller) {
        return network.clearCookies(caller)
      },
      async network_set_proxy(params, caller) {
        return network.setProxy(params as NetworkSetProxyParams, caller)
      },
      async filesystem_read_file(params, caller) {
        return files.readFile(params as FileReadParams, caller)
      },
      async filesystem_write_file(params, caller) {
        return files.writeFile(params as FileWriteParams, caller)
      },
      async filesystem_read_cache(params, caller) {
        return files.readCache(params as FileCacheParams, caller)
      },
      async filesystem_write_cache(params, caller) {
        return files.writeCache(params as FileCacheParams, caller)
      },
      async filesystem_read_file_chunk(params, caller) {
        return files.readFileChunk(params as FileReadChunkParams, caller)
      },
      async filesystem_read_cache_chunk(params, caller) {
        const input = params as FileCacheReadChunkParams
        return files.readCacheChunk(input.relativePath, input.offset, input.length, caller)
      },
      async filesystem_write_file_start(params, caller) {
        return files.startWrite(params as FileWriteStartParams, caller)
      },
      async filesystem_write_cache_start(params, caller) {
        const input = params as FileCacheWriteStartParams
        return files.startCacheWrite(input.relativePath, input.totalSize, caller)
      },
      async filesystem_write_file_chunk(params, caller) {
        return files.writeChunk(params as FileWriteChunkParams, caller)
      },
      async filesystem_write_cache_chunk(params, caller) {
        return files.writeChunk(params as FileWriteChunkParams, caller)
      },
      async filesystem_write_file_end(params, caller) {
        return files.finishWrite((params as FileWriteHandleParams).handle, caller)
      },
      async filesystem_write_cache_end(params, caller) {
        return files.finishWrite((params as FileWriteHandleParams).handle, caller)
      },
      async filesystem_write_file_cancel(params, caller) {
        return files.cancelWrite((params as FileWriteHandleParams).handle, caller)
      },
      async filesystem_write_cache_cancel(params, caller) {
        return files.cancelWrite((params as FileWriteHandleParams).handle, caller)
      },
      async filesystem_delete_file(params, caller) {
        return files.deleteFile(params as FilePathParams, caller)
      },
      async filesystem_copy_file(params, caller) {
        return files.copyFile(params as FileCopyParams, caller)
      },
      async filesystem_move_file(params, caller) {
        return files.moveFile(params as FileCopyParams, caller)
      },
      async filesystem_file_exists(params, caller) {
        return files.fileExists(params as FilePathParams, caller)
      },
      async filesystem_get_file_size(params, caller) {
        return files.getFileSize(params as FilePathParams, caller)
      },
      async filesystem_create_directory(params, caller) {
        return files.createDirectory(params as FilePathParams, caller)
      },
      async filesystem_delete_directory(params, caller) {
        return files.deleteDirectory(params as FilePathParams, caller)
      },
      async filesystem_directory_exists(params, caller) {
        return files.directoryExists(params as FilePathParams, caller)
      },
      async filesystem_get_directory_contents(params, caller) {
        return files.getDirectoryContents(params as FilePathParams, caller)
      },
      async filesystem_get_current_directory(_params, caller) {
        return files.getCurrentDirectory(caller)
      },
      async filesystem_set_current_directory(params, caller) {
        return files.setCurrentDirectory(params as FilePathParams, caller)
      },
      async filesystem_find_files(params, caller) {
        return files.find(params as FileFindParams, caller, false)
      },
      async filesystem_find_directories(params, caller) {
        return files.find(params as FileFindParams, caller, true)
      },
      async filesystem_get_full_path(params, caller) {
        return files.getFullPath(params as FilePathParams, caller)
      },
      async filesystem_combine_path(params) {
        return files.combinePath(params as FileCombineParams)
      },
      async filesystem_get_file_name(params) {
        return files.getFileName(params as FilePathParams)
      },
      async filesystem_get_extension(params) {
        return files.getExtension(params as FilePathParams)
      },
      async filesystem_get_parent_directory(params) {
        return files.getParentDirectory(params as FilePathParams)
      },
      async shell_open_path(params, caller) {
        return shell.openPath(params as ShellPathParams, caller)
      },
      async shell_trash_item(params, caller) {
        return shell.trashItem(params as ShellPathParams, caller)
      },
      async shell_show_item_in_folder(params, caller) {
        return shell.showItemInFolder(params as ShellPathParams, caller)
      },
      async shell_open_external(params) {
        return shell.openExternal(params as ShellOpenExternalParams)
      },
      async shell_beep() {
        return shell.beep()
      },
      async shell_exec() {
        return shell.exec()
      },
      async process_list_ports(_params, _caller, signal) {
        return processes.listPorts(signal)
      },
      async process_list(_params, _caller, signal) {
        return processes.list(signal)
      },
      async process_info(params, caller, signal) {
        return processes.info(params as ProcessPidParams, caller, signal)
      },
      async process_exists(params, caller, signal) {
        return processes.exists(params as ProcessExistsParams, caller, signal)
      },
      async process_find(params, _caller, signal) {
        return processes.find(params as ProcessFindParams, signal)
      },
      async process_start(params, caller, signal) {
        return processes.start(params as ProcessStartParams, caller, signal)
      },
      async process_kill(params, caller) {
        return processes.kill(params as ProcessKillParams, caller)
      },
      async process_kill_by_name(params, caller) {
        return processes.killByName(params as ProcessKillByNameParams, caller)
      },
      async process_wait(params, caller, signal) {
        return processes.wait(params as ProcessWaitParams, caller, signal)
      },
      async process_get_window(params, _caller, signal) {
        return processes.getWindow(params as ProcessPidParams, signal)
      },
      async process_run_ffmpeg() {
        return processes.runFFmpeg()
      },
      async screen_capture(params, caller, signal) {
        return screens.capture(params as ScreenCaptureParams, caller, signal)
      },
      async screen_get_cursor_pos() {
        return screens.getCursorScreenPoint()
      },
      async screen_get_primary_display() {
        return screens.getPrimaryDisplay()
      },
      async screen_get_all_displays() {
        return screens.getAllDisplays()
      },
      async screen_get_display_nearest(params) {
        return screens.getDisplayNearestPoint(params as ScreenPointParams)
      },
      async screen_get_display_matching(params) {
        return screens.getDisplayMatching(params as ScreenRectParams)
      },
      async clipboard_copy_text(params, caller, signal) {
        return clipboard.copyText(params as ClipboardCopyTextParams, caller, signal)
      },
      async clipboard_copy_image(params) {
        return clipboard.copyImage(params as ClipboardImageParams)
      },
      async clipboard_copy_file(params, caller, signal) {
        return clipboard.copyFile(params as ClipboardFileParams, caller, signal)
      },
      async clipboard_copy_files(params, caller, signal) {
        return clipboard.copyFiles(params as ClipboardFilesParams, caller, signal)
      },
      async clipboard_read_text() {
        return clipboard.readText()
      },
      async clipboard_read_image(_params, caller) {
        return clipboard.readImage(caller)
      },
      async clipboard_read_files(_params, caller, signal) {
        return clipboard.readFiles(caller, signal)
      },
      async clipboard_hide_and_paste_text(params, caller, signal) {
        return clipboard.hideAndPasteText(params as ClipboardCopyTextParams, caller, signal)
      },
      async clipboard_hide_and_paste_image(params, caller, signal) {
        return clipboard.hideAndPasteImage(params as ClipboardImageParams, caller, signal)
      },
      async clipboard_hide_and_paste_file(params, caller, signal) {
        return clipboard.hideAndPasteFile(params as ClipboardFileParams, caller, signal)
      },
      async clipboard_hide_and_type(params, caller, signal) {
        return clipboard.hideAndType((params as { text: string }).text, caller, signal)
      },
      async clipboard_clear() {
        return clipboard.clear()
      },
      async db_put(params, caller, signal) {
        return database.put(params as DatabasePutParams, caller, signal)
      },
      async db_get(params, caller, signal) {
        return database.get(params as DatabaseGetParams, caller, signal)
      },
      async db_delete(params, caller, signal) {
        return database.delete(params as DatabaseKeyParams, caller, signal)
      },
      async db_exists(params, caller, signal) {
        return database.exists(params as DatabaseKeyParams, caller, signal)
      },
      async db_query(params, caller, signal) {
        return database.query(params as DatabaseQueryParams, caller, signal)
      },
      async db_batch(params, caller, signal) {
        return database.batch(params as DatabaseBatchParams, caller, signal)
      },
      async db_put_secure(params, caller, signal) {
        return database.putSecure(params as DatabaseSecurePutParams, caller, signal)
      },
      async db_get_secure(params, caller, signal) {
        return database.getSecure(params as DatabaseKeyParams, caller, signal)
      },
      async credential_v1_status(_params, caller) {
        return database.credentialV1Status(caller)
      },
      async credential_v1_set(params, caller, signal) {
        return database.credentialV1Set(params as CredentialV1SetParams, caller, signal)
      },
      async credential_v1_get(params, caller, signal) {
        return database.credentialV1Get(params as CredentialV1KeyParams, caller, signal)
      },
      async credential_v1_delete(params, caller, signal) {
        return database.credentialV1Delete(params as CredentialV1KeyParams, caller, signal)
      },
      async window_open() {
        return windows.unsupported('window_open')
      },
      async window_close(_params, caller) {
        return windows.close(caller)
      },
      async window_minimize(_params, caller) {
        return windows.minimize(caller)
      },
      async window_maximize(_params, caller) {
        return windows.maximize(caller)
      },
      async window_fullscreen_toggle(_params, caller) {
        return windows.toggleFullscreen(caller)
      },
      async window_drag() {
        return windows.unsupported('window_drag')
      },
      async window_hide(_params, caller) {
        return windows.hide(caller)
      },
      async window_show(_params, caller) {
        return windows.show(caller)
      },
      async pluginwin_hide(_params, caller) {
        return windows.hide(caller)
      },
      async pluginwin_show(_params, caller) {
        return windows.show(caller)
      },
      async pluginwin_minimize(_params, caller) {
        return windows.minimize(caller)
      },
      async pluginwin_restore(_params, caller) {
        return windows.show(caller)
      },
      async window_set_height(params, caller) {
        return windows.setHeight(params as WindowSetHeightParams, caller)
      },
      async window_out_plugin(_params, caller) {
        return windows.hide(caller)
      },
      async window_redirect(params, caller) {
        return windows.redirect(params as WindowUrlParams, caller)
      },
      async window_show_open_dialog(params, caller) {
        return windows.showOpenDialog(params as WindowDialogParams, caller)
      },
      async window_show_save_dialog(params, caller) {
        return windows.showSaveDialog(params as WindowDialogParams, caller)
      },
      async window_show_select_folder_dialog(params, caller) {
        return windows.showSelectFolderDialog(params as WindowDialogParams, caller)
      },
      async window_set_size(params, caller) {
        return windows.setSize(params as WindowSetSizeParams, caller)
      },
      async window_get_bounds(_params, caller) {
        return windows.getBounds(caller)
      },
      async window_set_opacity(params, caller) {
        return windows.setOpacity(params as WindowSetOpacityParams, caller)
      },
      async window_set_always_on_top(params, caller) {
        return windows.setAlwaysOnTop(params as WindowSetAlwaysOnTopParams, caller)
      },
      async window_show_tooltip(params, caller) {
        return windows.showTooltip((params as { text: string }).text, caller)
      },
      async window_hide_tooltip(_params, caller) {
        return windows.hideTooltip(caller)
      },
      async window_show_record_bar(params, caller) {
        return windows.showRecordBar(params as { duration?: number; taskId?: string }, caller)
      },
      async window_update_record_bar(params, caller) {
        return windows.updateRecordBar(params as { duration?: number; status?: string }, caller)
      },
      async window_hide_record_bar(_params, caller) {
        return windows.hideRecordBar(caller)
      },
      async window_toggle_devtools(_params, caller) {
        return windows.toggleDevTools(caller)
      },
      async ui_close_confirm_result(params, caller) {
        try {
          return await windows.handleCloseConfirm(
            params as WindowCloseConfirmParams,
            caller,
            async () => { await services.config.setSetting('closeConfirm', false) }
          )
        } finally {
          options.closeConfirmationResolved()
        }
      },
      async clipboard_history_query(params) {
        return services.clipboardHistory.queryItems(params as any)
      },
      async clipboard_history_toggle_pin(params) {
        const input = params as { id: string }
        const success = services.clipboardHistory.togglePin(input?.id)
        return { success }
      },
      async clipboard_history_delete(params) {
        const input = params as { id: string }
        const success = services.clipboardHistory.deleteItem(input?.id)
        return { success }
      },
      async clipboard_history_clear_unpinned() {
        const count = services.clipboardHistory.clearUnpinned()
        return { success: true, count }
      },
      async clipboard_history_paste_sequential(_params, caller, signal) {
        return services.clipboardHistory.pasteSequential(async (text) => {
          await clipboard.hideAndPasteText({ text }, caller, signal)
        })
      },
      async clipboard_history_reset_sequence() {
        return services.clipboardHistory.resetPasteSequence()
      },
      async snippets_list(params) {
        return services.snippets.listSnippets((params as { query?: string })?.query)
      },
      async snippets_create(params) {
        return services.snippets.createSnippet(params as any)
      },
      async snippets_update(params) {
        const input = params as { id: string; [key: string]: any }
        return services.snippets.updateSnippet(input?.id, input as any)
      },
      async snippets_delete(params) {
        const input = params as { id: string }
        const success = services.snippets.deleteSnippet(input?.id)
        return { success }
      },
      async snippets_toggle(params) {
        const input = params as { id: string }
        const success = services.snippets.toggleSnippet(input?.id)
        return { success }
      },
      async snippets_match_and_expand(params) {
        const input = params as { typedText: string; clipboardContent?: string }
        return services.snippets.matchAndExpand(input?.typedText, input?.clipboardContent)
      },
      async snippets_import(params) {
        const input = params as { data: any }
        return services.snippets.importSnippets(input?.data ?? params)
      },
      async snippets_export() {
        return services.snippets.exportSnippets()
      },
      async filesearch_query(params) {
        const input = params as { query: string; limit?: number }
        return services.fileSearch.search(input?.query, input?.limit)
      },
      async filesearch_open(params) {
        const input = params as { path: string }
        return services.fileSearch.openFile(input?.path)
      },
      async filesearch_reveal(params) {
        const input = params as { path: string }
        return services.fileSearch.revealFile(input?.path)
      },
      async filesearch_sha256(params) {
        const input = params as { path: string }
        return services.fileSearch.calculateSha256(input?.path)
      },
      async window_manage_action(params) {
        const input = params as { action: string }
        return services.windowManagement.applyAction(input?.action)
      },
      async window_manage_list_actions() {
        return services.windowManagement.listActions()
      },
      async developer_create_extension(params) {
        return services.developer.createExtension(params as any)
      },
      async developer_import_extension(params) {
        const input = params as { path: string }
        return services.developer.importExtension(input?.path)
      },
      async developer_list_extensions(params) {
        const input = params as { search?: string }
        return services.developer.listExtensions(input?.search)
      },
      async developer_toggle_extension(params) {
        const input = params as { id: string; enabled?: boolean }
        return { success: services.developer.toggleExtension(input?.id, input?.enabled) }
      },
      async developer_remove_extension(params) {
        const input = params as { id: string }
        return { success: services.developer.removeExtension(input?.id) }
      },
      async developer_diagnostics() {
        return services.developer.extensionDiagnostics()
      },
      async mcp_install_server(params) {
        return services.mcp.installServer(params as any)
      },
      async mcp_manage_servers(params) {
        const input = params as { search?: string }
        return services.mcp.manageServers(input?.search)
      },
      async mcp_toggle_server(params) {
        const input = params as { id: string; enabled?: boolean }
        return { success: await services.mcp.toggleServer(input?.id, input?.enabled) }
      },
      async mcp_remove_server(params) {
        const input = params as { id: string }
        return { success: await services.mcp.removeServer(input?.id) }
      },
      async focus_start(params) {
        return services.focus.startSession(params as any)
      },
      async focus_toggle() {
        return services.focus.toggleSession()
      },
      async focus_pause() {
        return services.focus.pauseSession()
      },
      async focus_resume() {
        return services.focus.resumeSession()
      },
      async focus_complete() {
        return services.focus.completeSession()
      },
      async focus_cancel() {
        return services.focus.cancelSession()
      },
      async focus_get_current() {
        return services.focus.getCurrentSession()
      },
      async focus_list_categories(params) {
        const input = params as { search?: string }
        return services.focus.listCategories(input?.search)
      },
      async focus_create_category(params) {
        return services.focus.createCategory(params as any)
      },
      async focus_get_stats() {
        return services.focus.getStats()
      },
      async screen_awareness_selected_text() {
        return services.screenAwareness.captureSelectedText()
      },
      async screen_awareness_screen() {
        return services.screenAwareness.captureScreen()
      },
      async screen_awareness_screen_area(params) {
        const input = params as { rect: any }
        return services.screenAwareness.captureScreenArea(input?.rect)
      },
      async screen_awareness_focused_window() {
        return services.screenAwareness.captureFocusedWindow()
      },
      async dictation_start(params) {
        return services.dictation.startDictation(params as any)
      },
      async dictation_finish(params) {
        return services.dictation.finishDictation(params as any)
      },
      async dictation_cancel() {
        return { success: services.dictation.cancelDictation() }
      },
      async dictation_get_last() {
        return services.dictation.getLastTranscription()
      },
      async dictation_search(params) {
        const input = params as { query?: string; limit?: number }
        return services.dictation.searchTranscriptions(input?.query, input?.limit)
      },
      async dictation_add_word(params) {
        const input = params as { word: string }
        return { success: services.dictation.addWordToVocabulary(input?.word) }
      },
      async dictation_list_words() {
        return services.dictation.listVocabulary()
      },
      async calendar_create_event(params) {
        return services.calendar.createEvent(params as any)
      },
      async calendar_upcoming_events(params) {
        const input = params as { withinHours?: number }
        return services.calendar.getUpcomingEvents(input?.withinHours)
      },
      async calendar_list_events(params) {
        return services.calendar.listEvents(params as any)
      },
      async calendar_delete_event(params) {
        const input = params as { id: string }
        return { success: services.calendar.deleteEvent(input?.id) }
      },
      async calendar_export_ics(params) {
        const input = params as { events?: any[] }
        return { ics: services.calendar.exportToIcs(input?.events) }
      },
      async navigation_list_windows(params) {
        const input = params as { search?: string }
        return services.navigation.listOpenWindows(input?.search)
      },
      async navigation_activate_window(params) {
        const input = params as { hwnd: number }
        return services.navigation.activateWindow(input?.hwnd)
      },
      async navigation_close_window(params) {
        const input = params as { hwnd: number }
        return services.navigation.closeWindow(input?.hwnd)
      },
      async web_search(params) {
        const input = params as { engine: any; query: string }
        return services.webBrowser.searchWeb(input?.engine, input?.query)
      },
      async url_quick_open(params) {
        const input = params as { url: string }
        return services.webBrowser.quickOpenUrl(input?.url)
      },
      async browser_get_active_tab() {
        return services.webBrowser.getActiveBrowserUrl()
      },
      async contacts_list(params) {
        const input = params as { search?: string; limit?: number }
        return services.webBrowser.listContacts(input?.search, input?.limit)
      },
      async contacts_create(params) {
        return services.webBrowser.createContact(params as any)
      },
      async contacts_delete(params) {
        const input = params as { id: string }
        return { success: services.webBrowser.deleteContact(input?.id) }
      },
      async games_list(params) {
        const input = params as { search?: string }
        return services.geekTools.listGames(input?.search)
      },
      async games_launch(params) {
        const input = params as { id: string }
        return services.geekTools.launchGame(input?.id)
      },
      async typing_get_challenges() {
        return services.geekTools.getTypingChallenges()
      },
      async typing_evaluate(params) {
        const input = params as { challengeId: string; typedText: string; elapsedSeconds: number }
        return services.geekTools.evaluateTyping(input?.challengeId, input?.typedText, input?.elapsedSeconds)
      },
      async game_2048_create() {
        return services.geekTools.createGame2048()
      },
      async game_2048_move(params) {
        const input = params as { state: any; direction: any }
        return services.geekTools.moveGame2048(input?.state, input?.direction)
      },
      async debug_sample_memory() {
        return services.geekTools.sampleMemory()
      },
      async debug_create_clipboard_history(params) {
        const input = params as { count?: number }
        return services.geekTools.createDebugClipboardHistory(input?.count)
      },
      // M1.5 Group 2 Services
      async emoji_search(params) {
        const input = (params || {}) as { query?: string; category?: any; skinTone?: any; limit?: number }
        const opts: Parameters<typeof services.emoji.search>[1] = {}
        if (input?.category !== undefined) opts.category = input.category
        if (input?.skinTone !== undefined) opts.skinTone = input.skinTone
        if (input?.limit !== undefined) opts.limit = input.limit
        return services.emoji.search(input?.query ?? '', opts)
      },
      async emoji_record_usage(params) {
        const input = params as { char: string }
        services.emoji.recordUsage(input?.char)
        return { success: true }
      },
      async emoji_toggle_favorite(params) {
        const input = params as { char: string }
        return { isFavorite: services.emoji.toggleFavorite(input?.char) }
      },
      async emoji_get_recents() {
        return { items: services.emoji.getRecent() }
      },
      async emoji_get_favorites() {
        return { items: services.emoji.getFavorites() }
      },
      async translator_translate(params) {
        const input = params as { text: string; sourceLanguage?: string; targetLanguage?: string }
        const opts: Parameters<typeof services.translator.translate>[1] = {}
        if (input?.sourceLanguage !== undefined) opts.sourceLanguage = input.sourceLanguage
        if (input?.targetLanguage !== undefined) opts.targetLanguage = input.targetLanguage
        return services.translator.translate(input?.text, opts)
      },
      async translator_detect_language(params) {
        const input = params as { text: string }
        return { language: services.translator.detectLanguage(input?.text) }
      },
      async translator_get_history() {
        return { items: services.translator.getHistory() }
      },
      async notes_list(params) {
        const input = (params || {}) as any
        return services.notes.listNotes(input)
      },
      async notes_get(params) {
        const input = params as { id: string }
        return services.notes.getNote(input?.id)
      },
      async notes_save(params) {
        const input = params as any
        if (input?.id) {
          return services.notes.updateNote(input.id, {
            title: input?.title,
            content: input?.content,
            pinned: input?.pinned,
            color: input?.color,
            tags: input?.tags
          })
        }
        return services.notes.createNote({
          title: input?.title,
          content: input?.content || '',
          pinned: input?.pinned,
          color: input?.color,
          tags: input?.tags
        })
      },
      async notes_delete(params) {
        const input = params as { id: string; permanent?: boolean }
        if (input?.permanent) {
          return { success: services.notes.permanentlyDelete(input?.id) }
        }
        services.notes.moveToTrash(input?.id)
        return { success: true }
      },
      async notes_restore(params) {
        const input = params as { id: string }
        services.notes.restoreFromTrash(input?.id)
        return { success: true }
      },
      async notes_toggle_pin(params) {
        const input = params as { id: string }
        return { pinned: services.notes.togglePin(input?.id) }
      },
      async notes_count() {
        return services.notes.countNotes()
      },
      async windows_run_search(params) {
        const input = (params || {}) as { query?: string }
        return services.windowsRun.searchCommands(input?.query)
      },
      async windows_run_execute(params) {
        const input = params as { command: string; args?: string[]; runAsAdmin?: boolean; shell?: any; workingDirectory?: string }
        const opts: Parameters<typeof services.windowsRun.execute>[1] = {}
        if (input?.args) opts.arguments = input.args.join(' ')
        if (input?.runAsAdmin !== undefined) opts.asAdministrator = input.runAsAdmin
        if (input?.shell !== undefined) opts.shell = input.shell
        if (input?.workingDirectory !== undefined) opts.workingDirectory = input.workingDirectory
        return services.windowsRun.execute(input?.command, opts)
      },
      async windows_run_register_alias(params) {
        const input = params as { alias: string; command: string; description?: string; descriptionZh?: string; runAsAdminByDefault?: boolean }
        return services.windowsRun.createCustomCommand({
          alias: input?.alias,
          command: input?.command,
          description: input?.description,
          descriptionZh: input?.descriptionZh,
          runAsAdminByDefault: input?.runAsAdminByDefault
        })
      },
      async windows_run_remove_alias(params) {
        const input = params as { alias: string }
        const cmd = services.windowsRun.getByAlias(input?.alias)
        return { success: cmd ? services.windowsRun.deleteCustomCommand(cmd.id) : false }
      },
      async taskbar_toggle() {
        return services.taskbar.toggleTaskbar()
      },
      async taskbar_show() {
        return services.taskbar.showTaskbar()
      },
      async taskbar_hide() {
        return services.taskbar.hideTaskbar()
      },
      async taskbar_status() {
        return { visible: await services.taskbar.isTaskbarVisible() }
      },
      async screenshots_scan(params) {
        const input = (params || {}) as { query?: string; limit?: number; pinnedFirst?: boolean; forceRefresh?: boolean }
        return services.screenshots.scanScreenshots(input?.forceRefresh)
      },
      async screenshots_paste_latest() {
        return services.screenshots.pasteLatestScreenshot()
      },
      async screenshots_toggle_pin(params) {
        const input = params as { filePath: string }
        const screenshots = services.screenshots.scanScreenshots()
        const target = screenshots.find(s => s.path === input?.filePath)
        if (target?.pinned) {
          services.screenshots.unpinScreenshot(input?.filePath)
          return { pinned: false }
        } else {
          services.screenshots.pinScreenshot(input?.filePath)
          return { pinned: true }
        }
      },
      async screenshots_delete(params) {
        const input = params as { filePath: string; permanent?: boolean }
        return { success: await services.screenshots.deleteScreenshot(input?.filePath) }
      },
      async applications_list(params) {
        const input = (params || {}) as { query?: string; includeSystemComponents?: boolean; forceRefresh?: boolean }
        const opts = input?.includeSystemComponents !== undefined ? { includeSystemComponents: input.includeSystemComponents } : {}
        return services.applications.searchApplications(input?.query, opts)
      },
      async applications_uninstall(params) {
        const input = params as { command: string }
        return services.applications.launchUninstall(input?.command)
      },
      async dictionary_lookup(params) {
        const input = params as { word: string }
        return services.dictionary.lookup(input?.word)
      },
      async dictionary_suggestions(params) {
        const input = params as { prefix: string; limit?: number }
        return services.dictionary.getSuggestions(input?.prefix, input?.limit)
      },
      async dictionary_toggle_favorite(params) {
        const input = params as { word: string }
        return { isFavorite: services.dictionary.toggleFavorite(input?.word) }
      },
      async dictionary_get_favorites() {
        return { items: services.dictionary.getFavorites() }
      },
      async dictionary_get_history() {
        return { items: services.dictionary.getHistory() }
      }
    }
    this.#stopThemeEvents = constructionScope.ownCleanup(
      bindNativeThemeEvents(nativeTheme, this.#events)
    )
  }

  register(): void {
    if (this.#registered || this.#stopping) throw new Error('IpcRouter can only be registered once')
    this.#capabilityPrompt.register()
    ipcMain.handle(IPC_CALL_CHANNEL, (event, value) => this.#handle(event, value))
    ipcMain.handle(RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL, (event, value) => this.#handleRuntimeCapabilityRequestCancel(event, value))
    ipcMain.handle(NETWORK_REQUEST_CANCEL_CHANNEL, (event, value) => this.#handleNetworkRequestCancel(event, value))
    const fileDrop = new FileDropService(this.registry, this.#files)
    ipcMain.handle(FILE_DROP_CHANNEL, async (event, value: unknown) => {
      try {
        return await this.#handleFileDrop(event, value, fileDrop)
      } catch (error) {
        return { success: false, error: toPublicError(error) }
      }
    })
    ipcMain.handle(REFERENCE_CANCEL_CHANNEL, (event, value) => this.#handleReferenceCancel(event, value))
    const handshakeListener = (event: IpcMainEvent, ...args: unknown[]): void => {
      event.returnValue = createSdkLaneHandshakeReply(
        this.registry,
        event,
        args.length,
        this.#stopping,
        SDK_HOST_MAXIMUM_CONTRACT_VERSION
      )
    }
    this.#sdkLaneHandshakeListener = handshakeListener
    ipcMain.on(SDK_LANE_HANDSHAKE_CHANNEL, handshakeListener)
    this.#registered = true
    this.#permissionMonitor.start()
    ipcMain.on('ztools:legacy-file-sync', this.#handleLegacyFile)
  }

  readonly #handleLegacyFile = (event: IpcMainEvent, value: unknown): void => {
    const method = typeof value === 'object' && value !== null && 'method' in value ? value.method : undefined
    if (!['filesystem_get_file_size', 'filesystem_read_file', 'filesystem_read_file_chunk', 'filesystem_write_file'].includes(method as string)) {
      event.returnValue = { success: false, error: { code: errorCodes.methodNotFound, message: '不支持的同步文件方法' } }
      return
    }
    // Only the caller renderer waits; authorization, validation, timeout and async file I/O
    // use the same pipeline as the normal bridge. Never invoke renderer JS here.
    void this.#handle(event, value).then((response) => { event.returnValue = response })
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopping = true
    const errors: unknown[] = []
    const attempt = (action: () => unknown): void => {
      try { action() }
      catch (error) { errors.push(error) }
    }
    attempt(() => this.#permissionMonitor.stop())
    attempt(() => this.#capabilityAuthorization.stop())
    attempt(() => this.#capabilityRequestCancellations.stop())
    attempt(() => this.#networkRequestCancellations.stop())
    attempt(() => this.#runtimeCapabilities.stop())
    attempt(() => this.#stopPermissionOwnerEvents())
    attempt(() => this.#stopThemeEvents())
    attempt(() => this.#removeUpdateProgressListener())
    attempt(() => ipcMain.removeListener('ztools:legacy-file-sync', this.#handleLegacyFile))
    attempt(() => this.#windows.stop())
    if (this.#registered) {
      attempt(() => ipcMain.removeHandler(IPC_CALL_CHANNEL))
      attempt(() => ipcMain.removeHandler(RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL))
      attempt(() => ipcMain.removeHandler(NETWORK_REQUEST_CANCEL_CHANNEL))
      attempt(() => ipcMain.removeHandler(FILE_DROP_CHANNEL))
      attempt(() => ipcMain.removeHandler(REFERENCE_CANCEL_CHANNEL))
      this.#registered = false
      if (this.#sdkLaneHandshakeListener) {
        const listener = this.#sdkLaneHandshakeListener
        this.#sdkLaneHandshakeListener = undefined
        attempt(() => ipcMain.removeListener(SDK_LANE_HANDSHAKE_CHANNEL, listener))
      }
    }
    try { this.#referenceRuntime?.closeIngress() } catch (error) { errors.push(error) }
    for (const senderCalls of this.#pending.values()) {
      for (const call of senderCalls.values()) call.controller.abort(errorCodes.appStopping)
    }
    this.#pending.clear()
    this.#stopPromise = (async () => {
      const settle = async (actions: readonly (() => unknown)[]): Promise<void> => {
        const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)))
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
      }

      const runtime = this.#referenceRuntime
      if (runtime) {
        await settle([() => runtime.drain()])
        await settle([() => runtime.stop()])
      }

      await settle([
        () => this.#dllPlugins.stop(),
        () => this.#pluginWindows.stop(),
        () => this.#plugins.stop(),
        () => this.#triggers.stop(),
        () => this.#superPanelInput?.stop(),
        () => this.#processes.stop(),
        () => this.#system.stop(),
        async () => { await this.#clipboard.stop(); await this.#database.stop() }
      ])
      await settle([
        () => this.#files.stop(),
        () => this.#events.stop()
      ])
      if (errors.length > 0) throw new AggregateError(errors, 'IpcRouter cleanup was incomplete')
    })()
    return this.#stopPromise
  }

  async #handle(event: IpcMainInvokeEvent | IpcMainEvent, value: unknown): Promise<ZToolsResponse> {
    if (this.#stopping) {
      return failedResponse(value, errorCodes.appStopping, '应用正在退出')
    }
    const dispatch = selectTrustedSdkLaneDispatch(this.registry, event, value, SDK_HOST_MAXIMUM_CONTRACT_VERSION)
    return dispatchTrustedSdkLaneCall({
      decision: dispatch,
      event,
      value,
      ...(this.#referenceRuntime ? { reference: this.#referenceRuntime.endpoint } : {}),
      legacy: context => this.#handleLegacy(event, value, context)
    })
  }

  async #handleLegacy(
    event: IpcMainInvokeEvent | IpcMainEvent,
    value: unknown,
    ownerContext?: TrustedSdkLaneContext
  ): Promise<ZToolsResponse> {
    let request: ZToolsRequest | undefined
    let caller: CallerIdentity | undefined
    let failureStage = 'parse'
    try {
      request = parseRequest(value)
      failureStage = 'identity'
      caller = this.registry.get(event.sender.id)
      if (!caller) throw new ZToolsError(errorCodes.permissionDenied, '调用者未注册')
      if (ownerContext && (!isCurrentTrustedSdkLaneContext(ownerContext) ||
          caller.type !== ownerContext.caller.type || caller.pluginId !== ownerContext.caller.pluginId ||
          caller.pluginInstanceId !== ownerContext.caller.pluginInstanceId)) {
        throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面已失效')
      }
      failureStage = 'authorization'
      authorizeIpcRequest(caller, request, event.sender)
      if (!isPlatformSupportedMethod(request.method)) {
        throw new ZToolsError(
          errorCodes.platformNotSupported,
          `当前操作系统 (${process.platform}) 不支持方法: ${request.method}`
        )
      }
      failureStage = 'validation'
      validateMethodParams(request.method, request.params)
      const handler = this.#handlers[request.method]
      failureStage = 'execute'
      const data = await this.#execute(
        event,
        request,
        caller,
        handler,
        ownerContext ? () => isCurrentTrustedSdkLaneContext(ownerContext) : undefined
      )
      return { messageId: request.messageId, success: true, data }
    } catch (error) {
      console.error('[IPC ROUTER ERROR DETAILS]', request?.method, error)
      const publicError = toPublicError(error)
      caller ??= this.registry.get(event.sender.id)
      if (request && caller) {
        const executionStage = failureStage === 'execute'
          ? request.method.startsWith('dllplugin_')
            ? 'native'
            : request.method === 'network_http_request'
              ? 'network'
              : 'execute'
          : failureStage
        this.#diagnosticFailures.record(caller, {
          requestId: request.messageId,
          method: request.method,
          failureStage: executionStage,
          errorCode: publicError.code
        })
      }
      const failureLogIdentifierFields = getIpcFailureLogIdentifierFields(request)
      // Missing optional settings/cache entries are handled as null by the SDK.
      // Preserve the wire error for compatibility without logging a host failure.
      const missingDatabaseKey = publicError.code === errorCodes.databaseKeyNotFound &&
        (request?.method === 'db_get' || request?.method === 'db_get_secure')
      if (!missingDatabaseKey) {
        console.warn('IPC request failed', {
          senderWebContentsId: event.sender.id,
          messageId: request?.messageId,
          callerType: caller?.type ?? 'unregistered',
          pluginId: caller?.pluginId,
          method: request?.method ?? 'invalid',
          ...failureLogIdentifierFields,
          errorCode: publicError.code,
          errorMessage: publicError.message,
          ...(error instanceof ZToolsError && error.details ? {
            hostCode: error.details.hostCode,
            rejectedFields: error.details.fields,
            rejectionPath: error.details.path
          } : {})
        })
      }
      return {
        messageId: request?.messageId ?? 'invalid',
        success: false,
        error: publicError
      }
    }
  }

  async #handleReferenceCancel(event: IpcMainInvokeEvent, value: unknown): Promise<ZToolsResponse> {
    let messageId = requestMessageId(value)
    try {
      if (this.#stopping) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
      const context = getTrustedSdkLaneContext(this.registry, event)
      if (!context || context.lane !== 2) {
        throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面无效')
      }
      const cancellation = parseReferenceCancellation(value)
      messageId = cancellation.messageId
      const route = selectTrustedSdkLaneDispatch(this.registry, event, {
        method: cancellation.method
      }, SDK_HOST_MAXIMUM_CONTRACT_VERSION)
      if (route.kind !== 'reference') {
        throw new ZToolsError(errorCodes.notSupported, '此 SDK lane 未启用引用式取消')
      }
      if (!this.#referenceRuntime) {
        throw new ZToolsError(errorCodes.notSupported, '文件引用运行时尚未接线')
      }
      if (!isCurrentTrustedSdkLaneContext(context) || !isCurrentTrustedSdkLaneContext(route.context)) {
        throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面已失效')
      }
      return await this.#referenceRuntime.endpoint.cancel(event, value)
    } catch (error) {
      return { messageId, success: false, error: toPublicError(error) }
    }
  }

  async #handleRuntimeCapabilityRequestCancel(event: IpcMainInvokeEvent, value: unknown): Promise<ZToolsResponse> {
    let messageId = requestMessageId(value)
    try {
      if (this.#stopping) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
      const context = getTrustedSdkLaneContext(this.registry, event)
      if (!context || context.caller.type !== 'plugin') {
        throw new ZToolsError(errorCodes.permissionDenied, '屏幕权限申请取消调用者无效')
      }
      const request = parseRuntimeCapabilityRequestCancellation(value)
      messageId = request.messageId
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, '屏幕权限申请取消调用者已失效')
      }
      const data = this.#capabilityRequestCancellations.cancel(context.caller, request.messageId, request.reason)
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, '屏幕权限申请取消调用者已失效')
      }
      return { messageId, success: true, data }
    } catch (error) {
      return { messageId, success: false, error: toPublicError(error) }
    }
  }

  async #handleNetworkRequestCancel(event: IpcMainInvokeEvent, value: unknown): Promise<ZToolsResponse> {
    return this.#networkRequestCancellationEndpoint.cancel(event, value)
  }

  async #handleFileDrop(
    event: IpcMainInvokeEvent,
    value: unknown,
    legacyDrop: FileDropService
  ): Promise<unknown> {
    if (this.#stopping) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    const caller = this.registry.get(event.sender.id)
    if (!caller) return legacyDrop.accept(event.sender.id, value)
    let lane: number | undefined
    try { lane = this.registry.getSdkApiLane(caller) }
    catch { throw new ZToolsError(errorCodes.notSupported, 'SDK API lane 无效') }
    if (lane === 1) return legacyDrop.accept(event.sender.id, value)
    if (lane !== 2) throw new ZToolsError(errorCodes.notSupported, 'SDK API lane 无效')

    const context = getTrustedSdkLaneContext(this.registry, event)
    if (!context || context.lane !== 2) {
      throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面无效')
    }
    const route = selectTrustedSdkLaneDispatch(this.registry, event, {
      method: 'filesystem_read_file'
    }, SDK_HOST_MAXIMUM_CONTRACT_VERSION)
    if (route.kind !== 'reference') {
      throw new ZToolsError(errorCodes.notSupported, '当前 host 尚未启用引用式文件拖放')
    }
    if (!this.#referenceRuntime) {
      throw new ZToolsError(errorCodes.notSupported, '文件引用运行时尚未接线')
    }
    if (!isCurrentTrustedSdkLaneContext(context)) {
      throw new ZToolsError(errorCodes.permissionDenied, '调用者身份或页面已失效')
    }
    return this.#referenceRuntime.endpoint.acceptDrop(event, value)
  }

  async #execute(
    event: Pick<IpcMainInvokeEvent, 'sender'>,
    request: ZToolsRequest,
    caller: CallerIdentity,
    handler: Handler,
    ownerIsCurrent?: () => boolean
  ): Promise<unknown> {
    if (ownerIsCurrent && !ownerIsCurrent()) {
      throw new ZToolsError(errorCodes.callerDestroyed, '调用页面已失效')
    }
    const senderCalls = this.#pending.get(event.sender.id) ?? new Map<string, PendingLegacyCall>()
    if (senderCalls.has(request.messageId)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'messageId 正在使用')
    }
    this.#pending.set(event.sender.id, senderCalls)
    const controller = new AbortController()
    const pendingCall = { method: request.method, controller }
    senderCalls.set(request.messageId, pendingCall)
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timeout = timeoutMs === 'infinite'
      ? undefined
      : setTimeout(() => controller.abort(errorCodes.requestTimeout), timeoutMs)
    const onDestroyed = (): void => {
      if (request.method === 'network_http_request') this.#networkRequestCancellations.closeOwner(event.sender.id)
      controller.abort(errorCodes.callerDestroyed)
    }
    event.sender.once('destroyed', onDestroyed)
    let releaseCapabilityRequestCancellation: () => void = () => undefined
    let releaseNetworkRequestCancellation: () => void = () => undefined
    let removeNetworkNavigationListener: () => void = () => undefined
    let onAbort: (() => void) | undefined
    try {
      if (request.method === 'network_http_request') {
        const onNavigation = (_details: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
          if (!isMainFrame || isInPlace) return
          this.#networkRequestCancellations.closeOwner(event.sender.id)
          controller.abort(errorCodes.callerDestroyed)
        }
        event.sender.on('did-start-navigation', onNavigation)
        removeNetworkNavigationListener = () => event.sender.removeListener('did-start-navigation', onNavigation)
      }
      if (request.method === 'runtime_capability_request') {
        releaseCapabilityRequestCancellation = this.#capabilityRequestCancellations.begin(caller, request.messageId, controller)
      }
      if (request.method === 'network_http_request') {
        releaseNetworkRequestCancellation = this.#networkRequestCancellations.begin(
          caller,
          'network_http_request',
          request.messageId,
          controller
        )
      }
      if (request.method === 'network_http_request') {
        if (controller.signal.aborted) {
          const code = controller.signal.reason
          if (code === errorCodes.requestTimeout) throw new ZToolsError(errorCodes.requestTimeout, '调用超时')
          if (code === errorCodes.appStopping) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
          throw new ZToolsError(errorCodes.callerDestroyed, '调用者已销毁')
        }
        const result = await handler(request.params, caller, controller.signal)
        if (ownerIsCurrent && !ownerIsCurrent()) {
          throw new ZToolsError(errorCodes.callerDestroyed, '调用页面已失效，结果未交付')
        }
        return result
      }
      const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            const code = controller.signal.reason
            if (code === errorCodes.requestTimeout) {
              reject(new ZToolsError(errorCodes.requestTimeout, '调用超时'))
            } else if (code === errorCodes.appStopping) {
              reject(new ZToolsError(errorCodes.appStopping, '应用正在退出'))
            } else {
              reject(new ZToolsError(errorCodes.callerDestroyed, '调用者已销毁'))
            }
        }
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      if (controller.signal.aborted) await abortPromise
      const result = await Promise.race([handler(request.params, caller, controller.signal), abortPromise])
      if (ownerIsCurrent && !ownerIsCurrent()) {
        throw new ZToolsError(errorCodes.callerDestroyed, '调用页面已失效，结果未交付')
      }
      return result
    } finally {
      releaseCapabilityRequestCancellation()
      releaseNetworkRequestCancellation()
      removeNetworkNavigationListener()
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
      event.sender.removeListener('destroyed', onDestroyed)
      senderCalls.delete(request.messageId)
      if (senderCalls.size === 0) this.#pending.delete(event.sender.id)
    }
  }
}

function requestMessageId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const messageId = (value as Record<string, unknown>).messageId
  return typeof messageId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(messageId)
    ? messageId
    : 'invalid'
}

function failedResponse(
  value: unknown,
  code: typeof errorCodes[keyof typeof errorCodes],
  message: string
): ZToolsResponse {
  return {
    messageId: requestMessageId(value),
    success: false,
    error: toPublicError(new ZToolsError(code, message))
  }
}
