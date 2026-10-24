export type AnyRecord = Record<string, unknown>
export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading'
export type EventHandler<T = unknown> = (envelope: EventEnvelope<T>) => void

export interface ZToolsAPI {
  fs: FileSystemAPI
  db: DatabaseAPI
  credentials: CredentialsAPI
  sys: SystemAPI
  win: WindowAPI
  window: WindowAPI
  plugin: PluginAPI
  settings: KeyValueAPI
  config: ConfigAPI
  events: EventsAPI
  clipboard: ClipboardAPI
  screen: ScreenAPI
  shell: ShellAPI
  network: NetworkAPI
  process: ProcessAPI
  ocr: OCRAPI
  trigger: TriggerAPI
  privileged: PrivilegedAPI
  update: UpdateAPI
  image: ImageAPI
  ffmpeg: FFmpegAPI
  dllplugin: DLLPluginAPI
  screenshot: ScreenshotAPI
  features?: FeaturesAPI
  zip: ZipAPI
  sqlite: BrowserSnapshotAPI
  protocol: AnyRecord
  destroy(): Promise<EventsCleanupResult>
  getVersion(): string
  getEnvironment(): AnyRecord
  isCEF(): boolean
  isBrowser(): boolean
}

export interface DatabaseAPI {
  setPluginId(pluginId: string): Promise<void>
  get<T = unknown>(key: string): Promise<T | null>
  get<T = unknown>(pluginId: string, key: string): Promise<T | null>
  put<T extends ZToolsDocument>(doc: T): Promise<T>
  remove(id: string): Promise<{ ok: true; id: string }>
  set(key: string, value: unknown): Promise<boolean>
  set(pluginId: string, key: string, value: unknown): Promise<boolean>
  delete(key: string): Promise<boolean>
  delete(pluginId: string, key: string): Promise<boolean>
  allDocs<T extends ZToolsDocument = ZToolsDocument>(prefix?: string): Promise<T[]>
  bulkDocs<T extends ZToolsDocument>(docs: T[]): Promise<Array<{ ok: true; id: string }>>
  postAttachment(docId: string, attachment: string | ArrayBuffer | Blob, type: string): Promise<{ ok: true; id: string }>
  getAttachment(docId: string): Promise<string | null>
  getAttachmentType(docId: string): Promise<string | null>
  /** @deprecated Legacy reversible transform only; do not use for passwords, tokens, or other secrets. Use credentials.v1. */
  putSecure(key: string, value: string): Promise<boolean>
  /** @deprecated Legacy reversible transform only; do not use for passwords, tokens, or other secrets. Use credentials.v1. */
  putSecure(pluginId: string, key: string, value: string): Promise<boolean>
  /** @deprecated Legacy reversible transform only; do not use for passwords, tokens, or other secrets. Use credentials.v1. */
  getSecure(key: string): Promise<string | null>
  /** @deprecated Legacy reversible transform only; do not use for passwords, tokens, or other secrets. Use credentials.v1. */
  getSecure(pluginId: string, key: string): Promise<string | null>
}

export type CredentialProtectionStatus =
  | { status: 'available' }
  | { status: 'unavailable'; reason: 'encryption-unavailable' | 'insecure-backend' | 'backend-unknown' }

export interface CredentialsAPI {
  readonly v1: CredentialStoreV1API
}

export interface CredentialStoreV1API {
  /** Status is explicit; unavailable hosts never fall back to plaintext or the legacy DB transform. */
  status(): Promise<CredentialProtectionStatus>
  /** Stores or overwrites a plugin-installation-scoped UTF-8 string (maximum 64 KiB). */
  set(key: string, value: string): Promise<boolean>
  /** Returns null when missing; throws a coded error when the record is corrupt or protection is unavailable. */
  get(key: string): Promise<string | null>
  /** Idempotently deletes a plugin-installation-scoped credential. */
  delete(key: string): Promise<boolean>
}

/* ---------------------------------------------------------------------------
 * 声明式插件 SDK（@ztools/declarative-ui）宿主能力：SecureStorage / terminateProcess / getHostTransport。
 * 声明式插件由宿主按插件注入实现，调用自动带插件会话归属；类型在此同步一份供审核与工具使用。
 * ------------------------------------------------------------------------- */
