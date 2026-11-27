import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigService } from './config-service.js'
import type { CredentialProtection } from './credential-protection.js'
import { JsonFileStore } from './json-file-store.js'
import { UpdateService, type MacUpdateInstaller } from './update-service.js'
import { SidecarManager } from './sidecar-manager.js'
import type { WebResourceService } from './web-resource-service.js'
import type { LibraryMetadataSource } from './library-integrity-pins.js'
import { mainEdition } from '../edition.js'
import type { AccountService, HostAnalytics, MainEdition } from '../edition-types.js'
import { runtimePathsForBusinessDataRoot, type RuntimePaths } from '../runtime/runtime-paths.js'
import type { OrdinaryNativeRuntimePort } from '../native-host/dll-client-port.js'
import type { ServiceClient } from '../service/service-client.js'
import type { NativeInputAdapter } from '../platform/native-runtime.js'
import { resolveNormalizedRuntimePlatformAndArch } from '../platform/runtime-architecture.js'

import { FrecencyRankingService } from './frecency-ranking-service.js'
import { HudService } from './hud-service.js'
import { ClipboardHistoryService } from './clipboard-history-service.js'
import { SnippetsService } from './snippets-service.js'
import { FileSearchService } from './file-search-service.js'
import { WindowManagementService } from './window-management-service.js'
import { ScriptCommandsService } from './script-commands-service.js'
import { DeveloperService } from './developer-service.js'
import { McpService } from './mcp-service.js'
import { FocusService } from './focus-service.js'
import { ScreenAwarenessService } from './screen-awareness-service.js'
import { DictationService } from './dictation-service.js'
import { CalendarService } from './calendar-service.js'
import { NavigationService } from './navigation-service.js'
import { WebBrowserService } from './web-browser-service.js'
import { GeekToolsService } from './geek-tools-service.js'
import { EmojiService } from './emoji-service.js'
import { TranslatorService } from './translator-service.js'
import { NotesService } from './notes-service.js'
import { WindowsRunService } from './windows-run-service.js'
import { TaskbarService } from './taskbar-service.js'
import { ScreenshotsService } from './screenshots-service.js'
import { ApplicationsService } from './applications-service.js'
import { DictionaryService } from './dictionary-service.js'

export interface CoreServices {
  runtimePaths: RuntimePaths
  dataRoot: string
  appVersion: string
  webVersion: string
  config: ConfigService
  /** 当前主进程版本（开源版 / 商业版） */
  edition: MainEdition['id']
  user: AccountService
  analytics: HostAnalytics
  update: UpdateService
  /** 公共库元数据来源（插件安装依赖库时使用） */
  libraryMetadata: LibraryMetadataSource
  frecency: FrecencyRankingService
  hud: HudService
  clipboardHistory: ClipboardHistoryService
  snippets: SnippetsService
  fileSearch: FileSearchService
  windowManagement: WindowManagementService
  scriptCommands: ScriptCommandsService
  developer: DeveloperService
  mcp: McpService
  focus: FocusService
  screenAwareness: ScreenAwarenessService
  dictation: DictationService
  calendar: CalendarService
  navigation: NavigationService
  webBrowser: WebBrowserService
  geekTools: GeekToolsService
  emoji: EmojiService
  translator: TranslatorService
  notes: NotesService
  windowsRun: WindowsRunService
  taskbar: TaskbarService
  screenshots: ScreenshotsService
  applications: ApplicationsService
  dictionary: DictionaryService
  webResources: WebResourceService | null
  nativeHost: OrdinaryNativeRuntimePort | null
  serviceClient: ServiceClient | null
  nativeInput: NativeInputAdapter | null
  /** 当前原生输入通道是否已就绪（供 system-service 透出双击与鼠标触发能力） */
  readonly nativeInputAvailable?: boolean
  sidecars: SidecarManager
  stop(): Promise<void>
}

export async function readWebVersion(webRoot: string): Promise<string> {
  try {
    const source = await fs.readFile(path.join(webRoot, 'version.json'), 'utf8')
    const value: unknown = JSON.parse(source.replace(/^\uFEFF/, ''))
    if (
      typeof value === 'object' &&
      value !== null &&
      'version' in value &&
      typeof value.version === 'string' &&
      /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version)
    ) {
      return value.version
    }
  } catch {
    // Missing or malformed renderer metadata is represented by the legacy fallback.
  }
  return '0'
}

