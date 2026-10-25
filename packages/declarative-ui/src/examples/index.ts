// 3. GitHub 仪表盘
export { default as GithubDashboardCommand, GithubDetailView } from "./github/index.js";
export * from "./github/types.js";
export * from "./github/data.js";

// 4. Google 多语言即时翻译
export { default as GoogleTranslateCommand, TranslateDetailView } from "./google-translate/index.js";
export * from "./google-translate/languages.js";
export * from "./google-translate/translate.js";

// 5. 屏幕取色（Windows），颜色格式转换由内置插件 color-picker 提供
export { default as ColorPickerCommand, ColorDetailView } from "./screen-color-picker/index.js";
export * from "./screen-color-picker/converter.js";

// 6. Obsidian 知识库管理
export { default as ObsidianCommand, ObsidianNoteDetailView, ObsidianQuickNoteForm } from "./obsidian/index.js";
export * from "./obsidian/types.js";
export * from "./obsidian/vault.js";

// 7. 网络测速与连通性诊断 (Speedtest)
export { default as SpeedtestCommand, SpeedtestDetailView } from "./speedtest/index.js";
export * from "./speedtest/types.js";
export * from "./speedtest/speedtest-service.js";

// 8. Windows 包管理器前端 (Winget)
export { default as WingetCommand, WingetDetailView } from "./winget/index.js";
export * from "./winget/packages.js";

// 9. 全球多币种实时汇率换算 (Currency Exchange)
export { default as CurrencyExchangeCommand, CurrencyDetailView } from "./currency-exchange/index.js";
export * from "./currency-exchange/rates.js";

// 10. 进程管理急救箱 (Kill Process)
export { default as KillProcessCommand, ProcessDetailView } from "./kill-process/index.js";
export * from "./kill-process/process-manager.js";

// 11. Everything文件搜索 (自研零依赖引擎 + 标杆声明式 UI)
export { default as EverythingFileSearchCommand, FileDetailView, FileQuickLookDetailView } from "./everything-file-search/index.js";
export * from "./everything-file-search/types.js";
export * from "./everything-file-search/search-service.js";

// 12. 官方内置核心能力: 剪贴板历史 (Clipboard History)
export { default as ClipboardHistoryCommand, ClipboardDetailView } from "./clipboard-history/index.js";
export * from "./clipboard-history/types.js";
export * from "./clipboard-history/clipboard-storage.js";

// 13. 官方内置核心能力: Snippets 文本扩展 (Snippets & Text Expansion)
export {
  default as SnippetsCommand,
  SnippetEditForm,
  CreateSnippetForm,
  SnippetDetailView,
  SnippetArgumentFormView,
  filterSnippets,
  expandSnippetTemplate,
  SAMPLE_SNIPPETS
} from "./snippets/index.js";
export * from "./snippets/types.js";
export * from "./snippets/macro-engine.js";

// 14. 官方内置核心能力: Window Management 窗口管理器 (Win32 SetWindowPos 下沉)
export { default as WindowManagementCommand, WindowActionDetailView, WindowPreferencesForm } from "./window-management/index.js";
export * from "./window-management/types.js";
export * from "./window-management/window-actions.js";

// 16. 官方内置核心能力: Windows 原生运维动作 (System Actions)
export { default as SystemCommand } from "./system/index.js";
export * from "./system/system-actions.js";

// 17. 官方内置核心能力: 快捷直达链接 (Quicklinks)
export { default as QuicklinksCommand, CreateQuicklinkForm, EditQuicklinkForm, ImportQuicklinksForm } from "./quicklinks/index.js";
export * from "./quicklinks/types.js";
export * from "./quicklinks/quicklinks-storage.js";

// 18. 官方系统治理与偏好设置: Settings (Raycast Settings 9 大分类)
export { default as SettingsCommand, SettingsFormView } from "./settings/index.js";
export * from "./settings/types.js";
export * from "./settings/settings-storage.js";

// 19. 核心系统: Core (Release Notes, 更新检查, 版本公告)
export { default as RaycastCoreCommand } from "./core-account/index.js";
export * from "./core-account/types.js";
export * from "./core-account/core-service.js";

// 21. 极客数据大盘与自动化: Wrapped, Trial Nudges & Shortcuts (Windows & macOS 快捷指令)
export {
  default as RaycastWrappedCommand,
  TrialNudgesCommand,
  WindowsShortcutsCommand,
  AppleShortcutsCommand,
  RunShortcutWithInputForm
} from "./wrapped-nudges-shortcuts/index.js";
export * from "./wrapped-nudges-shortcuts/types.js";
export * from "./wrapped-nudges-shortcuts/engine.js";

