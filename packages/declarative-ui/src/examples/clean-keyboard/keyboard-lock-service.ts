/**
 * Clean Keyboard (键盘清洁防误触锁) 核心状态机与服务
 *
 * 直接借鉴 Raycast 官方 `extensions/clean-keyboard/src/clean-keyboard.tsx` 源码改造：
 * - 完整保留原版 8 档预设时长 (15s 🪥, 30s 🧽, 1m 🧼, 2m 🚿, 5m 🛁, 1h 🧹, 24h 🫧, Forever 🤯)
 * - 严谨的五步键盘锁定状态机：unlocked -> locking -> locked -> unlocking -> unlocked
 * - 内置原子互斥锁 (mutexBusy) 防止并发重复加锁，内置看门狗超时解锁防死锁
 * - 支持记录锁定期间被拦截的误触按键次数 (Blocked Keystrokes) 与清洁历史统计
 */

import { LocalStorage } from "../../index.js";
import {
  CleanDurationPreset,
  CleaningSessionRecord,
  CleaningStats,
  EmergencyShortcutConfig,
  KeyboardLockActionResult,
  KeyboardLockState,
  LockKeyboardOptions,
  ShortcutModifier,
  UnlockReason
} from "./types.js";

export const CLEAN_KEYBOARD_STATS_KEY = "ztools.clean-keyboard.stats.v1";
export const CLEAN_KEYBOARD_SHORTCUT_KEY = "ztools.clean-keyboard.shortcut.v1";

/**
 * 源自 Raycast `clean-keyboard/src/clean-keyboard.tsx` 的预设时长列表
 */
export const CLEAN_DURATION_PRESETS: readonly CleanDurationPreset[] = Object.freeze([
  {
    id: "preset-15s",
    display: "15 seconds",
    title: "15 秒 (快速擦拭)",
    subtitle: "适合用气吹或毛刷快速扫除表面浮尘",
    seconds: 15,
    icon: "🪥",
    recommended: true
  },
  {
    id: "preset-30s",
    display: "30 seconds",
    title: "30 秒 (标准清洁)",
    subtitle: "适合使用湿巾擦拭键帽与触控板",
    seconds: 30,
    icon: "🧽",
    recommended: true
  },
  {
    id: "preset-60s",
    display: "1 minute",
    title: "1 分钟 (深度清洁)",
    subtitle: "适合仔细擦拭全键盘每个角落与屏幕",
    seconds: 60,
    icon: "🧼"
  },
  {
    id: "preset-120s",
    display: "2 minutes",
    title: "2 分钟 (键帽缝隙清理)",
    subtitle: "适合使用清洁泥与酒精棉片清理键帽缝隙",
    seconds: 120,
    icon: "🚿"
  },
  {
    id: "preset-300s",
    display: "5 minutes",
    title: "5 分钟 (拔键帽大扫除)",
    subtitle: "适合局部拆卸键帽清理轴体周围灰尘",
    seconds: 300,
    icon: "🛁"
  },
  {
    id: "preset-3600s",
    display: "1 hour",
    title: "1 小时 (防宠物/猫咪踩踏模式)",
    subtitle: "临时离开座位，防止家猫踩踏键盘误发消息",
    seconds: 3600,
    icon: "🧹"
  },
  {
    id: "preset-86400s",
    display: "24 hours",
    title: "24 小时 (全天锁定)",
    subtitle: "长时间外接展示或展览模式",
    seconds: 86400,
    icon: "🫧"
  },
  {
    id: "preset-forever",
    display: "Forever",
    title: "无限期锁定 (手动按 Ctrl+U 解锁)",
    subtitle: "保持锁定直到按下紧急解锁组合键",
    seconds: undefined,
    icon: "🤯"
  }
]);

export const DEFAULT_EMERGENCY_SHORTCUT: EmergencyShortcutConfig = Object.freeze({
  modifiers: ["ctrl"] as ShortcutModifier[],
  key: "u",
  display: "Ctrl + U"
});

const VALID_MODIFIERS = new Set<ShortcutModifier>(["ctrl", "alt", "shift", "cmd", "opt"]);

