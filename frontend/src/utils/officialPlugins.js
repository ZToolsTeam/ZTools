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
  VideoDownloaderCommand
} from '@ztools/declarative-ui'

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
    iconGradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
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
    iconGradient: 'linear-gradient(135deg, #8b5cf6, #a78bfa)',
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
    iconGradient: 'linear-gradient(135deg, #3b82f6, #60a5fa)',
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
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
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
    description: '安全实时数学表达式估值 + Hex/RGB/HSL/CMYK 色彩实时双向转换与对比度评级',
    category: '办公效率',
    keyword: 'calculator math color 计算器 算术 颜色 换算 估值 calculator',
    faIcon: 'fa-calculator',
    iconGradient: 'linear-gradient(135deg, #10b981, #34d399)',
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
    description: '锁屏、关机、重启、清空回收站、静音、调音量等 Win32 原生系统快捷指令',
    category: '系统工具',
    keyword: 'system power 关机 重启 锁屏 清空回收站 静音 运维 win32 system',
    faIcon: 'fa-cogs',
    iconGradient: 'linear-gradient(135deg, #64748b, #94a3b8)',
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
    description: '支持 {query} 模板参数与别名触发的常用网站/应用极速直达引擎',
    category: '办公效率',
    keyword: 'quicklinks link 直达 网址 书签 别名 quicklink quicklinks',
    faIcon: 'fa-link',
    iconGradient: 'linear-gradient(135deg, #ec4899, #f472b6)',
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
    iconGradient: 'linear-gradient(135deg, #ef4444, #f87171)',
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
    description: 'JSON 实时校验、2/4空格美化、单行压缩与 TypeScript Interface 递归推导',
    category: '办公效率',
    keyword: 'json format ts typescript 格式化 校验 压缩 接口推导 json-format',
    faIcon: 'fa-code',
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
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
    iconGradient: 'linear-gradient(135deg, #10b981, #34d399)',
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
    description: 'Hex/RGB/HSL/CMYK 双向转换、WCAG 2.1 对比度评级与调色板历史',
    category: '媒体处理',
    keyword: 'color picker 色彩 调色板 拾色器 hex rgb hsl cmyk 颜色',
    faIcon: 'fa-eyedropper',
    iconGradient: 'linear-gradient(135deg, #ec4899, #f472b6)',
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
    description: '多语言即时互译、音标发音与本地翻译历史持久化',
    category: '办公效率',
    keyword: 'translate 翻译 词典 英语 日语 语言 fanyi google-translate',
    faIcon: 'fa-language',
    iconGradient: 'linear-gradient(135deg, #3b82f6, #60a5fa)',
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
    iconGradient: 'linear-gradient(135deg, #475569, #64748b)',
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
    iconGradient: 'linear-gradient(135deg, #0284c7, #38bdf8)',
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
    iconGradient: 'linear-gradient(135deg, #6366f1, #818cf8)',
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
    iconGradient: 'linear-gradient(135deg, #8b5cf6, #c084fc)',
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
    iconGradient: 'linear-gradient(135deg, #eab308, #facc15)',
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
    iconGradient: 'linear-gradient(135deg, #f97316, #fb923c)',
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
    title: 'Windows 快捷指令 (Apple Shortcuts 兼容)',
    description: '映射 Windows 自定义快捷命令与 Task Scheduler 极客自动化，刷新 DNS / 重启资源管理器',
    category: '系统工具',
    keyword: 'shortcuts apple-shortcuts windows automation 快捷指令 自动化 脚本 powershell cmd',
    faIcon: 'fa-bolt',
    iconGradient: 'linear-gradient(135deg, #ec4899, #f472b6)',
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
    description: '多语言与拼音 Emoji 极速检索、分类过滤、肤色修饰与高频收藏',
    category: '办公效率',
    keyword: 'emoji biaoqing 符号 表情 symbol picker 表情包 emoji-picker',
    faIcon: 'fa-smile-o',
    iconGradient: 'linear-gradient(135deg, #f59e0b, #fbbf24)',
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
    iconGradient: 'linear-gradient(135deg, #3b82f6, #60a5fa)',
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
    description: '极简临时 Markdown 便签、SQLite WAL 存储、置顶加星与回收站管理',
    category: '办公效率',
    keyword: 'notes note 便签 记事 备忘 草稿 bianqian notes',
    faIcon: 'fa-sticky-note-o',
    iconGradient: 'linear-gradient(135deg, #10b981, #34d399)',
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
    description: 'Windows 运行命令增强、系统内置 30+ 运维别名、管理员提权执行与自定义别名',
    category: '系统工具',
    keyword: 'run yongxing 运行 windows-run cmd powershell control regedit gpedit 系统命令',
    faIcon: 'fa-terminal',
    iconGradient: 'linear-gradient(135deg, #6366f1, #818cf8)',
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
    description: 'Win32 原生任务栏显隐切换、沉浸全屏模式调度与 HUD 状态感知反馈',
    category: '系统工具',
    keyword: 'taskbar renwulan 任务栏 隐藏 显示 全屏 windows-taskbar',
    faIcon: 'fa-window-maximize',
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
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
    iconGradient: 'linear-gradient(135deg, #ec4899, #f472b6)',
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
    iconGradient: 'linear-gradient(135deg, #8b5cf6, #c084fc)',
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
    iconGradient: 'linear-gradient(135deg, #14b8a6, #2dd4bf)',
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
    iconGradient: 'linear-gradient(135deg, #6366f1, #818cf8)',
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
    iconGradient: 'linear-gradient(135deg, #8b5cf6, #a78bfa)',
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
    iconGradient: 'linear-gradient(135deg, #f97316, #fb923c)',
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
    description: 'Windows 官方包管理器图形界面，极速安装、更新与卸载常用软件',
    category: '系统工具',
    keyword: 'winget package install app 软件 管理器 安装 卸载 更新',
    faIcon: 'fa-cube',
    iconGradient: 'linear-gradient(135deg, #06b6d4, #22d3ee)',
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
    iconGradient: 'linear-gradient(135deg, #14b8a6, #2dd4bf)',
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
    iconGradient: 'linear-gradient(135deg, #2563eb, #60a5fa)',
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
    iconGradient: 'linear-gradient(135deg, #059669, #34d399)',
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
    iconGradient: 'linear-gradient(135deg, #7c3aed, #a78bfa)',
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
    iconGradient: 'linear-gradient(135deg, #ea580c, #fb923c)',
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
    iconGradient: 'linear-gradient(135deg, #0284c7, #38bdf8)',
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
    description: '实时 CPU/内存大盘看板、多维分段过滤、进程树与句柄详情、关联服务穿透、安全防误杀防护与定位程序目录',
    category: '系统工具',
    keyword: 'process monitor 进程管理 进程 监控 任务管理器 杀死 结束进程 服务 cpu 内存 process-monitor',
    faIcon: 'fa-tasks',
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
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
    description: '扫描系统已安装软件、磁盘空间占用排行、一键静默卸载、注册表项查看与底层运行库依赖保护',
    category: '系统工具',
    keyword: 'software manager uninstall 软件 管理 卸载 清理 运行库 体积排行 静默卸载 software-manager',
    faIcon: 'fa-cubes',
    iconGradient: 'linear-gradient(135deg, #6366f1, #818cf8)',
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
    description: '智能扫描系统临时文件、Windows 更新残留、浏览器缓存、崩溃转储与日志碎片，安全释放磁盘空间',
    category: '系统工具',
    keyword: 'cleaner clean 垃圾清理 系统垃圾 临时文件 磁盘清理 缓存 清理 cleaner',
    faIcon: 'fa-trash-o',
    iconGradient: 'linear-gradient(135deg, #10b981, #059669)',
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
    description: '本机真实物理分区容量透视、热点目录大文件体积排行、扩展名空间分布与安全移入回收站',
    category: '系统工具',
    keyword: 'disk analyzer space 磁盘分析 空间占用 大文件 分区 容量 磁盘清理 disk-analyzer',
    faIcon: 'fa-pie-chart',
    iconGradient: 'linear-gradient(135deg, #2563eb, #60a5fa)',
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
    description: '真实扫描本机 WeChat Files / xwechat 缓存、朋友圈视频与小程序残留，严密保护 MSG.db 聊天记录库',
    category: '系统工具',
    keyword: 'wechat cleaner wx 微信清理 微信缓存 朋友圈 聊天记录保护 瘦身 wechat-cleaner',
    faIcon: 'fa-comments',
    iconGradient: 'linear-gradient(135deg, #059669, #34d399)',
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
    description: '真实扫描本机 Tencent Files / NTQQ 群聊缩略图、短视频缓存与运行日志，严密保护 Msg3.0.db 加密库',
    category: '系统工具',
    keyword: 'qq cleaner ntqq QQ清理 腾讯文件 群聊缓存 瘦身 qq-cleaner',
    faIcon: 'fa-commenting-o',
    iconGradient: 'linear-gradient(135deg, #0284c7, #38bdf8)',
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
    description: '真实聚合本机 TCP/UDP 活跃套接字与进程列表，审查远端连接 IP、监听端口并支持一键阻断异常联网进程',
    category: '系统工具',
    keyword: 'flow guard network traffic port 流量监控 网络连接 端口 远端IP 断网拦截 flow-guard',
    faIcon: 'fa-tachometer',
    iconGradient: 'linear-gradient(135deg, #0d9488, #2dd4bf)',
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
    description: '真实读取本机 CPU 微架构、物理内存工作集、全量存储卷、多显示器分辨率刷新率与电源状态',
    category: '系统工具',
    keyword: 'hardware info cpu ram gpu display 硬件信息 处理器 内存 显卡 显示器 温度 hardware-info',
    faIcon: 'fa-microchip',
    iconGradient: 'linear-gradient(135deg, #4f46e5, #818cf8)',
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
    description: '实时监控物理内存负载与高占用后台进程，支持一键清理系统 %TEMP% 热点残留与安全释放内存',
    category: '系统工具',
    keyword: 'boost memory optimize 加速 内存整理 释放内存 性能优化 系统加速 boost',
    faIcon: 'fa-rocket',
    iconGradient: 'linear-gradient(135deg, #ea580c, #fb923c)',
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
    description: '加载本机真实目录文件，支持序号递增、前缀/后缀注入与大小写规范，实时新旧命名 Diff 预览与原子改名',
    category: '办公效率',
    keyword: 'batch rename file 批量重命名 文件改名 序号 前缀 后缀 batch-rename',
    faIcon: 'fa-i-cursor',
    iconGradient: 'linear-gradient(135deg, #7c3aed, #a78bfa)',
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
    description: '扫描本机视频与下载目录媒体文件，支持 H.264 CRF23 智能压缩、MP4 封装转换、9:16 竖屏裁剪与转 GIF',
    category: '图像视频',
    keyword: 'batch video transcode mp4 compress 批量视频 视频压缩 视频转码 水印 gif batch-video',
    faIcon: 'fa-film',
    iconGradient: 'linear-gradient(135deg, #db2777, #f472b6)',
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
    description: '扫描本机音乐与下载目录音轨，支持 MP3 320kbps、无损 FLAC、EBU R128 (-16 LUFS) 响度标准化与静音切除',
    category: '图像视频',
    keyword: 'batch audio mp3 flac loudnorm 批量音频 音频转码 响度均衡 静音裁剪 batch-audio',
    faIcon: 'fa-music',
    iconGradient: 'linear-gradient(135deg, #059669, #10b981)',
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
    description: '扫描本机文档目录，支持 PDF 转可编辑 Word/Excel、300DPI 高清长图导出、Office 转 PDF 与无损合并',
    category: '办公效率',
    keyword: 'pdf word excel merge convert PDF工具箱 PDF转Word PDF合并 文档转换 pdf',
    faIcon: 'fa-file-pdf-o',
    iconGradient: 'linear-gradient(135deg, #dc2626, #f87171)',
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
    description: '16 线程分块并发加速、剪贴板下载链接自动嗅探、本机 Downloads 文件分类管理与磁盘容量预检',
    category: '网络工具',
    keyword: 'multi download aria2 16线程 多线程下载 高速下载 断点续传 磁力链 multi-download',
    faIcon: 'fa-cloud-download',
    iconGradient: 'linear-gradient(135deg, #2563eb, #38bdf8)',
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
    description: '支持 Bilibili、抖音无水印、快手、YouTube 等 6 大平台链接智能识别、4K 60fps 音画合并与无损音频提取',
    category: '图像视频',
    keyword: 'video downloader bilibili douyin youtube 视频下载 B站下载 抖音去水印 音轨提取 video-downloader',
    faIcon: 'fa-video-camera',
    iconGradient: 'linear-gradient(135deg, #ec4899, #8b5cf6)',
    version: '2.0.0',
    author: 'ZTools Official',
    badge: '2.0标杆',
    isBuiltin: true,
    isDeclarative: true,
    enabled: true,
    command: VideoDownloaderCommand
  })
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
  let normalized = pluginId.trim().toLowerCase()
  if (normalized === 'apple-shortcuts') normalized = 'windows-shortcuts'
  return Boolean(
    OFFICIAL_PLUGINS_MAP[normalized] ||
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
  let normalized = pluginId.trim().toLowerCase()
  if (normalized === 'apple-shortcuts') normalized = 'windows-shortcuts'
  return OFFICIAL_PLUGINS_MAP[normalized] || OFFICIAL_PLUGINS_MAP[pluginId.trim()]
}

/**
 * 获取全量官方应用清单副本
 * @returns {Array<typeof OFFICIAL_PLUGINS_MAP[string]>}
 */
export function getOfficialPluginsList() {
  return [...OFFICIAL_PLUGINS_LIST]
}