export interface CoreServicesRuntimeOptions {
  readonly runningUnderARM64Translation?: boolean | null
  readonly platform?: NodeJS.Platform
  readonly processArch?: string
  readonly processorArchitecture?: string | undefined
  readonly processorArchitew6432?: string | undefined
  readonly credentialProtection?: CredentialProtection
  readonly isPackaged?: boolean
}

export function createCoreServices(
  runtime: RuntimePaths | string,
  appVersion: string,
  webVersion = '0',
  nativeHost: OrdinaryNativeRuntimePort | null = null,
  serviceClient: ServiceClient | null = null,
  nativeInput: NativeInputAdapter | null = null,
  webResources: WebResourceService | null = null,
  edition: MainEdition = mainEdition(),
  macUpdater?: MacUpdateInstaller,
  runtimeOptions?: CoreServicesRuntimeOptions
): CoreServices {
  const runtimePaths = typeof runtime === 'string'
    ? runtimePathsForBusinessDataRoot(runtime)
    : runtime
  const dataRoot = runtimePaths.businessDataRoot
  // 版本相关的存储文件（例如账号文件）只在需要它的版本里放行
  const store = new JsonFileStore(dataRoot, new Set([...ConfigService.allowedStoreFiles, ...edition.storeFiles]))
  const { user, analytics, updateSource, libraryMetadata } = edition.createServices({
    appVersion,
    webVersion,
    dataRoot,
    store,
    ...(runtimeOptions?.credentialProtection
      ? { credentialProtection: runtimeOptions.credentialProtection }
      : {}),
    ...(runtimeOptions?.runningUnderARM64Translation !== undefined
      ? { runningUnderARM64Translation: runtimeOptions.runningUnderARM64Translation }
      : {})
  })
  const effectivePlatform = runtimeOptions?.platform ?? process.platform
  const { arch: runtimeArch } = resolveNormalizedRuntimePlatformAndArch({
    platform: effectivePlatform,
    processArch: runtimeOptions?.processArch ?? process.arch,
    runningUnderARM64Translation: runtimeOptions?.runningUnderARM64Translation ?? null,
    processorArchitecture: runtimeOptions && 'processorArchitecture' in runtimeOptions
      ? runtimeOptions.processorArchitecture
      : process.env.PROCESSOR_ARCHITECTURE,
    processorArchitew6432: runtimeOptions && 'processorArchitew6432' in runtimeOptions
      ? runtimeOptions.processorArchitew6432
      : process.env.PROCESSOR_ARCHITEW6432
  })
  const update = new UpdateService({
    platform: effectivePlatform,
    arch: runtimeArch,
    runtimePaths,
    appVersion,
    webVersion,
    updateSource,
    ...(runtimeOptions?.isPackaged !== undefined ? { isPackaged: runtimeOptions.isPackaged } : {}),
    ...(macUpdater ? { macUpdater } : {}),
    ...(webResources ? { webResources } : {})
  })
  const sidecars = new SidecarManager()
  const frecency = new FrecencyRankingService({
    storageFilePath: path.join(dataRoot, 'frecency_ranking.json')
  })
  const hud = new HudService()
  const clipboardHistory = new ClipboardHistoryService({
    dbPath: path.join(dataRoot, 'clipboard_history.sqlite')
  })
  const snippets = new SnippetsService({
    dbPath: path.join(dataRoot, 'snippets.sqlite'),
    onSnippetsChanged: (items) => {
      void sidecars.setSnippets(items)
    }
  })
  const fileSearch = new FileSearchService({
    sidecarManager: sidecars
  })
  const windowManagement = new WindowManagementService({
    sidecarManager: sidecars,
    hudService: hud
  })
  const scriptCommands = new ScriptCommandsService({
    dataRoot,
    hudService: hud
  })
  const developer = new DeveloperService({
    dataRoot
  })
  const mcp = new McpService({
    dataRoot,
    ...(runtimeOptions?.credentialProtection
      ? { credentialProtection: runtimeOptions.credentialProtection }
      : {})
  })
  const focus = new FocusService({
    dbPath: path.join(dataRoot, 'focus.sqlite'),
    hudService: hud
  })
  const screenAwareness = new ScreenAwarenessService({
    sidecarManager: sidecars
  })
  const dictation = new DictationService({
    dbPath: path.join(dataRoot, 'dictation.sqlite'),
    sidecarManager: sidecars
  })
  const calendar = new CalendarService({
    dbPath: path.join(dataRoot, 'calendar.sqlite')
  })
  const navigation = new NavigationService({
    sidecarManager: sidecars
  })
  const webBrowser = new WebBrowserService({
    dbPath: path.join(dataRoot, 'contacts.sqlite'),
    sidecarManager: sidecars
  })
  const geekTools = new GeekToolsService({
    dbPath: path.join(dataRoot, 'geek_tools.sqlite'),
    clipboardHistory
  })
  const emoji = new EmojiService()
  const translator = new TranslatorService()
  const notes = new NotesService({
    dbPath: path.join(dataRoot, 'notes.sqlite')
  })
  const windowsRun = new WindowsRunService()
  const taskbar = new TaskbarService({ hudService: hud })
  const screenshots = new ScreenshotsService()
  const applications = new ApplicationsService()
  const dictionary = new DictionaryService()
  return {
    runtimePaths,
    dataRoot,
    appVersion,
    webVersion,
    config: new ConfigService(store),
    edition: edition.id,
    user,
    analytics,
    update,
    libraryMetadata,
    frecency,
    hud,
    clipboardHistory,
    snippets,
    fileSearch,
    windowManagement,
    scriptCommands,
    developer,
    mcp,
    focus,
    screenAwareness,
    dictation,
    calendar,
    navigation,
    webBrowser,
    geekTools,
    emoji,
    translator,
    notes,
    windowsRun,
    taskbar,
    screenshots,
    applications,
    dictionary,
    webResources,
    nativeHost,
    serviceClient,
    nativeInput,
    get nativeInputAvailable(): boolean {
      return nativeInput !== null && nativeInput.state === 'ready'
    },
    sidecars,
    stop: async () => {
      // 逐项隔离停机异常，防止前序业务服务报错导致 sidecars / serviceClient / nativeHost 漏停
      const stopStep = async (name: string, action: () => unknown): Promise<void> => {
        try {
          await action()
        } catch (error) {
          console.warn(`[core-services] 停机步骤 "${name}" 失败:`, error)
        }
      }

      await stopStep('notes', () => notes.stop())
      await stopStep('geekTools', () => geekTools.stop())
      await stopStep('webBrowser', () => webBrowser.stop())
      await stopStep('navigation', () => navigation.stop())
      await stopStep('calendar', () => calendar.stop())
      await stopStep('dictation', () => dictation.stop())
      await stopStep('screenAwareness', () => screenAwareness.stop())
      await stopStep('focus', () => focus.stop())
      await stopStep('mcp', () => mcp.stop())
      await stopStep('developer', () => developer.stop())
      await stopStep('scriptCommands', () => scriptCommands.stop())
      await stopStep('clipboardHistory', () => clipboardHistory.stop())
      await stopStep('snippets', () => snippets.stop())
      await stopStep('analytics', () => analytics.stop())
      await stopStep('update', () => update.stop())
      await stopStep('sidecars', async () => {
        const sidecarStopReport = await sidecars.stop()
        const sidecarStopSerialized = JSON.stringify(sidecarStopReport)
        if (sidecarStopReport.uiaccess.error || sidecarStopReport.indexer.error) {
          console.warn(`原生侧车停机存在异常：${sidecarStopSerialized}`)
        } else {
          console.info(`原生侧车停机已完成：${sidecarStopSerialized}`)
        }
      })
      await stopStep('frecency', () => frecency.flush())
      await stopStep('hud', () => hud.stop())
      await stopStep('serviceClient', () => serviceClient?.stop())
      await stopStep('nativeHost', async () => {
        const nativeHostShutdown = await nativeHost?.stop()
        if (nativeHostShutdown) {
          const serialized = JSON.stringify(nativeHostShutdown)
          if (!nativeHostShutdown.completed || nativeHostShutdown.timedOut ||
              nativeHostShutdown.forced || nativeHostShutdown.cancelFailed > 0 ||
              nativeHostShutdown.stopFailed > 0 || nativeHostShutdown.internalFailures > 0) {
            console.warn(`普通 Native Host 停机未完整确认： ${serialized}`)
          } else {
            console.info(`普通 Native Host 停机已完成： ${serialized}`)
          }
        }
      })
    }
  }
}
