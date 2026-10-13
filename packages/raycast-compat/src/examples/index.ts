// 1. JSON 格式化与类型转换
export { default as JsonFormatCommand, JsonDetailView } from "./json-format/index.js";
export * from "./json-format/logic.js";

// 2. 二维码生成与管理
export { default as QrCodeCommand, QrDetailView, CreateQrForm, DecodeQrView } from "./qr-code/index.js";
export * from "./qr-code/qr-generator.js";

// 3. GitHub 仪表盘
export { default as GithubDashboardCommand, GithubDetailView } from "./github/index.js";
export * from "./github/types.js";
export * from "./github/data.js";

// 4. Google 多语言即时翻译
export { default as GoogleTranslateCommand, TranslateDetailView } from "./google-translate/index.js";
export * from "./google-translate/languages.js";
export * from "./google-translate/translate.js";

// 5. 调色板与色彩转换器
export { default as ColorPickerCommand, ColorDetailView } from "./color-picker/index.js";
export * from "./color-picker/converter.js";

// 6. Obsidian 知识库管理
export { default as ObsidianCommand, ObsidianNoteDetailView, ObsidianQuickNoteForm } from "./obsidian/index.js";
export * from "./obsidian/types.js";
export * from "./obsidian/vault.js";

// 7. 网络与 IP 诊断 (Speedtest)
export { default as SpeedtestCommand, SpeedtestDetailView } from "./speedtest/index.js";
export * from "./speedtest/diagnostic.js";

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
export { default as SnippetsCommand, SnippetDetailView, CreateSnippetForm, ImportSnippetsForm } from "./snippets/index.js";
export * from "./snippets/types.js";
export * from "./snippets/snippets-storage.js";

// 14. 官方内置核心能力: Window Management 窗口管理器 (Win32 SetWindowPos 下沉)
export { default as WindowManagementCommand, WindowActionDetailView, WindowPreferencesForm } from "./window-management/index.js";
export * from "./window-management/types.js";
export * from "./window-management/window-actions.js";

// 15. 官方内置核心能力: 计算器与色彩速查 (Calculator & Color Inspector)
export { default as CalculatorCommand } from "./calculator/index.js";
export * from "./calculator/calculator-engine.js";

// 16. 官方内置核心能力: Windows 原生运维动作 (System Actions)
export { default as SystemCommand } from "./system/index.js";
export * from "./system/system-actions.js";

// 17. 官方内置核心能力: 快捷直达链接 (Quicklinks)
export { default as QuicklinksCommand, CreateQuicklinkForm, EditQuicklinkForm, ImportQuicklinksForm } from "./quicklinks/index.js";
export * from "./quicklinks/types.js";
export * from "./quicklinks/quicklinks-storage.js";

// 18. M1.5 官方系统治理与偏好设置: Settings (Raycast Settings 9 大分类)
export { default as SettingsCommand, SettingsFormView } from "./settings/index.js";
export * from "./settings/types.js";
export * from "./settings/settings-storage.js";

// 19. M1.5 核心系统与极客账户: Core & Account (Release Notes, 更新检查, 会话维护)
export { default as RaycastCoreCommand, RaycastAccountCommand } from "./core-account/index.js";
export * from "./core-account/types.js";
export * from "./core-account/core-service.js";

// 20. M1.5 商业与团队协同: Organizations (Raycast for Teams, 成员架构, 共享短语, Webhooks)
export { default as OrganizationsCommand } from "./organizations/index.js";
export * from "./organizations/types.js";
export * from "./organizations/organizations-storage.js";

// 21. M1.5 极客数据大盘与自动化: Wrapped, Trial Nudges & Shortcuts (Windows 快捷指令)
export { default as RaycastWrappedCommand, TrialNudgesCommand, WindowsShortcutsCommand } from "./wrapped-nudges-shortcuts/index.js";
export * from "./wrapped-nudges-shortcuts/types.js";
export * from "./wrapped-nudges-shortcuts/engine.js";

// 22. M1.5 第二组高频应用: Emoji & Symbols (表情与特殊符号)
export { default as EmojiPickerCommand, EmojiDetailView } from "./emoji-picker/index.js";
export * from "./emoji-picker/types.js";
export * from "./emoji-picker/data.js";
export * from "./emoji-picker/search.js";
export * from "./emoji-picker/storage.js";

// 23. M1.5 第二组高频应用: Translator (多语言即时翻译)
export { default as TranslatorCommand } from "./translator/index.js";

// 24. M1.5 第二组高频应用: Notes (极简便签记事)
export { default as NotesCommand, NoteDetailView, NoteCreateForm, NoteEditForm } from "./notes/index.js";
export * from "./notes/types.js";
export * from "./notes/notes-storage.js";

// 25. M1.5 第二组高频应用: Windows Run (Windows 运行中枢)
export { default as WindowsRunCommand } from "./windows-run/index.js";
export * from "./windows-run/types.js";
export * from "./windows-run/run-service.js";

// 26. M1.5 第二组高频应用: Windows Taskbar (任务栏显隐控制)
export { default as WindowsTaskbarCommand } from "./windows-taskbar/index.js";
export * from "./windows-taskbar/types.js";
export * from "./windows-taskbar/taskbar-service.js";

// 27. M1.5 第二组高频应用: Screenshots (截图管理与回贴)
export { default as ScreenshotsCommand, ScreenshotDetailView } from "./screenshots/index.js";
export * from "./screenshots/types.js";
export * from "./screenshots/screenshots-service.js";

// 28. M1.5 第二组高频应用: Applications (已装应用管理与卸载)
export { default as ApplicationsCommand, AppDetailView } from "./applications/index.js";
export * from "./applications/types.js";
export * from "./applications/applications-service.js";

// 29. M1.5 第二组高频应用: Dictionary (英汉双解科技词典)
export { default as DictionaryCommand, WordDetailView } from "./dictionary/index.js";
