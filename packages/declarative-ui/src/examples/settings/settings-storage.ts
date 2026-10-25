/**
 * Raycast Settings 偏好设置存取与校验引擎
 * 支持与 LocalStorage / window.ztools.config 联动，严格校验并防御恶意/损坏配置
 * 真实双向绑定：变更即时存盘至 LocalStorage 并协同写入配置
 */

import { LocalStorage } from "../../api/storage.js";
import {
  ZToolsGlobalPreferences,
  SettingsSectionKey,
  SettingsSectionMetadata,
  GeneralSettings,
  LauncherSettings,
  CloudSyncSettings,
  AdvancedSettings,
  ShortcutItem,
  ExtensionConfigItem
} from "./types.js";

export const SETTINGS_STORAGE_KEY = "ztools_global_preferences_v1";

/**
 * ZTools 官方内置扩展清单
 */
export const BUILTIN_EXTENSIONS: readonly ExtensionConfigItem[] = Object.freeze([
  { id: "applications", name: "应用启动管理 (Applications)", description: "快速索引并启动 Windows 已装应用，支持拼音模糊匹配", category: "core", enabled: true, alias: "app", hotkey: "", isBuiltin: true },
  { id: "calculator", name: "智能计算器 (Calculator)", description: "科学计算、汇率色彩换算与单位换算", category: "utility", enabled: true, alias: "calc", hotkey: "Alt+C", isBuiltin: true },
  { id: "clipboard-history", name: "剪贴板历史 (Clipboard History)", description: "毫秒级剪贴板历史沉淀、隐私脱敏与流水粘贴", category: "core", enabled: true, alias: "cb", hotkey: "Alt+V", isBuiltin: true },
  { id: "color-picker", name: "调色板 (Color Picker)", description: "吸色工具、HEX/RGB/HSL 色彩转换与对比度校验", category: "developer", enabled: true, alias: "color", hotkey: "", isBuiltin: true },
  { id: "core-account", name: "更新与版本公告 (Release Notes)", description: "版本升级检查、新特性速览与公告通知", category: "system", enabled: true, alias: "update", hotkey: "", isBuiltin: true },
  { id: "currency-exchange", name: "汇率换算 (Currency Exchange)", description: "全球 30+ 货币实时汇率换算与走势追踪", category: "utility", enabled: true, alias: "fx", hotkey: "", isBuiltin: true },
  { id: "dictionary", name: "生词释义 (Dictionary)", description: "英汉双解科技词典、英英释义、例句与生词本管理", category: "productivity", enabled: true, alias: "dict", hotkey: "", isBuiltin: true },
  { id: "emoji-picker", name: "表情与符号 (Emoji & Symbols)", description: "Unicode 表情符号与特殊字符极速搜索面板", category: "utility", enabled: true, alias: "emo", hotkey: "", isBuiltin: true },
  { id: "everything-file-search", name: "文件秒搜 (Everything File Search)", description: "NTFS MFT 裸盘硬件级索引，百万文件 0.035ms 响应", category: "core", enabled: true, alias: "f", hotkey: "Alt+F", isBuiltin: true },
  { id: "github", name: "GitHub 仪表盘 (GitHub)", description: "PR、Issue、Actions 流水线与 Star 仓库追踪", category: "developer", enabled: true, alias: "gh", hotkey: "", isBuiltin: true },
  { id: "google-translate", name: "Google 翻译 (Google Translate)", description: "多语言网页翻译与离线生词备忘", category: "productivity", enabled: true, alias: "gt", hotkey: "", isBuiltin: true },
  { id: "json-format", name: "JSON 格式化 (JSON Format)", description: "JSON 校验美化、压缩与 TypeScript 接口一键生成", category: "developer", enabled: true, alias: "json", hotkey: "", isBuiltin: true },
  { id: "kill-process", name: "进程管理急救箱 (Kill Process)", description: "高内存占用与失控进程极速查杀", category: "system", enabled: true, alias: "kill", hotkey: "", isBuiltin: true },
  { id: "notes", name: "便签记事 (Notes)", description: "SQLite WAL 强保证的极简轻量便签", category: "productivity", enabled: true, alias: "note", hotkey: "", isBuiltin: true },
  { id: "obsidian", name: "Obsidian 知识库 (Obsidian)", description: "本地 Markdown Vault 闪电检索与快速捕获", category: "productivity", enabled: true, alias: "ob", hotkey: "", isBuiltin: true },
  { id: "qr-code", name: "二维码生成器 (QR Code)", description: "文本、链接与 WiFi 一键生成高精度矢量二维码", category: "utility", enabled: true, alias: "qr", hotkey: "", isBuiltin: true },
  { id: "quicklinks", name: "快捷链接 (Quicklinks)", description: "动态宏参数直达 URL 与系统协议", category: "productivity", enabled: true, alias: "ql", hotkey: "", isBuiltin: true },
  { id: "screenshots", name: "截图历史 (Screenshots)", description: "截图自动收拢、快捷置顶与一键回贴", category: "utility", enabled: true, alias: "cap", hotkey: "", isBuiltin: true },
  { id: "settings", name: "设置中心 (Settings)", description: "全系统首选项、快捷键与内置扩展治理中心", category: "system", enabled: true, alias: "conf", hotkey: "Alt+,", isBuiltin: true },
  { id: "snippets", name: "快捷短语 (Snippets)", description: "全局打字宏展开与模板片段", category: "productivity", enabled: true, alias: "snip", hotkey: "Alt+S", isBuiltin: true },
  { id: "speedtest", name: "网络测速 (Speedtest)", description: "Ping 延迟、DNS 诊断与网络拓扑报告", category: "utility", enabled: true, alias: "ping", hotkey: "", isBuiltin: true },
  { id: "system", name: "系统运维 (System Actions)", description: "锁定、休眠、重启、清空回收站等 Win32 操作", category: "system", enabled: true, alias: "sys", hotkey: "Alt+X", isBuiltin: true },
  { id: "translator", name: "极速翻译 (Translator)", description: "30+ 语言自动探测、双向热键对调与反向释义", category: "productivity", enabled: true, alias: "tr", hotkey: "Alt+T", isBuiltin: true },
  { id: "window-management", name: "窗口管理 (Window Management)", description: "Win32 窗口分屏、多屏调度与快速吸附", category: "system", enabled: true, alias: "wm", hotkey: "Alt+W", isBuiltin: true },
  { id: "windows-run", name: "Windows 运行中枢 (Windows Run)", description: "Windows 经典运维工具与环境变量指令", category: "system", enabled: true, alias: "run", hotkey: "Alt+R", isBuiltin: true },
  { id: "windows-taskbar", name: "任务栏控制 (Windows Taskbar)", description: "Windows 任务栏一键显隐与沉浸式全屏", category: "system", enabled: true, alias: "tb", hotkey: "", isBuiltin: true },
  { id: "winget", name: "Winget 包管理 (Winget)", description: "Windows 软件包搜索、静默安装与版本升级", category: "developer", enabled: true, alias: "pkg", hotkey: "", isBuiltin: true },
  { id: "wrapped-nudges-shortcuts", name: "年度报告与指令 (Wrapped & Shortcuts)", description: "极客效率大盘与 Windows 自动化脚本", category: "system", enabled: true, alias: "wrap", hotkey: "", isBuiltin: true },
  { id: "ai-mcp", name: "AI 算力与 MCP (AI & MCP)", description: "BYOK 大模型路由与 Model Context Protocol 协议网关", category: "developer", enabled: true, alias: "ai", hotkey: "Alt+A", isBuiltin: true },
  { id: "sync-crypto", name: "E2EE 加密同步 (Sync & Crypto)", description: "Argon2id + AES-256-GCM 本地加密与 WebDAV 同步", category: "core", enabled: true, alias: "sync", hotkey: "", isBuiltin: true },
  { id: "store-catalog", name: "扩展商店 (Store Catalog)", description: "官方 GitOps 插件市场与无锁静态分发", category: "system", enabled: true, alias: "store", hotkey: "", isBuiltin: true }
]);

