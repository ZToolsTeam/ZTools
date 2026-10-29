import { RecentProjectsService } from '../services/recent-projects-service.js'
import { StartupManagerService } from '../services/startup-manager-service.js'
import { StartupBackupStore } from '../services/startup-backups.js'
import { MacStartupWriter, macStartupHelperPath } from '../services/startup-writer.js'
import { LanNetworkService } from '../services/lan-network-service.js'
import { NetworkSpeedtestService } from '../services/network-speedtest-service.js'
import { HotkeyProbeService, nativeHotkeyProbe, macHotkeysHelperPath } from '../services/hotkey-probe-service.js'
import { HostsManagerService } from '../services/hosts-manager-service.js'
import { HostsBackups } from '../services/hosts-backups.js'
import { MacHostsProvider, macHostsHelperPath } from '../services/hosts-provider.js'
import { FolderSyncService } from '../services/folder-sync-service.js'
import { NativePathAccessAdapter } from '../platform/native-path-access.js'
import { resolvePathAccessBroker } from '../platform/path-access-broker.js'
import { FontManagerService } from '../services/font-manager-service.js'
import { BrowserBookmarksService } from '../services/browser-bookmarks-service.js'
import { KeyboardLockService, macInputLockPath } from '../services/keyboard-lock-service.js'
import { DockerManagerService } from '../services/docker-manager-service.js'
import { EnvironmentManagerService } from '../services/environment-manager-service.js'
import { FileUnlockService } from '../services/file-unlock-service.js'
import { MacFileLocks } from '../services/mac-file-locks.js'
import { SystemEnvironmentProvider } from '../services/environment-provider.js'
import { EnvironmentBackupStore } from '../services/environment-backups.js'
import { DnsBenchmarkService } from '../services/dns-benchmark-service.js'
import { DnsBackupStore } from '../services/dns-backup-store.js'
import { MacDnsNetworkProvider, macDnsHelperPath } from '../services/dns-network-provider.js'
import { SystemFontProvider, macFontHelperPath } from '../services/font-provider.js'
import { MediaMetadataService } from '../services/media-metadata-service.js'
import { OfficeDocumentService } from '../services/office-document-service.js'
import { MarkdownDocumentService } from '../services/markdown-document-service.js'
import { MonitorControlService, monitorHelperPath } from '../services/monitor-control-service.js'
import { SshProxyService } from '../services/ssh-proxy-service.js'
import { TlsInspectService } from '../services/tls-inspect-service.js'
import { ProxyConfigurationProvider } from '../services/proxy-configuration.js'
import { bindNativeThemeEvents } from '../platform/native-theme-events.js'
import { createMacPasteAdapter } from '../platform/macos/window-controller.js'
import { showDesktopNotification } from '../platform/desktop-notification.js'
import {
  app,
  BrowserWindow,
  clipboard as electronClipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  nativeImage,
  powerSaveBlocker,
  shell as electronShell,
  systemPreferences,
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
  type DatabaseCompareAndSetParams,
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
  type PluginInstallStatusParams,
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
  type SystemPowerSessionParams,
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
  type WindowUrlParams,
  type WindowOpenParams,
  type WindowPopoutHandoffTakeParams,
  type DatabaseCompactParams,
  type DeclarativeSessionCloseParams,
  type DeclarativeSessionOpenParams,
  type ProcessTerminatePidParams
} from '../../contracts/method-params.js'
import {
  createBundledManifestReader,
  DeclarativePluginAttributionService
} from '../services/declarative-plugin-attribution-service.js'
import { isHostCaller, requirePluginPermission } from './plugin-principal.js'
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
import {
  FileSystemService,
  type ResultGrantEntry,
  type ResultGrantOptions,
  type ResultGrantSource
} from '../services/file-system-service.js'
import { expandHomeDir } from '../platform/macos/file-indexer.js'
import type { SearchFilesResult } from '../services/sidecar-manager.js'
import { prefetchMacosApplicationIcons, readMacosApplicationIconCached } from '../platform/macos/application-icon.js'
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
import { BuiltinPluginHostService } from '../services/builtin-plugin-host-service.js'
import { isFullyQualifiedPath, isProtectedSystemPath } from '../services/host-plugins/shared-utils.js'
import { ProcessService, type ProcessDiscoveryAdapter } from '../services/process-service.js'
import { PluginIconService } from '../services/plugin-icon-service.js'
import { PluginShortcutService } from '../services/plugin-shortcut-service.js'
import { uninstallPluginWithCleanup } from '../services/plugin-uninstall-flow.js'
import { publishAccountChanged, type AccountEventType } from '../services/account-events.js'
import { PluginStateService } from '../services/plugin-state-service.js'
import {
  RuntimeCapabilityService,
  type RuntimeCapabilityProviders
} from '../services/runtime-capability-service.js'
import { listSystemVolumes, type SystemVolumeSnapshot } from '../services/volume-service.js'
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

/**
 * 把宿主自己产生、即将返回给调用窗口的路径登记为结果授权。只给宿主窗口（type:'main'）；
 * 登记失败（窗口已关闭等）或有条目被跳过时只记一次 warn，不影响结果返回。
 */
export async function grantResultsForCaller(
  files: FileSystemService,
  caller: CallerIdentity,
  entries: readonly ResultGrantEntry[],
  source: ResultGrantSource,
  options: ResultGrantOptions = {}
): Promise<void> {
  if (caller.type !== 'main' || entries.length === 0) return
  try {
    const summary = await files.grantResultPaths(caller, entries, source, options)
    // An indexed file can disappear while a search is in flight.
    if (summary.skipped > 0) console.warn('结果路径授权跳过', { source, skipped: summary.skipped })
  } catch (error) {
    console.warn('结果路径授权失败', error instanceof Error ? error.message : String(error))
  }
}

/** 文件搜索 / dir: 扫描结果：files（含 is_dir）与 dir: 的 subdirs（只读）；回收站条件见 FileSystemService.grantResultPaths */
export async function grantSearchResultsForCaller(
  query: string,
  result: SearchFilesResult,
  caller: CallerIdentity,
  files: FileSystemService
): Promise<void> {
  const entries: ResultGrantEntry[] = []
  for (const file of Array.isArray(result?.files) ? result.files : []) {
    // is_dir 不是明确的 false 时按目录处理（不给回收站）；FileSystemService 另外会 lstat 核对
    if (typeof file?.path === 'string') entries.push({ path: file.path, isDir: file.is_dir !== false })
  }
  for (const subdir of Array.isArray(result?.subdirs) ? result.subdirs : []) {
    if (typeof subdir?.path === 'string') entries.push({ path: subdir.path, isDir: true })
  }
  const trimmed = String(query ?? '').trim()
  const scanDir = trimmed.toLowerCase().startsWith('dir:') ? trimmed.slice(4).trim() : ''
  if (!scanDir) {
    await grantResultsForCaller(files, caller, entries, 'search')
    return
  }
  // dir: 扫描已跳过子项里的链接；这里仍按真实路径核对（纵深防御）：只登记真实路径在扫描根之内的结果（扫描根本身可以是链接，如 /tmp）
  await grantResultsForCaller(files, caller, entries, 'dir-scan', { scanRoot: expandHomeDir(scanDir) })
}

/** 进程列表里的可执行文件路径（只读），让「在访达 / 资源管理器中显示」能用 */
export async function grantProcessPathsForCaller(
  rows: unknown,
  caller: CallerIdentity,
  files: FileSystemService
): Promise<void> {
  if (!Array.isArray(rows)) return
  const entries: ResultGrantEntry[] = []
  for (const row of rows) {
    const value = (row as { path?: unknown } | null)?.path
    if (typeof value === 'string' && value !== '') entries.push({ path: value, isDir: false })
  }
  await grantResultsForCaller(files, caller, entries, 'process')
}

/** system_list_volumes 返回的卷根（主进程枚举出的挂载点）：只读、精确路径、不递归，让「打开此分区」能用；不给回收站，也不授权卷内任何内容 */
export async function grantVolumeRootsForCaller(
  snapshot: SystemVolumeSnapshot,
  caller: CallerIdentity,
  files: FileSystemService
): Promise<void> {
  const entries: ResultGrantEntry[] = []
  for (const volume of Array.isArray(snapshot?.volumes) ? snapshot.volumes : []) {
    if (typeof volume?.path === 'string' && volume.path !== '') entries.push({ path: volume.path, isDir: true })
  }
  await grantResultsForCaller(files, caller, entries, 'volume')
}

