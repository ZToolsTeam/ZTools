export type TemplateType = 'declarative' | 'vue-vite' | 'react-vite' | 'preload-only'

export interface PluginConfig {
  id: string
  name: string
  author: string
  description: string
  template: TemplateType
  targetDir: string
}

export interface CliOptions {
  id?: string
  name?: string
  author?: string
  description?: string
  template?: string
  yes?: boolean
  overwrite?: boolean
  help?: boolean
  version?: boolean
}

export interface GenerateResult {
  success: boolean
  targetDir: string
  config: PluginConfig
  files: string[]
}
