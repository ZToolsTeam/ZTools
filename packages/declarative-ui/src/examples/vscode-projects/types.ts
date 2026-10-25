export type SupportedEditor =
  | 'vscode'
  | 'cursor'
  | 'trae'
  | 'windsurf'
  | 'idea'
  | 'webstorm'
  | 'pycharm'
  | 'goland'

export type EditorFilterGroup = 'all' | 'vsc-family' | 'jetbrains'

export interface ProjectEntry {
  name: string
  path: string
  displayPath: string
  editorType: SupportedEditor
  editorName: string
  lastOpenedMs: number
  lastOpenedRelative: string
  gitBranch?: string
  isMissing: boolean
}
