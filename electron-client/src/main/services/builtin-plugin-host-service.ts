import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { ProcessService } from './process-service.js'
import type { ShellService } from './shell-service.js'
import { MediaOcrHostPluginHandler } from './host-plugins/media-ocr-host.js'
import { NetworkHostPluginHandler } from './host-plugins/network-host.js'
import type {
  HostClipboardPort,
  HostPathAuthorityPort,
  HostPluginContext,
  HostWindowControlPort
} from './host-plugins/shared-utils.js'
import { StorageHostPluginHandler } from './host-plugins/storage-host.js'
import { SystemRegistryHostPluginHandler } from './host-plugins/system-registry-host.js'

export interface BuiltinPluginHostServiceOptions {
  clipboard?: HostClipboardPort | null | undefined
  processService?: ProcessService | null | undefined
  shellService?: ShellService | null | undefined
  windowControl?: HostWindowControlPort | null | undefined
  pathAuthority?: HostPathAuthorityPort | null | undefined
  platform?: NodeJS.Platform | undefined
}

export const SUPPORTED_PLUGIN_ALIASES: Record<string, string> = {
  'lan-share': 'LanSharePlugin',
  lanshareplugin: 'LanSharePlugin',
  'network-adapter': 'NetworkAdapterPlugin',
  networkadapterplugin: 'NetworkAdapterPlugin',
  'network-rescue': 'NetworkRescuePlugin',
  networkrescueplugin: 'NetworkRescuePlugin',
  mover: 'MoverPlugin',
  moverplugin: 'MoverPlugin',
  'data-recovery': 'DataRecoveryPlugin',
  datarecoveryplugin: 'DataRecoveryPlugin',
  shredder: 'ShredderPlugin',
  shredderplugin: 'ShredderPlugin',
  'system-backup': 'SystemBackupPlugin',
  systembackupplugin: 'SystemBackupPlugin',
  'sqlite-plugin': 'SqlitePlugin',
  sqliteplugin: 'SqlitePlugin',
  'file-compare': 'FileComparePlugin',
  filecompareplugin: 'FileComparePlugin',
  ocr: 'OcrPlugin',
  ocrplugin: 'OcrPlugin',
  'screen-color-picker': 'ColorPickerPlugin',
  colorpickerplugin: 'ColorPickerPlugin',
  record: 'RecordPlugin',
  recordplugin: 'RecordPlugin',
  'context-menu': 'ContextMenuPlugin',
  contextmenuplugin: 'ContextMenuPlugin',
  'wechat-multi': 'WeChatMultiPlugin',
  wechatmultiplugin: 'WeChatMultiPlugin',
  'flow-guard': 'FlowGuardPlugin',
  flowguardplugin: 'FlowGuardPlugin',
  boost: 'BoostPlugin',
  boostplugin: 'BoostPlugin',
  'ai-image': 'AiImagePlugin',
  aiimageplugin: 'AiImagePlugin',
  'batch-video': 'BatchVideoPlugin',
  batchvideoplugin: 'BatchVideoPlugin',
  'batch-audio': 'BatchAudioPlugin',
  batchaudioplugin: 'BatchAudioPlugin',
  'ai-video': 'AiVideoPlugin',
  aivideoplugin: 'AiVideoPlugin',
  pdf: 'PdfPlugin',
  pdfplugin: 'PdfPlugin',
  screenshots: 'ScreenshotsPlugin',
  screenshot: 'ScreenshotsPlugin',
  screenshotsplugin: 'ScreenshotsPlugin',
  cleaner: 'CleanerPlugin',
  cleanerplugin: 'CleanerPlugin',
  'disk-analyzer': 'AnalyzerPlugin',
  analyzerplugin: 'AnalyzerPlugin',
  diskanalyzerplugin: 'AnalyzerPlugin',
  'wechat-cleaner': 'WechatCleanerPlugin',
  wechatcleanerplugin: 'WechatCleanerPlugin',
  'qq-cleaner': 'QQCleanerPlugin',
  qqcleanerplugin: 'QQCleanerPlugin',
  'batch-rename': 'BatchRenamePlugin',
  batchrenameplugin: 'BatchRenamePlugin',
  'software-manager': 'SoftwareManagerPlugin',
  softwaremanagerplugin: 'SoftwareManagerPlugin',
  'hardware-info': 'HardwareInfoPlugin',
  hardwareinfoplugin: 'HardwareInfoPlugin',
  system: 'SystemActionsPlugin',
  'system-tools': 'SystemActionsPlugin',
  systemactionsplugin: 'SystemActionsPlugin',
  'multi-download': 'MultiDownloadPlugin',
  multidownloadplugin: 'MultiDownloadPlugin',
  'video-downloader': 'VideoDownloaderPlugin',
  videodownloaderplugin: 'VideoDownloaderPlugin',
  'window-management': 'WindowManagementPlugin',
  'window-manager': 'WindowManagementPlugin',
  windowmanagementplugin: 'WindowManagementPlugin',
  'clipboard-history': 'ClipboardHistoryPlugin',
  'clipboard-manager': 'ClipboardHistoryPlugin',
  clipboardhistoryplugin: 'ClipboardHistoryPlugin'
}