// 22. 第二组高频应用: Emoji & Symbols (表情与特殊符号)
export { default as EmojiPickerCommand, EmojiDetailView } from "./emoji-picker/index.js";
export * from "./emoji-picker/types.js";
export * from "./emoji-picker/data.js";
export * from "./emoji-picker/search.js";
export * from "./emoji-picker/storage.js";

// 23. 第二组高频应用: Translator (多语言即时翻译)
export { default as TranslatorCommand } from "./translator/index.js";

// 25. 第二组高频应用: Windows Run (Windows 运行中枢)
export { default as WindowsRunCommand } from "./windows-run/index.js";
export * from "./windows-run/types.js";
export * from "./windows-run/run-service.js";

// 26. 第二组高频应用: Windows Taskbar (任务栏显隐控制)
export { default as WindowsTaskbarCommand } from "./windows-taskbar/index.js";
export * from "./windows-taskbar/types.js";
export * from "./windows-taskbar/taskbar-service.js";

// 27. 第二组高频应用: Screenshots (截图管理与回贴)
export { default as ScreenshotsCommand, ScreenshotDetailView } from "./screenshots/index.js";
export * from "./screenshots/types.js";
export * from "./screenshots/screenshots-service.js";

// 28. 第二组高频应用: Applications (已装应用管理与卸载)
export { default as ApplicationsCommand, AppDetailView } from "./applications/index.js";
export * from "./applications/types.js";
export * from "./applications/applications-service.js";

// 29. 第二组高频应用: Dictionary (英汉双解科技词典)
export { default as DictionaryCommand, WordDetailView } from "./dictionary/index.js";

// 30. 密码保险箱 (Password Vault - AES-256-GCM 本地离线加密)
export {
  default as PasswordVaultCommand,
  VaultEntryForm
} from "./password-vault/index.js";
export * from "./password-vault/types.js";
export * from "./password-vault/vault-crypto.js";

// 31. Wi-Fi 密码查看器 (WiFi Password Reveal - 双端明文提取与扫码连网)
export { default as WifiPasswordRevealCommand, WifiDetailView } from "./wifi-password-reveal/index.js";
export * from "./wifi-password-reveal/types.js";
export * from "./wifi-password-reveal/wifi-service.js";

// 32. 音频设备一键切换 (Audio Device - 输出/输入端点切换、调音与场景组合)
export {
  default as AudioDeviceCommand,
  AudioDeviceDetailView,
  AudioVolumeForm
} from "./audio-device/index.js";
export * from "./audio-device/types.js";
export * from "./audio-device/audio-service.js";

// 33. 键盘清洁防误触锁 (Clean Keyboard - 定时锁定状态机与误触拦截统计)
export {
  default as CleanKeyboardCommand,
  CleanKeyboardDetailView,
  CustomDurationForm
} from "./clean-keyboard/index.js";
export * from "./clean-keyboard/types.js";
export * from "./clean-keyboard/keyboard-lock-service.js";

// 34. 下载文件夹管家 (Downloads Manager - 最新文件秒拷、分类归档与过期清理)
export {
  default as DownloadsManagerCommand,
  DownloadFileDetailView
} from "./downloads-manager/index.js";
export * from "./downloads-manager/types.js";
export * from "./downloads-manager/downloads-service.js";

// 35. 系统进程与服务深度监控 (Process Monitor - 实时进程树、CPU/内存看板与系统核心防护)
export { default as ProcessMonitorCommand } from "./process-monitor/index.js";
export {
  type CapabilityActionItem,
  type NativeInvocationResult,
  type ProcessItem,
  type SystemInfoData,
  type ProcessServiceInfo,
  type ProcessDetailInfo,
  type ProcessSortKey,
  type ProcessTerminateMode,
  type ResourceFocusSummary,
  DLL_PLUGIN_NAME as PROCESS_MONITOR_DLL,
  FORBIDDEN_TARGET_PATTERN,
  FORBIDDEN_REASON,
  CRITICAL_PROCESS_NAMES,
  getMockProcesses,
  getMockSystemInfo,
  getMockProcessDetail,
  getMockServicesByPID,
  normalizeProcessItem,
  getResourceFocus,
  invokeNativeCapability as invokeProcessMonitorNative,
  fetchSystemInfo,
  fetchProcesses,
  fetchProcessDetail,
  fetchServicesByPID,
  terminateProcess as terminateProcessMonitor,
  openFileLocation,
  filterProcesses,
  formatBytes as formatProcessBytes
} from "./process-monitor/logic.js";