/** filesearch_open / reveal / sha256 / quick_look 的目标：与 shell_* 一样必须是调用窗口已授权（含结果授权）的路径 */
export async function resolveFileSearchTarget(
  files: FileSystemService,
  params: unknown,
  caller: CallerIdentity
): Promise<string> {
  const input = params as { path?: string; fullPath?: string }
  return files.resolveAuthorizedPath(String(input?.path ?? input?.fullPath ?? ''), caller, 'read', false)
}

/** Authorize actual search results before returning them to the requesting host window. */
export async function searchFilesForCaller(
  params: SystemSearchFilesParams,
  caller: CallerIdentity,
  sidecars: CoreServices['sidecars'],
  files: FileSystemService
) {
  const result = await sidecars.searchFiles(params.query, params.limit ?? 20, params.scope ? { scope: params.scope } : {})
  await grantSearchResultsForCaller(params.query, result, caller, files)
  return result
}

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
  'getPath' | 'getAppPath' | 'isPackaged' | 'runningUnderARM64Translation' | 'getFileIcon'
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
  onTrayStatePossiblyChanged?: () => void
  /** 宿主关键子进程 pid（Electron 子进程、侧车、Native Host），结束进程时受保护；缺省按 app.getAppMetrics 等组装 */
  protectedProcessPids?: () => Promise<Iterable<number>> | Iterable<number>
}

const credentialV1Methods = new Set([
  'credential_v1_status',
  'credential_v1_compare_and_set',
  'credential_v1_set',
  'credential_v1_get',
  'credential_v1_delete'
])

/** Only DLL-call failures log request-derived identifiers; credential payloads are never inspected. */
/**
 * 平台能力边界：处理函数以 NOT_SUPPORTED 明确声明当前平台不提供该能力（例如 macOS 尚未开放更新安装链）。
 * 这类失败是可预期的，路由层只记 info，不打印堆栈；其余失败（包括普通 Error）照常按故障记录。
 */
export function isIpcCapabilityBoundary(error: unknown): boolean {
  return error instanceof ZToolsError && error.code === errorCodes.notSupported
}

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

/** 使用进程监控兜底（读取进程列表、结束进程等）的插件 */
const PROCESS_MONITOR_FALLBACK_PLUGINS = new Set(['process-monitor', 'kill-process', 'boost', 'flow-guard'])

/**
 * dllplugin_call 落到宿主进程监控实现时的调用方限制：
 * 宿主自身与 internal-* 受信任插件放行；其余只放行使用进程监控能力的插件（按 pluginId 或会话归属的 pluginId）。
 */
export function isProcessMonitorFallbackAllowed(caller: CallerIdentity): boolean {
  if (isHostCaller(caller)) return true
  if (caller.type === 'plugin' && isInternalPlugin(caller.pluginId)) return true
  const callerPluginId = caller.attributedPlugin?.pluginId ?? (caller.type === 'plugin' ? caller.pluginId : undefined)
  return callerPluginId !== undefined && PROCESS_MONITOR_FALLBACK_PLUGINS.has(callerPluginId)
}

/**
 * dllplugin_call 落到宿主内置处理器时的调用方限制：
 * 宿主自身与 internal-* 受信任插件可调用任意处理器；其余插件只能调用自己对应的处理器
 * （独立插件窗口按 pluginId，主窗口声明式插件按会话归属的 pluginId；失效会话不放行）。
 */
