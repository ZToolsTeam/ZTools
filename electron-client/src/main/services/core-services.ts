import fs from 'node:fs/promises'
import path from 'node:path'
import { AnalyticsService } from './analytics-service.js'
import { ConfigService } from './config-service.js'
import { JsonFileStore } from './json-file-store.js'
import { UpdateService } from './update-service.js'
import { UserAccountService } from './user-account-service.js'
import { SidecarManager } from './sidecar-manager.js'
import type { WebResourceService } from './web-resource-service.js'
import { runtimePathsForBusinessDataRoot, type RuntimePaths } from '../runtime/runtime-paths.js'
import type { OrdinaryNativeRuntimePort } from '../native-host/dll-client-port.js'
import type { ServiceClient } from '../service/service-client.js'
import type { NativeInputAdapter } from '../super-panel/input-service.js'

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
  user: UserAccountService
  analytics: AnalyticsService
  update: UpdateService
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

export function createCoreServices(
  runtime: RuntimePaths | string,
  appVersion: string,
  webVersion = '0',
  nativeHost: OrdinaryNativeRuntimePort | null = null,
  serviceClient: ServiceClient | null = null,
  nativeInput: NativeInputAdapter | null = null,
  webResources: WebResourceService | null = null
): CoreServices {
  const runtimePaths = typeof runtime === 'string'
    ? runtimePathsForBusinessDataRoot(runtime)
    : runtime
  const dataRoot = runtimePaths.businessDataRoot
  const store = new JsonFileStore(dataRoot, ConfigService.allowedStoreFiles)
  const user = new UserAccountService(store)
  const analytics = new AnalyticsService({
    appVersion,
    webVersion,
    store,
    dataRoot,
    getUserId: async () => {
      const info = await user.getInfo().catch(() => null)
      if (info && info.logged_in && info.user && typeof (info.user as Record<string, unknown>).user_id === 'string') {
        return (info.user as Record<string, unknown>).user_id as string
      }
      return null
    }
  })
  const update = new UpdateService({
    runtimePaths,
    appVersion,
    webVersion,
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
    dataRoot
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
    user,
    analytics,
    update,
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
    sidecars,
    stop: async () => {
      notes.stop()
      await geekTools.stop()
      await webBrowser.stop()
      await navigation.stop()
      await calendar.stop()
      await dictation.stop()
      await screenAwareness.stop()
      await focus.stop()
      await mcp.stop()
      await developer.stop()
      await scriptCommands.stop()
      clipboardHistory.stop()
      snippets.stop()
      analytics.stop()
      await update.stop()
      await sidecars.stop()
      await frecency.flush()
      hud.stop()
      serviceClient?.stop()
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
    }
  }
}