// 36. 软件管理与卸载中心 (Software Manager - 已装软件快照、体积排行、静默卸载与底层依赖防护)
export { default as SoftwareManagerCommand } from "./software-manager/index.js";
export {
  type SoftwareItem,
  type SoftwareSummaryData,
  DLL_PLUGIN_NAME as SOFTWARE_MANAGER_DLL,
  PROTECTED_SYSTEM_SOFTWARE_PATTERN,
  FORBIDDEN_SOFTWARE_PATTERN as FORBIDDEN_SOFTWARE_UNINSTALL_PATTERN,
  FORBIDDEN_UNINSTALL_REASON,
  fetchSoftwareList,
  fetchSoftwareSummary,
  uninstallSoftware,
  openSoftwareLocation,
  launchSoftware,
  filterSoftwareList,
  formatBytes as formatSoftwareBytes
} from "./software-manager/logic.js";

// 37. 系统垃圾深度清理 (Cleaner - 规则扫描、临时文件/补丁/浏览器缓存全盘清理与安全防护)
export { default as CleanerCommand } from "./cleaner/index.js";
export {
  type CleanGroupItem,
  type CleanSummaryData,
  type CleanExecutionResult,
  type CleanSampleFile,
  DLL_PLUGIN_NAME as CLEANER_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_CLEANER_TARGET_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_CLEANER_REASON,
  fetchCleanRulesAndScan,
  executeCleanGroups,
  emptyRecycleBin,
  filterCleanGroups,
  formatBytes as formatCleanerBytes
} from "./cleaner/logic.js";

// 真实宿主 IPC 桥接工具 (Real Host IPC Bridge)
export {
  isRealElectronHost,
  callHostTransport,
  probeRealDiskDrives,
  getRealSystemPath,
  searchRealIndexedFiles,
  scanRealDirectoryTree,
  listRealDirectoryContents,
  getRealFileSize,
  showRealItemInFolder,
  openRealPath,
  trashRealItem,
  joinWinPath,
  getRealEnvPaths,
  resolveRealSpecialPaths,
  readRealDirectory,
  moveRealFilesToTrash,
  invokeHostCapability,
  invokePluginService,
  writeRealClipboardText,
  showRealToast,
  type RealDiskDriveInfo,
  type RealDriveUsageInfo,
  type RealIndexedFileEntry,
  type RealDirectorySubdirSummary,
  type RealDirectoryScanResult
} from "./shared/native-ipc.js";

// 38. 磁盘文件分析 (Disk Analyzer - 真实挂载分区容量透视、热点目录大文件扫描与类型分布)
export { default as DiskAnalyzerCommand } from "./disk-analyzer/index.js";
export {
  type DiskDriveItem,
  type DiskFileEntry,
  type DiskExtStat,
  type DiskAnalysisSnapshot,
  DLL_PLUGIN_NAME as DISK_ANALYZER_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_DISK_ANALYZER_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_DISK_ANALYZER_REASON,
  fetchDiskAnalysisSnapshot,
  deleteDiskFileItem,
  openDiskItemLocation,
  classifyFileExtension,
  computeExtStats,
  formatBytes as formatDiskAnalyzerBytes
} from "./disk-analyzer/logic.js";

// 39. 微信深度清理 (WeChat Cleaner - 真实探测 WeChat Files / xwechat 缓存，严密保护 MSG.db 聊天库)
export { default as WechatCleanerCommand } from "./wechat-cleaner/index.js";
export {
  type WechatCleanCategoryItem,
  type WechatScanSnapshot,
  DLL_PLUGIN_NAME as WECHAT_CLEANER_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_WECHAT_CLEANER_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_WECHAT_CLEANER_REASON,
  fetchWechatCleanSnapshot,
  executeWechatCleanup,
  openWechatDirectory,
  formatBytes as formatWechatCleanerBytes
} from "./wechat-cleaner/logic.js";

// 40. QQ 深度清理 (QQ Cleaner - 真实探测 Tencent Files / NTQQ 缓存，严密保护 Msg3.0.db / nt_msg.db)
export { default as QQCleanerCommand } from "./qq-cleaner/index.js";
export {
  type QQCleanCategoryItem,
  type QQScanSnapshot,
  DLL_PLUGIN_NAME as QQ_CLEANER_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_QQ_CLEANER_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_QQ_CLEANER_REASON,
  fetchQQCleanSnapshot,
  executeQQCleanup,
  openQQDirectory,
  formatBytes as formatQQCleanerBytes
} from "./qq-cleaner/logic.js";

