import { callHostTransport } from '../shared/native-ipc.js'
import { CHEATSHEET_SHORTCUTS, HIGH_CONFLICT_HOTKEY_PRESETS } from './cheatsheet-data.js'
import type {
  CheatsheetShortcutItem,
  HotkeyModeFilter,
  HotkeyProbePreset,
  HotkeyProbeResultItem,
  ParsedHotkeyCombo
} from './types.js'

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'] as const
const MODIFIER_MAP: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  ctl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  shft: 'Shift',
  win: 'Win',
  meta: 'Win',
  super: 'Win',
  cmd: 'Ctrl',
  command: 'Ctrl'
}

const VALID_MAIN_KEY_REGEX =
  /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|SPACE|TAB|ENTER|RETURN|ESC|ESCAPE|BACKSPACE|DELETE|DEL|INSERT|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|PLUS|MINUS|[\\[\];',./`=-])$/i

export function parseAndNormalizeHotkeyCombo(rawInput: string): ParsedHotkeyCombo {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return {
      valid: false,
      normalized: '',
      modifiers: [],
      key: '',
      error: 'EMPTY_HOTKEY_EXPRESSION: 快捷键表达式不能为空'
    }
  }

  const trimmed = rawInput.trim()
  if (/\+\s*\+/.test(trimmed) || trimmed.endsWith('+')) {
    return {
      valid: false,
      normalized: '',
      modifiers: [],
      key: '',
      error: `MALFORMED_HOTKEY: 快捷键格式包含连续或末尾加号 (${trimmed})`
    }
  }

  const tokens = trimmed
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean)

  if (tokens.length === 0) {
    return {
      valid: false,
      normalized: '',
      modifiers: [],
      key: '',
      error: 'EMPTY_HOTKEY_EXPRESSION'
    }
  }

  const modSet = new Set<(typeof MODIFIER_ORDER)[number]>()
  const mainKeys: string[] = []

  for (const token of tokens) {
    const lower = token.toLowerCase()
    const mappedMod = MODIFIER_MAP[lower]
    if (mappedMod) {
      modSet.add(mappedMod)
      continue
    }
    if (!VALID_MAIN_KEY_REGEX.test(token)) {
      return {
        valid: false,
        normalized: '',
        modifiers: [],
        key: '',
        error: `INVALID_KEY_TOKEN: 不支持的按键名称 "${token}"`
      }
    }
    const normalizedKey =
      token.length === 1
        ? token.toUpperCase()
        : token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
    mainKeys.push(normalizedKey)
  }

  if (mainKeys.length !== 1) {
    return {
      valid: false,
      normalized: '',
      modifiers: [],
      key: '',
      error:
        mainKeys.length === 0
          ? 'MISSING_MAIN_KEY: 缺少主键（如 A、F1、Space）'
          : 'MULTIPLE_MAIN_KEYS: 一组快捷键只能包含一个主键'
    }
  }

  const orderedMods = MODIFIER_ORDER.filter((m) => modSet.has(m))
  const mainKey = mainKeys[0]!
  const isFunctionKey = /^F(?:[1-9]|1[0-2])$/i.test(mainKey)

  if (orderedMods.length === 0 && !isFunctionKey) {
    return {
      valid: false,
      normalized: '',
      modifiers: [],
      key: mainKey,
      error: 'MISSING_MODIFIER: 普通字母/数字全局热键必须包含 Ctrl / Alt / Shift / Win 修饰键'
    }
  }

  const normalized = [...orderedMods, mainKey].join('+')
  return {
    valid: true,
    normalized,
    modifiers: orderedMods,
    key: mainKey
  }
}