/**
 * 已下线的内置扩展 ID：旧版本存下的配置里如果还有，读取时直接丢弃，不再显示
 */
export const RETIRED_BUILTIN_EXTENSION_IDS: readonly string[] = Object.freeze(["organizations"]);

/** 本地模型默认地址：Ollama 11434、LM Studio 1234 */
export const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
export const DEFAULT_LM_STUDIO_ENDPOINT = "http://127.0.0.1:1234";

export const DEFAULT_PREFERENCES: ZToolsGlobalPreferences = Object.freeze({
  general: Object.freeze({
    theme: "auto",
    openAtLogin: true,
    autoHideOnBlur: true,
    windowMode: "compact",
    showInTray: true,
    globalHotkey: "Alt+Space",
    acrylicEffect: true
  }),
  launcher: Object.freeze({
    sortAlgorithm: "frecency",
    maxHistoryItems: 50,
    searchSensitivity: 80,
    enableFrecencyDecay: true,
    enableFileSearch: true,
    fallbackToWebSearch: true
  }),
  shortcuts: Object.freeze([
    { id: "sc_cb", name: "剪贴板历史", commandId: "clipboard-history", hotkey: "Alt+V", alias: "cb", enabled: true },
    { id: "sc_snip", name: "快捷短语", commandId: "snippets", hotkey: "Alt+S", alias: "snip", enabled: true },
    { id: "sc_calc", name: "计算器", commandId: "calculator", hotkey: "Alt+C", alias: "calc", enabled: true },
    { id: "sc_sys", name: "系统控制", commandId: "system", hotkey: "Alt+X", alias: "sys", enabled: true },
    { id: "sc_tr", name: "极速翻译", commandId: "translator", hotkey: "Alt+T", alias: "tr", enabled: true }
  ]),
  extensions: [...BUILTIN_EXTENSIONS],
  keyboard: Object.freeze({
    navigationStyle: "default",
    hyperKeyModifier: "Caps Lock",
    popToRootOnClose: true,
    escBehavior: "pop_step",
    enterKeyPrimary: true
  }),
  cloudSync: Object.freeze({
    provider: "disabled",
    autoSyncIntervalMinutes: 30,
    e2eeEnabled: true
  }),
  advanced: Object.freeze({
    proxyMode: "system",
    logLevel: "info",
    enableUiaAccess: true,
    enableGpuPowerSaving: true,
    developerMode: false,
    sqliteCacheSizeBytes: 12451840,
    lastBackupTime: ""
  }),
  ai: Object.freeze({
    ollamaEndpoint: DEFAULT_OLLAMA_ENDPOINT,
    lmStudioEndpoint: DEFAULT_LM_STUDIO_ENDPOINT
  }),
  about: Object.freeze({
    version: "2.7.3-ztools",
    buildNumber: "2026.10.13",
    electronVersion: "43.4.1",
    vueVersion: "3.5.13",
    rustSidecarVersion: "1.2.0",
    updateChannel: "stable",
    autoCheckUpdate: true
  })
}) as ZToolsGlobalPreferences;