export function isBuiltinPluginFallbackAllowed(
  caller: CallerIdentity,
  targetPlugin: string,
  normalize: (pluginName: string) => string | null
): boolean {
  if (isHostCaller(caller)) return true
  if (caller.type === 'plugin' && isInternalPlugin(caller.pluginId)) return true
  const callerPluginId = caller.attributedPlugin?.pluginId ?? (caller.type === 'plugin' ? caller.pluginId : undefined)
  const callerCanonical = callerPluginId ? normalize(callerPluginId) : null
  return callerCanonical !== null && callerCanonical === normalize(targetPlugin)
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
  readonly #attribution: DeclarativePluginAttributionService
  readonly #processes: ProcessService
  readonly #builtinPluginHost: BuiltinPluginHostService
  readonly #runtimeCapabilities: RuntimeCapabilityService
  readonly #capabilityAuthorization: RuntimeCapabilityAuthorizationService
  readonly #capabilityPrompt: RuntimeCapabilityPromptService
  readonly #permissionMonitor: RuntimePermissionMonitorService
  readonly #stopPermissionOwnerEvents: () => void
  readonly #triggers: TriggerService
  readonly #superPanelInput: SuperPanelInputService | null
  readonly #system: SystemService
  readonly #folderSync: FolderSyncService
  readonly #removeFolderSyncListener: () => void
  readonly #fonts: FontManagerService
  readonly #mediaMetadata: MediaMetadataService
  readonly #office: OfficeDocumentService
  readonly #recentProjects: RecentProjectsService
  readonly #removeRecentProjectsListener: () => void
  readonly #startupManager: StartupManagerService
  readonly #removeStartupListener: () => void
  readonly #browserBookmarks: BrowserBookmarksService
  readonly #keyboardLock: KeyboardLockService
  readonly #dockerManager: DockerManagerService
  readonly #removeDockerWindowListener: () => void
  readonly #environmentManager: EnvironmentManagerService
  readonly #removeEnvironmentWindowListener: () => void
  readonly #lanNetwork: LanNetworkService
  readonly #removeLanWindowListener: () => void
  readonly #networkSpeedtest: NetworkSpeedtestService
  readonly #markdown: MarkdownDocumentService
  readonly #monitorControl: MonitorControlService
  readonly #sshProxy: SshProxyService
  readonly #tlsInspect: TlsInspectService
  readonly #removeTlsInspectListener: () => void
  readonly #removeSshProxyListener: () => void
  readonly #removeMarkdownWindowListener: () => void
  readonly #removeSpeedtestWindowListener: () => void
  readonly #hostsManager: HostsManagerService
  readonly #removeHostsWindowListener: () => void
  readonly #fileUnlock: FileUnlockService
  readonly #removeFileUnlockWindowListener: () => void
  readonly #dnsBenchmark: DnsBenchmarkService
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

  reloadSuperPanelInput(): Promise<void> {
    return this.#superPanelInput?.reload() ?? Promise.resolve()
  }

  listInstalledPlugins(): Promise<{ success: true; data: Record<string, unknown>[] }> {
    return this.#plugins.list()
  }

  openPlugin(params: PluginOpenParams): Promise<unknown> {
    this.#services.frecency?.recordUsage(params.pluginId)
    return this.#pluginWindows.open(params).then((result) => {
      const opened = result as { success?: boolean; pluginId?: string; instanceId?: string; windowInstanceStatus?: string }
      if (opened.success === true && opened.pluginId) {
        this.#services.analytics.reportPluginOpened(opened.pluginId, {
          instanceId: opened.instanceId,
          status: opened.windowInstanceStatus
        })
      }
      return result
    })
  }

  publishLaunchIntent(payload: unknown): void {
    this.#events.publishHost('launch_intent', payload)
  }

  publishDarkModeChange(enabled: boolean, force = false): void {
    if (!force && this.#lastDarkMode === enabled) return
    this.#lastDarkMode = enabled
    this.#events.publishHost('system.DarkModeChange', { isDark: enabled, mode: nativeTheme.themeSource })
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
        options.pathSemanticsAdapter ?? createPathSemanticsAdapter(process.platform),
        {
          pathAccessBroker: { platform: process.platform, isPackaged: mainApp.isPackaged, appPath: mainApp.getAppPath(), resourcesPath: process.resourcesPath },
          // 宿主自己的数据目录不接受「扫描结果移入回收站」
          protectedTrashRoots: [
            options.systemPlatformAdapter.userDataPath,
            services.runtimePaths.businessDataRoot,
            services.runtimePaths.browserProfileRoot,
            services.runtimePaths.installRoot
          ]
        }
      ),
      (files) => files.stop()
    )
    const files = this.#files
    const folderSync = this.#folderSync = constructionScope.own(new FolderSyncService(files, () => {
      const broker = resolvePathAccessBroker({ platform: process.platform, isPackaged: mainApp.isPackaged, appPath: mainApp.getAppPath(), resourcesPath: process.resourcesPath })
      if (!broker.available) throw new Error('安全文件组件不可用，请重新构建或更新客户端')
      return new NativePathAccessAdapter(broker.executable, 30000)
    }, [services.runtimePaths.businessDataRoot, services.runtimePaths.browserProfileRoot, services.runtimePaths.installRoot]), service => service.stop())
    this.#removeFolderSyncListener = registry.onRemoved(id => { void folderSync.closeOwner(id).catch(error => console.error('目录同步关闭失败', error)) })
    constructionScope.ownCleanup(this.#removeFolderSyncListener)
    const fonts = this.#fonts = constructionScope.own(new FontManagerService(new SystemFontProvider(macFontHelperPath(mainApp.isPackaged, process.resourcesPath)), file => electronShell.showItemInFolder(file)), service => service.stop())
    const recentProjects = this.#recentProjects = constructionScope.own(new RecentProjectsService(), service => service.stop())
    this.#removeRecentProjectsListener = registry.onRemoved(id => recentProjects.closeOwner(id))
    constructionScope.ownCleanup(this.#removeRecentProjectsListener)
    const startupManager = this.#startupManager = constructionScope.own(new StartupManagerService(new StartupBackupStore(path.join(services.dataRoot, 'startup-backups')),
      () => electronShell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension'), new MacStartupWriter(macStartupHelperPath(mainApp.isPackaged, process.resourcesPath))), service => service.stop())
    this.#removeStartupListener = registry.onRemoved(id => startupManager.closeOwner(id))
    constructionScope.ownCleanup(this.#removeStartupListener)
    const browserBookmarks = this.#browserBookmarks = constructionScope.own(new BrowserBookmarksService(), service => service.stop())
    const keyboardLock = this.#keyboardLock = constructionScope.own(new KeyboardLockService(macInputLockPath(mainApp.isPackaged, process.resourcesPath)), service => service.stop())
    const dockerManager = this.#dockerManager = constructionScope.own(new DockerManagerService(), service => service.stop())
    this.#removeDockerWindowListener = registry.onRemoved(id => dockerManager.closeOwner(id))
    constructionScope.ownCleanup(this.#removeDockerWindowListener)
    const environmentManager = this.#environmentManager = constructionScope.own(new EnvironmentManagerService(new SystemEnvironmentProvider(() => {
      const broker = resolvePathAccessBroker({ platform: process.platform, isPackaged: mainApp.isPackaged, appPath: mainApp.getAppPath(), resourcesPath: process.resourcesPath })
      if (!broker.available) throw new Error('安全文件组件不可用，请重新构建或更新客户端')
      return new NativePathAccessAdapter(broker.executable, 30000)
    }), new EnvironmentBackupStore(path.join(services.dataRoot, 'environment-backups'))), service => service.stop())
    this.#removeEnvironmentWindowListener = registry.onRemoved(id => environmentManager.closeOwner(id))
    constructionScope.ownCleanup(this.#removeEnvironmentWindowListener)
    const lanNetwork = this.#lanNetwork = constructionScope.own(new LanNetworkService(), service => service.stop())
    this.#removeLanWindowListener = registry.onRemoved(id => lanNetwork.closeOwner(id))
    constructionScope.ownCleanup(this.#removeLanWindowListener)
    const networkSpeedtest = this.#networkSpeedtest = constructionScope.own(new NetworkSpeedtestService(), service => service.stop())
    this.#removeSpeedtestWindowListener = registry.onRemoved(id => networkSpeedtest.closeOwner(id))
    constructionScope.ownCleanup(this.#removeSpeedtestWindowListener)
    const hostsManager = this.#hostsManager = constructionScope.own(new HostsManagerService(new MacHostsProvider(macHostsHelperPath(mainApp.isPackaged, process.resourcesPath)), new HostsBackups(path.join(services.dataRoot, 'hosts-backups'))), service => service.stop())
    this.#removeHostsWindowListener = registry.onRemoved(id => hostsManager.closeOwner(id))
    constructionScope.ownCleanup(this.#removeHostsWindowListener)
    const dnsBenchmark = this.#dnsBenchmark = constructionScope.own(new DnsBenchmarkService(new DnsBackupStore(path.join(services.dataRoot, 'dns-backups')),
      new MacDnsNetworkProvider(undefined, undefined, macDnsHelperPath(mainApp.isPackaged, process.resourcesPath))), service => service.stop())
    const mediaMetadata = this.#mediaMetadata = constructionScope.own(new MediaMetadataService(files), service => service.stop())
    const office = this.#office = constructionScope.own(new OfficeDocumentService(files), service => service.stop())
    const monitorControl = this.#monitorControl = constructionScope.own(new MonitorControlService(monitorHelperPath(mainApp.isPackaged, process.resourcesPath)), service => service.stop())
    const sshProxy = this.#sshProxy = constructionScope.own(new SshProxyService(new ProxyConfigurationProvider(() => {
      const broker = resolvePathAccessBroker({ platform: process.platform, isPackaged: mainApp.isPackaged, appPath: mainApp.getAppPath(), resourcesPath: process.resourcesPath })
      if (!broker.available) throw new Error('安全文件组件不可用，请重新构建或更新客户端')
      return new NativePathAccessAdapter(broker.executable, 30000)
    }), new EnvironmentBackupStore(path.join(services.dataRoot, 'proxy-backups'))), service => service.stop())
    this.#removeSshProxyListener = registry.onRemoved(id => sshProxy.closeOwner(id))
    constructionScope.ownCleanup(this.#removeSshProxyListener)
    const tlsInspect = this.#tlsInspect = constructionScope.own(new TlsInspectService(), service => service.stop())
    this.#removeTlsInspectListener = registry.onRemoved(id => tlsInspect.closeOwner(id))
    constructionScope.ownCleanup(this.#removeTlsInspectListener)
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
    const protectedProcessPids = options.protectedProcessPids ?? (() => {
      const pids = new Set<number>()
      const metrics = (app as { getAppMetrics?: () => Array<{ pid: number }> } | undefined)?.getAppMetrics?.() ?? []
      for (const metric of metrics) pids.add(metric.pid)
      const sidecarStatus = services.sidecars?.getStatus?.()
      for (const pid of [sidecarStatus?.uiaccess.pid, sidecarStatus?.indexer.pid]) if (typeof pid === 'number') pids.add(pid)
      for (const pid of [services.nativeHost?.diagnostics?.pid,
        (services.serviceClient as { diagnostics?: { pid?: unknown } } | null)?.diagnostics?.pid]) {
        if (typeof pid === 'number') pids.add(pid)
      }
      return pids
    })
    this.#processes = constructionScope.own(
      new ProcessService(
        registry,
        files,
        Date.now,
        process.platform,
        options.processDiscoveryAdapter,
        undefined,
        undefined,
        { protectedPids: protectedProcessPids }
      ),
      (processes) => processes.stop()
    )
    const processes = this.#processes
    const fileUnlock = this.#fileUnlock = constructionScope.own(new FileUnlockService(async (file, caller, access) => {
      // 文件解锁延续内置工具的路径输入能力；其他插件仍需窗口的文件授权。
      if (isHostCaller(caller) || caller.attributedPlugin?.pluginId === 'file-unlock' || caller.pluginId === 'file-unlock' || isInternalPlugin(caller.pluginId)) return path.resolve(file)
      return files.resolveAuthorizedPath(file, caller, access, false)
    }, () => {
      const broker = resolvePathAccessBroker({ platform: process.platform, isPackaged: mainApp.isPackaged, appPath: mainApp.getAppPath(), resourcesPath: process.resourcesPath })
      if (!broker.available) throw new Error('安全文件组件不可用，请重新构建或更新客户端')
      return new NativePathAccessAdapter(broker.executable, 30000)
    }, processes, new MacFileLocks(undefined, protectedProcessPids), [options.systemPlatformAdapter.userDataPath,
      services.runtimePaths.businessDataRoot, services.runtimePaths.browserProfileRoot, services.runtimePaths.installRoot]), service => service.stop())
    this.#removeFileUnlockWindowListener = registry.onRemoved(id => { void fileUnlock.closeOwner(id).catch(error => console.error('文件解锁关闭失败', error)) })
    constructionScope.ownCleanup(this.#removeFileUnlockWindowListener)
    this.#builtinPluginHost = constructionScope.own(
      new BuiltinPluginHostService({
        processService: processes,
        shellService: shell,
        clipboard: {
          getText: async () => electronClipboard.readText(),
          setText: async (text: string) => {
            electronClipboard.writeText(text)
          }
        },
        pathAuthority: {
          resolveAuthorizedPath: async (rawPath, caller, access, allowMissing) => {
            if (
              caller.type === 'main' ||
              (caller.type === 'plugin' &&
                (isInternalPlugin(caller.pluginId) ||
                  this.#builtinPluginHost?.supportsPlugin(caller.pluginId ?? '')))
            ) {
              if (rawPath.includes('\0')) {
                throw new ZToolsError(errorCodes.invalidRequest, '路径包含非法空字节')
              }
              // 相对路径会按主进程工作目录解析，写入位置不可预期，直接拒绝
              if (!isFullyQualifiedPath(rawPath, process.platform)) {
                throw new ZToolsError(errorCodes.invalidRequest, '路径必须是绝对路径')
              }
              const resolved = path.resolve(rawPath)
              if (access === 'write' && isProtectedSystemPath(resolved)) {
                throw new ZToolsError(errorCodes.permissionDenied, '系统受保护核心路径禁止写入或移除')
              }
              return resolved
            }
            return files.resolveAuthorizedPath(rawPath, caller, access, allowMissing)
          }
        },
        platform: process.platform
      }),
      (host) => host.stop()
    )
    const builtinPluginHost = this.#builtinPluginHost
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
    const notifyAccountChanged = (type: AccountEventType): void => {
      if (!this.#stopping) publishAccountChanged(events, type)
    }
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
    const hotkeyProbe = new HotkeyProbeService(nativeHotkeyProbe(macHotkeysHelperPath(mainApp.isPackaged, process.resourcesPath)), globalShortcut, () => app.isReady())
    const triggers = this.#triggers
    this.#plugins = constructionScope.own(
      new PluginInstallService(services.dataRoot, events, {
        state: this.#pluginState,
        libraryMetadata: services.libraryMetadata,
        analytics: (event, pluginId, data) => {
          // 安装 / 更新 / 卸载完成：旧清单签发的会话立即失效（权限可能已变）
          this.#attribution?.revokePlugin(pluginId)
          services.analytics.reportHost(event, pluginId, data)
        },
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
    const readBundledManifest = createBundledManifestReader(options.pluginResources.webRoot)
    this.#attribution = constructionScope.own(
      new DeclarativePluginAttributionService(registry, {
        readBundled: readBundledManifest,
        readInstalled: (pluginId) => plugins.withPluginManifest(pluginId, async manifest => manifest),
        isRevoked: (pluginId) => plugins.isRevoked(pluginId)
      }),
      attribution => attribution.stop()
    )
    const attribution = this.#attribution
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
        nativePlatform === 'win32' || nativePlatform === 'darwin' ? async entry => {
          await database.recordClipboard(entry)
          services.clipboardHistory.recordClipboardEntry(entry)
        } : undefined,
        registry,
        inputInjection,
        nativePlatform === 'darwin' ? createMacPasteAdapter({ app, systemPreferences }) : undefined
      ),
      (clipboard) => clipboard.stop()
    )
    services.clipboardHistory.useImageThumbnailer((dataUrl) => {
      const img = nativeImage.createFromDataURL(dataUrl)
      if (img.isEmpty()) return ''
      const { width, height } = img.getSize()
      const maxEdge = 320
      const thumb = width > maxEdge || height > maxEdge
        ? img.resize(width >= height ? { width: maxEdge } : { height: maxEdge })
        : img
      return thumb.toDataURL()
    })
    constructionScope.own(services.clipboardHistory, (history) => history.useImageThumbnailer(undefined))
    const clipboard = this.#clipboard
    const markdown = this.#markdown = constructionScope.own(new MarkdownDocumentService(files, clipboard), service => service.stop())
    this.#removeMarkdownWindowListener = registry.onRemoved(id => markdown.closeOwner(id))
    constructionScope.ownCleanup(this.#removeMarkdownWindowListener)
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
        this.publishDarkModeChange(enabled, true)
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
        await showDesktopNotification(params.title || 'ZTools', params.message)
      },
      async getFileIcon(filePath) {
        if (nativePlatform === 'darwin' && filePath.toLowerCase().endsWith('.app')) {
          return readMacosApplicationIconCached(filePath)
        }
        return (await mainApp.getFileIcon(filePath, { size: nativePlatform === 'darwin' ? 'normal' : 'large' })).toDataURL()
      },
      getNativeId: () => options.systemPlatformAdapter.getNativeId(),
      startPreventSleep: (mode = 'display') => powerSaveBlocker.start(mode === 'system' ? 'prevent-app-suspension' : 'prevent-display-sleep'),
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
      config_set: async (params) => {
        const input = params as ConfigSetParams
        await config.set(input.file, input.path, input.value, input.sync_enabled)
        if (input.file === 'user_settings.json' && input.path === 'ui.theme' &&
            (input.value === 'system' || input.value === 'light' || input.value === 'dark')) {
          nativeTheme.themeSource = input.value
          const isDark = nativeTheme.shouldUseDarkColors
          options.onDarkModeChanged?.(isDark)
          this.publishDarkModeChange(isDark, true)
        }
        options.onTrayStatePossiblyChanged?.()
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
        options.onTrayStatePossiblyChanged?.()
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
      async user_get_info(_params, caller) {
        // 登录凭据只给宿主自身：插件窗口与主窗口里已归属到插件的调用都拿不到 token / refresh_token
        return services.user.getInfo({ includeCredentials: isHostCaller(caller) })
      },
      async user_set_token(params) {
        // 没有账号能力的版本（开源版）不保存任何凭据，返回未登录
        const saved = await services.user.setToken(params as UserSetTokenParams)
        if (saved) notifyAccountChanged('user.login')
        return saved ? { success: true } : { success: false, logged_in: false }
      },
      async user_logout() {
        await services.user.logout()
        // 401 时请求层会直接清掉本地凭据，界面的登录状态靠这个事件同步
        notifyAccountChanged('user.logout')
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
          if (!enabled) {
            attribution.revokePlugin(manifest.id)
            system.releasePluginPowerSessions(manifest.id)
            await pluginWindows.closePlugin(manifest.id)
          }
          return { success: true, pluginId: manifest.id, enabled }
        })
      },
      async plugin_revoke(params) {
        const input = params as { pluginId: string; revoked: boolean; reason?: string }
        await plugins.markRevoked(input.pluginId, input.revoked, input.reason)
        if (input.revoked) {
          attribution.revokePlugin(input.pluginId)
          system.releasePluginPowerSessions(input.pluginId)
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
      async plugin_install_status(params) {
        const input = params as PluginInstallStatusParams
        return plugins.getInstallStatus(input.pluginId, input.operationId)
      },
      async plugin_install(params) {
        const input = params as PluginInstallParams
        attribution.revokePlugin(input.pluginId)
        await pluginWindows.closePlugin(input.pluginId)
        await dllPlugins.unloadPlugin(input.pluginId)
        return plugins.startInstall(input, false)
      },
      async plugin_update(params) {
        const input = params as PluginInstallParams
        attribution.revokePlugin(input.pluginId)
        await pluginWindows.closePlugin(input.pluginId)
        await dllPlugins.unloadPlugin(input.pluginId)
        return plugins.startInstall(input, true)
      },
      async plugin_uninstall(params) {
        const input = params as PluginKeyParams
        return uninstallPluginWithCleanup(input.pluginId, {
          async stopRuntime(pluginId) {
            attribution.revokePlugin(pluginId)
            system.releasePluginPowerSessions(pluginId)
            await pluginWindows.closePlugin(pluginId)
            await dllPlugins.unloadPlugin(pluginId)
          },
          planShortcutCleanup: (pluginId) => pluginShortcuts.planUninstallCleanup(pluginId),
          uninstall: () => plugins.uninstall(input),
          removeTriggers: (pluginId) => triggers.removePlugin(pluginId),
          warn: (message, error) => console.warn(message, error)
        })
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
        const input = params as SystemPathParams
        const result = await system.getPath(input, caller)
        // 返回的用户目录只读、不递归授权（cache / temp 在缓存根内；安装目录与宿主数据目录不授权）
        if (!['cache', 'temp', 'app', 'userData'].includes(input.name)) {
          await grantResultsForCaller(files, caller, [{ path: result.path, isDir: true }], 'system-path')
        }
        return result
      },
      async system_list_common_folders(_params, caller) {
        const result = await system.listCommonFolders()
        await grantResultsForCaller(
          files,
          caller,
          result.data.folders.filter((folder) => folder.exists).map((folder) => ({ path: folder.path, isDir: true })),
          'common-folder'
        )
        return result
      },
      async system_get_file_icon(params, caller) {
        return system.getFileIcon(params as SystemFileIconParams, caller)
      },
      async system_search_files(params, caller) {
        const input = params as SystemSearchFilesParams
        const result = await searchFilesForCaller(input, caller, services.sidecars, files)
        // 程序列表交给界面后，在后台把图标预取进缓存，搜索结果里的图标就不用再等
        if (nativePlatform === 'darwin' && input.scope === 'applications') {
          prefetchMacosApplicationIcons(result.files.map(file => file.path))
        }
        return result
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
      async system_power_session(params, caller) {
        return system.managePowerSession(params as SystemPowerSessionParams, caller)
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
      async system_list_volumes(_params, caller) {
        const result = await listSystemVolumes()
        await grantVolumeRootsForCaller(result, caller, files)
        return result
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
        options.onTrayStatePossiblyChanged?.()
        return { success: true }
      },
      async system_get_panel_local_apps() {
        return { success: true, data: await options.getPanelLocalApps() }
      },
      async dllplugin_list(_params, caller) {
        return dllPlugins.list(caller)
      },
      async dllplugin_call(params, caller, signal) {
        const input = params as DllPluginCallParams
        // 查看器的结构化只读操作属于宿主；SQLitePlugin 公共 DLL 使用另一套原生协议。
        if (builtinPluginHost.normalizePluginName(input.plugin) === 'SqlitePlugin' &&
            (input.func === 'inspectWorkspace' || input.func === 'executeQuery')) {
          if (!isBuiltinPluginFallbackAllowed(caller, input.plugin, name => builtinPluginHost.normalizePluginName(name))) {
            throw new ZToolsError(errorCodes.permissionDenied, '插件只能访问自身对应的 SQLite 查看能力')
          }
          await requirePluginPermission(caller, 'sqlite', plugins)
          await requirePluginPermission(caller, 'fs', plugins)
          const values = input.params ?? {}
          const allowed = input.func === 'executeQuery' ? ['dbPath', 'tableName', 'limit'] : ['dbPath']
          if (Object.keys(values).some(key => !allowed.includes(key)) ||
              typeof values.dbPath !== 'string' || !values.dbPath.trim() ||
              (input.func === 'executeQuery' && (typeof values.tableName !== 'string' || !values.tableName))) {
            throw new ZToolsError(errorCodes.invalidRequest, 'SQLite 查看器只接受数据库路径和表名')
          }
          const result = await builtinPluginHost.handlePluginCall('SqlitePlugin', input.func,
            { ...values, ...(input.func === 'executeQuery' ? { limit: 50 } : {}) }, signal, caller)
          return { ...(result as Record<string, unknown>), data: result }
        }
        // 原生 DLL 不可用时落到宿主内置实现；调用方只能使用与自己对应的兜底能力
        const hostFallback = async (error: unknown): Promise<unknown> => {
          const allowedProcessMonitorCaller = isProcessMonitorFallbackAllowed(caller)
          if (
            input.plugin.toLowerCase() === 'processmonitorplugin' &&
            allowedProcessMonitorCaller &&
            error instanceof ZToolsError &&
            (error.code === errorCodes.pluginNotFound ||
              error.code === errorCodes.serviceUnavailable ||
              error.code === errorCodes.nativeHostUnavailable)
          ) {
            if (input.func === 'OpenFileLocation' && typeof input.params?.path === 'string' && input.params.path.trim()) {
              await shell.showItemInFolder({ fullPath: input.params.path.trim() }, caller)
              return { success: true, data: { opened: true, path: input.params.path.trim() } }
            }
            const fallback = await processes.handleProcessMonitorCall(input.func, input.params ?? {}, signal)
            if (input.func === 'GetProcessList') {
              await grantProcessPathsForCaller((fallback.data as { processes?: unknown } | undefined)?.processes, caller, files)
            }
            return fallback
          }
          const allowedBuiltinPluginCaller = isBuiltinPluginFallbackAllowed(
            caller,
            input.plugin,
            name => builtinPluginHost.normalizePluginName(name)
          )
          if (
            allowedBuiltinPluginCaller &&
            builtinPluginHost.supportsPlugin(input.plugin) &&
            error instanceof ZToolsError &&
            (error.code === errorCodes.pluginNotFound ||
              error.code === errorCodes.serviceUnavailable ||
              error.code === errorCodes.nativeHostUnavailable)
          ) {
            const hostResult = await builtinPluginHost.handlePluginCall(
              input.plugin,
              input.func,
              (input.params as Record<string, unknown>) ?? {},
              signal,
              caller
            )
            if (
              hostResult &&
              typeof hostResult === 'object' &&
              !Array.isArray(hostResult) &&
              (hostResult as Record<string, unknown>).data === undefined
            ) {
              const record = hostResult as Record<string, unknown>
              return {
                ...record,
                data: { ...record }
              }
            }
            return hostResult
          }
          throw error
        }
        try {
          return await dllPlugins.call(input, caller, signal)
        } catch (error) {
          return hostFallback(error)
        }
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
      async filesystem_write_file_end(params, caller, signal) {
        return files.finishWrite((params as FileWriteHandleParams).handle, caller, signal)
      },
      async filesystem_write_cache_end(params, caller, signal) {
        return files.finishWrite((params as FileWriteHandleParams).handle, caller, signal)
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
      async filesystem_move_file_no_replace(params, caller, signal) {
        return files.moveFileNoReplace(params as FileCopyParams, caller, signal)
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
      async process_list(_params, caller, signal) {
        let result: { success: boolean; data: unknown }
        let rows: unknown
        try {
          const listed = await processes.list(signal)
          result = listed
          rows = listed.data
        } catch {
          result = await processes.handleProcessMonitorCall('GetProcessList', {}, signal)
          rows = (result.data as { processes?: unknown } | undefined)?.processes
        }
        await grantProcessPathsForCaller(rows, caller, files)
        return result
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
      async process_terminate_pid(params, caller, signal) {
        // 插件必须声明 process 权限；未归属的主窗口调用（宿主自身或不带令牌的插件代码）拒绝
        await requirePluginPermission(caller, 'process', plugins)
        return processes.terminatePid(params as ProcessTerminatePidParams, signal)
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
      async db_compare_and_set(params, caller, signal) {
        return database.compareAndSet(params as DatabaseCompareAndSetParams, caller, signal)
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
      async credential_v1_compare_and_set(params, caller, signal) {
        return database.credentialV1Set(params as CredentialV1SetParams, caller, signal)
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
      async db_compact(params, caller, signal) {
        return database.compact(params as DatabaseCompactParams, caller, signal)
      },
      async declarative_session_open(params, caller) {
        return attribution.open(caller, params as DeclarativeSessionOpenParams)
      },
      async declarative_session_close(params, caller) {
        return attribution.close(caller, params as DeclarativeSessionCloseParams)
      },
      async window_open(params, caller) {
        return windows.open(params as WindowOpenParams, caller)
      },
      async window_popout_handoff_take(params, caller) {
        return windows.takePopoutHandoff(params as WindowPopoutHandoffTakeParams, caller)
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
      async clipboard_history_query(params, caller) {
        try {
          services.clipboardHistory.ensureInitialHostClipboardSeed(electronClipboard.readText())
        } catch {
          services.clipboardHistory.ensureInitialHostClipboardSeed()
        }
        const rows = services.clipboardHistory.queryItems(params as Parameters<typeof services.clipboardHistory.queryItems>[0])
        // 系统采集的文件条目里的路径只读、精确、不递归授权，让「在访达 / 资源管理器中显示」能用；不给回收站
        await grantResultsForCaller(
          files,
          caller,
          services.clipboardHistory.systemCapturedFilePaths(rows).map((filePath) => ({ path: filePath, isDir: true })),
          'clipboard'
        )
        return rows
      },
      async clipboard_history_restore(params, caller, signal) {
        const input = params as { id: string; paste?: boolean }
        const restored = await clipboard.restoreHistoryEntry(services.clipboardHistory.getEntry(input.id), caller, signal, input.paste === true)
        services.clipboardHistory.touchItem(input.id)
        return restored
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
        return services.clipboardHistory.pasteSequential(async (_text, item) => {
          await clipboard.restoreHistoryEntry(services.clipboardHistory.getEntry(item.id), caller, signal, true)
        })
      },
      async clipboard_history_reset_sequence() {
        return services.clipboardHistory.resetPasteSequence()
      },
      async snippets_list(params) {
        return services.snippets.listSnippets((params as { query?: string })?.query)
      },
      async snippets_create(params) {
        return services.snippets.createSnippet(params as Parameters<typeof services.snippets.createSnippet>[0])
      },
      async snippets_update(params) {
        const input = params as { id: string } & Parameters<typeof services.snippets.updateSnippet>[1]
        return services.snippets.updateSnippet(input?.id, input)
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
        const input = params as { data?: Parameters<typeof services.snippets.importSnippets>[0] }
        return services.snippets.importSnippets((input?.data ?? params) as Parameters<typeof services.snippets.importSnippets>[0])
      },
      async snippets_export() {
        return services.snippets.exportSnippets()
      },
      async filesearch_query(params, caller) {
        const input = params as { query: string; limit?: number }
        const result = await services.fileSearch.search(input?.query, input?.limit)
        await grantSearchResultsForCaller(input?.query ?? '', result, caller, files)
        return result
      },
      // filesearch_open / reveal / sha256 / quick_look 与 shell_* 一致：先按调用窗口的授权解析，未授权 PERMISSION_DENIED
      async filesearch_open(params, caller) {
        return services.fileSearch.openFile(await resolveFileSearchTarget(files, params, caller))
      },
      async filesearch_reveal(params, caller) {
        return services.fileSearch.revealFile(await resolveFileSearchTarget(files, params, caller))
      },
      async filesearch_sha256(params, caller) {
        return services.fileSearch.calculateSha256(await resolveFileSearchTarget(files, params, caller))
      },
      async filesearch_quick_look(params, caller) {
        return services.fileSearch.quickLookSelection(await resolveFileSearchTarget(files, params, caller))
      },
      async window_manage_action(params) {
        const input = params as { action: string }
        return services.windowManagement.applyAction(input?.action)
      },
      async window_manage_list_actions() {
        return services.windowManagement.listActions()
      },
      async developer_create_extension(params) {
        return services.developer.createExtension(params as Parameters<typeof services.developer.createExtension>[0])
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
        return services.mcp.installServer(params as Parameters<typeof services.mcp.installServer>[0])
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
      async focus_start(params, caller) {
        if ((params as { mode?: string }).mode === 'pomodoro') await requirePluginPermission(caller, 'notification', plugins)
        return services.focus.startSession(params as Parameters<typeof services.focus.startSession>[0])
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
        return services.focus.createCategory(params as Parameters<typeof services.focus.createCategory>[0])
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
        const input = params as { rect: Parameters<typeof services.screenAwareness.captureScreenArea>[0] }
        return services.screenAwareness.captureScreenArea(input?.rect)
      },
      async screen_awareness_focused_window() {
        return services.screenAwareness.captureFocusedWindow()
      },
      async dictation_start(params) {
        return services.dictation.startDictation(params as Parameters<typeof services.dictation.startDictation>[0])
      },
      async dictation_finish(params) {
        return services.dictation.finishDictation(params as Parameters<typeof services.dictation.finishDictation>[0])
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
        return services.calendar.createEvent(params as Parameters<typeof services.calendar.createEvent>[0])
      },
      async calendar_upcoming_events(params) {
        const input = params as { withinHours?: number }
        return services.calendar.getUpcomingEvents(input?.withinHours)
      },
      async calendar_list_events(params) {
        const input = (params || {}) as { search?: string; startTime?: number; endTime?: number; limit?: number; order?: 'asc' | 'desc' }
        return services.calendar.listEvents({
          search: input.search,
          startTime: input.startTime,
          endTime: input.endTime,
          limit: input.limit,
          order: input.order
        })
      },
      async calendar_count_events(params) {
        const input = (params || {}) as { search?: string; startTime?: number; endTime?: number }
        return { total: services.calendar.countEvents({ search: input.search, startTime: input.startTime, endTime: input.endTime }) }
      },
      async calendar_delete_event(params) {
        const input = params as { id: string }
        return { success: services.calendar.deleteEvent(input?.id) }
      },
      async calendar_export_ics(params) {
        const input = (params || {}) as { events?: Parameters<typeof services.calendar.exportToIcs>[0]; eventIds?: string[] }
        // 同时传 events 与 eventIds 时以 eventIds 为准；eventIds 为空数组时导出空日历，不能退回导出全部
        const events = Array.isArray(input.eventIds)
          ? services.calendar.getEventsByIds(input.eventIds)
          : input.events
        const ics = services.calendar.exportToIcs(events)
        return { ics, count: ics.split('\r\n').filter(line => line === 'BEGIN:VEVENT').length }
      },
      async navigation_list_windows(params) {
        const input = (params || {}) as { search?: string; query?: string }
        return services.navigation.listOpenWindows(input?.search ?? input?.query)
      },
      async navigation_activate_window(params) {
        const input = (params || {}) as { hwnd?: number | string; handle?: number | string; id?: number | string; windowId?: number | string }
        const raw = input?.hwnd ?? input?.handle ?? input?.windowId ?? input?.id
        const parsedHwnd = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/\D+/g, ''))
        return services.navigation.activateWindow(parsedHwnd)
      },
      async navigation_close_window(params) {
        const input = (params || {}) as { hwnd?: number | string; handle?: number | string; id?: number | string; windowId?: number | string }
        const raw = input?.hwnd ?? input?.handle ?? input?.windowId ?? input?.id
        const parsedHwnd = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/\D+/g, ''))
        return services.navigation.closeWindow(parsedHwnd)
      },
      async navigation_search_menu_items(params) {
        const input = (params || {}) as { search?: string; query?: string }
        return services.navigation.searchMenuItems(input?.search ?? input?.query)
      },
      async navigation_click_menu_item(params) {
        const input = (params || {}) as { id?: string; appName?: string; path?: string[] }
        return services.navigation.clickMenuItem(input)
      },
      async web_search(params) {
        const input = params as { engine: Parameters<typeof services.webBrowser.searchWeb>[0]; query: string }
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
        const input = (params || {}) as { search?: string; query?: string; limit?: number }
        return services.webBrowser.listContacts(input?.search ?? input?.query, input?.limit)
      },
      async contacts_create(params) {
        return services.webBrowser.createContact(params as Parameters<typeof services.webBrowser.createContact>[0])
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
        const input = params as {
          state: Parameters<typeof services.geekTools.moveGame2048>[0]
          direction: Parameters<typeof services.geekTools.moveGame2048>[1]
        }
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
        type EmojiSearchOpts = NonNullable<Parameters<typeof services.emoji.search>[1]>
        const input = (params || {}) as {
          query?: string
          category?: EmojiSearchOpts['category']
          skinTone?: EmojiSearchOpts['skinTone']
          limit?: number
        }
        const opts: EmojiSearchOpts = {}
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
        const input = (params || {}) as Parameters<typeof services.notes.listNotes>[0]
        return services.notes.listNotes(input)
      },
      async notes_get(params) {
        const input = params as { id: string }
        return services.notes.getNote(input?.id)
      },
      async notes_save(params) {
        type NoteSaveInput = { id?: string } & Partial<Parameters<typeof services.notes.createNote>[0]>
        const input = params as NoteSaveInput
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
        type WinRunExecOpts = NonNullable<Parameters<typeof services.windowsRun.execute>[1]>
        const input = params as { command: string; args?: string[]; runAsAdmin?: boolean; shell?: WinRunExecOpts['shell']; workingDirectory?: string }
        const opts: WinRunExecOpts = {}
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
      async taskbar_set_dock_position(params) {
        const input = (params || {}) as { edge?: 'bottom' | 'left' | 'right'; position?: 'bottom' | 'left' | 'right' }
        return services.taskbar.setDockPosition((input?.edge ?? input?.position ?? 'bottom'))
      },
      async taskbar_restart_dock() {
        return services.taskbar.restartDock()
      },
      async screenshots_scan(params, caller) {
        const input = (params || {}) as { query?: string; limit?: number; pinnedFirst?: boolean; forceRefresh?: boolean }
        // 返回 { screenshots, failedDirs }：插件按 data.screenshots 取列表；failedDirs 为跳过的不可读目录及中文原因
        const report = services.screenshots.scanScreenshotsReport(input?.forceRefresh)
        await grantResultsForCaller(
          files,
          caller,
          report.screenshots.map((record) => ({ path: record.path, isDir: false })),
          'screenshot'
        )
        return report
      },
      async screenshots_paste_latest(_params, caller, signal) {
        return services.screenshots.pasteLatestScreenshot(async (filePath) => {
          const image = nativeImage.createFromPath(filePath)
          if (image.isEmpty()) throw new ZToolsError(errorCodes.fileError, '无法读取截图图片')
          const imageParams = { image: image.toPNG().toString('base64') }
          // 先写剪贴板（失败则整体失败）；再尝试回到前台应用粘贴，粘贴不可用时保留剪贴板内容让用户手动粘贴
          clipboard.copyImage(imageParams)
          try {
            await clipboard.hideAndPasteImage(imageParams, caller, signal)
            return { pasted: true }
          } catch {
            return { pasted: false }
          }
        })
      },
      async screenshots_toggle_pin(params) {
        const input = params as { filePath: string }
        const target = await services.screenshots.resolveScannedScreenshot(input?.filePath)
        return { pinned: services.screenshots.togglePin(target.path) }
      },
      async screenshots_delete(params) {
        const input = params as { filePath: string; permanent?: boolean }
        const target = await services.screenshots.resolveScannedScreenshot(input?.filePath)
        return { success: await services.screenshots.deleteScreenshot(target.path) }
      },
      async applications_list(params) {
        const input = (params || {}) as { query?: string; includeSystemComponents?: boolean; forceRefresh?: boolean }
        const opts = {
          ...(input?.includeSystemComponents !== undefined ? { includeSystemComponents: input.includeSystemComponents } : {}),
          ...(input?.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {})
        }
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
      },
      async dictionary_speak(params) {
        const input = params as { word: string }
        return services.dictionary.speakWord(input?.word)
      },
      async system_execute_action(params) {
        const input = (params || {}) as { actionKey?: string; action?: string; params?: Record<string, unknown> } & Record<string, unknown>
        const key = input?.actionKey ?? input?.action ?? ''
        return system.executeSystemAction(key, input?.params ?? input)
      },
      async shortcuts_list() {
        return { items: await system.listShortcuts() }
      },
      async shortcuts_run(params) {
        const input = params as { name: string; input?: string }
        return system.runShortcut(input?.name, input?.input)
      },
      async shortcuts_view(params) {
        const input = params as { name: string }
        return system.viewShortcut(input?.name)
      },
      async folder_sync(params, caller, signal) { return folderSync.execute(params, caller, signal) },
      async folder_sync_cancel(params, caller) { return folderSync.cancel((params as { operationId: string }).operationId, caller) },
      async font_manager(params, caller, signal) { return fonts.execute(params, caller, signal) },
      async font_manager_cancel(params, caller) { return fonts.cancel((params as { operationId: string }).operationId, caller) },
      async recent_projects(params, caller, signal) {
        await requirePluginPermission(caller, 'fs', plugins)
        if (['open', 'terminal'].includes((params as { action: string }).action)) await requirePluginPermission(caller, 'shell', plugins)
        return recentProjects.handle(params, caller, signal)
      },
      async startup_manager(params, caller, signal) {
        await requirePluginPermission(caller, 'system', plugins)
        await requirePluginPermission(caller, 'fs', plugins)
        return startupManager.handle(params, caller, signal)
      },
      async browser_bookmarks_scan(params, caller, signal) {
        await requirePluginPermission(caller, 'fs', plugins)
        return browserBookmarks.scan(params, caller, signal)
      },
      async downloads_manager(params, caller, signal) {
        await requirePluginPermission(caller, 'fs', plugins)
        const input = params as { action: 'discover' | 'validate'; customDirs?: string[]; dirPath?: string }
        return builtinPluginHost.handlePluginCall('DownloadsManagerPlugin',
          input.action === 'discover' ? 'discoverSources' : 'validateCustomDir',
          input.action === 'discover' ? { customDirs: input.customDirs } : { dirPath: input.dirPath }, signal, caller)
      },
      async keyboard_lock(params, caller, signal) {
        await requirePluginPermission(caller, 'system', plugins)
        return keyboardLock.handle(params, caller, signal)
      },
      async docker_manager(params, caller, signal) {
        await requirePluginPermission(caller, 'shell', plugins)
        return dockerManager.handle(params, caller, signal)
      },
      async environment_manager(params, caller, signal) {
        await requirePluginPermission(caller, 'system', plugins)
        await requirePluginPermission(caller, 'fs', plugins)
        return environmentManager.handle(params, caller, signal)
      },
      async lan_network(params, caller, signal) {
        await requirePluginPermission(caller, 'network', plugins)
        return lanNetwork.handle(params, caller, signal)
      },
      async network_speedtest(params, caller, signal) {
        await requirePluginPermission(caller, 'network', plugins)
        return networkSpeedtest.handle(params, caller, signal)
      },
      async hotkey_probe(params, caller, signal) {
        await requirePluginPermission(caller, 'system', plugins)
        return hotkeyProbe.probe(params, signal)
      },
      async hosts_manager(params, caller, signal) {
        await requirePluginPermission(caller, 'system', plugins)
        await requirePluginPermission(caller, 'fs', plugins)
        return hostsManager.handle(params, caller, signal)
      },
      async file_unlock(params, caller, signal) {
        await requirePluginPermission(caller, 'fs', plugins)
        if ((params as { action: string }).action === 'terminate') await requirePluginPermission(caller, 'process', plugins)
        return fileUnlock.handle(params, caller, signal)
      },
      async dns_benchmark(params, caller, signal) {
        await requirePluginPermission(caller, 'network', plugins)
        await requirePluginPermission(caller, 'system', plugins)
        return dnsBenchmark.handle(params, caller, signal)
      },
      async browser_bookmarks_cancel(params, caller) {
        await requirePluginPermission(caller, 'fs', plugins)
        return browserBookmarks.cancel(params, caller)
      },
      async media_metadata(params, caller, signal) {
        return mediaMetadata.execute(params, caller, signal)
      },
      async media_metadata_cancel(params, caller) {
        return mediaMetadata.cancel((params as { operationId: string }).operationId, caller)
      },
      async office_document(params, caller, signal) {
        return office.execute(params, caller, signal)
      },
      async markdown_document(params, caller, signal) {
        const action = (params as { action: string }).action
        if (action === 'read' || action === 'export') await requirePluginPermission(caller, 'fs', plugins)
        if (action === 'copy') await requirePluginPermission(caller, 'clipboard', plugins)
        return markdown.execute(params, caller, signal)
      },
      async monitor_control(params, caller, signal) {
        await requirePluginPermission(caller, (params as { action: string }).action === 'sleep' ? 'system' : 'screen', plugins)
        return monitorControl.execute(params, signal)
      },
      async ssh_proxy(params, caller, signal) {
        const action = (params as { action: string }).action
        await requirePluginPermission(caller, ['connect', 'tunnel', 'terminal-proxy'].includes(action) ? 'shell' : 'fs', plugins)
        return sshProxy.handle(params, caller, signal)
      },
      async tls_inspect(params, caller, signal) {
        await requirePluginPermission(caller, 'network', plugins)
        return tlsInspect.handle(params, caller, signal)
      },
      async office_cancel(params, caller) {
        return office.cancel((params as { operationId: string }).operationId, caller)
      },
      async audio_get_devices() {
        return { devices: await system.getAudioDevices() }
      },
      async audio_set_default_device(params, caller) {
        await requirePluginPermission(caller, 'audio', plugins)
        const input = (params || {}) as { id?: string; name?: string; idOrName?: string; type?: 'output' | 'input' }
        const target = input?.idOrName ?? input?.id ?? input?.name ?? ''
        return system.setDefaultAudioDevice(target, input?.type ?? 'output')
      },
      async audio_set_volume(params, caller) {
        await requirePluginPermission(caller, 'audio', plugins)
        const input = (params || {}) as { volume: number; type?: 'output' | 'input'; id?: string }
        return system.setAudioVolume(input?.volume, input?.type ?? 'output', input?.id)
      },
      async audio_toggle_mute(params, caller) {
        await requirePluginPermission(caller, 'audio', plugins)
        const input = (params || {}) as { muted?: boolean; type?: 'output' | 'input'; id?: string }
        return system.toggleAudioMute(input?.muted, input?.type ?? 'output', input?.id)
      },
      async wifi_get_profiles(_params, caller) {
        await requirePluginPermission(caller, 'system', plugins)
        return { profiles: await system.getWifiProfiles() }
      },
      async wifi_get_password(params, caller) {
        await requirePluginPermission(caller, 'system', plugins)
        const input = params as { ssid: string }
        return system.getWifiPassword(input?.ssid)
      },
      async brew_exec(params) {
        const input = (params || {}) as { action: Parameters<typeof system.execBrewCommand>[0]['action']; pkg?: string; query?: string; cask?: boolean }
        if (process.platform === 'win32' && input.action === 'outdated') {
          return {
            success: true,
            action: input.action,
            stdout: '',
            stderr: '',
            items: []
          }
        }
        if (
          process.platform === 'win32' &&
          (input.action === 'list' || input.action === 'search')
        ) {
          const apps = await services.applications.searchApplications(input.pkg ?? input.query)
          if (apps.length > 0) {
            const items = apps.slice(0, 45).map((app) => {
              const slug = app.name
                .toLowerCase()
                .replace(/[^a-z0-9._+-]+/g, '-')
                .replace(/^-+|-+$/g, '') || app.id
              const isFormula = /sdk|cli|node|git|python|rust|go|cmake|llvm|redistributable|7-zip/i.test(app.name)
              const ver = app.version || '1.0.0'
              return {
                name: slug,
                fullName: app.name,
                version: ver,
                installedVersion: ver,
                latestVersion: ver,
                type: isFormula ? ('formula' as const) : ('cask' as const),
                isCask: !isFormula,
                cask: !isFormula,
                description: `${app.name} — Publisher: ${app.publisher || 'Windows Installed Package'}`,
                tap: 'windows/installed'
              }
            })
            return {
              success: true,
              action: input.action,
              stdout: items.map((i) => `${i.name} ${i.version}`).join('\n'),
              stderr: '',
              items
            }
          }
        }
        return system.execBrewCommand({
          action: input.action,
          ...(input.pkg ?? input.query ? { pkg: input.pkg ?? input.query } : {}),
          ...(input.cask !== undefined ? { cask: input.cask } : {})
        })
      },
      async script_commands_list(params) {
        const input = (params || {}) as { query?: string; search?: string }
        if (services.scriptCommands.commands.size === 0) {
          await services.scriptCommands.scanScripts()
        }
        const items = services.scriptCommands.getSearchItems()
        const q = (input?.query ?? input?.search ?? '').trim().toLowerCase()
        if (!q) return { items, scripts: items, commands: items }
        const filtered = items.filter((item) =>
          item.title.toLowerCase().includes(q) ||
          item.packageName.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
        )
        return { items: filtered, scripts: filtered, commands: filtered }
      },
      async script_commands_execute(params) {
        const input = (params || {}) as { id?: string; commandId?: string; scriptPath?: string; filePath?: string; args?: string[]; timeoutMs?: number }
        const target = input?.id ?? input?.commandId ?? input?.scriptPath ?? input?.filePath ?? ''
        return services.scriptCommands.executeCommand(
          target,
          Array.isArray(input?.args) ? input.args.map(String) : [],
          input?.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : undefined
        )
      },
      async script_commands_create(params) {
        type ScriptCmdCreateOpts = Parameters<typeof services.scriptCommands.createScriptCommand>[0]
        const input = (params || {}) as {
          title: string
          mode?: ScriptCmdCreateOpts['mode']
          template?: ScriptCmdCreateOpts['template']
          language?: ScriptCmdCreateOpts['template']
          packageName?: string
          description?: string
        }
        return services.scriptCommands.createScriptCommand({
          title: input.title,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
          ...(input.template ?? input.language ? { template: input.template ?? input.language } : {}),
          ...(input.packageName !== undefined ? { packageName: input.packageName } : {}),
          ...(input.description !== undefined ? { description: input.description } : {})
        })
      },
      async script_commands_reload() {
        const commands = await services.scriptCommands.scanScripts()
        return { success: true, count: commands.length, items: services.scriptCommands.getSearchItems() }
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
    attempt(() => this.#attribution.stop())
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
        () => this.#builtinPluginHost.stop(),
        () => this.#system.stop(),
        () => this.#folderSync.stop(),
        () => this.#removeFolderSyncListener(),
        () => this.#fonts.stop(),
        () => this.#mediaMetadata.stop(),
        () => this.#office.stop(),
        () => this.#recentProjects.stop(),
        () => this.#removeRecentProjectsListener(),
        () => this.#startupManager.stop(),
        () => this.#removeStartupListener(),
        () => this.#browserBookmarks.stop(),
        () => this.#keyboardLock.stop(),
        () => this.#dnsBenchmark.stop(),
        () => this.#dockerManager.stop(),
        () => this.#removeDockerWindowListener(),
        () => this.#environmentManager.stop(),
        () => this.#removeEnvironmentWindowListener(),
        () => this.#lanNetwork.stop(),
        () => this.#removeLanWindowListener(),
        () => this.#markdown.stop(),
        () => this.#monitorControl.stop(),
        () => this.#sshProxy.stop(),
        () => this.#tlsInspect.stop(),
        () => this.#removeTlsInspectListener(),
        () => this.#removeSshProxyListener(),
        () => this.#removeMarkdownWindowListener(),
        () => this.#networkSpeedtest.stop(),
        () => this.#removeSpeedtestWindowListener(),
        () => this.#hostsManager.stop(),
        () => this.#removeHostsWindowListener(),
        () => this.#fileUnlock.stop(),
        () => this.#removeFileUnlockWindowListener(),
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
      // 主窗口声明式插件的会话归属：只附加 attributedPlugin，type / pluginId 不变；失效令牌按未归属处理
      caller = this.#attribution.attributeCaller(caller, request)
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
      // 平台能力边界（如 macOS 尚未开放的更新安装链）是明确声明的 NOT_SUPPORTED，不是宿主故障：
      // 不打印堆栈与 warn，只记一条 info；返回给调用方的错误与诊断记录保持不变
      const capabilityBoundary = isIpcCapabilityBoundary(error)
      if (!capabilityBoundary) {
        console.error('[IPC ROUTER ERROR DETAILS]', request?.method, error)
      }
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
      if (capabilityBoundary) {
        console.info('IPC capability not supported on this platform', {
          method: request?.method ?? 'invalid',
          callerType: caller?.type ?? 'unregistered',
          errorMessage: publicError.message
        })
      } else if (!missingDatabaseKey) {
        console.warn('IPC request failed', {
          senderWebContentsId: event.sender.id,
          messageId: request?.messageId,
          callerType: caller?.type ?? 'unregistered',
          pluginId: caller?.pluginId,
          ...(caller?.attributedPlugin ? { attributedPluginId: caller.attributedPlugin.pluginId } : {}),
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
