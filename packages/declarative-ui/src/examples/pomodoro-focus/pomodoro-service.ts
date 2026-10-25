import type {
  CountdownCategory,
  CountdownItem,
  EnrichedCountdownItem,
  PomodoroPhase,
  PomodoroState
} from './types.js'

export const FOCUS_DURATION_MS = 25 * 60 * 1000
export const SHORT_BREAK_DURATION_MS = 5 * 60 * 1000
export const LONG_BREAK_DURATION_MS = 15 * 60 * 1000

export const DEFAULT_COUNTDOWNS: CountdownItem[] = [
  {
    id: 'cd-1',
    title: 'ZTools 2.0 极客正式版全球发布',
    targetDate: '2026-10-28',
    category: 'work',
    isRecurring: false,
    createdAt: 1700000000000
  },
  {
    id: 'cd-2',
    title: '每月固定发薪日与绩效结算',
    targetDate: '2026-10-31',
    category: 'finance',
    isRecurring: true,
    createdAt: 1700000000000
  },
  {
    id: 'cd-3',
    title: '核心云服务器与 CDN 年度续费节点',
    targetDate: '2026-11-15',
    category: 'work',
    isRecurring: false,
    createdAt: 1700000000000
  },
  {
    id: 'cd-4',
    title: '元旦跨年假期与年度复盘',
    targetDate: '2027-01-01',
    category: 'life',
    isRecurring: false,
    createdAt: 1700000000000
  }
]

export function formatRemainingMmSs(remainingMs: number): string {
  const safeSec = Math.max(0, Math.ceil(remainingMs / 1000))
  const mm = String(Math.floor(safeSec / 60)).padStart(2, '0')
  const ss = String(safeSec % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 基于真实物理时间戳 (Date.now() - startTime) 的防休眠漂移番茄工作钟内核
 */
export class PomodoroTimerEngine {
  #state: PomodoroState
  #onNotification?: (title: string, body: string, nextPhase: PomodoroPhase) => void

  constructor(
    initialState?: Partial<PomodoroState>,
    onNotification?: (title: string, body: string, nextPhase: PomodoroPhase) => void
  ) {
    this.#state = {
      phase: initialState?.phase ?? 'idle',
      startTime: initialState?.startTime ?? 0,
      durationMs: initialState?.durationMs ?? FOCUS_DURATION_MS,
      pausedRemainingMs: initialState?.pausedRemainingMs,
      completedCycles: initialState?.completedCycles ?? 0
    }
    this.#onNotification = onNotification
  }

  getState(): PomodoroState {
    return { ...this.#state }
  }

  startFocus(nowMs = Date.now(), durationMs = FOCUS_DURATION_MS): PomodoroState {
    this.#state = {
      phase: 'focus',
      startTime: nowMs,
      durationMs,
      pausedRemainingMs: undefined,
      completedCycles: this.#state.completedCycles
    }
    return this.getState()
  }

  pause(nowMs = Date.now()): PomodoroState {
    if (this.#state.phase === 'idle' || this.#state.pausedRemainingMs !== undefined) {
      return this.getState()
    }
    const elapsed = Math.max(0, nowMs - this.#state.startTime)
    const remaining = Math.max(0, this.#state.durationMs - elapsed)
    this.#state = {
      ...this.#state,
      pausedRemainingMs: remaining
    }
    return this.getState()
  }

  resume(nowMs = Date.now()): PomodoroState {
    if (this.#state.phase === 'idle' || this.#state.pausedRemainingMs === undefined) {
      return this.getState()
    }
    this.#state = {
      ...this.#state,
      startTime: nowMs,
      durationMs: this.#state.pausedRemainingMs,
      pausedRemainingMs: undefined
    }
    return this.getState()
  }

  reset(): PomodoroState {
    this.#state = {
      phase: 'idle',
      startTime: 0,
      durationMs: FOCUS_DURATION_MS,
      pausedRemainingMs: undefined,
      completedCycles: this.#state.completedCycles
    }
    return this.getState()
  }

  getRemainingMs(nowMs = Date.now()): number {
    if (this.#state.phase === 'idle') {
      return FOCUS_DURATION_MS
    }
    if (this.#state.pausedRemainingMs !== undefined) {
      return this.#state.pausedRemainingMs
    }
    const elapsed = Math.max(0, nowMs - this.#state.startTime)
    return Math.max(0, this.#state.durationMs - elapsed)
  }

  /**
   * 推进时钟状态：若倒计时归零，自动流转至下一阶段并触发原生系统通知回调
   */
  tick(nowMs = Date.now()): {
    state: PomodoroState
    remainingMs: number
    transitioned: boolean
  } {
    if (this.#state.phase === 'idle' || this.#state.pausedRemainingMs !== undefined) {
      return {
        state: this.getState(),
        remainingMs: this.getRemainingMs(nowMs),
        transitioned: false
      }
    }

    const remaining = this.getRemainingMs(nowMs)
    if (remaining > 0) {
      return {
        state: this.getState(),
        remainingMs: remaining,
        transitioned: false
      }
    }

    if (this.#state.phase === 'focus') {
      const nextCycles = this.#state.completedCycles + 1
      const isLongBreak = nextCycles % 4 === 0
      const nextPhase: PomodoroPhase = isLongBreak ? 'long_break' : 'short_break'
      const nextDuration = isLongBreak ? LONG_BREAK_DURATION_MS : SHORT_BREAK_DURATION_MS

      this.#state = {
        phase: nextPhase,
        startTime: nowMs,
        durationMs: nextDuration,
        pausedRemainingMs: undefined,
        completedCycles: nextCycles
      }
      this.#onNotification?.(
        '番茄专注完成',
        isLongBreak
          ? `已完成 ${nextCycles} 个番茄钟，进入 15 分钟长休恢复精力`
          : '25 分钟深度专注已达成，起身休息 5 分钟吧',
        nextPhase
      )
      return {
        state: this.getState(),
        remainingMs: nextDuration,
        transitioned: true
      }
    }

    // Break finished -> back to idle
    this.#state = {
      phase: 'idle',
      startTime: 0,
      durationMs: FOCUS_DURATION_MS,
      pausedRemainingMs: undefined,
      completedCycles: this.#state.completedCycles
    }
    this.#onNotification?.('休息结束', '准备好开启下一轮 25 分钟极简专注了吗？', 'idle')
    return {
      state: this.getState(),
      remainingMs: FOCUS_DURATION_MS,
      transitioned: true
    }
  }
}

function getDaysInYearMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate()
}

export function validateCountdownInput(input: {
  title: string
  targetDate: string
  category?: CountdownCategory
}): {
  valid: boolean
  error?: string
} {
  if (!input || !String(input.title || '').trim()) {
    return { valid: false, error: 'INVALID_TITLE: 倒数日标题不能为空' }
  }
  const dateStr = String(input.targetDate || '').trim()
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return { valid: false, error: 'INVALID_DATE: 日期格式必须为 YYYY-MM-DD' }
  }
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12) {
    return { valid: false, error: 'INVALID_DATE: 月份必须在 01 ~ 12 之间' }
  }
  const maxDay = getDaysInYearMonth(y, m)
  if (d < 1 || d > maxDay) {
    return { valid: false, error: `INVALID_DATE: ${y}-${m} 不存在第 ${d} 日` }
  }
  return { valid: true }
}

/**
 * 计算倒数天数，支持按月循环日程（如每月 31 号发薪日在 2 月自动对齐至 28/29 号，绝不产生 NaN 或越界）
 */
export function calculateDaysLeft(
  targetDate: string,
  isRecurring = false,
  referenceDate: Date | string = new Date()
): {
  days: number
  text: string
  resolvedDate: string
} {
  const check = validateCountdownInput({ title: 'check', targetDate })
  if (!check.valid) {
    throw new Error(check.error)
  }

  const refObj = typeof referenceDate === 'string' ? new Date(`${referenceDate}T00:00:00Z`) : referenceDate
  if (Number.isNaN(refObj.getTime())) {
    throw new Error('INVALID_REFERENCE_DATE: 基准时间无效')
  }

  const refYear = refObj.getUTCFullYear()
  const refMonth = refObj.getUTCMonth() + 1
  const refDay = refObj.getUTCDate()
  const refUtcMs = Date.UTC(refYear, refMonth - 1, refDay)

  const [origY, origM, origD] = targetDate.split('-').map(Number) as [number, number, number]

  let finalY = origY
  let finalM = origM
  let finalD = origD

  if (isRecurring) {
    // 优先计算当月对应的循环日（若当月只有 28/29/30 天，自动钳位至当月最后一天）
    const maxDayThisMonth = getDaysInYearMonth(refYear, refMonth)
    const clampedThisMonthDay = Math.min(origD, maxDayThisMonth)
    const candidateThisMonthMs = Date.UTC(refYear, refMonth - 1, clampedThisMonthDay)

    if (candidateThisMonthMs >= refUtcMs) {
      finalY = refYear
      finalM = refMonth
      finalD = clampedThisMonthDay
    } else {
      const nextY = refMonth === 12 ? refYear + 1 : refYear
      const nextM = refMonth === 12 ? 1 : refMonth + 1
      const maxDayNextMonth = getDaysInYearMonth(nextY, nextM)
      finalY = nextY
      finalM = nextM
      finalD = Math.min(origD, maxDayNextMonth)
    }
  }

  const targetUtcMs = Date.UTC(finalY, finalM - 1, finalD)
  const diffDays = Math.round((targetUtcMs - refUtcMs) / (24 * 3600 * 1000))
  const resolvedDate = `${finalY}-${String(finalM).padStart(2, '0')}-${String(finalD).padStart(2, '0')}`

  if (diffDays === 0) {
    return { days: 0, text: '就是今天', resolvedDate }
  }
  if (diffDays > 0) {
    return { days: diffDays, text: `还有 ${diffDays} 天`, resolvedDate }
  }
  return { days: diffDays, text: `已过去 ${Math.abs(diffDays)} 天`, resolvedDate }
}

export function enrichAndSortCountdowns(
  items: CountdownItem[],
  referenceDate: Date | string = new Date()
): EnrichedCountdownItem[] {
  const enriched = items.map((item) => {
    const calc = calculateDaysLeft(item.targetDate, item.isRecurring, referenceDate)
    return {
      ...item,
      daysLeft: calc.days,
      daysLeftText: calc.text,
      targetDateFormatted: item.isRecurring
        ? `每月 ${item.targetDate.slice(8)} 日 (下次: ${calc.resolvedDate})`
        : calc.resolvedDate
    }
  })

  return enriched.sort((a, b) => {
    if (a.daysLeft >= 0 && b.daysLeft < 0) return -1
    if (a.daysLeft < 0 && b.daysLeft >= 0) return 1
    return a.daysLeft - b.daysLeft
  })
}