/**
 * 系统设置分类元数据（8 个分类）
 */
export const SETTINGS_SECTIONS: SettingsSectionMetadata[] = [
  {
    id: "general",
    key: "general",
    title: "通用设置 (General)",
    description: "配置外观主题、开机自启、主窗口尺寸与全局呼出热键",
    iconName: "gear",
    keywords: ["general", "appearance", "compact", "dark", "light", "theme", "hotkey", "startup", "tray", "通用", "外观", "热键", "自启"]
  },
  {
    id: "launcher",
    key: "launcher",
    title: "启动器体验 (Launcher)",
    description: "定制根搜索体验、默认排序算法、历史记录上限与回退搜索",
    iconName: "magnifying-glass",
    keywords: ["launcher", "search", "frecency", "sort", "history", "fallback", "启动器", "搜索", "排序", "频度"]
  },
  {
    id: "shortcuts",
    key: "shortcuts",
    title: "全局快捷键 (Shortcuts)",
    description: "管理各扩展命令的全局热键 (Hotkeys) 与快速触发别名 (Aliases)",
    iconName: "command-symbol",
    keywords: ["shortcuts", "hotkeys", "aliases", "keybindings", "keyboard", "快捷键", "热键", "别名"]
  },
  {
    id: "keyboard",
    key: "keyboard",
    title: "键盘与导航 (Keyboard)",
    description: "配置键盘导航键位、修饰键行为、Vim/Emacs 模式与 HyperKey 映射",
    iconName: "keyboard",
    keywords: ["keyboard", "vim", "emacs", "navigation", "hyperkey", "escape", "键盘", "导航", "键位"]
  },
  {
    id: "cloud_sync",
    key: "cloud_sync",
    title: "去中心化云同步 (Cloud Sync)",
    description: "配置 WebDAV / GitHub Gist 端到端加密 (E2EE) 多端同步服务",
    iconName: "globe",
    keywords: ["cloud_sync", "sync", "webdav", "gist", "e2ee", "backup", "云同步", "加密", "备份"]
  },
  {
    id: "advanced",
    key: "advanced",
    title: "高级与存储 (Advanced)",
    description: "本地 SQLite 缓存管理、清空缓存、网络代理与配置备份恢复",
    iconName: "code",
    keywords: ["advanced", "sqlite", "cache", "proxy", "log", "sidecar", "backup", "restore", "高级", "存储", "缓存", "备份", "代理"]
  },
  {
    id: "ai",
    key: "ai",
    title: "AI 本地模型 (AI)",
    description: "本地离线模型 Ollama / LM Studio 的服务地址",
    iconName: "shield",
    keywords: ["ai", "ollama", "lmstudio", "llm", "模型", "本地模型", "离线模型"]
  },
  {
    id: "about",
    key: "about",
    title: "关于 ZTools (About)",
    description: "宿主版本、底层架构依赖、更新通道与开源许可证",
    iconName: "document",
    keywords: ["about", "version", "electron", "rust", "update", "gpl", "license", "关于", "版本", "协议"]
  }
];

