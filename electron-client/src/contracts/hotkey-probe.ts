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
  if (typeof input !== 'string' || input.length > 128 || /[\u0000-\u001f\u007f]/.test(input)) invalid('Invalid shortcut format, e.g. Cmd+Shift+P')
  const parts = input.trim().split('+').map(s => s.trim())
  if (parts.some(s => !s)) invalid('Shortcut cannot contain empty keys; use Plus for the + key')
  const mods = new Set<string>(); let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase(), modifier = Object.hasOwn(modifiers, lower) ? modifiers[lower] : undefined
    if (modifier) { if (mods.has(modifier)) invalid('Shortcut contains duplicate modifier keys'); mods.add(modifier); continue }
    if (key) invalid('Only a single simultaneous key combination is supported; key sequences are not supported')
    key = Object.hasOwn(keys, lower) ? keys[lower]! : /^[a-z0-9]$/i.test(part) || /^f(?:[1-9]|1\d|20)$/i.test(part) ? part.toUpperCase() : /^[\[\];',./`=\-\\]$/.test(part) ? part : ''
    if (!key) invalid('Unsupported key; on macOS use Cmd, Ctrl, Option, Shift with a standard key or F1-F20')
  }
  if (!key || (!mods.size && !/^F\d+$/.test(key))) invalid('Standard keys require a modifier such as Cmd+K; standalone function keys must be F1-F20')
  return [...['Control', 'Alt', 'Shift', 'Command'].filter(m => mods.has(m)), key].join('+')
}
export function parseHotkeyProbeRequest(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid hotkey probe request')
  const request = value as Record<string, unknown>
  if (Object.keys(request).some(k => k !== 'combos') || !Array.isArray(request.combos) || request.combos.length < 1 || request.combos.length > 32) invalid('Only 1 to 32 shortcuts can be probed per request')
  return [...new Set(request.combos.map(normalizeMacHotkey))]
}