export type DeclarativeSecureStorageStatus =
  | { available: true }
  | { available: false; reason: 'encryption-unavailable' | 'insecure-backend' | 'backend-unknown' | 'host-unsupported' | 'identity-required' }

export interface DeclarativeSecureStorageImportResult {
  status: 'imported' | 'not-found' | 'kept-secure'
  value?: unknown
  /** 加密存储与明文同时存在且不同：由插件合并后调用 discardLocalStorage */
  legacyValue?: unknown
}

/** 加密存储（Electron safeStorage）；不可用时报错，绝不回落明文。防磁盘 / 备份泄露，不防同一宿主里的其他插件 */
export interface DeclarativeSecureStorage {
  status(): Promise<DeclarativeSecureStorageStatus>
  /** 值以 JSON 保存；损坏抛 DATA_CORRUPT */
  getItem<T = unknown>(key: string): Promise<T | undefined>
  /** JSON 后 ≤ 64 KiB；不可用抛 SECURE_STORAGE_UNAVAILABLE */
  setItem(key: string, value: unknown): Promise<void>
  removeItem(key: string): Promise<void>
  importFromLocalStorage(key: string, options?: { targetKey?: string }): Promise<DeclarativeSecureStorageImportResult>
  discardLocalStorage(key: string): Promise<void>
}

export interface TerminateProcessOptions {
  mode?: 'graceful' | 'force'
  tree?: boolean
  /** 100–10000 毫秒，默认 graceful 3000 / force 2000 */
  timeoutMs?: number
  expectedName?: string
}

export interface TerminateProcessResult {
  pid: number
  mode: 'graceful' | 'force'
  tree: boolean
  terminated: number[]
}

/**
 * 结束本机任意进程（插件需声明 "process" 权限）。失败抛 ZToolsHostError：
 * PROCESS_PROTECTED / PROCESS_NOT_FOUND / PROCESS_ACCESS_DENIED / PROCESS_IDENTITY_MISMATCH /
 * PROCESS_TERMINATE_TIMEOUT（details.stillRunning，不自动升级 force）/ PLUGIN_PERMISSION_REQUIRED /
 * PLUGIN_IDENTITY_REQUIRED / HOST_FEATURE_UNAVAILABLE。
 */
export type DeclarativeTerminateProcess = (pid: number, options?: TerminateProcessOptions) => Promise<TerminateProcessResult>

export interface DeclarativeHostTransport {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
}

export interface PopoutStateOptions<T> {
  /** 值里引用的本地路径：宿主只把当前窗口对这些路径已有的授权（不会更多）转交给独立窗口 */
  paths?: (value: T) => readonly string[] | null | undefined
}

/**
 * 与 useState 相同；「弹出独立窗口」时值交给新窗口，新窗口首次渲染用它代替 initialValue（只用一次）。
 * 只在根页面生效；值必须是纯 JSON（普通对象 / 数组 / 字符串 / 有限数字 / 布尔 / null），否则该项不带。
 * key 为 1–64 个字符、同一页面内唯一。插件升级后旧值形状可能变化，插件需自行容错。
 */
export type DeclarativeUsePopoutState = <T>(
  key: string,
  initialValue: T | (() => T),
  options?: PopoutStateOptions<T>
) => [T, (next: T | ((prev: T) => T)) => void]

export interface ZToolsDocument {
  _id: string
  [key: string]: unknown
}

export interface FileSystemAPI {
  readFile(path: string, options?: AnyRecord): Promise<string>
  readFileAsBinary(path: string, options?: AnyRecord): Promise<unknown>
  writeFile(path: string, content: unknown, options?: AnyRecord): Promise<unknown>
  writeCache(relativePath: string, content: unknown, options?: AnyRecord): Promise<unknown>
  readCache(relativePath: string, options?: AnyRecord): Promise<string | null>
  deleteFile(path: string): Promise<boolean>
  copyFile(sourcePath: string, destPath: string): Promise<boolean>
  moveFile(sourcePath: string, destPath: string): Promise<boolean>
  fileExists(path: string): Promise<boolean>
  getFileSize(path: string): Promise<number>
  createDirectory(path: string): Promise<boolean>
  deleteDirectory(path: string): Promise<boolean>
  directoryExists(path: string): Promise<boolean>
  getDirectoryContents(path: string): Promise<FileInfo[]>
  getCurrentDirectory(): Promise<string>
  setCurrentDirectory(path: string): Promise<boolean>
  findFiles(path: string, pattern?: string): Promise<string[]>
  findDirectories(path: string, pattern?: string): Promise<string[]>
  getFullPath(path: string): Promise<string>
  combinePath(path1: string, path2: string): Promise<string>
  getFileName(path: string): Promise<string>
  getExtension(path: string): Promise<string>
  getParentDirectory(path: string): Promise<string>
}

