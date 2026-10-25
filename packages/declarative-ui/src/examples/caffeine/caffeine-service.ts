import { invokePluginService } from '../shared/native-ipc.js'
import type {
  CaffeineActionResult,
  CaffeineMode,
  CaffeinePreset,
  CaffeineStatus
} from './types.js'

export const CAFFEINE_PLUGIN_NAME = 'CaffeinePlugin'

export const CAFFEINE_PRESETS: ReadonlyArray<CaffeinePreset> = [
  {
    id: 'caffeine-0',
    minutes: 0,
    title: '无限期保持常亮（直到手动关闭）',
    subtitle: '阻止系统自动进入睡眠或关闭显示器背光'
  },
  {
    id: 'caffeine-15',
    minutes: 15,
    title: '保持常亮 15 分钟',
    subtitle: '适合短时文件传输、会议投屏演示或临时离开座位'
  },
  {
    id: 'caffeine-30',
    minutes: 30,
    title: '保持常亮 30 分钟',
    subtitle: '适合阅读长文、线上分享或常规构建打包'
  },
  {
    id: 'caffeine-60',
    minutes: 60,
    title: '保持常亮 1 小时',
    subtitle: '适合编译大型工程、下载大体积镜像或导出视频'
  },
  {
    id: 'caffeine-120',
    minutes: 120,
    title: '保持常亮 2 小时',
    subtitle: '适合长时间模型推理、数据库迁移或备份任务'
  },
  {
    id: 'caffeine-240',
    minutes: 240,
    title: '保持常亮 4 小时',
    subtitle: '适合半天无人值守批处理任务，到期后自动恢复系统休眠策略'
  }
]

export function formatRemainingDuration(
  active: boolean,
  durationMinutes: number,
  remainingMs: number | null
): string {
  if (!active) return '未开启'
  if (durationMinutes === 0 || remainingMs === null) {
    return '无限期常亮（手动关闭）'
  }
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000))
  if (totalSec < 60) {
    return `${totalSec} 秒`
  }
  const totalMin = Math.floor(totalSec / 60)
  const remSec = totalSec % 60
  if (totalMin < 60) {
    return remSec > 0 ? `${totalMin} 分 ${remSec} 秒` : `${totalMin} 分钟`
  }
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60
  return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`
}

export function normalizeCaffeineStatus(raw: Record<string, unknown>): CaffeineStatus {
  const active = Boolean(raw.active)
  const rawMode = String(raw.mode ?? 'display').trim().toLowerCase()
  const mode: CaffeineMode = rawMode === 'system' ? 'system' : 'display'
  const durationMinutes = Number.isFinite(Number(raw.durationMinutes))
    ? Math.max(0, Number(raw.durationMinutes))
    : 0
  const startedAtMs =
    typeof raw.startedAtMs === 'number' && Number.isFinite(raw.startedAtMs)
      ? raw.startedAtMs
      : null
  const expiresAtMs =
    typeof raw.expiresAtMs === 'number' && Number.isFinite(raw.expiresAtMs)
      ? raw.expiresAtMs
      : null
  const remainingMs =
    active && expiresAtMs !== null
      ? Math.max(0, typeof raw.remainingMs === 'number' ? raw.remainingMs : expiresAtMs - Date.now())
      : null

  return {
    active,
    mode,
    durationMinutes,
    startedAtMs,
    expiresAtMs,
    remainingMs,
    remainingText: formatRemainingDuration(active, durationMinutes, remainingMs),
    sessionId: Number(raw.sessionId ?? 0)
  }
}

export function getDefaultInactiveStatus(mode: CaffeineMode = 'display'): CaffeineStatus {
  return {
    active: false,
    mode,
    durationMinutes: 0,
    startedAtMs: null,
    expiresAtMs: null,
    remainingMs: null,
    remainingText: '未开启',
    sessionId: 0
  }
}

export async function getCaffeineStatus(hostOverride?: unknown): Promise<CaffeineActionResult> {
  const res = await invokePluginService<Record<string, unknown>>(
    CAFFEINE_PLUGIN_NAME,
    'getStatus',
    {},
    hostOverride
  )
  if (!res.ok || !res.data || res.data.ok === false) {
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? 'STATUS_QUERY_FAILED'),
      error: String(res.data?.error ?? res.error ?? '查询防休眠状态失败')
    }
  }
  return {
    ok: true,
    status: normalizeCaffeineStatus(res.data)
  }
}

export async function startCaffeineSession(
  durationMinutes: number,
  mode: CaffeineMode = 'display',
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<CaffeineActionResult> {
  const num = Number(durationMinutes)
  if (!Number.isFinite(num) || num < 0 || num > 10080) {
    return {
      ok: false,
      errorCode: 'INVALID_DURATION',
      error: 'INVALID_DURATION: 防休眠时长必须为 0（无限期）或 1~10080 分钟之间的有效数值'
    }
  }
  if (mode !== 'display' && mode !== 'system') {
    return {
      ok: false,
      errorCode: 'INVALID_MODE',
      error: 'INVALID_MODE: 防休眠模式仅支持 display 或 system'
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    CAFFEINE_PLUGIN_NAME,
    'start',
    {
      durationMinutes: num,
      mode,
      ...extraParams
    },
    hostOverride
  )

  if (!res.ok || !res.data || res.data.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '开启防休眠失败')
    const errCode = String(res.data?.errorCode ?? (errText.match(/^([A-Z0-9_]+):/)?.[1] || 'START_CAFFEINE_FAILED'))
    return {
      ok: false,
      errorCode: errCode,
      error: errText
    }
  }

  return {
    ok: true,
    status: normalizeCaffeineStatus(res.data)
  }
}

export async function stopCaffeineSession(
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<CaffeineActionResult> {
  const res = await invokePluginService<Record<string, unknown>>(
    CAFFEINE_PLUGIN_NAME,
    'stop',
    extraParams,
    hostOverride
  )
  if (!res.ok || !res.data || res.data.ok === false) {
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? 'STOP_CAFFEINE_FAILED'),
      error: String(res.data?.error ?? res.error ?? '停止防休眠失败')
    }
  }
  return {
    ok: true,
    status: normalizeCaffeineStatus(res.data)
  }
}

export async function toggleCaffeineSession(
  mode: CaffeineMode = 'display',
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<CaffeineActionResult> {
  const res = await invokePluginService<Record<string, unknown>>(
    CAFFEINE_PLUGIN_NAME,
    'toggle',
    { mode, ...extraParams },
    hostOverride
  )
  if (!res.ok || !res.data || res.data.ok === false) {
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? 'TOGGLE_CAFFEINE_FAILED'),
      error: String(res.data?.error ?? res.error ?? '切换防休眠状态失败')
    }
  }
  return {
    ok: true,
    status: normalizeCaffeineStatus(res.data)
  }
}
