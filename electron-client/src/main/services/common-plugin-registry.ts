import definitions from './common-plugins.json'

export const COMMON_PLUGIN_ROOT_ID = 'CommonPlugins'

export interface CommonPluginDefinition {
  readonly id: string
  readonly path: string
  readonly requireAdmin: boolean
}

export const COMMON_PLUGIN_DEFINITIONS: readonly CommonPluginDefinition[] = definitions

export function findCommonPlugin(id: string): CommonPluginDefinition | undefined {
  return COMMON_PLUGIN_DEFINITIONS.find((definition) =>
    definition.id.toLowerCase() === id.toLowerCase()
  )
}

export function isCommonPluginRoot(id: string): boolean {
  return COMMON_PLUGIN_ROOT_ID.toLowerCase() === id.toLowerCase()
}