export function normalizePluginName(pluginName: string): string | null {
  const key = (pluginName ?? '').trim().toLowerCase()
  return SUPPORTED_PLUGIN_ALIASES[key] ?? null
}

export function isSupportedPlugin(pluginName: string): boolean {
  return normalizePluginName(pluginName) !== null
}

export class BuiltinPluginHostService {
  readonly #pathAuthority: HostPathAuthorityPort | null
  readonly #network: NetworkHostPluginHandler
  readonly #storage: StorageHostPluginHandler
  readonly #mediaOcr: MediaOcrHostPluginHandler
  readonly #systemRegistry: SystemRegistryHostPluginHandler

  constructor(options: BuiltinPluginHostServiceOptions = {}) {
    this.#pathAuthority = options.pathAuthority ?? null
    const ctx: HostPluginContext = {
      clipboard: options.clipboard ?? null,
      processService: options.processService ?? null,
      windowControl: options.windowControl ?? null,
      authorizeExistingPath: (rawPath, caller, access) =>
        this.#authorizeExistingPath(rawPath, caller, access),
      authorizeOutputPath: (rawPath, caller) => this.#authorizeOutputPath(rawPath, caller)
    }
    this.#network = new NetworkHostPluginHandler(ctx)
    this.#storage = new StorageHostPluginHandler(ctx)
    this.#mediaOcr = new MediaOcrHostPluginHandler(ctx)
    this.#systemRegistry = new SystemRegistryHostPluginHandler(ctx)
  }

