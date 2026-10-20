/**
 * 官方标杆声明式应用注册与转发中心 (Official Built-in & Store Registry)
 *
 * 体系定调：
 * 1. 第一方内置核心应用 (First-party Built-in Core Apps):
 *    剪贴板历史、短语展开、窗口极速调度、文件秒搜、计算器色彩、系统运维、快捷链接等。
 *    随宿主预置、零外部依赖、开箱即用、免安装。
 * 2. 官方 Store 扩展 (Official Store Extensions):
 *    依赖外部网络/第三方环境的应用（GitHub, Obsidian, Speedtest, Winget, 汇率换算）
 *    已正式移入 plugins/official/* 官方商店目录，支持独立分发与转发渲染。
 */

import {
  JsonFormatCommand,
  QrCodeCommand,
  GoogleTranslateCommand,
  ColorPickerCommand,
  KillProcessCommand,
  EverythingFileSearchCommand,
  ClipboardHistoryCommand,
  SnippetsCommand,
  WindowManagementCommand,
  CalculatorCommand,
  SystemCommand,
  QuicklinksCommand,
  SettingsCommand,
  RaycastCoreCommand,
  RaycastAccountCommand,
  OrganizationsCommand,
  RaycastWrappedCommand,
  TrialNudgesCommand,
  WindowsShortcutsCommand,
  GithubDashboardCommand,
  ObsidianCommand,
  SpeedtestCommand,
  WingetCommand,
  CurrencyExchangeCommand,
  EmojiPickerCommand,
  TranslatorCommand,
  NotesCommand,
  WindowsRunCommand,
  WindowsTaskbarCommand,
  ScreenshotsCommand,
  ApplicationsCommand,
  DictionaryCommand,
  PasswordVaultCommand,
  WifiPasswordRevealCommand,
  AudioDeviceCommand,
  CleanKeyboardCommand,
  DownloadsManagerCommand,
  ProcessMonitorCommand,
  SoftwareManagerCommand,
  CleanerCommand,
  DiskAnalyzerCommand,
  WechatCleanerCommand,
  QQCleanerCommand,
  FlowGuardCommand,
  HardwareInfoCommand,
  BoostCommand,
  BatchRenameCommand,
  BatchVideoCommand,
  BatchAudioCommand,
  PdfCommand,
  MultiDownloadCommand,
  VideoDownloaderCommand,
  AppleShortcutsCommand,
  NavigationCommand,
  HomebrewCommand,
  ScriptCommandsCommand,
  RaycastFocusCommand,
  CalendarCommand,
  WebSearchesCommand,
  NetworkAdapterCommand,
  NetworkRescueCommand,
  ContextMenuCommand,
  WechatMultiCommand,
  LanShareCommand,
  MoverCommand,
  DataRecoveryCommand,
  ShredderCommand,
  SystemBackupCommand,
  SqlitePluginCommand,
  AiImageCommand,
  AiVideoCommand,
  OcrCommand,
  RecordCommand,
  FileCompareCommand
} from '@ztools/declarative-ui'
import { isBundledPlugin } from './bundledPlugins.js'

/**
 * 官方标杆应用唯一标识清单
 */
export const OFFICIAL_PLUGIN_IDS = Object.freeze({
  // 第一方内置核心套件 (Core Built-ins)
  CLIPBOARD_HISTORY: 'clipboard-history',
  SNIPPETS: 'snippets',
  WINDOW_MANAGEMENT: 'window-management',
  EVERYTHING_SEARCH: 'everything-file-search',
  CALCULATOR: 'calculator',
  SYSTEM: 'system',
  QUICKLINKS: 'quicklinks',
  KILL_PROCESS: 'kill-process',
  JSON_FORMAT: 'json-format',
  QR_CODE: 'qr-code',
  COLOR_PICKER: 'color-picker',
  GOOGLE_TRANSLATE: 'google-translate',

  // 原生插件声明式 2.0 升级标杆 (Native Plugin Declarative 2.0 Benchmark)
  PROCESS_MONITOR: 'process-monitor',
  SOFTWARE_MANAGER: 'software-manager',
  CLEANER: 'cleaner',
  DISK_ANALYZER: 'disk-analyzer',
  WECHAT_CLEANER: 'wechat-cleaner',
  QQ_CLEANER: 'qq-cleaner',
  FLOW_GUARD: 'flow-guard',
  HARDWARE_INFO: 'hardware-info',
  BOOST: 'boost',
  BATCH_RENAME: 'batch-rename',
  BATCH_VIDEO: 'batch-video',
  BATCH_AUDIO: 'batch-audio',
  PDF: 'pdf',
  MULTI_DOWNLOAD: 'multi-download',
  VIDEO_DOWNLOADER: 'video-downloader',
  NETWORK_ADAPTER: 'network-adapter',
  NETWORK_RESCUE: 'network-rescue',
  CONTEXT_MENU: 'context-menu',
  WECHAT_MULTI: 'wechat-multi',
  LAN_SHARE: 'lan-share',
  MOVER: 'mover',
  DATA_RECOVERY: 'data-recovery',
  SHREDDER: 'shredder',
  SYSTEM_BACKUP: 'system-backup',
  SQLITE_PLUGIN: 'sqlite-plugin',
  AI_IMAGE: 'ai-image',
  AI_VIDEO: 'ai-video',
  OCR: 'ocr',
  RECORD: 'record',
  FILE_COMPARE: 'file-compare',

  // M1.5 第二组: 高频核心内置应用 (Group 2 Built-in Apps)
  EMOJI_PICKER: 'emoji-picker',
  TRANSLATOR: 'translator',
  NOTES: 'notes',
  WINDOWS_RUN: 'windows-run',
  WINDOWS_TASKBAR: 'windows-taskbar',
  SCREENSHOTS: 'screenshots',
  APPLICATIONS: 'applications',
  DICTIONARY: 'dictionary',

  // 新增 5 款装机高频独立套件 (Password Vault, WiFi Reveal, Audio Device, Clean Keyboard, Downloads Manager)
  PASSWORD_VAULT: 'password-vault',
  WIFI_PASSWORD_REVEAL: 'wifi-password-reveal',
  AUDIO_DEVICE: 'audio-device',
  CLEAN_KEYBOARD: 'clean-keyboard',
  DOWNLOADS_MANAGER: 'downloads-manager',

  // M1.5 第四组: 系统治理与设置套件
  RAYCAST_SETTINGS: 'raycast-settings',
  RAYCAST_CORE: 'raycast-core',
  RAYCAST_ACCOUNT: 'raycast-account',
  ORGANIZATIONS: 'organizations',
  RAYCAST_WRAPPED: 'raycast-wrapped',
  TRIAL_NUDGES: 'trial-nudges',
  WINDOWS_SHORTCUTS: 'windows-shortcuts',
  APPLE_SHORTCUTS: 'apple-shortcuts',

  // 新增 macOS 与跨端第一方标杆内置套件 (Navigation, Homebrew, Script Commands, Focus, Calendar, Web Searches)
  NAVIGATION: 'navigation',
  HOMEBREW: 'homebrew',
  SCRIPT_COMMANDS: 'script-commands',
  RAYCAST_FOCUS: 'raycast-focus',
  CALENDAR: 'calendar',
  WEB_SEARCHES: 'web-searches',

  // 官方 Store 扩展转发 (Store Extensions in plugins/official/*)
  GITHUB: 'github',
  OBSIDIAN: 'obsidian',
  SPEEDTEST: 'speedtest',
  WINGET: 'winget',
  CURRENCY_EXCHANGE: 'currency-exchange'
})

