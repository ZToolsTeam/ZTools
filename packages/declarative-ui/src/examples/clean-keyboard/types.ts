/**
 * Clean Keyboard (键盘清洁防误触锁) 类型定义
 *
 * 参考依据：
 * - Raycast 官方扩展 `raycast/extensions/extensions/clean-keyboard/src/clean-keyboard.tsx`
 * - 支持多档位预设时长 (15s / 30s / 1m / 2m / 5m / 1h / 24h / Forever) 与自定义时长
 * - 严谨的五步键盘锁定状态机：unlocked -> locking -> locked -> unlocking -> unlocked
 * - 支持误触按键拦截计数 (Blocked Keystrokes Counter)、紧急解锁热键与看门狗超时自动解锁
 */

export type KeyboardLockStatus = "unlocked" | "locking" | "locked" | "unlocking";

export type UnlockReason =
  | "manual"
  | "timer_expired"
  | "watchdog_timeout"
  | "emergency_hotkey"
  | "hotkey"
  | "system_reset";

export type ShortcutModifier = "ctrl" | "alt" | "shift" | "cmd" | "opt";

export interface CleanDurationPreset {
  readonly id: string;
  readonly display: string;
  readonly title: string;
  readonly subtitle: string;
  readonly seconds?: number | undefined;
  readonly icon: string;
  readonly recommended?: boolean | undefined;
}

export interface EmergencyShortcutConfig {
  readonly modifiers: ShortcutModifier[];
  readonly key: string;
  readonly display: string;
}

export interface CleaningSessionRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly plannedDurationSeconds: number | null;
  readonly actualDurationSeconds: number;
  readonly blockedKeystrokes: number;
  readonly unlockReason: UnlockReason;
  readonly presetTitle: string;
}

export interface CleaningStats {
  readonly totalSessions: number;
  readonly totalCleanedSeconds: number;
  readonly totalBlockedKeystrokes: number;
  readonly lastCleanedAt: number | null;
  readonly history: CleaningSessionRecord[];
}

export interface KeyboardLockState {
  readonly status: KeyboardLockStatus;
  readonly lockedAt: number | null;
  readonly expiresAt: number | null;
  readonly durationSeconds: number | null;
  readonly remainingSeconds: number | null;
  readonly blockedKeystrokes: number;
  readonly lastBlockedKey: string | null;
  readonly activePresetTitle: string | null;
  readonly activeIcon: string | null;
  readonly emergencyShortcut: EmergencyShortcutConfig;
  readonly lastModifiedAt: number;
}

export type KeyboardLockErrorCode =
  | "ALREADY_LOCKED"
  | "MUTEX_BUSY"
  | "INVALID_DURATION"
  | "NOT_LOCKED"
  | "INVALID_SHORTCUT";

export interface KeyboardLockActionResult {
  readonly success: boolean;
  readonly status: KeyboardLockStatus;
  readonly message: string;
  readonly state: KeyboardLockState;
  readonly sessionRecord?: CleaningSessionRecord | undefined;
  readonly error?: string | undefined;
  readonly code?: KeyboardLockErrorCode | undefined;
}

export interface LockKeyboardOptions {
  readonly presetTitle?: string | undefined;
  readonly icon?: string | undefined;
  readonly watchdogMs?: number | undefined;
  readonly hostOverride?: any;
}
