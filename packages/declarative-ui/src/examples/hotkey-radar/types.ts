export type HotkeyModeFilter =
  | 'conflict'
  | 'conflict:occupied'
  | 'sheet:all'
  | 'sheet:os'
  | 'sheet:vscode'
  | 'sheet:excel'
  | 'sheet:ps'
  | 'sheet:browser'

export type CheatsheetCategory = 'os' | 'vscode' | 'excel' | 'ps' | 'browser'

export interface CheatsheetShortcutItem {
  id: string
  category: CheatsheetCategory
  categoryLabel: string
  keyCombo: string
  macKeyCombo?: string
  title: string
  subtitle: string
  keywords: string[]
}

export interface HotkeyProbePreset {
  id: string
  keyCombo: string
  commonVictim: string
  typicalCulprit: string
  modifyGuide: string
}

export interface HotkeyProbeResultItem {
  id: string
  keyCombo: string
  title: string
  subtitle: string
  categoryLabel: string
  statusText: string
  isOccupied: boolean
  isSystemReserved: boolean
  suspectApp: string | null
  suspectProcess: string | null
  suspectPid: number | null
  modifyGuide: string
}

export interface ParsedHotkeyCombo {
  valid: boolean
  normalized: string
  modifiers: string[]
  key: string
  error?: string
}