export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  modifiedTime?: string
  [key: string]: unknown
}

export interface HardwareSummary {
  platform: 'windows' | 'macos'
  osVersion: string
  processArch: 'ia32' | 'x64' | 'arm64'
  cpuModels: readonly string[]
  logicalCpuCount: number
  totalMemory: number
  fieldAvailability: Readonly<{ cpuModels: boolean; logicalCpuCount: boolean; totalMemory: boolean; osVersion: boolean }>
}
export interface SystemAPI {
  getHardwareSummary(): Promise<Readonly<HardwareSummary>>
  notify(title: string, message: string, options?: { modal?: boolean }): Promise<boolean>
  toast(type: ToastType, message: string, duration?: number): Promise<void>
  confirm(title: string, message: string, options?: AnyRecord): Promise<boolean>
  setDarkMode(enabled: boolean): Promise<boolean>
  getInfo(): Promise<SystemInfo>
  getCapability(capability: RuntimeCapabilityId): Promise<RuntimeCapabilityRecord>
  getRuntimeIdentity(): Promise<RuntimeIdentity>
  getNativeId(): Promise<string>
  getAppName(): Promise<string>
  getAppVersion(): Promise<string>
  getPath(name: string): Promise<string>
  getFileIcon(filePath: string): Promise<string>
  readCurrentFolderPath(): Promise<string>
  readCurrentBrowserUrl(): Promise<string>
  isDev(): Promise<boolean>
  getPlatform(): Promise<string>
  isWindows(): Promise<boolean>
  isMacOS(): Promise<boolean>
  isLinux(): Promise<boolean>
  shutdown(force?: boolean, timeout?: number): Promise<unknown>
  restart(force?: boolean): Promise<unknown>
  logout(force?: boolean): Promise<unknown>
  lock(): Promise<unknown>
  sleep(): Promise<unknown>
  hibernate(): Promise<unknown>
  preventSleep(enable: boolean): Promise<unknown>
  simulateKeyPress(key: string): Promise<unknown>
  simulateKeyCombo(keys: string[]): Promise<unknown>
  simulateText(text: string): Promise<unknown>
  simulateMouseMove(x: number, y: number): Promise<unknown>
  simulateMouseClick(button: string, x?: number, y?: number): Promise<unknown>
  simulateMouseWheel(delta: number): Promise<unknown>
  getCPUUsage(): Promise<unknown>
  getMemoryUsage(): Promise<unknown>
  getDiskUsage(drive?: string): Promise<unknown>
  getNetworkStats(): Promise<unknown>
  getBatteryStatus(): Promise<unknown>
  checkUpdate(source?: string): Promise<unknown>
  checkAppUpdate(): Promise<unknown>
  checkWebUpdate(): Promise<unknown>
  performUpdate(type: string, info?: AnyRecord): Promise<unknown>
  getCurrentVersion(): Promise<unknown>
  privilegedExecute(type: string, payload: AnyRecord, timeout?: number): Promise<unknown>
  reloadHotkeys(): Promise<unknown>
  getPanelLocalApps(): Promise<unknown>
}

export type RuntimeCapabilityId =
  | 'screen.capture'
  | 'clipboard.files.read'
  | 'system.hibernate'

export interface RuntimeCapabilityTarget {
  platform: 'windows' | 'macos'
  runtime: 'electron'
  arch: 'ia32' | 'x64' | 'arm64'
}

export interface RuntimeCapabilityRecord {
  contractVersion: number
  target: RuntimeCapabilityTarget
  capability: RuntimeCapabilityId
  implementation: 'supported' | 'unsupported' | 'unavailable'
  authorization: 'granted' | 'denied' | 'unknown'
  osPermission: 'not-required' | 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
  revision: number
  reasonCode?: string
}

export type RuntimeIdentityArchitecture = 'ia32' | 'x64' | 'arm64' | 'unknown'
export type RuntimeIdentityTranslationMode =
  | 'native'
  | 'translated'
  | 'compatibility'
  | 'not-applicable'
  | 'unknown'

