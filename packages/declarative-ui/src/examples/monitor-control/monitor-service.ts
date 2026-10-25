import { invokePluginService } from '../shared/native-ipc.js'
import type {
  MonitorActionResult,
  MonitorDisplayInfo,
  MonitorFilterValue,
  MonitorProtocol,
  MonitorScanResult
} from './types.js'

export const MONITOR_CONTROL_PLUGIN_NAME = 'MonitorControlPlugin'

export const BRIGHTNESS_PRESETS: ReadonlyArray<{
  id: string
  label: string
  value: number
  shortcutKey: '1' | '2' | '3' | '4'
}> = [
  { id: 'preset-100', label: '设为 100% 亮度（日间模式）', value: 100, shortcutKey: '1' },
  { id: 'preset-75', label: '设为 75% 亮度（标准办公）', value: 75, shortcutKey: '2' },
  { id: 'preset-50', label: '设为 50% 亮度（柔和阅读）', value: 50, shortcutKey: '3' },
  { id: 'preset-20', label: '设为 20% 亮度（夜间护眼）', value: 20, shortcutKey: '4' }
]

export function clampBrightnessValue(value: number): { valid: boolean; clamped: number; errorCode?: string; error?: string } {
  const num = Number(value)
  if (!Number.isFinite(num)) {
    return {
      valid: false,
      clamped: 0,
      errorCode: 'INVALID_BRIGHTNESS',
      error: 'INVALID_BRIGHTNESS: 亮度参数必须为有效的数字 (0~100)'
    }
  }
  return {
    valid: true,
    clamped: Math.max(0, Math.min(100, Math.round(num)))
  }
}

export function formatProtocolLabel(protocol: MonitorProtocol): string {
  switch (protocol) {
    case 'ddcci':
      return 'DDC/CI 硬件控制'
    case 'wmi':
      return 'WMI 内置背光'
    case 'apple':
      return 'Apple DisplayServices'
    case 'unsupported':
      return '不支持 DDC/CI'
  }
}

export function normalizeMonitorDisplay(raw: Record<string, unknown>, idx = 0): MonitorDisplayInfo {
  const id = String(raw.id ?? `display-${idx + 1}`).trim()
  const name = String(raw.name ?? `显示器 #${idx + 1}`).trim()
  const isPrimary = Boolean(raw.isPrimary ?? idx === 0)
  const rawProto = String(raw.protocol ?? 'ddcci').trim().toLowerCase()
  const protocol: MonitorProtocol =
    rawProto === 'wmi' || rawProto === 'ddcci' || rawProto === 'apple' || rawProto === 'unsupported'
      ? rawProto
      : 'ddcci'
  const supportsBrightness = protocol !== 'unsupported'
  const rawBri = Number(raw.brightness)
  const brightness =
    supportsBrightness && Number.isFinite(rawBri)
      ? Math.max(0, Math.min(100, Math.round(rawBri)))
      : null
  const rawCon = Number(raw.contrast)
  const contrast =
    supportsBrightness && raw.contrast !== null && raw.contrast !== undefined && Number.isFinite(rawCon)
      ? Math.max(0, Math.min(100, Math.round(rawCon)))
      : null

  return {
    id,
    name,
    isPrimary,
    protocol,
    protocolLabel: formatProtocolLabel(protocol),
    brightness,
    contrast,
    resolution: String(raw.resolution ?? '1920x1080'),
    scaleFactor: Number(raw.scaleFactor ?? 1) || 1,
    supportsBrightness
  }
}

export async function listMonitorDisplays(
  hostOverride?: unknown,
  extraParams: Record<string, unknown> = {}
): Promise<MonitorScanResult> {
  const res = await invokePluginService<{
    ok?: boolean
    displays?: Array<Record<string, unknown>>
    error?: string
  }>(MONITOR_CONTROL_PLUGIN_NAME, 'listDisplays', extraParams, hostOverride)

  if (!res.ok || !res.data || res.data.ok === false) {
    return {
      ok: false,
      displays: [],
      error: String(res.data?.error ?? res.error ?? res.message ?? '扫描连接的显示器失败')
    }
  }

  const rawList = Array.isArray(res.data.displays) ? res.data.displays : []
  const displays = rawList
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item, idx) => normalizeMonitorDisplay(item, idx))

  return {
    ok: true,
    displays
  }
}