/**
 * 官方标杆应用元数据与组件定义表
 */
export const OFFICIAL_PLUGINS_MAP = Object.freeze({
  // ==================== 第一方核心内置应用 (Core Built-in Apps) ====================
  [OFFICIAL_PLUGIN_IDS.CLIPBOARD_HISTORY]: Object.freeze({
    id: 'clipboard-history',
    pluginId: 'clipboard-history',
    name: '剪贴板历史与流水粘贴',
    title: '剪贴板历史与流水粘贴',
    description: 'SQLite WAL 毫秒级存储、大图/长文本截断、高熵密码脱敏与流水粘贴 (Paste Sequentially)',
    category: '办公效率',
    keyword: 'clipboard history 剪贴板 粘贴 复制 历史 流水粘贴 clipboard-history',
    faIcon: 'fa-clipboard',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ClipboardHistoryCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SNIPPETS]: Object.freeze({
    id: 'snippets',
    pluginId: 'snippets',
    name: '快捷短语与宏展开',
    title: '快捷短语与宏展开',
    description: '触发词毫秒匹配、退格模拟、{clipboard}/{date}/{time}/{cursor} 动态宏展开与 JSON 导入导出',
    category: '办公效率',
    keyword: 'snippets snippet 短语 快捷 文本 宏 模板 snippets',
    faIcon: 'fa-font',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SnippetsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WINDOW_MANAGEMENT]: Object.freeze({
    id: 'window-management',
    pluginId: 'window-management',
    name: '窗口极速调度',
    title: '窗口极速调度',
    description: '15 种 Win32 原生分屏吸附动作、工作区避让与毫秒级半透明 HUD 视觉提示',
    category: '系统工具',
    keyword: 'window management 窗口 分屏 吸附 排版 最大化 居中 window-management',
    faIcon: 'fa-window-restore',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WindowManagementCommand
  }),

  [OFFICIAL_PLUGIN_IDS.EVERYTHING_SEARCH]: Object.freeze({
    id: 'everything-file-search',
    pluginId: 'everything-file-search',
    name: 'Everything 文件秒搜',
    title: 'Everything 文件秒搜',
    description: '自研硬件级极速文件检索引擎与标杆声明式 UI，支持全盘毫秒召回与 SHA-256 计算',
    category: '系统工具',
    keyword: 'everything search file 秒搜 文件 检索 mft usn everything-file-search',
    faIcon: 'fa-search',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: EverythingFileSearchCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CALCULATOR]: Object.freeze({
    id: 'calculator',
    pluginId: 'calculator',
    name: '综合计算器与色彩速查',
    title: '综合计算器与色彩速查',
    description: '输入算式直接出结果，支持单位换算和颜色值换算',
    category: '办公效率',
    keyword: 'calculator math color 计算器 算术 颜色 换算 估值 calculator',
    faIcon: 'fa-calculator',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: CalculatorCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SYSTEM]: Object.freeze({
    id: 'system',
    pluginId: 'system',
    name: 'Windows 运维动作',
    title: 'Windows 运维动作',
    description: '锁屏、关机、重启、清空回收站、静音、调音量',
    category: '系统工具',
    keyword: 'system power 关机 重启 锁屏 清空回收站 静音 运维 win32 system',
    faIcon: 'fa-cogs',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SystemCommand
  }),

  [OFFICIAL_PLUGIN_IDS.QUICKLINKS]: Object.freeze({
    id: 'quicklinks',
    pluginId: 'quicklinks',
    name: '快捷直达链接',
    title: '快捷直达链接',
    description: '给常用网址起个短别名，输入别名加关键词直接打开搜索',
    category: '办公效率',
    keyword: 'quicklinks link 直达 网址 书签 别名 quicklink quicklinks',
    faIcon: 'fa-link',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: QuicklinksCommand
  }),

  [OFFICIAL_PLUGIN_IDS.KILL_PROCESS]: Object.freeze({
    id: 'kill-process',
    pluginId: 'kill-process',
    name: '进程管理急救箱',
    title: '进程管理急救箱',
    description: '按内存/CPU 搜索进程列表，一键强制结束进程动作与任务管理器对比',
    category: '系统工具',
    keyword: 'kill process task 进程 任务管理器 强退 卡死 结束进程 内存',
    faIcon: 'fa-tasks',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: KillProcessCommand
  }),

  [OFFICIAL_PLUGIN_IDS.JSON_FORMAT]: Object.freeze({
    id: 'json-format',
    pluginId: 'json-format',
    name: 'JSON 格式化与类型推导',
    title: 'JSON 格式化与类型推导',
    description: '检查 JSON 是否有错，一键美化或压缩，还能生成 TypeScript 类型',
    category: '办公效率',
    keyword: 'json format ts typescript 格式化 校验 压缩 接口推导 json-format',
    faIcon: 'fa-code',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '官方标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: JsonFormatCommand
  }),

  [OFFICIAL_PLUGIN_IDS.QR_CODE]: Object.freeze({
    id: 'qr-code',
    pluginId: 'qr-code',
    name: '二维码生成与识别',
    title: '二维码生成与识别',
    description: '纯前端无依赖二维码生成（SVG/DataURL 预览）、历史管理与扫描解析',
    category: '系统工具',
    keyword: 'qr qrcode 二维码 生成 识别 条形码 scan qr-code',
    faIcon: 'fa-qrcode',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '官方标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: QrCodeCommand
  }),

  [OFFICIAL_PLUGIN_IDS.COLOR_PICKER]: Object.freeze({
    id: 'color-picker',
    pluginId: 'color-picker',
    name: '色彩拾取与转换',
    title: '色彩拾取与转换',
    description: '拾取屏幕颜色，在 Hex、RGB、HSL、CMYK 之间换算，查看文字对比度',
    category: '媒体处理',
    keyword: 'color picker 色彩 调色板 拾色器 hex rgb hsl cmyk 颜色',
    faIcon: 'fa-eyedropper',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '官方标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ColorPickerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.GOOGLE_TRANSLATE]: Object.freeze({
    id: 'google-translate',
    pluginId: 'google-translate',
    name: '多语言即时翻译',
    title: '多语言即时翻译',
    description: '中英日韩等多语言互译，可朗读译文、保存历史；译文由在线翻译服务提供，需联网',
    category: '办公效率',
    keyword: 'translate 翻译 词典 英语 日语 语言 fanyi google-translate',
    faIcon: 'fa-language',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '官方标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: GoogleTranslateCommand
  }),

  // ==================== M1.5 第四组: 系统治理与组织协同套件 ====================
  [OFFICIAL_PLUGIN_IDS.RAYCAST_SETTINGS]: Object.freeze({
    id: 'raycast-settings',
    pluginId: 'raycast-settings',
    name: '系统偏好设置',
    title: '系统偏好设置',
    description: '支持通用、启动器、快捷键、键盘、E2EE云同步、高级侧车与账户9大系统设置项',
    category: '系统工具',
    keyword: 'settings preferences 偏好设置 系统设置 主题 快捷键 同步 代理 ztools-settings',
    faIcon: 'fa-cog',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '系统治理',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SettingsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.RAYCAST_CORE]: Object.freeze({
    id: 'raycast-core',
    pluginId: 'raycast-core',
    name: '更新与版本公告',
    title: '更新与版本公告',
    description: '版本升级检查、新特性速览 (Release Notes)、公告通知与系统广播',
    category: '系统工具',
    keyword: 'core update release notes changelog 公告 更新 版本 升级 ztools-core',
    faIcon: 'fa-info-circle',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '核心系统',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: RaycastCoreCommand
  }),

  [OFFICIAL_PLUGIN_IDS.RAYCAST_ACCOUNT]: Object.freeze({
    id: 'raycast-account',
    pluginId: 'raycast-account',
    name: '极客账户与授权',
    title: '极客账户与授权 (Account)',
    description: '本地极客身份、BYOK 算力通道状态与轻量 Token 会话维护',
    category: '系统工具',
    keyword: 'account user profile token 账户 用户 授权 密钥 ztools-account',
    faIcon: 'fa-user-circle',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '极客账户',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: RaycastAccountCommand
  }),

  [OFFICIAL_PLUGIN_IDS.ORGANIZATIONS]: Object.freeze({
    id: 'organizations',
    pluginId: 'organizations',
    name: '商业与团队协同',
    title: '商业与团队协同 (Organizations)',
    description: '团队架构、成员管理、团队共享 Snippets 与私有插件目录',
    category: '办公效率',
    keyword: 'organizations team teams enterprise 团队 协同 组织 企业 共享 webhooks',
    faIcon: 'fa-users',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '商业协同',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: OrganizationsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.RAYCAST_WRAPPED]: Object.freeze({
    id: 'raycast-wrapped',
    pluginId: 'raycast-wrapped',
    name: '年度极客使用报告',
    title: '年度极客使用报告 (Wrapped)',
    description: '基于本地 SQLite 统计总启动次数、最常用扩展 Top 5、按键习惯与节省时间估算',
    category: '办公效率',
    keyword: 'wrapped review report 战报 年度 报告 极客 统计 ztools-wrapped',
    faIcon: 'fa-trophy',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '极客战报',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: RaycastWrappedCommand
  }),

  [OFFICIAL_PLUGIN_IDS.TRIAL_NUDGES]: Object.freeze({
    id: 'trial-nudges',
    pluginId: 'trial-nudges',
    name: '核心特权与技术方案',
    title: '核心特权与技术方案 (Trial Nudges)',
    description: 'NTFS MFT 硬件级索引、UIAccess 穿透、E2EE 加密同步与 BYOK 自由原则',
    category: '系统工具',
    keyword: 'nudges pro trial features 特权 方案 架构 索引 穿透 trial-nudges',
    faIcon: 'fa-star',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '核心特权',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: TrialNudgesCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WINDOWS_SHORTCUTS]: Object.freeze({
    id: 'windows-shortcuts',
    pluginId: 'windows-shortcuts',
    name: 'Windows 自动化快捷指令',
    title: 'Windows 快捷指令',
    description: '把常用系统操作做成快捷指令，比如刷新 DNS、重启资源管理器',
    category: '系统工具',
    keyword: 'shortcuts apple-shortcuts windows automation 快捷指令 自动化 脚本 powershell cmd',
    faIcon: 'fa-bolt',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '原生自动化',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WindowsShortcutsCommand
  }),

  // ==================== M1.5 第二组: 高频核心内置应用 (Group 2 Built-in Apps) ====================
  [OFFICIAL_PLUGIN_IDS.EMOJI_PICKER]: Object.freeze({
    id: 'emoji-picker',
    pluginId: 'emoji-picker',
    name: 'Emoji 与符号选择器',
    title: 'Emoji 与符号选择器',
    description: '按中文、拼音或英文搜索 Emoji，点一下就复制',
    category: '办公效率',
    keyword: 'emoji biaoqing 符号 表情 symbol picker 表情包 emoji-picker',
    faIcon: 'fa-smile-o',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: EmojiPickerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.TRANSLATOR]: Object.freeze({
    id: 'translator',
    pluginId: 'translator',
    name: '即时划词翻译',
    title: '即时划词翻译',
    description: '多引擎聚合、离线词库兜底、自动语种探测与双语例句解析',
    category: '办公效率',
    keyword: 'translator translate 翻译 fanyi 词典 查词 划词 translator',
    faIcon: 'fa-language',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: TranslatorCommand
  }),

  [OFFICIAL_PLUGIN_IDS.NOTES]: Object.freeze({
    id: 'notes',
    pluginId: 'notes',
    name: '轻量便签记事',
    title: '轻量便签记事',
    description: '随手记的 Markdown 便签，可置顶，只保存在本机',
    category: '办公效率',
    keyword: 'notes note 便签 记事 备忘 草稿 bianqian notes',
    faIcon: 'fa-sticky-note-o',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: NotesCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WINDOWS_RUN]: Object.freeze({
    id: 'windows-run',
    pluginId: 'windows-run',
    name: 'Windows 运行中枢',
    title: 'Windows 运行中枢',
    description: '加强版「运行」：内置常用系统命令别名，可自定义，可用管理员身份执行',
    category: '系统工具',
    keyword: 'run yongxing 运行 windows-run cmd powershell control regedit gpedit 系统命令',
    faIcon: 'fa-terminal',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WindowsRunCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WINDOWS_TASKBAR]: Object.freeze({
    id: 'windows-taskbar',
    pluginId: 'windows-taskbar',
    name: 'Windows 任务栏控制',
    title: 'Windows 任务栏控制',
    description: '一键隐藏或显示任务栏',
    category: '系统工具',
    keyword: 'taskbar renwulan 任务栏 隐藏 显示 全屏 windows-taskbar',
    faIcon: 'fa-window-maximize',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WindowsTaskbarCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SCREENSHOTS]: Object.freeze({
    id: 'screenshots',
    pluginId: 'screenshots',
    name: '截图历史与回贴',
    title: '截图历史与回贴',
    description: '本地截图目录自动侦测、图片哈希去重、一键回贴到目标窗口与收藏置顶',
    category: '办公效率',
    keyword: 'screenshots jietu 截图 截屏 贴图 图片剪贴板 screenshots',
    faIcon: 'fa-camera',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ScreenshotsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.APPLICATIONS]: Object.freeze({
    id: 'applications',
    pluginId: 'applications',
    name: '已装应用管理与卸载',
    title: '已装应用管理与卸载',
    description: '注册表与系统组件快速索引、拼音过滤、一键唤起官方卸载器与安装路径定位',
    category: '系统工具',
    keyword: 'applications apps yingyong 应用 软件 卸载 uninstall xiezai applications',
    faIcon: 'fa-th-large',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ApplicationsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.DICTIONARY]: Object.freeze({
    id: 'dictionary',
    pluginId: 'dictionary',
    name: '英汉双解科技词典',
    title: '英汉双解科技词典',
    description: '技术名词与高频词汇英汉释义、音标、双语例句、离线查询与生词收藏',
    category: '办公效率',
    keyword: 'dictionary cidian 词典 查词 英语 英汉 释义 dictionary',
    faIcon: 'fa-book',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: DictionaryCommand
  }),

  // ==================== 官方 Store 扩展转发 (Official Store Extensions) ====================
  [OFFICIAL_PLUGIN_IDS.GITHUB]: Object.freeze({
    id: 'github',
    pluginId: 'github',
    name: 'GitHub 仪表盘',
    title: 'GitHub 仪表盘',
    description: 'PR、Issue、Workflow runs、Starred 仓库全功能仪表盘与 Git 分支快捷复制',
    category: '办公效率',
    keyword: 'github git pr issue repo 仓库 workflow actions commit',
    faIcon: 'fa-github',
    version: '1.0.0',
    author: 'official',
    badge: '官方商店',
    isBuiltin: true,
    isStoreExtension: true,
    isDeclarative: true,
    enabled: true,
    command: GithubDashboardCommand
  }),

  [OFFICIAL_PLUGIN_IDS.OBSIDIAN]: Object.freeze({
    id: 'obsidian',
    pluginId: 'obsidian',
    name: 'Obsidian 笔记随手记',
    title: 'Obsidian 笔记随手记',
    description: 'Vault 知识库笔记即时搜索、随手记 Form 表单与 Markdown 详情渲染',
    category: '办公效率',
    keyword: 'obsidian markdown 笔记 随手记 vault note 知识库',
    faIcon: 'fa-book',
    version: '1.0.0',
    author: 'official',
    badge: '官方商店',
    isBuiltin: true,
    isStoreExtension: true,
    isDeclarative: true,
    enabled: true,
    command: ObsidianCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SPEEDTEST]: Object.freeze({
    id: 'speedtest',
    pluginId: 'speedtest',
    name: '网络诊断与网速测试',
    title: '网络诊断与网速测试',
    description: '纯前端高精度网络测速、内外网 IP 探测与 DNS 解析延迟基准对比',
    category: '系统工具',
    keyword: 'speedtest network ping dns 测速 延迟 网络诊断 speed',
    faIcon: 'fa-tachometer',
    version: '1.0.0',
    author: 'official',
    badge: '官方商店',
    isBuiltin: true,
    isStoreExtension: true,
    isDeclarative: true,
    enabled: true,
    command: SpeedtestCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WINGET]: Object.freeze({
    id: 'winget',
    pluginId: 'winget',
    name: 'Winget 软件包管理器',
    title: 'Winget 软件包管理器',
    description: '用图形界面搜索、安装、更新和卸载软件（基于 Windows 自带的 winget）',
    category: '系统工具',
    keyword: 'winget package install app 软件 管理器 安装 卸载 更新',
    faIcon: 'fa-cube',
    version: '1.0.0',
    author: 'official',
    badge: '官方商店',
    isBuiltin: true,
    isStoreExtension: true,
    isDeclarative: true,
    enabled: true,
    command: WingetCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CURRENCY_EXCHANGE]: Object.freeze({
    id: 'currency-exchange',
    pluginId: 'currency-exchange',
    name: '实时多币种汇率换算',
    title: '实时多币种汇率换算',
    description: '全球 160+ 国家法定与加密货币实时汇率牌价、离线缓存与多向极速换算',
    category: '金融理财',
    keyword: 'currency exchange 汇率 换算 货币 美元 人民币 欧元 rates',
    faIcon: 'fa-exchange',
    version: '1.0.0',
    author: 'official',
    badge: '官方商店',
    isBuiltin: true,
    isStoreExtension: true,
    isDeclarative: true,
    enabled: true,
    command: CurrencyExchangeCommand
  }),

  // ==================== 新增 5 款装机高频独立套件 ====================
  [OFFICIAL_PLUGIN_IDS.PASSWORD_VAULT]: Object.freeze({
    id: 'password-vault',
    pluginId: 'password-vault',
    name: '密码保险箱',
    title: '密码保险箱',
    description: '纯粹管理网站账号、密码、网址与私密备注，支持主密码加密锁与 Chrome/Edge CSV 密码表导入导出',
    category: '安全隐私',
    keyword: 'password vault keepass bitwarden 密码 保险箱 账号 登录 csv password-vault',
    faIcon: 'fa-key',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: PasswordVaultCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WIFI_PASSWORD_REVEAL]: Object.freeze({
    id: 'wifi-password-reveal',
    pluginId: 'wifi-password-reveal',
    name: 'Wi-Fi 密码查看器',
    title: 'Wi-Fi 密码查看器',
    description: '一键提取本机已保存的所有历史 Wi-Fi 明文密码，并生成手机扫码连网二维码',
    category: '系统工具',
    keyword: 'wifi password reveal wlan 无线 密码 查看 二维码 连网 wifi-password-reveal',
    faIcon: 'fa-wifi',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WifiPasswordRevealCommand
  }),

  [OFFICIAL_PLUGIN_IDS.AUDIO_DEVICE]: Object.freeze({
    id: 'audio-device',
    pluginId: 'audio-device',
    name: '音频设备一键切换',
    title: '音频设备一键切换',
    description: '蓝牙耳机、外接显示器音响、本机扬声器与麦克风一键秒切，支持精确调音与会议/外放场景组合',
    category: '系统工具',
    keyword: 'audio device sound speaker microphone 音频 声卡 耳机 扬声器 麦克风 切换 音量 audio-device',
    faIcon: 'fa-volume-up',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: AudioDeviceCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CLEAN_KEYBOARD]: Object.freeze({
    id: 'clean-keyboard',
    pluginId: 'clean-keyboard',
    name: '键盘清洁防误触锁',
    title: '键盘清洁防误触锁',
    description: '擦拭键盘、清洁屏幕或防宠物踩踏时一键锁定全键盘输入，实时统计拦截误触次数并支持 Ctrl+U 紧急解锁',
    category: '系统工具',
    keyword: 'clean keyboard lock 键盘 清洁 防误触 锁定 擦键盘 猫咪 clean-keyboard',
    faIcon: 'fa-keyboard-o',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: CleanKeyboardCommand
  }),

  [OFFICIAL_PLUGIN_IDS.DOWNLOADS_MANAGER]: Object.freeze({
    id: 'downloads-manager',
    pluginId: 'downloads-manager',
    name: '下载文件夹管家',
    title: '下载文件夹管家',
    description: '一键打开或复制最新下载文件，支持按安装包/压缩包/文档/图片智能归档整理与过期大文件清理',
    category: '办公效率',
    keyword: 'downloads manager folder 下载 文件夹 管家 归档 清理 最新下载 downloads-manager',
    faIcon: 'fa-download',
    version: '1.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: DownloadsManagerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.PROCESS_MONITOR]: Object.freeze({
    id: 'process-monitor',
    pluginId: 'process-monitor',
    name: '系统进程与服务深度监控',
    title: '系统进程与服务深度监控',
    description: '查看正在运行的程序和服务占用的 CPU、内存，可结束程序或打开所在目录',
    category: '系统工具',
    keyword: 'process monitor 进程管理 进程 监控 任务管理器 杀死 结束进程 服务 cpu 内存 process-monitor',
    faIcon: 'fa-tasks',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ProcessMonitorCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SOFTWARE_MANAGER]: Object.freeze({
    id: 'software-manager',
    pluginId: 'software-manager',
    name: '软件管理与卸载中心',
    title: '软件管理与卸载中心',
    description: '列出已安装的软件及占用空间，一键卸载',
    category: '系统工具',
    keyword: 'software manager uninstall 软件 管理 卸载 清理 运行库 体积排行 静默卸载 software-manager',
    faIcon: 'fa-cubes',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SoftwareManagerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CLEANER]: Object.freeze({
    id: 'cleaner',
    pluginId: 'cleaner',
    name: '系统垃圾深度清理',
    title: '系统垃圾深度清理',
    description: '扫描并清理临时文件、系统更新残留、浏览器缓存和日志，释放磁盘空间',
    category: '系统工具',
    keyword: 'cleaner clean 垃圾清理 系统垃圾 临时文件 磁盘清理 缓存 清理 cleaner',
    faIcon: 'fa-trash-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: CleanerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.DISK_ANALYZER]: Object.freeze({
    id: 'disk-analyzer',
    pluginId: 'disk-analyzer',
    name: '磁盘文件空间分析',
    title: '磁盘文件空间分析',
    description: '看看磁盘空间被哪些文件夹和大文件占了，可移到回收站',
    category: '系统工具',
    keyword: 'disk analyzer space 磁盘分析 空间占用 大文件 分区 容量 磁盘清理 disk-analyzer',
    faIcon: 'fa-pie-chart',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: DiskAnalyzerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WECHAT_CLEANER]: Object.freeze({
    id: 'wechat-cleaner',
    pluginId: 'wechat-cleaner',
    name: '微信专项深度清理',
    title: '微信专项深度清理',
    description: '清理微信的图片、视频和小程序缓存，不动聊天记录',
    category: '系统工具',
    keyword: 'wechat cleaner wx 微信清理 微信缓存 朋友圈 聊天记录保护 瘦身 wechat-cleaner',
    faIcon: 'fa-comments',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WechatCleanerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.QQ_CLEANER]: Object.freeze({
    id: 'qq-cleaner',
    pluginId: 'qq-cleaner',
    name: 'QQ 专项深度清理',
    title: 'QQ 专项深度清理',
    description: '清理 QQ 的图片、视频缓存和日志，不动聊天记录',
    category: '系统工具',
    keyword: 'qq cleaner ntqq QQ清理 腾讯文件 群聊缓存 瘦身 qq-cleaner',
    faIcon: 'fa-commenting-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: QQCleanerCommand
  }),

  [OFFICIAL_PLUGIN_IDS.FLOW_GUARD]: Object.freeze({
    id: 'flow-guard',
    pluginId: 'flow-guard',
    name: '网络连接与流量监控',
    title: '网络连接与流量监控',
    description: '查看哪些程序在联网、连到了哪里，可断开可疑程序的网络',
    category: '系统工具',
    keyword: 'flow guard network traffic port 流量监控 网络连接 端口 远端IP 断网拦截 flow-guard',
    faIcon: 'fa-tachometer',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: FlowGuardCommand
  }),

  [OFFICIAL_PLUGIN_IDS.HARDWARE_INFO]: Object.freeze({
    id: 'hardware-info',
    pluginId: 'hardware-info',
    name: '硬件配置与实时遥测',
    title: '硬件配置与实时遥测',
    description: '查看 CPU、内存、硬盘、显示器和电池等硬件信息',
    category: '系统工具',
    keyword: 'hardware info cpu ram gpu display 硬件信息 处理器 内存 显卡 显示器 温度 hardware-info',
    faIcon: 'fa-microchip',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: HardwareInfoCommand
  }),

  [OFFICIAL_PLUGIN_IDS.BOOST]: Object.freeze({
    id: 'boost',
    pluginId: 'boost',
    name: '系统内存与负载加速',
    title: '系统内存与负载加速',
    description: '查看内存占用高的程序，清理临时文件，释放内存',
    category: '系统工具',
    keyword: 'boost memory optimize 加速 内存整理 释放内存 性能优化 系统加速 boost',
    faIcon: 'fa-rocket',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: BoostCommand
  }),

  [OFFICIAL_PLUGIN_IDS.BATCH_RENAME]: Object.freeze({
    id: 'batch-rename',
    pluginId: 'batch-rename',
    name: '批量文件重命名工作台',
    title: '批量文件重命名工作台',
    description: '批量改文件名：加序号、加前后缀、改大小写，改之前先预览',
    category: '办公效率',
    keyword: 'batch rename file 批量重命名 文件改名 序号 前缀 后缀 batch-rename',
    faIcon: 'fa-i-cursor',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: BatchRenameCommand
  }),

  [OFFICIAL_PLUGIN_IDS.BATCH_VIDEO]: Object.freeze({
    id: 'batch-video',
    pluginId: 'batch-video',
    name: '批量视频转码与瘦身',
    title: '批量视频转码与瘦身',
    description: '批量压缩视频、转成 MP4 或 GIF、裁成竖屏',
    category: '图像视频',
    keyword: 'batch video transcode mp4 compress 批量视频 视频压缩 视频转码 水印 gif batch-video',
    faIcon: 'fa-film',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: BatchVideoCommand
  }),

  [OFFICIAL_PLUGIN_IDS.BATCH_AUDIO]: Object.freeze({
    id: 'batch-audio',
    pluginId: 'batch-audio',
    name: '批量音频处理与转码',
    title: '批量音频处理与转码',
    description: '批量转 MP3 或 FLAC，统一音量，去掉首尾静音',
    category: '图像视频',
    keyword: 'batch audio mp3 flac loudnorm 批量音频 音频转码 响度均衡 静音裁剪 batch-audio',
    faIcon: 'fa-music',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: BatchAudioCommand
  }),

  [OFFICIAL_PLUGIN_IDS.PDF]: Object.freeze({
    id: 'pdf',
    pluginId: 'pdf',
    name: 'PDF 多功能转换与合并箱',
    title: 'PDF 多功能转换与合并箱',
    description: 'PDF 转 Word、Excel 或长图，Office 文件转 PDF，合并多个 PDF',
    category: '办公效率',
    keyword: 'pdf word excel merge convert PDF工具箱 PDF转Word PDF合并 文档转换 pdf',
    faIcon: 'fa-file-pdf-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: PdfCommand
  }),

  [OFFICIAL_PLUGIN_IDS.MULTI_DOWNLOAD]: Object.freeze({
    id: 'multi-download',
    pluginId: 'multi-download',
    name: 'Aria2 多线程高速下载',
    title: 'Aria2 多线程高速下载',
    description: '多线程下载文件，自动识别剪贴板里的下载链接',
    category: '网络工具',
    keyword: 'multi download aria2 16线程 多线程下载 高速下载 断点续传 磁力链 multi-download',
    faIcon: 'fa-cloud-download',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: MultiDownloadCommand
  }),

  [OFFICIAL_PLUGIN_IDS.VIDEO_DOWNLOADER]: Object.freeze({
    id: 'video-downloader',
    pluginId: 'video-downloader',
    name: '流媒体音视频解析下载',
    title: '流媒体音视频解析下载',
    description: '粘贴 B 站、抖音、快手、YouTube 等视频链接，下载视频或音频',
    category: '图像视频',
    keyword: 'video downloader bilibili douyin youtube 视频下载 B站下载 抖音去水印 音轨提取 video-downloader',
    faIcon: 'fa-video-camera',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: VideoDownloaderCommand
  }),

  // ==================== 新增 macOS 与跨端第一方内置套件 (macOS & Cross-Platform Built-ins) ====================
  [OFFICIAL_PLUGIN_IDS.APPLE_SHORTCUTS]: Object.freeze({
    id: 'apple-shortcuts',
    pluginId: 'apple-shortcuts',
    name: 'macOS 快捷指令 (Apple Shortcuts)',
    title: 'macOS 快捷指令 (Apple Shortcuts)',
    description: '直连 /usr/bin/shortcuts CLI，检索、带参运行与编辑 macOS 原生快捷指令工作流',
    category: '系统工具',
    keyword: 'apple shortcuts macos 快捷指令 自动化 工作流 siri shortcuts apple-shortcuts',
    faIcon: 'fa-bolt',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: AppleShortcutsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.NAVIGATION]: Object.freeze({
    id: 'navigation',
    pluginId: 'navigation',
    name: '窗口切换与菜单栏搜索 (Navigation)',
    title: '窗口切换与菜单栏搜索 (Navigation)',
    description: '全键盘枚举切换活动窗口 (Switch Windows) 与搜索当前前台应用顶部菜单栏命令 (Search Menu Items)',
    category: '系统工具',
    keyword: 'navigation switch windows menu bar 窗口切换 菜单栏 搜索 聚焦 激活窗口 navigation',
    faIcon: 'fa-compass',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: NavigationCommand
  }),

  [OFFICIAL_PLUGIN_IDS.HOMEBREW]: Object.freeze({
    id: 'homebrew',
    pluginId: 'homebrew',
    name: 'Homebrew 包管理器 (Brew)',
    title: 'Homebrew 包管理器 (Brew)',
    description: 'macOS Formulae & Casks 软件包检索、一键安装、升级、卸载与缓存清理',
    category: '开发工具',
    keyword: 'homebrew brew cask formula macos 包管理器 安装 升级 卸载 软件源 homebrew',
    faIcon: 'fa-beer',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: HomebrewCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SCRIPT_COMMANDS]: Object.freeze({
    id: 'script-commands',
    pluginId: 'script-commands',
    name: '自定义脚本命令 (Script Commands)',
    title: '自定义脚本命令 (Script Commands)',
    description: '兼容 @raycast.* 注释规范，支持 Bash/Zsh/AppleScript/Python/Node/PowerShell 脚本模板创建与秒级执行',
    category: '开发工具',
    keyword: 'script commands bash zsh applescript python 自定义脚本 命令行 自动化 script-commands',
    faIcon: 'fa-terminal',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ScriptCommandsCommand
  }),

  [OFFICIAL_PLUGIN_IDS.RAYCAST_FOCUS]: Object.freeze({
    id: 'raycast-focus',
    pluginId: 'raycast-focus',
    name: '心流专注与防分心时钟 (Focus)',
    title: '心流专注与防分心时钟 (Focus)',
    description: '极客番茄钟、自定义专注分类、干扰应用与分心网站屏蔽及连续专注统计',
    category: '办公效率',
    keyword: 'focus pomodoro timer 专注 番茄钟 心流 屏蔽 分心 倒计时 raycast-focus',
    faIcon: 'fa-bullseye',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: RaycastFocusCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CALENDAR]: Object.freeze({
    id: 'calendar',
    pluginId: 'calendar',
    name: '日程表与视频会议直达 (Calendar)',
    title: '日程表与视频会议直达 (Calendar)',
    description: '今日与近期日程速览 (My Schedule)、Zoom/飞书/Meet 会议链接一键入会、新建日程与 ICS 导出',
    category: '办公效率',
    keyword: 'calendar schedule meeting 日程 日历 会议 飞书 zoom 提醒 ics calendar',
    faIcon: 'fa-calendar',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: CalendarCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WEB_SEARCHES]: Object.freeze({
    id: 'web-searches',
    pluginId: 'web-searches',
    name: '全网多源搜索与浏览器标签中枢',
    title: '全网多源搜索与浏览器标签中枢',
    description: 'Google/GitHub/知乎/B站/MDN 多引擎秒搜、Safari/Chrome/Arc 当前活动标签页嗅探与通讯录速查',
    category: '网络工具',
    keyword: 'web searches browser contacts 网页搜索 搜索引擎 浏览器标签 通讯录 联系人 web-searches',
    faIcon: 'fa-globe',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '内置核心',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WebSearchesCommand
  }),

  // ==================== 补齐 35 款本地原生标杆插件全集 (35 Local Native Suite) ====================
  [OFFICIAL_PLUGIN_IDS.NETWORK_ADAPTER]: Object.freeze({
    id: 'network-adapter',
    pluginId: 'network-adapter',
    name: '网络适配器与网卡管家',
    title: '网络适配器与网卡管家',
    description: '查看本机物理与虚拟网卡 IPv4/IPv6、MAC 地址、网关与 DNS，一键复制配置或刷新 DNS 缓存',
    category: '网络工具',
    keyword: 'network adapter nic ip mac dns 网卡 网络适配器 以太网 wifi 虚拟网卡 network-adapter',
    faIcon: 'fa-sitemap',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: NetworkAdapterCommand
  }),

  [OFFICIAL_PLUGIN_IDS.NETWORK_RESCUE]: Object.freeze({
    id: 'network-rescue',
    pluginId: 'network-rescue',
    name: '断网急救与协议栈修复',
    title: '断网急救与协议栈修复',
    description: '一键诊断并修复 DNS 解析异常、残留系统代理拦截、Winsock 协议栈损坏与 Hosts 劫持',
    category: '网络工具',
    keyword: 'network rescue repair dns winsock proxy 断网急救 网络修复 无法上网 代理清除 network-rescue',
    faIcon: 'fa-medkit',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: NetworkRescueCommand
  }),

  [OFFICIAL_PLUGIN_IDS.CONTEXT_MENU]: Object.freeze({
    id: 'context-menu',
    pluginId: 'context-menu',
    name: '系统右键菜单管理',
    title: '系统右键菜单管理',
    description: '扫描并启用/禁用文件、目录与桌面右键菜单扩展项，一键切换 Windows 11 经典完整右键菜单',
    category: '系统工具',
    keyword: 'context menu shell right click 右键菜单 经典菜单 注册表扩展 context-menu',
    faIcon: 'fa-bars',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ContextMenuCommand
  }),

  [OFFICIAL_PLUGIN_IDS.WECHAT_MULTI]: Object.freeze({
    id: 'wechat-multi',
    pluginId: 'wechat-multi',
    name: '微信双开分身与实例监控',
    title: '微信双开分身与实例监控',
    description: '突破单实例互斥锁一键启动全新微信分身，实时监控各微信主进程与小程序容器内存占用',
    category: '办公效率',
    keyword: 'wechat multi instance 微信多开 微信双开 微信分身 小程序内存 wechat-multi',
    faIcon: 'fa-weixin',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: WechatMultiCommand
  }),

  [OFFICIAL_PLUGIN_IDS.LAN_SHARE]: Object.freeze({
    id: 'lan-share',
    pluginId: 'lan-share',
    name: '局域网文件快传与扫码投送',
    title: '局域网文件快传与扫码投送',
    description: '将本机文件或剪贴板生成局域网 HTTP 免密直连地址与二维码，手机同一 Wi-Fi 扫码即下',
    category: '网络工具',
    keyword: 'lan share airdrop qrcode 局域网快传 内网共享 扫码传文件 隔空投送 lan-share',
    faIcon: 'fa-share-alt',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: LanShareCommand
  }),

  [OFFICIAL_PLUGIN_IDS.MOVER]: Object.freeze({
    id: 'mover',
    pluginId: 'mover',
    name: 'C 盘大目录无损搬家',
    title: 'C 盘大目录无损搬家',
    description: '基于 NTFS Junction 目录联接将微信、QQ、下载目录与开发缓存无损迁移至其他盘符并释放 C 盘空间',
    category: '系统工具',
    keyword: 'mover junction mklink c盘搬家 目录迁移 软件搬家 符号链接 mover',
    faIcon: 'fa-truck',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: MoverCommand
  }),

  [OFFICIAL_PLUGIN_IDS.DATA_RECOVERY]: Object.freeze({
    id: 'data-recovery',
    pluginId: 'data-recovery',
    name: '误删文件与回收站恢复',
    title: '误删文件与回收站恢复',
    description: '深度扫描回收站、临时副本与近期误删文件，按扇区完整度评估并一键恢复至原路径或桌面',
    category: '系统工具',
    keyword: 'data recovery undelete restore 数据恢复 文件恢复 误删恢复 回收站恢复 data-recovery',
    faIcon: 'fa-history',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: DataRecoveryCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SHREDDER]: Object.freeze({
    id: 'shredder',
    pluginId: 'shredder',
    name: '机密文件安全粉碎箱',
    title: '机密文件安全粉碎箱',
    description: '采用 DoD 5220.22-M / Gutmann 多重随机覆写算法彻底销毁机密文件，防止被恢复软件还原',
    category: '安全隐私',
    keyword: 'shredder wipe secure delete 文件粉碎 彻底删除 安全擦除 防恢复 shredder',
    faIcon: 'fa-eraser',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: ShredderCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SYSTEM_BACKUP]: Object.freeze({
    id: 'system-backup',
    pluginId: 'system-backup',
    name: '系统与开发配置备份中心',
    title: '系统与开发配置备份中心',
    description: '一键打包备份与回滚 Hosts、环境变量、SSH 密钥配置、Git 配置与 VSCode/终端偏好',
    category: '系统工具',
    keyword: 'system backup restore dotfiles 系统备份 配置备份 环境变量备份 快照还原 system-backup',
    faIcon: 'fa-archive',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SystemBackupCommand
  }),

  [OFFICIAL_PLUGIN_IDS.SQLITE_PLUGIN]: Object.freeze({
    id: 'sqlite-plugin',
    pluginId: 'sqlite-plugin',
    name: 'SQLite 数据库透视与导出',
    title: 'SQLite 数据库透视与导出',
    description: '浏览本机 SQLite 数据库表结构、索引与数据行，支持勾选记录导出 JSON / CSV / SQL INSERT',
    category: '开发工具',
    keyword: 'sqlite database db table sql 数据库 浏览 导出 sqlite-plugin',
    faIcon: 'fa-database',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: SqlitePluginCommand
  }),

  [OFFICIAL_PLUGIN_IDS.AI_IMAGE]: Object.freeze({
    id: 'ai-image',
    pluginId: 'ai-image',
    name: 'AI 图像超分与抠图工作台',
    title: 'AI 图像超分与抠图工作台',
    description: '集成 Real-ESRGAN 4倍无损超分放大、RMBG 智能去背景与人像画质修复批量处理队列',
    category: '图像视频',
    keyword: 'ai image upscale removebg AI图像 超分放大 智能抠图 去背景 画质修复 ai-image',
    faIcon: 'fa-picture-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: AiImageCommand
  }),

  [OFFICIAL_PLUGIN_IDS.AI_VIDEO]: Object.freeze({
    id: 'ai-video',
    pluginId: 'ai-video',
    name: 'AI 视频补帧与超分工作台',
    title: 'AI 视频补帧与超分工作台',
    description: '基于 RIFE 光流补帧至 60/120FPS 与 Real-CUGAN 视频超分至 4K UHD 的批量增强工作台',
    category: '图像视频',
    keyword: 'ai video rife upscale 60fps AI视频 视频补帧 视频超分 画质增强 ai-video',
    faIcon: 'fa-film',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: AiVideoCommand
  }),

  [OFFICIAL_PLUGIN_IDS.OCR]: Object.freeze({
    id: 'ocr',
    pluginId: 'ocr',
    name: '多语言离线图片 OCR 工作台',
    title: '多语言离线图片 OCR 工作台',
    description: '批量识别本机截图与图片中的中英日韩文字、代码段与 Markdown 表格，一键写入剪贴板',
    category: '办公效率',
    keyword: 'ocr text recognition 文字识别 截图识字 提取文字 表格识别 ocr',
    faIcon: 'fa-file-text-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: OcrCommand
  }),

  [OFFICIAL_PLUGIN_IDS.RECORD]: Object.freeze({
    id: 'record',
    pluginId: 'record',
    name: '高清屏幕录制与内录工作台',
    title: '高清屏幕录制与内录工作台',
    description: '支持 60FPS 全屏/区域/窗口硬件编码录屏、WASAPI 系统内录混音与高清 GIF 动图直出',
    category: '图像视频',
    keyword: 'record screen capture video 录屏 屏幕录制 系统内录 录像管理 record',
    faIcon: 'fa-dot-circle-o',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: RecordCommand
  }),

  [OFFICIAL_PLUGIN_IDS.FILE_COMPARE]: Object.freeze({
    id: 'file-compare',
    pluginId: 'file-compare',
    name: '双文件哈希与 Diff 比对工作台',
    title: '双文件哈希与 Diff 比对工作台',
    description: '双目录/双文件 SHA-256 字节级哈希校验与代码文本逐行 Diff 差异对比工作台',
    category: '开发工具',
    keyword: 'file compare diff sha256 hash 文件比对 文件夹对比 差异对比 哈希校验 file-compare',
    faIcon: 'fa-columns',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: FileCompareCommand
  })
})

/**
 * 35 款本地插件常用别名映射表 (Canonical Alias Map)
 */
export const OFFICIAL_PLUGIN_ALIASES = Object.freeze({
  'clipboard-manager': OFFICIAL_PLUGIN_IDS.CLIPBOARD_HISTORY,
  'everything-search': OFFICIAL_PLUGIN_IDS.EVERYTHING_SEARCH,
  'window-manager': OFFICIAL_PLUGIN_IDS.WINDOW_MANAGEMENT,
  'system-tools': OFFICIAL_PLUGIN_IDS.SYSTEM,
  screenshot: OFFICIAL_PLUGIN_IDS.SCREENSHOTS,
  'screen-color-picker': OFFICIAL_PLUGIN_IDS.COLOR_PICKER
})

/**
 * 官方标杆应用列表 (Array)
 */
export const OFFICIAL_PLUGINS_LIST = Object.freeze(Object.values(OFFICIAL_PLUGINS_MAP))

/**
 * 判断是否为官方内置或官方商店标杆应用
 * @param {string} pluginId
 * @returns {boolean}
 */
export function isOfficialPlugin(pluginId) {
  if (!pluginId || typeof pluginId !== 'string') return false
  const normalized = pluginId.trim().toLowerCase()
  const resolved = OFFICIAL_PLUGIN_ALIASES[normalized] || normalized
  // 与内置原版插件同 ID 的旧实现让位给原版
  if (isBundledPlugin(normalized) || isBundledPlugin(resolved)) return false
  return Boolean(
    OFFICIAL_PLUGINS_MAP[resolved] ||
    OFFICIAL_PLUGINS_MAP[pluginId.trim()]
  )
}

/**
 * 获取官方应用定义
 * @param {string} pluginId
 * @returns {typeof OFFICIAL_PLUGINS_MAP[string] | undefined}
 */
export function getOfficialPlugin(pluginId) {
  if (!pluginId || typeof pluginId !== 'string') return undefined
  const normalized = pluginId.trim().toLowerCase()
  const resolved = OFFICIAL_PLUGIN_ALIASES[normalized] || normalized
  if (isBundledPlugin(normalized) || isBundledPlugin(resolved)) return undefined
  return OFFICIAL_PLUGINS_MAP[resolved] || OFFICIAL_PLUGINS_MAP[pluginId.trim()]
}

/**
 * 获取全量官方应用清单副本
 * @returns {Array<typeof OFFICIAL_PLUGINS_MAP[string]>}
 */
export function getOfficialPluginsList() {
  return OFFICIAL_PLUGINS_LIST.filter((p) => !isBundledPlugin(p.pluginId))
}