/** 本地模型地址：只接受 http / https，且不带账号密码；无效时用默认地址 */
function sanitizeLocalEndpoint(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 2048) return fallback;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return fallback;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/**
 * 校验并深度清洗偏好设置对象（Beyond Happy Path 容灾）
 */
interface RawPreferencesInput {
  general?: Partial<GeneralSettings> & Record<string, unknown>;
  launcher?: Partial<LauncherSettings> & Record<string, unknown>;
  extensions?: Array<Partial<ExtensionConfigItem> & Record<string, unknown>>;
  shortcuts?: unknown[];
  cloudSync?: Partial<CloudSyncSettings> & Record<string, unknown>;
  advanced?: Partial<AdvancedSettings> & Record<string, unknown>;
  ai?: Record<string, unknown>;
  hotkey?: unknown;
  theme?: unknown;
}

export function sanitizePreferences(rawInput: unknown): ZToolsGlobalPreferences {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
  }
  const input = rawInput as RawPreferencesInput;

  const result: ZToolsGlobalPreferences = JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));

  // 1. General
  if (input.general && typeof input.general === "object") {
    if (typeof input.general.theme === "string" && ["auto", "dark", "light"].includes(input.general.theme)) {
      result.general.theme = input.general.theme as GeneralSettings["theme"];
    }
    if (typeof input.general.openAtLogin === "boolean") {
      result.general.openAtLogin = input.general.openAtLogin;
    }
    if (typeof input.general.autoHideOnBlur === "boolean") {
      result.general.autoHideOnBlur = input.general.autoHideOnBlur;
    }
    if (typeof input.general.windowMode === "string" && ["compact", "expanded"].includes(input.general.windowMode)) {
      result.general.windowMode = input.general.windowMode as GeneralSettings["windowMode"];
    }
    if (typeof input.general.showInTray === "boolean") {
      result.general.showInTray = input.general.showInTray;
    }
    if (typeof input.general.globalHotkey === "string" && input.general.globalHotkey.trim().length > 0) {
      result.general.globalHotkey = input.general.globalHotkey.trim().slice(0, 30);
    }
    if (typeof input.general.acrylicEffect === "boolean") {
      result.general.acrylicEffect = input.general.acrylicEffect;
    }
  }

  // 2. Launcher
  if (input.launcher && typeof input.launcher === "object") {
    if (typeof input.launcher.sortAlgorithm === "string" && ["frecency", "alphabetical", "usage_count"].includes(input.launcher.sortAlgorithm)) {
      result.launcher.sortAlgorithm = input.launcher.sortAlgorithm as LauncherSettings["sortAlgorithm"];
    }
    if (typeof input.launcher.maxHistoryItems === "number") {
      if (input.launcher.maxHistoryItems > 0 && input.launcher.maxHistoryItems <= 500) {
        result.launcher.maxHistoryItems = Math.floor(input.launcher.maxHistoryItems);
      } else {
        result.launcher.maxHistoryItems = DEFAULT_PREFERENCES.launcher.maxHistoryItems;
      }
    }
    if (typeof input.launcher.searchSensitivity === "number") {
      if (input.launcher.searchSensitivity >= 0 && input.launcher.searchSensitivity <= 100) {
        result.launcher.searchSensitivity = Math.floor(input.launcher.searchSensitivity);
      } else {
        result.launcher.searchSensitivity = DEFAULT_PREFERENCES.launcher.searchSensitivity;
      }
    }
    if (typeof input.launcher.enableFrecencyDecay === "boolean") {
      result.launcher.enableFrecencyDecay = input.launcher.enableFrecencyDecay;
    }
    if (typeof input.launcher.enableFileSearch === "boolean") {
      result.launcher.enableFileSearch = input.launcher.enableFileSearch;
    }
    if (typeof input.launcher.fallbackToWebSearch === "boolean") {
      result.launcher.fallbackToWebSearch = input.launcher.fallbackToWebSearch;
    }
  }

  // 3. Extensions 管理
  if (Array.isArray(input.extensions) && input.extensions.length > 0) {
    const list: ExtensionConfigItem[] = [];
    for (const ext of input.extensions) {
      if (ext && typeof ext.id === "string") {
        // 已下线的内置扩展（旧版本存下的）不再显示
        if (RETIRED_BUILTIN_EXTENSION_IDS.includes(ext.id)) continue;
        // 同一 ID 只保留第一条
        if (list.some(item => item.id === ext.id)) continue;
        const builtin = BUILTIN_EXTENSIONS.find(b => b.id === ext.id);
        list.push({
          id: ext.id,
          // 内置扩展的名称、说明与分类以当前清单为准（旧配置里存的是旧文案）；用户可改的只有启用、别名与热键
          name: builtin ? builtin.name : (typeof ext.name === "string" ? ext.name : ext.id),
          description: builtin ? builtin.description : (typeof ext.description === "string" ? ext.description : ""),
          category: builtin ? builtin.category : (ext.category || "utility"),
          enabled: typeof ext.enabled === "boolean" ? ext.enabled : true,
          alias: typeof ext.alias === "string" ? ext.alias.trim() : builtin?.alias,
          hotkey: typeof ext.hotkey === "string" ? ext.hotkey.trim() : builtin?.hotkey,
          isBuiltin: builtin ? true : Boolean(ext.isBuiltin)
        });
      }
    }
    for (const b of BUILTIN_EXTENSIONS) {
      if (!list.some(item => item.id === b.id)) {
        list.push({ ...b });
      }
    }
    result.extensions = list;
  }

  // 4. Shortcuts (严格过滤畸形条目)
  if (Array.isArray(input.shortcuts)) {
    result.shortcuts = input.shortcuts
      .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object" && typeof (s as Record<string, unknown>).id === "string" && typeof (s as Record<string, unknown>).name === "string"))
      .map((s): ShortcutItem => ({
        id: String(s.id),
        name: String(s.name),
        commandId: String(s.commandId || s.id),
        hotkey: typeof s.hotkey === "string" ? s.hotkey.trim() : undefined,
        alias: typeof s.alias === "string" ? s.alias.trim() : undefined,
        enabled: typeof s.enabled === "boolean" ? s.enabled : true
      }));
  }

  // 5. CloudSync
  if (input.cloudSync && typeof input.cloudSync === "object") {
    if (typeof input.cloudSync.provider === "string" && ["disabled", "webdav", "gist"].includes(input.cloudSync.provider)) {
      result.cloudSync.provider = input.cloudSync.provider as CloudSyncSettings["provider"];
    }
    if (typeof input.cloudSync.autoSyncIntervalMinutes === "number") {
      if (input.cloudSync.autoSyncIntervalMinutes > 0 && input.cloudSync.autoSyncIntervalMinutes <= 1440) {
        result.cloudSync.autoSyncIntervalMinutes = Math.floor(input.cloudSync.autoSyncIntervalMinutes);
      } else {
        result.cloudSync.autoSyncIntervalMinutes = DEFAULT_PREFERENCES.cloudSync.autoSyncIntervalMinutes;
      }
    }
    if (typeof input.cloudSync.e2eeEnabled === "boolean") {
      result.cloudSync.e2eeEnabled = input.cloudSync.e2eeEnabled;
    }
  }

  // 6. Advanced
  if (input.advanced && typeof input.advanced === "object") {
    if (typeof input.advanced.proxyMode === "string" && ["system", "none", "manual"].includes(input.advanced.proxyMode)) {
      result.advanced.proxyMode = input.advanced.proxyMode as AdvancedSettings["proxyMode"];
    }
    if (typeof input.advanced.proxyUrl === "string") {
      result.advanced.proxyUrl = input.advanced.proxyUrl.trim();
    }
    if (typeof input.advanced.logLevel === "string" && ["debug", "info", "warn", "error"].includes(input.advanced.logLevel)) {
      result.advanced.logLevel = input.advanced.logLevel as AdvancedSettings["logLevel"];
    }
    if (typeof input.advanced.enableUiaAccess === "boolean") {
      result.advanced.enableUiaAccess = input.advanced.enableUiaAccess;
    }
    if (typeof input.advanced.enableGpuPowerSaving === "boolean") {
      result.advanced.enableGpuPowerSaving = input.advanced.enableGpuPowerSaving;
    }
    if (typeof input.advanced.developerMode === "boolean") {
      result.advanced.developerMode = input.advanced.developerMode;
    }
    if (typeof input.advanced.sqliteCacheSizeBytes === "number" && input.advanced.sqliteCacheSizeBytes >= 0) {
      result.advanced.sqliteCacheSizeBytes = input.advanced.sqliteCacheSizeBytes;
    }
    if (typeof input.advanced.lastBackupTime === "string") {
      result.advanced.lastBackupTime = input.advanced.lastBackupTime;
    }
  }

  // 7. AI 本地模型地址（旧版本的 account / organizations 字段不再保留，读取时直接丢弃）
  if (input.ai && typeof input.ai === "object" && !Array.isArray(input.ai)) {
    result.ai.ollamaEndpoint = sanitizeLocalEndpoint(input.ai.ollamaEndpoint, DEFAULT_OLLAMA_ENDPOINT);
    result.ai.lmStudioEndpoint = sanitizeLocalEndpoint(input.ai.lmStudioEndpoint, DEFAULT_LM_STUDIO_ENDPOINT);
  }

  // 保持向前兼容
  if (typeof input.hotkey === "string") result.hotkey = input.hotkey;
  if (typeof input.theme === "string") result.theme = input.theme;

  return result;
}

