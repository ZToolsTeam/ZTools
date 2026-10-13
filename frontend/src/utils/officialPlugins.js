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
  DictionaryCommand
} from '@ztools/raycast-compat'

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

  // M1.5 第二组: 高频核心内置应用 (Group 2 Built-in Apps)
  EMOJI_PICKER: 'emoji-picker',
  TRANSLATOR: 'translator',
  NOTES: 'notes',
  WINDOWS_RUN: 'windows-run',
  WINDOWS_TASKBAR: 'windows-taskbar',
  SCREENSHOTS: 'screenshots',
  APPLICATIONS: 'applications',
  DICTIONARY: 'dictionary',

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
    keyword: 'settings preferences 偏好设置 系统设置 主题 快捷键 同步 代理 raycast-settings',
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
    keyword: 'core update release notes changelog 公告 更新 版本 升级 raycast-core',
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
    keyword: 'account user profile token 账户 用户 授权 密钥 raycast-account',
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
    keyword: 'wrapped review report 战报 年度 报告 极客 统计 raycast-wrapped',
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

