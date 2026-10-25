export type EnvScope = 'user' | 'system'

export type EnvFilterCategory = 'all' | 'path' | 'path-invalid' | 'user' | 'system'

export interface EnvItem {
  key: string
  value: string
  expandedValue?: string
  scope: EnvScope
  isPathItem: boolean
  index?: number
  isInvalid: boolean
}