export interface RuntimeIdentityTarget {
  id?: string
  platform: 'windows' | 'macos'
  runtime: 'electron'
  arch: 'ia32' | 'x64' | 'arm64' | 'universal'
  abi?: string
  minSdkContractVersion?: number
}

export interface RuntimeIdentity {
  contractVersion: 1
  appVersion: string
  target: RuntimeIdentityTarget
  os: {
    productVersion: string
    kernelVersion?: string
    arch: RuntimeIdentityArchitecture
  }
  process: {
    arch: RuntimeIdentityArchitecture
    translationMode: RuntimeIdentityTranslationMode
  }
  nativeHost: {
    state: 'not-applicable' | 'available' | 'unavailable' | 'unknown'
    arch: RuntimeIdentityArchitecture
    protocolVersion: number | null
  }
}

export interface SystemInfo extends AnyRecord {
  darkMode?: boolean
  platform?: string
  appVersion?: string
}

export interface WindowAPI {
  open(url: string): Promise<unknown>
  close(): Promise<unknown>
  minimize(): Promise<unknown>
  maximize(): Promise<unknown>
  toggleFullscreen(): Promise<unknown>
  drag(): Promise<unknown>
  hide(): Promise<unknown>
  show(): Promise<unknown>
  hidePluginWindow(): Promise<unknown>
  showPluginWindow(): Promise<unknown>
  minimizePluginWindow(): Promise<unknown>
  restorePluginWindow(): Promise<unknown>
  setHeight(height: number): Promise<unknown>
  outPlugin(): Promise<unknown>
  redirect(url: string): Promise<unknown>
  showOpenDialog(options?: DialogOptions): Promise<DialogResult>
  showSaveDialog(options?: DialogOptions): Promise<DialogResult>
  showSelectFolderDialog(options?: DialogOptions): Promise<DialogResult>
  setSize(width: number, height: number, animate?: boolean): Promise<unknown>
  getBounds(): Promise<WindowBounds>
  setOpacity(opacity: number): Promise<unknown>
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<unknown>
  showTooltip(text: string): Promise<unknown>
  hideTooltip(): Promise<unknown>
  showRecordBar(options?: { duration?: number; taskId?: string }): Promise<unknown>
  updateRecordBar(options?: { duration?: number; status?: string }): Promise<unknown>
  hideRecordBar(): Promise<unknown>
  toggleDevTools(): Promise<unknown>
  sendCloseConfirmResult(result: AnyRecord): Promise<unknown>
}

export interface DialogOptions extends AnyRecord {
  title?: string
  defaultPath?: string
  defaultName?: string
  filters?: string
  properties?: string[]
}

export interface DialogResult extends AnyRecord {
  canceled: boolean
  filePath?: string
  folderPath?: string
  filePaths?: Array<string | { path: string }>
}

export interface WindowBounds { x: number; y: number; width: number; height: number }

export interface PluginAPI {
  getList(): Promise<unknown[]>
  open(pluginId: string): Promise<unknown>
  uninstall(pluginId: string): Promise<unknown>
  install(pluginId: string, url: string): Promise<unknown>
  refresh(): Promise<unknown>
  toggle(pluginId: string): Promise<unknown>
  close(pluginId: string, instanceId?: string): Promise<unknown>
  createShortcut(pluginId: string): Promise<unknown>
  refreshIcon(pluginId: string, iconUrl: string): Promise<unknown>
}