// 41. 流量与网络连接监控 (Flow Guard - 真实聚合 process_list_ports 与 process_list 审计远端连接与监听端口)
export { default as FlowGuardCommand } from "./flow-guard/index.js";
export {
  type PortEndpointItem,
  type ProcessNetworkGroup,
  type FlowGuardSnapshot,
  DLL_PLUGIN_NAME as FLOW_GUARD_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_FLOW_GUARD_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_FLOW_GUARD_REASON,
  fetchFlowGuardSnapshot,
  terminateNetworkProcess,
  openNetworkProcessLocation,
  formatBytes as formatFlowGuardBytes
} from "./flow-guard/logic.js";

// 42. 硬件信息与传感器监控 (Hardware Info - 真实采集 CPU、内存、多盘分区、多显示器与电源遥测)
export { default as HardwareInfoCommand } from "./hardware-info/index.js";
export {
  type HardwareSpecEntry,
  type HardwareTelemetrySnapshot,
  DLL_PLUGIN_NAME as HARDWARE_INFO_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_HARDWARE_INFO_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_HARDWARE_INFO_REASON,
  fetchHardwareTelemetrySnapshot,
  formatBytes as formatHardwareInfoBytes
} from "./hardware-info/logic.js";

// 43. 系统极速加速 (Boost - 真实物理内存工作集监控、高内存进程释放与 %TEMP% 缓存一键回收)
export { default as BoostCommand } from "./boost/index.js";
export {
  type BoostCandidateItem,
  type BoostSnapshot,
  DLL_PLUGIN_NAME as BOOST_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_BOOST_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_BOOST_REASON,
  fetchBoostSnapshot,
  terminateBoostProcess,
  executeQuickBoostCleanup,
  openBoostItemLocation,
  formatBytes as formatBoostBytes
} from "./boost/logic.js";

// 44. 批量文件重命名 (Batch Rename - 真实目录文件加载、新旧命名实时 Diff 预览与 filesystem_move_file 执行)
export { default as BatchRenameCommand } from "./batch-rename/index.js";
export {
  type RenameRule,
  type RenameResultItem,
  type RealFileEntry as BatchRenameRealFileEntry,
  DLL_PLUGIN_NAME as BATCH_RENAME_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_BATCH_RENAME_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_BATCH_RENAME_REASON,
  splitFileName,
  applyRenameRule,
  batchApplyRename,
  fetchRealBatchRenameFiles,
  executeRealFileRename,
  openRenameFileLocation,
  formatBytes as formatBatchRenameBytes
} from "./batch-rename/logic.js";

// 45. 批量视频转码 (Batch Video - 真实扫描本机视频目录、CRF23 瘦身预估与转码预设工作台)
export { default as BatchVideoCommand } from "./batch-video/index.js";
export {
  type RealVideoFileItem,
  DLL_PLUGIN_NAME as BATCH_VIDEO_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_BATCH_VIDEO_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_BATCH_VIDEO_REASON,
  fetchRealVideoWorkspace,
  openVideoFileLocation,
  formatBytes as formatBatchVideoBytes
} from "./batch-video/logic.js";

// 46. 批量音频处理 (Batch Audio - 真实扫描本机音频目录、EBU R128 响度均衡与无损转码工作台)
export { default as BatchAudioCommand } from "./batch-audio/index.js";
export {
  type RealAudioFileItem,
  DLL_PLUGIN_NAME as BATCH_AUDIO_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_BATCH_AUDIO_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_BATCH_AUDIO_REASON,
  fetchRealAudioWorkspace,
  openAudioFileLocation,
  formatBytes as formatBatchAudioBytes
} from "./batch-audio/logic.js";

// 47. PDF 多功能工具箱 (PDF Workbench - 真实扫描本机文档目录、PDF 转 Word/Excel/高清图与合并工作台)
export { default as PdfCommand } from "./pdf/index.js";
export {
  type RealPdfDocItem,
  DLL_PLUGIN_NAME as PDF_WORKBENCH_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_PDF_WORKBENCH_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_PDF_WORKBENCH_REASON,
  fetchRealPdfWorkspace,
  openPdfFileLocation,
  openPdfDocument,
  formatBytes as formatPdfBytes
} from "./pdf/logic.js";

