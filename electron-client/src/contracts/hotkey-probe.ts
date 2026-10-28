import { errorCodes, ZToolsError } from './errors.js'

export type HotkeyProbeStatus = 'registered' | 'occupied' | 'system' | 'owned'
export interface HotkeyProbeResult { combo: string; status: HotkeyProbeStatus }
const modifiers: Record<string, string> = {
  ctrl: 'Control', control: 'Control', '⌃': 'Control',
  alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
  shift: 'Shift', '⇧': 'Shift', cmd: 'Command', command: 'Command', '⌘': 'Command'
}
const keys: Record<string, string> = {
  space: 'Space', tab: 'Tab', enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  plus: 'Plus', minus: '-'
}
function invalid(message: string): never { throw new ZToolsError(errorCodes.invalidRequest, message) }
export function normalizeMacHotkey(input: unknown): string {
  if (typeof input !== 'string' || input.length > 128 || /[\u0000-\u001f\u007f]/.test(input)) invalid('快捷键格式无效，示例：Cmd+Shift+P')
  const parts = input.trim().split('+').map(s => s.trim())
  if (parts.some(s => !s)) invalid('快捷键不能包含空按键；加号键请写 Plus')
  const mods = new Set<string>(); let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase(), modifier = Object.hasOwn(modifiers, lower) ? modifiers[lower] : undefined
    if (modifier) { if (mods.has(modifier)) invalid('快捷键包含重复修饰键'); mods.add(modifier); continue }
    if (key) invalid('只支持同时按下的一组快捷键，不支持连续按键序列')
    key = Object.hasOwn(keys, lower) ? keys[lower]! : /^[a-z0-9]$/i.test(part) || /^f(?:[1-9]|1\d|20)$/i.test(part) ? part.toUpperCase() : /^[\[\];',./`=\-\\]$/.test(part) ? part : ''
    if (!key) invalid('不支持此按键；Mac 请使用 Cmd、Ctrl、Option、Shift 和普通键/F1–F20')
  }
  if (!key || (!mods.size && !/^F\d+$/.test(key))) invalid('普通按键必须带修饰键，如 Cmd+K；单独功能键请写 F1–F20')
  return [...['Control', 'Alt', 'Shift', 'Command'].filter(m => mods.has(m)), key].join('+')
}
export function parseHotkeyProbeRequest(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('热键探测请求无效')
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(k => k !== 'combos') || !Array.isArray(request.combos) || request.combos.length < 1 || request.combos.length > 32) invalid('每次仅可检测 1–32 组快捷键')
  return [...new Set(request.combos.map(normalizeMacHotkey))]
}