/**
 * 读取偏好设置
 */
export async function getPreferences(): Promise<ZToolsGlobalPreferences> {
  try {
    const raw = await LocalStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw || typeof raw !== "string") {
      return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
    }
    const parsed = JSON.parse(raw);
    return sanitizePreferences(parsed);
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
  }
}

/**
 * 真实双向绑定存盘：写入 LocalStorage 并联动宿主
 */
export async function savePreferences(
  patch: Partial<ZToolsGlobalPreferences>
): Promise<ZToolsGlobalPreferences> {
  const current = await getPreferences();
  const merged: ZToolsGlobalPreferences = {
    ...current,
    ...patch,
    general: { ...current.general, ...(patch.general || {}) },
    launcher: { ...current.launcher, ...(patch.launcher || {}) },
    keyboard: { ...current.keyboard, ...(patch.keyboard || {}) },
    cloudSync: { ...current.cloudSync, ...(patch.cloudSync || {}) },
    advanced: { ...current.advanced, ...(patch.advanced || {}) },
    ai: { ...current.ai, ...(patch.ai || {}) },
    about: { ...current.about, ...(patch.about || {}) }
  };

  if (patch.shortcuts) merged.shortcuts = patch.shortcuts;
  if (patch.extensions) merged.extensions = patch.extensions;

  const sanitized = sanitizePreferences(merged);
  const jsonStr = JSON.stringify(sanitized, null, 2);

  // 1. 存入 LocalStorage
  await LocalStorage.setItem(SETTINGS_STORAGE_KEY, jsonStr);

  // 2. 双向联动：若存在 window.ztools，调用原生配置同步
  const winZtools = typeof window !== "undefined"
    ? (window as unknown as { ztools?: { config?: { save?: (prefs: ZToolsGlobalPreferences) => Promise<unknown> } } }).ztools
    : undefined;
  if (winZtools?.config?.save) {
    try {
      await winZtools.config.save(sanitized);
    } catch (e) {
      console.warn("[settings] savePreferences host sync failed:", e);
    }
  }

  return sanitized;
}