// 48. 多线程分块高速下载工作台 (Multi-Download - 真实扫描 Downloads、Aria2 16 线程分块与剪贴板嗅探)
export { default as MultiDownloadCommand } from "./multi-download/index.js";
export {
  type DownloadedFileItem,
  type MultiDownloadSnapshot,
  type ThreadSplitPreset,
  DLL_PLUGIN_NAME as MULTI_DOWNLOAD_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_MULTI_DOWNLOAD_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_MULTI_DOWNLOAD_REASON,
  DOWNLOAD_CATEGORIES,
  THREAD_SPLIT_PRESETS,
  fetchMultiDownloadSnapshot,
  startMultiThreadDownloadTask,
  deleteDownloadedFiles,
  openDownloadedFileLocation,
  openDownloadedFile,
  formatBytes as formatMultiDownloadBytes
} from "./multi-download/logic.js";

// 49. 全平台流媒体音视频解析与下载工坊 (Video Downloader - 6 大平台解析器、6 大画质封装与本地视频媒体库)
export { default as VideoDownloaderCommand } from "./video-downloader/index.js";
export {
  type LocalMediaVideoItem,
  type VideoDownloaderSnapshot,
  type VideoQualityPreset,
  DLL_PLUGIN_NAME as VIDEO_DOWNLOADER_DLL,
  FORBIDDEN_TARGET_PATTERN as FORBIDDEN_VIDEO_DOWNLOADER_PATTERN,
  FORBIDDEN_REASON as FORBIDDEN_VIDEO_DOWNLOADER_REASON,
  STREAM_PLATFORMS,
  VIDEO_QUALITY_PRESETS,
  detectVideoPlatform,
  fetchVideoDownloaderSnapshot,
  parseAndDownloadStreamVideo,
  trashLocalVideoFiles,
  openLocalVideoFile,
  openLocalVideoFolder,
  formatBytes as formatVideoDownloaderBytes
} from "./video-downloader/logic.js";

// 50. 窗口切换与顶部菜单栏搜索中枢 (Navigation - Switch Windows & Search Menu Items)
export { default as NavigationCommand } from "./navigation/index.js";
export * from "./navigation/index.js";

// 51. macOS Homebrew 极客包管理器 (Homebrew - Formulae & Casks)
export { default as HomebrewCommand } from "./homebrew/index.js";
export * from "./homebrew/index.js";

// 52. 自定义脚本命令工作台 (Script Commands - @raycast.* Metadata & Multi-runtime Runner)
export { default as ScriptCommandsCommand } from "./script-commands/index.js";
export * from "./script-commands/index.js";

// 53. 心流专注时钟与屏蔽套件 (Raycast Focus - Pomodoro & Distraction Blocker)
export { default as RaycastFocusCommand } from "./raycast-focus/index.js";
export * from "./raycast-focus/index.js";

// 54. 日程表与视频会议直达中枢 (Calendar - My Schedule, Join Meeting & ICS Export)
export { default as CalendarCommand } from "./calendar/index.js";
export * from "./calendar/index.js";

// 55. 全网多引擎搜索、活动浏览器标签页与通讯录中枢 (Web Searches, Browser Tab & Contacts)
export { default as WebSearchesCommand } from "./web-searches/index.js";
export * from "./web-searches/index.js";

// 56. 网络适配器与 IPv4/MAC/DNS 快照管家 (Network Adapter - 布局一)
export { default as NetworkAdapterCommand } from "./network-adapter/index.js";
export {
  type AdapterFilterMode,
  type NetworkAdapterItem,
  type NetworkAdapterSnapshot,
  fetchNetworkAdapters,
  flushDnsCache,
  copyAdapterInfo,
  filterNetworkAdapters
} from "./network-adapter/logic.js";

// 57. 断网急救箱与网络协议栈修复中枢 (Network Rescue - 布局一)
export { default as NetworkRescueCommand } from "./network-rescue/index.js";
export {
  type RescueCategory,
  type RescueFilterMode,
  type NetworkRescueItem,
  type NetworkDiagnosticSnapshot,
  NETWORK_RESCUE_ITEMS,
  runNetworkDiagnostics as runNetworkRescueDiagnostics,
  executeNetworkRepair,
  batchExecuteNetworkRepairs,
  filterNetworkRescueItems
} from "./network-rescue/logic.js";

// 58. 系统右键菜单管理与 Win11 经典菜单切换 (Context Menu - 布局一)
export { default as ContextMenuCommand } from "./context-menu/index.js";
export {
  type ContextMenuScope,
  type ContextMenuFilterMode,
  type ContextMenuEntry,
  DEFAULT_CONTEXT_MENU_ENTRIES,
  fetchContextMenuEntries,
  toggleContextMenuEntry,
  switchWin11ClassicMenu,
  filterContextMenuEntries
} from "./context-menu/logic.js";