export async function probeGlobalHotkeys(
  presets: readonly HotkeyProbePreset[] = HIGH_CONFLICT_HOTKEY_PRESETS,
  customCombo?: string,
  hostOverride?: unknown
): Promise<HotkeyProbeResultItem[]> {
  const effectivePresets: HotkeyProbePreset[] = [...presets]
  if (customCombo && customCombo.trim()) {
    const parsed = parseAndNormalizeHotkeyCombo(customCombo)
    if (parsed.valid) {
      const exists = effectivePresets.some(
        (p) => p.keyCombo.toUpperCase() === parsed.normalized.toUpperCase()
      )
      if (!exists) {
        effectivePresets.unshift({
          id: `custom-${parsed.normalized.toLowerCase()}`,
          keyCombo: parsed.normalized,
          commonVictim: '用户自定义测试组合键',
          typicalCulprit: '后台常驻进程',
          modifyGuide: '可在后台软件快捷键设置中排查或绑为新全局热键'
        })
      }
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'HotkeyRadarPlugin',
      func: 'probeHotkeys',
      params: {
        combos: effectivePresets.map((p) => p.keyCombo)
      }
    },
    hostOverride
  )

  const hostMap = new Map<string, Record<string, unknown>>()
  if (res.ok && res.data && Array.isArray(res.data.results)) {
    for (const r of res.data.results as Array<Record<string, unknown>>) {
      const key = String(r.keyCombo ?? '').toUpperCase().replace(/\s+/g, '')
      if (key) hostMap.set(key, r)
    }
  }

  const items: HotkeyProbeResultItem[] = effectivePresets.map((preset) => {
    const upper = preset.keyCombo.toUpperCase().replace(/\s+/g, '')
    const hostEntry = hostMap.get(upper)
    const isSystemReserved = Boolean(
      hostEntry?.isSystemReserved ?? (upper === 'WIN+L' || upper === 'CTRL+ALT+DEL')
    )
    const isOccupied = Boolean(hostEntry?.isOccupied ?? isSystemReserved)
    const suspectApp = isOccupied
      ? String(hostEntry?.suspectApp || preset.typicalCulprit || '后台进程')
      : null
    const suspectProcess =
      isOccupied && typeof hostEntry?.suspectProcess === 'string'
        ? hostEntry.suspectProcess
        : null
    const suspectPid =
      isOccupied && !isSystemReserved && typeof hostEntry?.suspectPid === 'number' && hostEntry.suspectPid > 4
        ? hostEntry.suspectPid
        : null
    const modifyGuide = String(hostEntry?.modifyGuide || preset.modifyGuide)

    return {
      id: preset.id,
      keyCombo: preset.keyCombo,
      title: preset.commonVictim,
      subtitle: isOccupied
        ? `疑似占用源: ${suspectApp}${suspectPid ? ` (PID: ${suspectPid})` : ''} · 解决建议: ${modifyGuide}`
        : `当前空闲可用 · 常被「${preset.typicalCulprit}」抢占`,
      categoryLabel: isSystemReserved ? '系统内核保留' : '全局热键空闲',
      statusText: isOccupied ? '冲突占用' : '空闲可用',
      isOccupied,
      isSystemReserved,
      suspectApp,
      suspectProcess,
      suspectPid,
      modifyGuide
    }
  })

  items.sort((a, b) => {
    if (a.isOccupied !== b.isOccupied) return a.isOccupied ? -1 : 1
    return 0
  })

  return items
}

export function filterCheatsheetItems(
  modeFilter: HotkeyModeFilter,
  query = '',
  items: readonly CheatsheetShortcutItem[] = CHEATSHEET_SHORTCUTS
): CheatsheetShortcutItem[] {
  const category = modeFilter.startsWith('sheet:')
    ? modeFilter.slice('sheet:'.length)
    : 'all'
  const q = query.trim().toLowerCase()

  return items.filter((item) => {
    if (category !== 'all' && item.category !== category) {
      return false
    }
    if (!q) return true
    const haystack = `${item.keyCombo} ${item.macKeyCombo ?? ''} ${item.title} ${item.subtitle} ${item.categoryLabel} ${item.keywords.join(' ')}`.toLowerCase()
    return haystack.includes(q)
  })
}

export async function killHotkeySuspectProcess(
  item: Pick<HotkeyProbeResultItem, 'isSystemReserved' | 'suspectPid' | 'suspectProcess' | 'suspectApp'>,
  hostOverride?: unknown
): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
  const procLower = (item.suspectProcess || '').toLowerCase()
  if (
    item.isSystemReserved ||
    !item.suspectPid ||
    item.suspectPid <= 4 ||
    procLower === 'explorer.exe' ||
    procLower === 'csrss.exe' ||
    procLower === 'winlogon.exe' ||
    procLower === 'svchost.exe'
  ) {
    return {
      ok: false,
      errorCode: 'PROTECTED_SYSTEM_PROCESS',
      error: `PROTECTED_SYSTEM_PROCESS: 禁止结束系统保留或核心外壳进程 (${item.suspectApp || procLower || 'System'})`
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'HotkeyRadarPlugin',
      func: 'killSuspectProcess',
      params: {
        pid: item.suspectPid,
        processName: item.suspectProcess ?? ''
      }
    },
    hostOverride
  )

  if (!res.ok || (res.data && res.data.ok === false)) {
    const errText = String(res.data?.error ?? res.error ?? '结束嫌疑进程失败')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? codeMatch?.[1] ?? 'KILL_PROCESS_FAILED'),
      error: errText
    }
  }

  return { ok: true }
}