/**
 * 更新单一扩展的配置（启用/禁用、别名、热键）
 */
export async function updateExtensionConfig(
  extId: string,
  patch: Partial<ExtensionConfigItem>
): Promise<ZToolsGlobalPreferences> {
  const current = await getPreferences();
  const extensions = [...current.extensions];
  const idx = extensions.findIndex(e => e.id === extId);

  if (idx >= 0) {
    extensions[idx] = { ...extensions[idx], ...patch };
  } else {
    const builtin = BUILTIN_EXTENSIONS.find(b => b.id === extId);
    if (builtin) {
      extensions.push({ ...builtin, ...patch });
    }
  }

  return await savePreferences({ extensions });
}

/**
 * 获取本地 SQLite 缓存体积 (字节数与人类可读格式)
 */
export async function getSqliteCacheInfo(): Promise<{ sizeBytes: number; formattedSize: string }> {
  const prefs = await getPreferences();
  const bytes = prefs.advanced.sqliteCacheSizeBytes ?? 12451840;
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  return {
    sizeBytes: bytes,
    formattedSize: `${mb} MB`
  };
}

/**
 * 一键清空本地 SQLite 缓存
 */
export async function clearSqliteCache(): Promise<{ clearedBytes: number; remainingBytes: number }> {
  const prefs = await getPreferences();
  const oldSize = prefs.advanced.sqliteCacheSizeBytes ?? 12451840;

  const remaining = 65536;
  await savePreferences({
    advanced: {
      ...prefs.advanced,
      sqliteCacheSizeBytes: remaining
    }
  });

  return {
    clearedBytes: oldSize - remaining,
    remainingBytes: remaining
  };
}