// 59. 微信双开/多开分身与实例监控 (WeChat Multi - 布局一)
export { default as WechatMultiCommand } from "./wechat-multi/index.js";
export {
  type WechatFilterMode,
  type WechatInstanceItem,
  type WechatMultiSnapshot,
  fetchWechatInstances,
  launchNewWechatInstance,
  terminateWechatInstance,
  openWechatInstallLocation,
  filterWechatInstances,
  formatBytes as formatWechatMultiBytes
} from "./wechat-multi/logic.js";

// 60. 局域网文件快传与二维码投送 (LAN Share - 布局一)
export { default as LanShareCommand } from "./lan-share/index.js";
export {
  type LanShareFilterMode,
  type LanShareItem,
  type LanShareSnapshot,
  fetchLanShareSnapshot,
  toggleFileShare,
  openSharedFileLocation,
  generateQrCodeSvgDataUri,
  filterLanShareItems,
  formatBytes as formatLanShareBytes
} from "./lan-share/logic.js";

// 61. C 盘大目录无损搬家工坊 (Mover - 布局二)
export { default as MoverCommand } from "./mover/index.js";
export {
  MOVER_CATEGORIES,
  DEFAULT_TARGET_DRIVES,
  createInitialMoverSnapshot,
  fetchMoverSnapshot,
  executeDirectoryMove,
  openMoverFolderLocation,
  invokeMoverAction,
  formatBytes as formatMoverBytes
} from "./mover/logic.js";

// 62. 误删文件与回收站深度恢复工坊 (Data Recovery - 布局二)
export { default as DataRecoveryCommand } from "./data-recovery/index.js";
export {
  RECOVERY_CATEGORIES,
  SCAN_DEPTH_MODES,
  createInitialRecoverySnapshot,
  fetchRecoverableFiles,
  restoreSelectedFiles,
  openRecoveryLocation,
  formatBytes as formatDataRecoveryBytes
} from "./data-recovery/logic.js";

// 63. 军工级机密文件安全粉碎箱 (Shredder - 布局二)
export { default as ShredderCommand } from "./shredder/index.js";
export {
  SHRED_STANDARDS,
  SHRED_CATEGORIES,
  createInitialShredderSnapshot,
  fetchShredCandidates,
  executeSecureShred,
  openShredCandidateLocation,
  formatBytes as formatShredderBytes
} from "./shredder/logic.js";

// 64. 系统与开发环境关键配置备份还原工坊 (System Backup - 布局二)
export { default as SystemBackupCommand } from "./system-backup/index.js";
export {
  BACKUP_CATEGORIES,
  BACKUP_PROFILES,
  createInitialSystemBackupSnapshot,
  fetchSystemBackupSnapshot,
  createBackupArchive,
  restoreBackupSnapshot,
  openBackupConfigLocation,
  formatBytes as formatSystemBackupBytes
} from "./system-backup/logic.js";

// 65. 本地 SQLite 数据库透视与导出工坊 (SQLite Plugin - 布局二)
export { default as SqlitePluginCommand } from "./sqlite-plugin/index.js";
export {
  SQLITE_TABLES,
  createInitialSqliteWorkspace,
  fetchSqliteWorkspace,
  exportTableRecords,
  executeSqliteQuery,
  openSqliteDbLocation,
  formatBytes as formatSqlitePluginBytes
} from "./sqlite-plugin/logic.js";

// 66. AI 图像超分放大与智能抠图工作台 (AI Image - 布局三)
export { default as AiImageCommand } from "./ai-image/index.js";
export {
  type AiImageEnginePreset,
  type AiImageFileItem,
  AI_IMAGE_ENGINES,
  INITIAL_AI_IMAGE_FILES,
  estimateTargetResolution,
  fetchAiImageWorkspace,
  openAiImageLocation,
  runAiImageBatch,
  formatBytes as formatAiImageBytes
} from "./ai-image/logic.js";

// 67. AI 视频光流补帧与超分增强工作台 (AI Video - 布局三)
export { default as AiVideoCommand } from "./ai-video/index.js";
export {
  type AiVideoFileItem,
  type AiVideoModelPreset,
  AI_VIDEO_MODELS,
  INITIAL_AI_VIDEO_FILES,
  fetchAiVideoWorkspace,
  openAiVideoLocation,
  runAiVideoBatch,
  formatBytes as formatAiVideoBytes
} from "./ai-video/logic.js";