export interface FeatureFlags {
  unifiedKeymap: boolean
  commandPalette: boolean
  dashboardStage: boolean
  silentInstall: boolean
  extensionHost: boolean
  scriptCommands: boolean
  extensionTools: boolean
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags>
export type FeatureFlagKey = keyof FeatureFlags

export interface FeaturesAPI {
  get(key?: string): Promise<unknown>
  getAll(): Promise<FeatureFlags>
}

export interface KeyValueAPI { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> }
export interface ConfigAPI {
  get(path: string, defaultValue?: unknown, file?: string): Promise<unknown>
  set(path: string, value: unknown, syncEnabled?: boolean, file?: string): Promise<unknown>
  getMultiple(paths: string[], file?: string): Promise<AnyRecord>
  setMultiple(values: AnyRecord, syncEnabled?: boolean, file?: string): Promise<unknown>
  getFeatures?(): Promise<FeatureFlags>
}

export interface EventEnvelope<T = unknown> {
  type?: string
  eventType?: string
  payload: T
  timestamp?: number
  requestId?: string
  replyTo?: string
  [key: string]: unknown
}

export interface EventsCleanupResult {
  success: boolean
  errors: unknown[]
}

export interface EventsAPI {
  dispatchEnvelope(envelope: EventEnvelope): void
  on<T = unknown>(eventType: string, handler: EventHandler<T>): void
  off<T = unknown>(eventType: string, handler: EventHandler<T>): void
  subscribeConfirmed<T = unknown>(eventType: string, handler: EventHandler<T>): Promise<() => Promise<void>>
  emit(eventType: string, payload: unknown, options?: AnyRecord): Promise<unknown>
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  onChannel(channel: string, handler: EventHandler): void
  offChannel(channel: string, handler: EventHandler): void
  publish(channel: string, eventType: string, payload: unknown, options?: AnyRecord): Promise<unknown>
  request<T = unknown>(eventType: string, payload: unknown, options?: AnyRecord): Promise<T>
  respond(replyTo: string, ackPayload: unknown, options?: AnyRecord): Promise<unknown>
  clear(): Promise<EventsCleanupResult>
  destroy(): Promise<EventsCleanupResult>
}

export interface ClipboardImageReference { type: 'reference'; reference: ReadFileReference; fileUrl: string; size: number; width: number; height: number; toDataURL(options?: { signal?: AbortSignal }): Promise<string>; release(): Promise<unknown> }
export interface ClipboardFilesResult { files: readonly (ReadFileReference | ReadDirectoryReference)[]; errors: readonly { index: number; code: string; message: string }[] }
export interface ClipboardAPI {
  copyText(text: string | ReadFileReference, options?: { signal?: AbortSignal }): Promise<unknown>
  copyImage(image: string | ReadFileReference, options?: { signal?: AbortSignal }): Promise<unknown>
  copyFile(filePath: string): Promise<unknown>
  copyFiles(filePaths: string[]): Promise<unknown>
  readText(options?: { signal?: AbortSignal }): Promise<string>
  readImage(options?: { signal?: AbortSignal }): Promise<unknown>
  readImageReference(options?: { signal?: AbortSignal }): Promise<string | ClipboardImageReference>
  readFiles(options?: { signal?: AbortSignal }): Promise<readonly (string | ReadFileReference | ReadDirectoryReference)[]>
  readFilesDetailed(options?: { signal?: AbortSignal }): Promise<ClipboardFilesResult>
  hideAndPasteText(text: string): Promise<unknown>
  hideAndPasteImage(image: unknown): Promise<unknown>
  hideAndPasteFile(filePath: string): Promise<unknown>
  hideAndType(text: string): Promise<unknown>
  writeText(text: string | ReadFileReference, options?: { signal?: AbortSignal }): Promise<unknown>
  clear(options?: { signal?: AbortSignal }): Promise<unknown>
  onChange(handler: EventHandler): () => void
  offChange(handler: EventHandler): void
}

export interface DLLPluginAPI {
  on(event: string, callback: (data: unknown) => void): void
  off(event: string, callback: (data: unknown) => void): void
  list(): Promise<DLLPluginInfo[]>
  getList(): Promise<DLLPluginInfo[]>
  call<T = unknown>(pluginName: string, funcName: string, params?: AnyRecord, options?: AnyRecord): Promise<T>
  callWithCallback(pluginName: string, funcName: string, params?: AnyRecord, callback?: (data: unknown, error: unknown) => void): Promise<string>
  clearCallback(taskId: string, removeTask?: boolean): void
  exists(pluginName: string): Promise<boolean>
  getInfo(pluginName: string): Promise<DLLPluginInfo | null>
  callAsync(pluginName: string, funcName: string, params?: AnyRecord): Promise<string>
  queryTask(pluginName: string, taskId: string): Promise<AnyRecord>
  waitTask<T = unknown>(taskId: string, pollInterval?: number, timeout?: number): Promise<T>
  cancelTask(pluginName: string, taskId: string): Promise<boolean>
  getTaskInfo(taskId: string): unknown
  getAllTasks(): unknown[]
}

export interface DLLPluginInfo extends AnyRecord { name?: string; pluginName?: string; version?: string; funcNames?: string[] }

export interface ScreenRectangle { x: number; y: number; width: number; height: number }
export interface ScreenReferenceCapture { reference: ReadFileReference; fileUrl: string; size: number; width: number; height: number }
export interface ScreenAPI {
  capture(rect?: ScreenRectangle, callback?: (image: string) => void, options?: { signal?: AbortSignal }): Promise<string>
  captureReference(rect?: ScreenRectangle, options?: { signal?: AbortSignal }): Promise<ScreenReferenceCapture>
  /** Interactive single-display DIP selection; undefined means the user dismissed it. */
  captureRegionReference(options?: { signal?: AbortSignal }): Promise<ScreenReferenceCapture | undefined>
  captureFullScreen(options?: { signal?: AbortSignal }): Promise<string>
  captureRegion(x: number, y: number, width: number, height: number, options?: { signal?: AbortSignal }): Promise<string>
  getCursorScreenPoint(): Promise<{ x: number; y: number }>
  getCursorPos(): Promise<{ x: number; y: number }>
  getPrimaryDisplay(): Promise<unknown>
  getAllDisplays(): Promise<unknown[]>
  getDisplayNearestPoint(point: { x: number; y: number }): Promise<unknown>
  getDisplayMatching(rect: ScreenRectangle): Promise<unknown>
}
export interface ShellAPI { openPath(path: string): Promise<any>; trashItem(path: string): Promise<any>; showItemInFolder(path: string): Promise<any>; openExternal(url: string): Promise<any>; beep(): Promise<any>; exec(command: string): Promise<any> }
export interface NetworkAPI { request(options: AnyRecord): Promise<any>; httpRequest(options: AnyRecord): Promise<any>; get(url: string, options?: AnyRecord): Promise<any>; post(url: string, body: unknown, options?: AnyRecord): Promise<any>; put(url: string, body: unknown, options?: AnyRecord): Promise<any>; delete(url: string, options?: AnyRecord): Promise<any>; download(url: string, savePath: string, options?: AnyRecord): Promise<any>; upload(url: string, filePath: string, options?: AnyRecord): Promise<any>; setCookie(cookie: AnyRecord): Promise<any>; getCookie(url: string): Promise<any>; clearCookies(): Promise<any>; setProxy(proxy: AnyRecord): Promise<any> }
export interface ProcessSummary {
  pid: number; name: string; path: string; cpuUsage: number; memoryUsage: number
  fieldAvailability: { path: boolean; cpuUsage: boolean; memoryUsage: boolean }
}
export interface ProcessPortConnection {
  protocol: 'TCP' | 'UDP'
  localAddress: string
  localPort: number
  remoteAddress: string
  remotePort: number | null
  state: string
  pid: number
  processName: string
  fieldAvailability: { processName: boolean; processPath: false; startTime: false }
}
export interface ProcessAPI {
  listPorts(): Promise<{ connections: readonly Readonly<ProcessPortConnection>[]; source: 'darwin-netstat' | 'darwin-lsof' | 'windows-netstat'; visibility: 'all-sockets' | 'visible-processes'; queriedAt: string }>
  list(): Promise<ProcessSummary[]>
  [method: string]: (...args: any[]) => Promise<any>
}
export interface LocalOcrResult {
  readonly provider: 'apple-vision-local'
  readonly revision: number
  readonly width: number
  readonly height: number
  readonly text: string
  /** Normalized bounds in the oriented image; bottom-left origin. */
  readonly lines: ReadonlyArray<{ readonly text: string; readonly confidence: number; readonly box: readonly [number, number, number, number] }>
}
export interface OCRAPI {
  recognizeLocal(file: ReadFileReference, options?: { languages?: string[]; signal?: AbortSignal }): Promise<LocalOcrResult>
  getLocalLanguages(options?: { signal?: AbortSignal }): Promise<{ readonly provider: 'apple-vision-local'; readonly revision: number; readonly languages: readonly string[] }>
}
export interface TriggerAPI { register(config: AnyRecord): Promise<any>; unregister(triggerId: string): Promise<any>; list(pluginId?: string): Promise<any>; setEnabled(triggerId: string, enabled: boolean): Promise<any>; checkConflict(key: string, pluginId?: string): Promise<any> }
export interface PrivilegedAPI { regWrite(path: string, name: string, value: unknown, view?: 32 | 64): Promise<any>; regDelete(path: string, name: string, view?: 32 | 64): Promise<any>; fileWrite(path: string, content: unknown): Promise<any>; restartExplorer(): Promise<any>; execute(command: string, options?: AnyRecord): Promise<any> }
export interface UpdateAPI { check(source?: string): Promise<any>; downloadAndInstall(info: AnyRecord): Promise<any>; downloadApp(info: AnyRecord): Promise<any>; downloadPlugin(id: string, info: AnyRecord): Promise<any> }
export interface ImageAPI {
  previewGIF(images: ReadFileReference[], options?: { interval?: number; loop?: boolean; signal?: AbortSignal }): Promise<{ reference: ReadFileReference; fileUrl: string; size: number; frameCount: number; width: number; height: number }>
  imagesToGIF(images: ReadFileReference[], output: SaveFileReference, options?: { interval?: number; loop?: boolean; replace?: boolean; signal?: AbortSignal }): Promise<boolean>
  [method: string]: (...args: any[]) => Promise<any>
}
export interface FFmpegAPI { [method: string]: (...args: any[]) => Promise<any> }
export interface ScreenshotRegionOptions {
  outputDir?: string
  outputFormat?: 'png' | 'jpg' | 'bmp'
  openFolder?: boolean
  enableToolbar?: boolean
  enablePinToScreen?: boolean
  autoFinishOnSelect?: boolean
  pollInterval?: number
  timeout?: number
  signal?: AbortSignal
}
export interface ScreenshotCaptureResult {
  success: boolean
  cancelled: boolean
  outputPath?: string
  savedPath?: string
  clipboard?: boolean
  pinned?: boolean
  width?: number
  height?: number
  error?: string
  message?: string
}
export interface ScreenshotAPI {
  capture(options?: ScreenshotRegionOptions): Promise<ScreenshotCaptureResult>
  captureRegion(options?: ScreenshotRegionOptions): Promise<ScreenshotCaptureResult>
  captureScreen(options?: Pick<ScreenshotRegionOptions, 'outputDir' | 'outputFormat' | 'openFolder'> & { screens?: number[] }): Promise<ScreenshotCaptureResult>
  captureWindow(options: Pick<ScreenshotRegionOptions, 'outputDir' | 'outputFormat' | 'openFolder'> & { windowTitle: string }): Promise<ScreenshotCaptureResult>
  getWindowList(): Promise<unknown[]>
  getScreenList(): Promise<unknown[]>
  isAvailable(): Promise<boolean>
}
export interface ReadFileReference { grantId: string; kind: 'file'; displayName: string; operations: readonly string[] }
export interface CommittedArtifactReference extends ReadFileReference { operations: readonly ['read']; fileUrl: string }
export type ReferenceFileWriteReceipt =
  | { success: true; status: 'committed'; size: number; reference: CommittedArtifactReference }
  | { success: false; status: 'result-unknown'; code: 'FILE_WRITE_OUTCOME_UNKNOWN' }
export interface ReadDirectoryReference { grantId: string; kind: 'directory'; displayName: string; operations: readonly string[] }
export interface WritableDirectoryReference { grantId: string; kind: 'directory'; displayName: string; operations: readonly string[] }
export interface SaveFileReference { grantId: string; kind: 'save'; displayName: string; operations: readonly string[] }
export type BrowserSnapshotKind = 'chromium-history' | 'firefox-history' | 'firefox-bookmarks'
export interface BrowserSnapshotResult { columns: readonly string[]; rows: readonly (readonly (string | number | null)[])[]; truncated: boolean; sqliteVersion: string }
export interface BrowserSnapshotAPI { readBrowserSnapshot(file: ReadFileReference, options: { kind: BrowserSnapshotKind; limit?: number; keyword?: string; signal?: AbortSignal }): Promise<BrowserSnapshotResult> }
export interface ZipEntry { name: string; size: number; isDirectory: boolean; compressedSize?: number }
export interface ZipAPI {
  list(archive: string | ReadFileReference, options?: { signal?: AbortSignal }): Promise<ZipEntry[]>
  test(archive: string | ReadFileReference, options?: { signal?: AbortSignal }): Promise<boolean>
  compress(options: { sources: string | string[] | ReadFileReference | ReadDirectoryReference | (ReadFileReference | ReadDirectoryReference)[]; output: string | SaveFileReference; format?: string; password?: string; level?: number; storePaths?: boolean; replace?: boolean; signal?: AbortSignal; onProgress?: (percent: number, message: string) => void }): Promise<boolean>
  extract(options: { archive: string | ReadFileReference; output: string | WritableDirectoryReference; password?: string; replace?: boolean; signal?: AbortSignal; onProgress?: (percent: number, message: string) => void }): Promise<boolean>
  getPluginInfo(): Promise<unknown>
  isAvailable(): Promise<boolean>
}

export interface ZToolsPluginSDK {
  init(options?: { root?: HTMLElement }): Promise<void>
  applyTheme(isDark: boolean, options?: { root?: HTMLElement }): void
  guessInitialTheme(): boolean
  onPluginEnter(callback: (meta: PluginEnterMeta) => void): () => void
  onPluginOut(callback: (isKill: boolean) => void): () => void
  onFileDrop(callback: (files: string[]) => void | Promise<void>): () => void
  getCurrentPluginMeta(): PluginEnterMeta | null
  enableFileDrop(options?: AnyRecord): void
  disableFileDrop(): void
  createContextMenu(options?: AnyRecord): ContextMenu
  ContextMenu: new () => ContextMenu
}

export interface ContextMenu { setItems(items: unknown[]): void; show(event: Event): void; hide(): void; beforeShow(callback: () => void): void; destroy(): void }
export interface PluginEnterMeta extends AnyRecord { code?: string; type?: string; payload?: unknown }

export interface PluginFeature {
  code: string
  explain: string
  icon?: string
  cmds?: Array<string | AnyRecord>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  category?: string[]
  author: string
  entry: string
  keyword: string
  keywords?: string[]
  icon: string
  window: PluginWindowConfig
  dllloader?: string
  requireAdmin?: boolean
  commonLibs?: string[]
  features?: PluginFeature[]
  targets?: AnyRecord[]
  nativeComponents?: AnyRecord[]
}

export interface PluginWindowConfig {
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  resizable: boolean
  controls?: { minimize: boolean; maximize: boolean }
  singleInstance: boolean
}

export interface UtoolsAPI {
  onPluginEnter(callback: (action: { code: string; type: string; payload: any; option?: any }) => void): void
  onPluginOut(callback: (processExit: boolean) => void): void
  onPluginDetach?(callback: () => void): void
  db: {
    put(doc: AnyRecord & { _id: string }): { id: string; ok: boolean; rev?: string }
    get(id: string): any
    remove(docOrId: string | AnyRecord): { id: string; ok: boolean }
    bulkDocs(docs: Array<AnyRecord & { _id: string }>): Array<{ id: string; ok: boolean }>
    allDocs(keyOrPrefix?: string): any[]
    promises?: {
      get(id: string): Promise<any>
      put(doc: AnyRecord & { _id: string }): Promise<{ id: string; ok: boolean; rev?: string }>
      remove(docOrId: string | AnyRecord): Promise<{ id: string; ok: boolean }>
      allDocs(keyOrPrefix?: string): Promise<any[]>
    }
  }
  dbStorage?: {
    setItem(key: string, value: any): void
    getItem(key: string): any
    removeItem(key: string): void
  }
  copyText(text: string): boolean
  copyImage(img: string): boolean
  showNotification(body: string, clickFeatureCode?: string): void
  showOpenDialog(options: AnyRecord): string[] | undefined
  showSaveDialog(options: AnyRecord): string | undefined
  getPath(name: string): string
  isMacOS(): boolean
  isWindows(): boolean
  isLinux(): boolean
  getAppVersion(): string
  setExpendHeight(height: number): boolean
  setSubInput(onChange: (action: { text: string }) => void, placeholder?: string, isFocus?: boolean): boolean
  removeSubInput(): boolean
  setSubInputValue(value: string): boolean
  [key: string]: unknown
}

declare global {
  interface Window {
    ztools: ZToolsAPI
    ztoolsPlugin: ZToolsPluginSDK
    utools?: UtoolsAPI
    __ztools_is_dark_mode?: boolean
  }
  const ztools: ZToolsAPI
  const ztoolsPlugin: ZToolsPluginSDK
  const utools: UtoolsAPI | undefined
}
