/**
 * Raycast Settings 系统偏好设置类型契约
 * 对标 Raycast 官方设置规范与 ZTools 极客架构要求
 */

export type ThemeMode = "auto" | "dark" | "light";
export type WindowMode = "compact" | "expanded";
export type SearchSortAlgorithm = "frecency" | "alphabetical" | "usage_count";
export type NavigationStyle = "default" | "vim" | "emacs";
export type SyncProvider = "disabled" | "webdav" | "gist";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface GeneralSettings {
  theme: ThemeMode;
  openAtLogin: boolean;
  autoHideOnBlur: boolean; // 窗口失焦自动隐藏
  windowMode: WindowMode;
  showInTray: boolean;
  globalHotkey: string;    // 启动热键
  acrylicEffect: boolean;
}

export interface LauncherSettings {
  sortAlgorithm: SearchSortAlgorithm;
  maxHistoryItems: number;
  searchSensitivity: number; // 0-100
  enableFrecencyDecay: boolean;
  enableFileSearch: boolean;
  fallbackToWebSearch: boolean;
}

export interface ShortcutItem {
  id: string;
  name: string;
  commandId: string;
  hotkey?: string;
  alias?: string;
  enabled: boolean;
}

export interface ExtensionConfigItem {
  id: string;
  name: string;
  description: string;
  category: "core" | "utility" | "developer" | "productivity" | "system";
  enabled: boolean;
  alias?: string;
  hotkey?: string;
  isBuiltin: boolean;
}

export interface KeyboardSettings {
  navigationStyle: NavigationStyle;
  hyperKeyModifier: string;
  popToRootOnClose: boolean;
  escBehavior: "pop_step" | "instant_hide";
  enterKeyPrimary: boolean;
}

export interface CloudSyncSettings {
  provider: SyncProvider;
  serverUrl?: string;
  username?: string;
  syncPassword?: string;
  gistToken?: string;
  gistId?: string;
  autoSyncIntervalMinutes: number;
  lastSyncTimestamp?: number;
  e2eeEnabled: boolean;
}

export interface AdvancedSettings {
  proxyMode: "system" | "none" | "manual";
  proxyUrl?: string;
  logLevel: LogLevel;
  rustSidecarPath?: string;
  enableUiaAccess: boolean;
  enableGpuPowerSaving: boolean; // 15秒显存挂起
  developerMode: boolean;
  sqliteCacheSizeBytes?: number; // 本地 SQLite 缓存体积 (字节)
  lastBackupTime?: string;
}

export interface AccountSettings {
  userId: string;
  username: string;
  email: string;
  plan: "community" | "pro_geek" | "team_enterprise";
  byokDeepSeekKey?: string;
  byokOpenAiKey?: string;
  byokClaudeKey?: string;
  ollamaEndpoint?: string;
  lmStudioEndpoint?: string;
  aiTokenUsageCount: number;
}

export interface OrganizationSettings {
  currentOrgId?: string;
  orgName?: string;
  memberRole?: "owner" | "admin" | "member" | "guest";
  enableTeamSnippets: boolean;
  enablePrivateStore: boolean;
}

export interface AboutSettings {
  version: string;
  buildNumber: string;
  electronVersion: string;
  vueVersion: string;
  rustSidecarVersion: string;
  updateChannel: "stable" | "beta" | "nightly";
  autoCheckUpdate: boolean;
}

export interface ZToolsGlobalPreferences {
  general: GeneralSettings;
  launcher: LauncherSettings;
  shortcuts: ShortcutItem[];
  extensions: ExtensionConfigItem[]; // 32 款内置扩展管理
  keyboard: KeyboardSettings;
  cloudSync: CloudSyncSettings;
  advanced: AdvancedSettings;
  account: AccountSettings;
  organizations: OrganizationSettings;
  about: AboutSettings;
  hotkey?: string;
  theme?: string;
  fontSize?: number;
  walCacheSizeMb?: number;
  telemetry?: boolean;
  language?: string;
}

export type SettingsSectionKey =
  | "general"
  | "launcher"
  | "shortcuts"
  | "extensions"
  | "keyboard"
  | "cloud_sync"
  | "advanced"
  | "account"
  | "organizations"
  | "about";

export type SettingsMainTab =
  | "general"
  | "extensions"
  | "shortcuts"
  | "advanced"
  | "about";

export interface SettingsSectionMetadata {
  id?: string;
  key: SettingsSectionKey;
  title: string;
  description: string;
  iconName: string;
  keywords: string[];
}