export function filterMonitorDisplays(
  displays: MonitorDisplayInfo[],
  filterValue: MonitorFilterValue,
  query: string
): MonitorDisplayInfo[] {
  const q = String(query ?? '').trim().toLowerCase()
  return displays.filter((d) => {
    if (filterValue === 'ddcci' && d.protocol !== 'ddcci') return false
    if (filterValue === 'internal' && d.protocol !== 'wmi' && d.protocol !== 'apple') return false
    if (!q) return true
    return (
      d.name.toLowerCase().includes(q) ||
      d.resolution.toLowerCase().includes(q) ||
      d.protocolLabel.toLowerCase().includes(q) ||
      d.id.toLowerCase().includes(q)
    )
  })
}

export async function setMonitorBrightness(
  display: MonitorDisplayInfo,
  targetBrightness: number,
  currentDisplays: MonitorDisplayInfo[],
  hostOverride?: unknown
): Promise<MonitorActionResult> {
  if (!display.supportsBrightness || display.protocol === 'unsupported') {
    return {
      ok: false,
      id: display.id,
      errorCode: 'DDC_UNSUPPORTED',
      error: `DDC_UNSUPPORTED: 显示器「${display.name}」未开启 DDC/CI 硬件调光或转接线不支持`
    }
  }

  const check = clampBrightnessValue(targetBrightness)
  if (!check.valid) {
    return {
      ok: false,
      id: display.id,
      errorCode: check.errorCode,
      error: check.error
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    MONITOR_CONTROL_PLUGIN_NAME,
    'setBrightness',
    {
      id: display.id,
      protocol: display.protocol,
      brightness: check.clamped
    },
    hostOverride
  )

  if (!res.ok || res.data?.ok === false) {
    const errText = String(res.data?.error ?? res.error ?? res.message ?? '调节显示器亮度失败')
    const errCode = String(res.data?.errorCode ?? (errText.match(/^([A-Z0-9_]+):/)?.[1] || 'BRIGHTNESS_SET_FAILED'))
    return {
      ok: false,
      id: display.id,
      errorCode: errCode,
      error: errText
    }
  }

  const applied =
    typeof res.data?.brightness === 'number' && Number.isFinite(res.data.brightness)
      ? Math.max(0, Math.min(100, Math.round(res.data.brightness)))
      : check.clamped

  const updatedDisplays = currentDisplays.map((item) =>
    item.id === display.id ? { ...item, brightness: applied } : item
  )

  return {
    ok: true,
    id: display.id,
    brightness: applied,
    updatedDisplays
  }
}

export async function syncAllMonitorsBrightness(
  targetBrightness: number,
  currentDisplays: MonitorDisplayInfo[],
  hostOverride?: unknown
): Promise<MonitorActionResult> {
  const check = clampBrightnessValue(targetBrightness)
  if (!check.valid) {
    return {
      ok: false,
      errorCode: check.errorCode,
      error: check.error
    }
  }

  const supportedIds = currentDisplays
    .filter((d) => d.supportsBrightness)
    .map((d) => d.id)

  if (supportedIds.length === 0) {
    return {
      ok: false,
      errorCode: 'DDC_UNSUPPORTED',
      error: 'DDC_UNSUPPORTED: 当前没有支持硬件亮度控制的显示器'
    }
  }

  const res = await invokePluginService<Record<string, unknown>>(
    MONITOR_CONTROL_PLUGIN_NAME,
    'setBrightness',
    {
      id: 'all',
      displayIds: supportedIds,
      brightness: check.clamped
    },
    hostOverride
  )

  if (!res.ok || res.data?.ok === false) {
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? 'SYNC_BRIGHTNESS_FAILED'),
      error: String(res.data?.error ?? res.error ?? '同步多屏亮度失败')
    }
  }

  const updatedDisplays = currentDisplays.map((d) =>
    d.supportsBrightness ? { ...d, brightness: check.clamped } : d
  )

  return {
    ok: true,
    id: 'all',
    brightness: check.clamped,
    updatedDisplays
  }
}

export async function triggerSleepAllMonitors(
  hostOverride?: unknown,
  dryRun = false
): Promise<MonitorActionResult> {
  const res = await invokePluginService<Record<string, unknown>>(
    MONITOR_CONTROL_PLUGIN_NAME,
    'sleepMonitors',
    { dryRun },
    hostOverride
  )
  if (!res.ok || res.data?.ok === false) {
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? 'SLEEP_MONITORS_FAILED'),
      error: String(res.data?.error ?? res.error ?? '发送熄屏指令失败')
    }
  }
  return { ok: true }
}