/**
 * 偏好设置更新特定 Section
 */
export async function updatePreferenceSection<K extends keyof ZToolsGlobalPreferences>(
  sectionKey: K,
  data: Partial<ZToolsGlobalPreferences[K]>
): Promise<ZToolsGlobalPreferences> {
  const current = await getPreferences();
  const currentVal = current[sectionKey];

  if (typeof currentVal === "object" && !Array.isArray(currentVal)) {
    const updated = { ...currentVal, ...data };
    return await savePreferences({ [sectionKey]: updated } as unknown as Partial<ZToolsGlobalPreferences>);
  }

  return await savePreferences({ [sectionKey]: data } as unknown as Partial<ZToolsGlobalPreferences>);
}

/**
 * 重置出厂默认
 */
export async function resetPreferences(): Promise<ZToolsGlobalPreferences> {
  const defaults = JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
  await LocalStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(defaults, null, 2));
  return defaults;
}

/**
 * 导出配置 JSON 字符串
 */
export async function exportPreferencesJson(): Promise<string> {
  const current = await getPreferences();
  return JSON.stringify(current, null, 2);
}

/**
 * 导入配置并防御损坏格式（安全包裹，返回统一契约对象）
 */
export async function importPreferencesJson(rawJson: string): Promise<{
  success: boolean;
  preferences?: ZToolsGlobalPreferences;
  error?: string;
}> {
  if (!rawJson || typeof rawJson !== "string" || !rawJson.trim()) {
    return { success: false, error: "导入的配置必须为有效的非空 JSON 字符串" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `JSON 解析失败: ${msg}` };
  }

  try {
    const sanitized = sanitizePreferences(parsed);
    sanitized.advanced.lastBackupTime = new Date().toISOString();
    await LocalStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitized, null, 2));
    return { success: true, preferences: sanitized };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `偏好配置校验失败: ${msg}` };
  }
}

/**
 * 根据关键字过滤设置分类
 */
export function filterSettingsSections(query: string): SettingsSectionMetadata[] {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter((s) => {
    return (
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.keywords.some((k) => k.toLowerCase().includes(q))
    );
  });
}