// 68. 多语言离线屏幕与批量图片 OCR 工作台 (OCR - 布局三)
export { default as OcrCommand } from "./ocr/index.js";
export {
  type OcrLanguagePreset,
  type OcrQueueItem,
  INITIAL_OCR_QUEUE_ITEMS,
  OCR_LANGUAGE_MODELS,
  captureScreenAreaOcr,
  executeBatchOcr,
  fetchOcrWorkspace,
  openOcrFileLocation,
  formatBytes as formatOcrBytes
} from "./ocr/logic.js";

// 69. 高清屏幕录制与系统内录工作台 (Record - 布局三)
export { default as RecordCommand } from "./record/index.js";
export {
  type RecordSourcePreset,
  type RecordedVideoItem,
  INITIAL_RECORDED_VIDEOS,
  RECORD_SOURCE_MODES,
  estimateMbPerMinute,
  fetchRecordWorkspace,
  openRecordFileLocation,
  openRecordedVideo,
  startScreenRecording,
  formatBytes as formatRecordBytes
} from "./record/logic.js";

// 70. 文件解锁与占用句柄解除 (File Unlock - 布局一)
export { default as FileUnlockCommand } from "./file-unlock/index.js";
export * from "./file-unlock/types.js";
export * from "./file-unlock/unlock-service.js";

// 71. 启动管理与后台服务/计划任务精简 (Startup Manager - 布局一)
export { default as StartupManagerCommand } from "./startup-manager/index.js";
export * from "./startup-manager/types.js";
export * from "./startup-manager/startup-service.js";

// 72. 外接显示器亮度与控制 (Monitor Control - 布局一)
export { default as MonitorControlCommand } from "./monitor-control/index.js";
export * from "./monitor-control/types.js";
export * from "./monitor-control/monitor-service.js";

// 73. 防休眠常亮助手 (Caffeine - 布局一)
export { default as CaffeineCommand } from "./caffeine/index.js";
export * from "./caffeine/types.js";
export * from "./caffeine/caffeine-service.js";

// 74. DNS 优选测速器 (DNS Benchmark - 布局一)
export { default as DnsBenchmarkCommand } from "./dns-benchmark/index.js";
export * from "./dns-benchmark/types.js";
export * from "./dns-benchmark/dns-service.js";

// 75. 热键冲突检测器 (Hotkey Radar - 布局一)
export { default as HotkeyRadarCommand } from "./hotkey-radar/index.js";
export * from "./hotkey-radar/types.js";
export * from "./hotkey-radar/hotkey-service.js";

// 76. 文件夹双向同步对比 (Folder Sync - 布局一)
export { default as FolderSyncCommand } from "./folder-sync/index.js";
export * from "./folder-sync/types.js";
export * from "./folder-sync/sync-service.js";

// 77. 跨浏览器书签检索 (Browser Bookmarks - 布局一)
export { default as BrowserBookmarksCommand } from "./browser-bookmarks/index.js";
export * from "./browser-bookmarks/types.js";
export * from "./browser-bookmarks/bookmark-scanner.js";

// 78. 剪贴板粘贴栈 (Paste Stack - 布局一)
export { default as PasteStackCommand } from "./paste-stack/index.js";
export * from "./paste-stack/types.js";
export * from "./paste-stack/stack-manager.js";

// 79. Office文档瘦身 (Office Slim - 布局三)
export { default as OfficeSlimCommand } from "./office-slim/index.js";
export * from "./office-slim/types.js";
export * from "./office-slim/office-slim-service.js";

// 80. AI文档转Word (MD to Office - 布局三)
export { default as MdToOfficeCommand } from "./md-to-office/index.js";
export * from "./md-to-office/types.js";
export * from "./md-to-office/md-to-office-service.js";

// 81. 字体管理 (Font Manager - 布局一)
export { default as FontManagerCommand } from "./font-manager/index.js";
export * from "./font-manager/types.js";
export * from "./font-manager/font-service.js";

// 82. 文件编码与指纹鉴定 (File Inspector - 布局三)
export { default as FileInspectorCommand } from "./file-inspector/index.js";
export * from "./file-inspector/types.js";
export * from "./file-inspector/inspector-service.js";

// 83. 音视频属性与封皮管理 (Media Metadata - 布局三)
export { default as MediaMetadataCommand } from "./media-metadata/index.js";
export * from "./media-metadata/types.js";
export * from "./media-metadata/media-service.js";

// 84. 证件安全防伪水印 (ID Watermark - 布局三)
export { default as IdWatermarkCommand } from "./id-watermark/index.js";
export * from "./id-watermark/types.js";
export * from "./id-watermark/watermark-service.js";