  async #authorizeExistingPath(
    rawPath: string,
    caller: CallerIdentity | undefined,
    access: 'read' | 'write' = 'read'
  ): Promise<string> {
    const trimmed = (rawPath ?? '').trim()
    if (!trimmed) {
      throw new Error('文件路径不能为空')
    }
    if (this.#pathAuthority && caller) {
      return this.#pathAuthority.resolveAuthorizedPath(trimmed, caller, access, false)
    }
    return path.resolve(trimmed)
  }

  async #authorizeOutputPath(
    rawPath: string,
    caller: CallerIdentity | undefined
  ): Promise<string> {
    const trimmed = (rawPath ?? '').trim()
    if (!trimmed) {
      throw new Error('输出路径不能为空')
    }
    if (this.#pathAuthority && caller) {
      return this.#pathAuthority.resolveAuthorizedPath(trimmed, caller, 'write', true)
    }
    return path.resolve(trimmed)
  }

  supportsPlugin(pluginName: string): boolean {
    return isSupportedPlugin(pluginName)
  }

  isSupportedPlugin(pluginName: string): boolean {
    return isSupportedPlugin(pluginName)
  }

  normalizePluginId(pluginName: string): string | null {
    return normalizePluginName(pluginName)
  }

  normalizePluginName(pluginName: string): string | null {
    return normalizePluginName(pluginName)
  }

  async stop(): Promise<void> {
    await Promise.all([this.#network.stop(), this.#mediaOcr.stop()])
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  async handlePluginCall(
    pluginName: string,
    funcName: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const canonical = normalizePluginName(pluginName)
    if (!canonical) {
      throw new Error(`Unsupported builtin plugin: ${pluginName}`)
    }
    const fn = (funcName ?? '').trim()

    switch (canonical) {
      case 'LanSharePlugin':
        return this.#network.handleLanShare(fn, params, caller)
      case 'NetworkAdapterPlugin':
        return this.#network.handleNetworkAdapter(fn, params, signal)
      case 'NetworkRescuePlugin':
        return this.#network.handleNetworkRescue(fn, params, signal)
      case 'MultiDownloadPlugin':
        return this.#network.handleMultiDownload(fn, params, caller, signal)
      case 'VideoDownloaderPlugin':
        return this.#network.handleVideoDownloader(fn, params, caller, signal)
      case 'MoverPlugin':
        return this.#storage.handleMover(fn, params, caller, signal)
      case 'DataRecoveryPlugin':
        return this.#storage.handleDataRecovery(fn, params, caller)
      case 'ShredderPlugin':
        return this.#storage.handleShredder(fn, params, caller)
      case 'SystemBackupPlugin':
        return this.#storage.handleSystemBackup(fn, params, caller)
      case 'SqlitePlugin':
        return this.#storage.handleSqlite(fn, params, caller)
      case 'FileComparePlugin':
        return this.#storage.handleFileCompare(fn, params, caller)
      case 'BatchRenamePlugin':
        return this.#storage.handleBatchRename(fn, params, caller)
      case 'CleanerPlugin':
      case 'AnalyzerPlugin':
      case 'WechatCleanerPlugin':
      case 'QQCleanerPlugin':
        return this.#storage.handleCleaner(canonical, fn, params, caller)
      case 'OcrPlugin':
        return this.#mediaOcr.handleOcr(fn, params, caller, signal)
      case 'ColorPickerPlugin':
        return this.#mediaOcr.handleColorPicker(fn, params, signal)
      case 'RecordPlugin':
        return this.#mediaOcr.handleRecord(fn, params, caller, signal)
      case 'ScreenshotsPlugin':
        return this.#mediaOcr.handleScreenshots(fn, params, caller, signal)
      case 'AiImagePlugin':
        return this.#mediaOcr.handleAiImage(fn, params, caller)
      case 'BatchVideoPlugin':
      case 'BatchAudioPlugin':
      case 'AiVideoPlugin':
        return this.#mediaOcr.handleBatchMedia(canonical, fn, params, caller, signal)
      case 'PdfPlugin':
        return this.#mediaOcr.handlePdf(fn, params, caller)
      case 'ContextMenuPlugin':
        return this.#systemRegistry.handleContextMenu(fn, params, caller, signal)
      case 'WeChatMultiPlugin':
        return this.#systemRegistry.handleWeChatMulti(fn, params, caller, signal)
      case 'FlowGuardPlugin':
        return this.#systemRegistry.handleFlowGuard(fn, params, signal)
      case 'BoostPlugin':
        return this.#systemRegistry.handleBoost(fn, params, signal)
      case 'SoftwareManagerPlugin':
        return this.#systemRegistry.handleSoftwareManager(fn, params, caller, signal)
      case 'HardwareInfoPlugin':
        return this.#systemRegistry.handleHardwareInfo(fn, signal)
      case 'SystemActionsPlugin':
        return this.#systemRegistry.handleSystemActions(fn, params, signal)
      case 'WindowManagementPlugin':
        return this.#systemRegistry.handleWindowManagement(fn, params)
      case 'ClipboardHistoryPlugin':
        return this.#systemRegistry.handleClipboardHistory(fn, params)
      default:
        return { ok: false, success: false, error: `Unknown plugin: ${canonical}` }
    }
  }
}