export function formatCleanDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "无限期 (手动解锁)";
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 秒";
  const sec = Math.floor(seconds);
  if (sec < 60) return `${sec} 秒`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) {
    return remSec > 0 ? `${mins} 分 ${remSec} 秒` : `${mins} 分钟`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours} 小时 ${remMins} 分` : `${hours} 小时`;
}

export class KeyboardLockManager {
  private state: KeyboardLockState;
  private mutexBusy = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private history: CleaningSessionRecord[] = [];
  private totalCleanedSeconds = 0;
  private totalBlockedKeystrokes = 0;
  private lastCleanedAt: number | null = null;

  constructor() {
    this.state = {
      status: "unlocked",
      lockedAt: null,
      expiresAt: null,
      durationSeconds: null,
      remainingSeconds: null,
      blockedKeystrokes: 0,
      lastBlockedKey: null,
      activePresetTitle: null,
      activeIcon: null,
      emergencyShortcut: { ...DEFAULT_EMERGENCY_SHORTCUT },
      lastModifiedAt: Date.now()
    };
  }

  public getState(): KeyboardLockState {
    return {
      ...this.state,
      emergencyShortcut: {
        ...this.state.emergencyShortcut,
        modifiers: [...this.state.emergencyShortcut.modifiers]
      }
    };
  }

  public getStats(): CleaningStats {
    return {
      totalSessions: this.history.length,
      totalCleanedSeconds: this.totalCleanedSeconds,
      totalBlockedKeystrokes: this.totalBlockedKeystrokes,
      lastCleanedAt: this.lastCleanedAt,
      history: [...this.history]
    };
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * 启动键盘锁定
   * @param durationSeconds 锁定时长（秒），传 null 或 undefined 表示无限期直到手动解锁
   */
  public async lockKeyboard(
    durationSeconds: number | null | undefined,
    options: LockKeyboardOptions = {}
  ): Promise<KeyboardLockActionResult> {
    if (this.mutexBusy) {
      return {
        success: false,
        status: this.state.status,
        message: "键盘锁正在切换状态中，请勿并发重复操作",
        state: this.getState(),
        error: "Mutex lock is busy",
        code: "MUTEX_BUSY"
      };
    }

    if (this.state.status === "locked" || this.state.status === "locking") {
      return {
        success: false,
        status: this.state.status,
        message: "键盘当前已处于锁定状态",
        state: this.getState(),
        error: "Keyboard is already locked",
        code: "ALREADY_LOCKED"
      };
    }

    if (durationSeconds !== null && durationSeconds !== undefined) {
      if (
        typeof durationSeconds !== "number" ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > 86400 * 7
      ) {
        return {
          success: false,
          status: this.state.status,
          message: "锁定时长无效（需在 1 秒 ~ 7 天之间）",
          state: this.getState(),
          error: "Invalid lock duration",
          code: "INVALID_DURATION"
        };
      }
    }

    this.mutexBusy = true;
    try {
      // Step 1: unlocked -> locking
      const now = Date.now();
      const normalizedSeconds =
        durationSeconds !== null && durationSeconds !== undefined
          ? Math.floor(durationSeconds)
          : null;

      this.state = {
        ...this.state,
        status: "locking",
        lastModifiedAt: now
      };

      // Step 2: locking -> locked
      this.clearWatchdog();
      const expiresAt = normalizedSeconds !== null ? now + normalizedSeconds * 1000 : null;
      this.state = {
        ...this.state,
        status: "locked",
        lockedAt: now,
        expiresAt,
        durationSeconds: normalizedSeconds,
        remainingSeconds: normalizedSeconds,
        blockedKeystrokes: 0,
        lastBlockedKey: null,
        activePresetTitle:
          options.presetTitle ||
          (normalizedSeconds ? `${normalizedSeconds} 秒清洁锁` : "无限期清洁锁"),
        activeIcon: options.icon || "🧼",
        lastModifiedAt: now
      };

      // 启动看门狗自动超时解锁防止永久死锁
      const watchdogDelayMs =
        options.watchdogMs ??
        (normalizedSeconds !== null && normalizedSeconds <= 60
          ? normalizedSeconds * 1000
          : null);

      if (watchdogDelayMs !== null && watchdogDelayMs > 0 && watchdogDelayMs <= 60_000) {
        this.watchdogTimer = setTimeout(() => {
          if (this.state.status === "locked") {
            void this.unlockKeyboard("watchdog_timeout");
          }
        }, watchdogDelayMs);
        if (typeof (this.watchdogTimer as any)?.unref === "function") {
          (this.watchdogTimer as any).unref();
        }
      }

      return {
        success: true,
        status: "locked",
        message: `键盘已锁定 (${formatCleanDuration(normalizedSeconds)})，按 ${this.state.emergencyShortcut.display} 可随时解锁`,
        state: this.getState()
      };
    } finally {
      this.mutexBusy = false;
    }
  }

  /**
   * 解除键盘锁定
   */
  public async unlockKeyboard(
    reason: UnlockReason = "manual"
  ): Promise<KeyboardLockActionResult> {
    if (this.mutexBusy) {
      return {
        success: false,
        status: this.state.status,
        message: "键盘锁正在切换状态中",
        state: this.getState(),
        error: "Mutex lock is busy",
        code: "MUTEX_BUSY"
      };
    }

    if (this.state.status !== "locked") {
      return {
        success: false,
        status: this.state.status,
        message: "键盘当前未处于锁定状态",
        state: this.getState(),
        error: "Keyboard is not locked",
        code: "NOT_LOCKED"
      };
    }

    this.mutexBusy = true;
    try {
      this.clearWatchdog();
      const now = Date.now();
      const startedAt = this.state.lockedAt ?? now;
      const plannedSeconds = this.state.durationSeconds;
      const elapsedSeconds = Math.max(1, Math.round((now - startedAt) / 1000));
      const actualSeconds =
        reason === "timer_expired" && plannedSeconds !== null
          ? plannedSeconds
          : elapsedSeconds;

      // Step 3: locked -> unlocking
      this.state = {
        ...this.state,
        status: "unlocking",
        lastModifiedAt: now
      };

      const record: CleaningSessionRecord = {
        id: `clean-${now}-${Math.random().toString(36).slice(2, 7)}`,
        startedAt,
        endedAt: now,
        plannedDurationSeconds: plannedSeconds,
        actualDurationSeconds: actualSeconds,
        blockedKeystrokes: this.state.blockedKeystrokes,
        unlockReason: reason,
        presetTitle: this.state.activePresetTitle || "清洁会话"
      };

      this.history = [record, ...this.history].slice(0, 30);
      this.totalCleanedSeconds += actualSeconds;
      this.totalBlockedKeystrokes += record.blockedKeystrokes;
      this.lastCleanedAt = now;

      await this.persistStats();

      // Step 4: unlocking -> unlocked
      this.state = {
        ...this.state,
        status: "unlocked",
        lockedAt: null,
        expiresAt: null,
        durationSeconds: null,
        remainingSeconds: null,
        blockedKeystrokes: 0,
        lastBlockedKey: null,
        activePresetTitle: null,
        activeIcon: null,
        lastModifiedAt: now
      };

      return {
        success: true,
        status: "unlocked",
        message: `键盘已恢复正常输入（本次拦截 ${record.blockedKeystrokes} 次误触按键）`,
        state: this.getState(),
        sessionRecord: record
      };
    } finally {
      this.mutexBusy = false;
    }
  }

  /**
   * 模拟或处理锁定期间的按键输入：
   * - 如果匹配紧急解锁组合键，自动触发解锁
   * - 否则拦截该按键并递增误触计数
   */
  public async interceptKeystroke(
    key: string,
    modifiers: ShortcutModifier[] = []
  ): Promise<{ blocked: boolean; unlocked: boolean; state: KeyboardLockState }> {
    if (this.state.status !== "locked") {
      return { blocked: false, unlocked: false, state: this.getState() };
    }

    const cleanKey = (key || "").trim().toLowerCase();
    const targetShortcut = this.state.emergencyShortcut;
    const modSet = new Set((modifiers || []).map((m) => m.toLowerCase() as ShortcutModifier));
    const isEmergencyMatch =
      cleanKey === targetShortcut.key.toLowerCase() &&
      targetShortcut.modifiers.every((m) => modSet.has(m));

    if (isEmergencyMatch) {
      await this.unlockKeyboard("emergency_hotkey");
      return { blocked: true, unlocked: true, state: this.getState() };
    }

    this.state = {
      ...this.state,
      blockedKeystrokes: this.state.blockedKeystrokes + 1,
      lastBlockedKey: key || "Unknown",
      lastModifiedAt: Date.now()
    };

    return { blocked: true, unlocked: false, state: this.getState() };
  }

  /**
   * 每秒倒计时滴答推进
   */
  public async tick(stepSeconds = 1): Promise<KeyboardLockState> {
    if (this.state.status !== "locked" || this.state.remainingSeconds === null) {
      return this.getState();
    }
    const step = Number.isFinite(stepSeconds) && stepSeconds > 0 ? Math.floor(stepSeconds) : 1;
    const nextRemaining = Math.max(0, this.state.remainingSeconds - step);
    this.state = {
      ...this.state,
      remainingSeconds: nextRemaining,
      lastModifiedAt: Date.now()
    };

    if (nextRemaining === 0) {
      await this.unlockKeyboard("timer_expired");
    }
    return this.getState();
  }

  /**
   * 更新紧急解锁快捷键配置
   */
  public async updateEmergencyShortcut(
    modifiers: ShortcutModifier[],
    key: string
  ): Promise<KeyboardLockActionResult> {
    const cleanKey = (key || "").trim().toLowerCase();
    const validMods = Array.isArray(modifiers)
      ? modifiers.filter((m) => VALID_MODIFIERS.has(m))
      : [];

    if (!cleanKey || cleanKey.length !== 1 || validMods.length === 0) {
      return {
        success: false,
        status: this.state.status,
        message: "紧急解锁快捷键必须包含至少一个修饰键 (Ctrl/Alt/Shift/Cmd) 与单个字母或数字键",
        state: this.getState(),
        error: "Invalid emergency shortcut",
        code: "INVALID_SHORTCUT"
      };
    }

    const display = `${validMods.map((m) => m[0].toUpperCase() + m.slice(1)).join(" + ")} + ${cleanKey.toUpperCase()}`;
    this.state = {
      ...this.state,
      emergencyShortcut: {
        modifiers: validMods,
        key: cleanKey,
        display
      },
      lastModifiedAt: Date.now()
    };

    await LocalStorage.setItem(
      CLEAN_KEYBOARD_SHORTCUT_KEY,
      JSON.stringify(this.state.emergencyShortcut)
    );

    return {
      success: true,
      status: this.state.status,
      message: `紧急解锁快捷键已更新为 ${display}`,
      state: this.getState()
    };
  }

  private async persistStats(): Promise<void> {
    try {
      await LocalStorage.setItem(CLEAN_KEYBOARD_STATS_KEY, JSON.stringify(this.getStats()));
    } catch {
      // ignore storage errors
    }
  }

  public async resetAll(): Promise<void> {
    this.clearWatchdog();
    this.mutexBusy = false;
    this.history = [];
    this.totalCleanedSeconds = 0;
    this.totalBlockedKeystrokes = 0;
    this.lastCleanedAt = null;
    this.state = {
      status: "unlocked",
      lockedAt: null,
      expiresAt: null,
      durationSeconds: null,
      remainingSeconds: null,
      blockedKeystrokes: 0,
      lastBlockedKey: null,
      activePresetTitle: null,
      activeIcon: null,
      emergencyShortcut: { ...DEFAULT_EMERGENCY_SHORTCUT },
      lastModifiedAt: Date.now()
    };
    await LocalStorage.removeItem(CLEAN_KEYBOARD_STATS_KEY);
    await LocalStorage.removeItem(CLEAN_KEYBOARD_SHORTCUT_KEY);
  }
}

export const defaultKeyboardLockManager = new KeyboardLockManager();