// 85. 表格万能互转 (Table Converter - 布局三)
export { default as TableConverterCommand } from "./table-converter/index.js";
export * from "./table-converter/types.js";
export * from "./table-converter/table-service.js";

// 86. 番茄专注与防沉迷锁 (Pomodoro Focus - 布局一)
export { default as PomodoroFocusCommand } from "./pomodoro-focus/index.js";
export * from "./pomodoro-focus/types.js";
export * from "./pomodoro-focus/pomodoro-service.js";

// 87. IDE 项目启动器 (VSCode Projects - 布局一)
export { default as VscodeProjectsCommand } from "./vscode-projects/index.js";
export * from "./vscode-projects/types.js";
export * from "./vscode-projects/project-service.js";

// 88. Hosts 方案秒切 (Hosts Switcher - 布局一)
export { default as HostsSwitcherCommand } from "./hosts-switcher/index.js";
export * from "./hosts-switcher/types.js";
export * from "./hosts-switcher/hosts-service.js";

// 89. 环境变量管家 (Env Manager - 布局一)
export { default as EnvManagerCommand } from "./env-manager/index.js";
export * from "./env-manager/types.js";
export * from "./env-manager/env-service.js";

// 90. Docker 容器秒控 (Docker Manager - 布局一)
export { default as DockerManagerCommand } from "./docker-manager/index.js";
export * from "./docker-manager/types.js";
export * from "./docker-manager/docker-service.js";

// 91. 局域网扫描与唤醒 (LAN Scanner - 布局一)
export { default as LanScannerCommand } from "./lan-scanner/index.js";
export * from "./lan-scanner/types.js";
export * from "./lan-scanner/lan-service.js";

// 92. SSH 与终端代理助手 (SSH Proxy Helper - 布局一)
export { default as SshProxyHelperCommand } from "./ssh-proxy-helper/index.js";
export * from "./ssh-proxy-helper/types.js";
export * from "./ssh-proxy-helper/ssh-proxy-service.js";

// 93. 正则与Cron (Regex Cron - 布局二)
export { default as RegexCronCommand } from "./regex-cron/index.js";
export * from "./regex-cron/types.js";
export * from "./regex-cron/regex-cron-service.js";

// 94. 命令与状态码 (Linux HTTP Dict - 布局二)
export { default as LinuxHttpDictCommand } from "./linux-http-dict/index.js";
export * from "./linux-http-dict/types.js";
export * from "./linux-http-dict/dict-service.js";

// 95. Git救命锦囊 (Git Helper - 布局二)
export { default as GitHelperCommand } from "./git-helper/index.js";
export * from "./git-helper/types.js";
export * from "./git-helper/git-helper-service.js";

// 96. SQL格式化转换 (SQL Helper - 布局二)
export { default as SqlHelperCommand } from "./sql-helper/index.js";
export * from "./sql-helper/types.js";
export * from "./sql-helper/sql-helper-service.js";

// 97. 测试数据生成 (Mock Data - 布局二)
export { default as MockDataCommand } from "./mock-data/index.js";
export * from "./mock-data/types.js";
export * from "./mock-data/mock-service.js";

// 98. JWT与URL解析 (JWT & URL Codec - 布局二)
export { default as JwtUrlCodecCommand } from "./jwt-url-codec/index.js";
export * from "./jwt-url-codec/types.js";
export * from "./jwt-url-codec/jwt-url-service.js";

// 99. 轻量接口调试 (cURL & HTTP - 布局二)
export { default as CurlHttpCommand } from "./curl-http/index.js";
export * from "./curl-http/types.js";
export * from "./curl-http/curl-service.js";

// 100. 域名与SSL诊断 (SSL & Domain Check - 布局二)
export { default as SslDomainCheckCommand } from "./ssl-domain-check/index.js";
export * from "./ssl-domain-check/types.js";
export * from "./ssl-domain-check/ssl-dns-service.js";

// 101. SVG预览与压缩 (SVG Icon Studio - 布局二)
export { default as SvgIconStudioCommand } from "./svg-icon-studio/index.js";
export * from "./svg-icon-studio/types.js";
export * from "./svg-icon-studio/svg-service.js";

// 102. 网段与权限计算 (Chmod & CIDR Calc - 布局二)
export { default as ChmodCidrCalcCommand } from "./chmod-cidr-calc/index.js";
export * from "./chmod-cidr-calc/types.js";
export * from "./chmod-cidr-calc/chmod-cidr-service.js";









