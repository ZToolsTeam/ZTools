const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const CONTEXT_ENVIRONMENT_KEYS = [
  'ZTOOLS_SOURCE',
  'ZTOOLS_LAUNCH_ID',
  'ZTOOLS_LAUNCH_REQUEST_ID',
  'ZTOOLS_LAUNCH_TYPE',
  'ZTOOLS_LAUNCH_ATTEMPT_NO',
  'ZTOOLS_LAUNCH_METHOD',
  'ZTOOLS_INSTALL_SESSION_ID',
  'ZTOOLS_INSTALLER_MODE',
  'ZTOOLS_REG_SOURCE',
  'ZTOOLS_PLUGIN_ID',
  'ZTOOLS_AUTOSTART',
  'ZTOOLS_UPDATED'
] as const

export interface LaunchIntent {
  pluginId?: string
  source?: string
  launchId?: string
  launchRequestId?: string
  launchType?: string
  launchAttemptNo?: string
  launchMethod?: string
  installSessionId?: string
  installerMode?: string
  registrySource?: string
  autostart?: boolean
  updated?: boolean
}

function cleanValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

function validPluginId(value: string | undefined): string | undefined {
  if (
    !value ||
    !PLUGIN_ID_PATTERN.test(value) ||
    value.endsWith('.') ||
    DEVICE_NAME_PATTERN.test(value)
  ) return undefined
  return value
}

function validSource(value: string | undefined): string | undefined {
  if (!value || !SOURCE_PATTERN.test(value)) return undefined
  return value
}

function validLaunchId(value: string | undefined): string | undefined {
  if (!value || !LAUNCH_ID_PATTERN.test(value)) return undefined
  return value
}

function validContextValue(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/.test(value)) return undefined
  return value
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

function flagValue(argument: string, name: string): string | undefined {
  const prefix = `${name}=`
  return argument.startsWith(prefix) ? cleanValue(argument.slice(prefix.length)) : undefined
}

function contextArgument(
  argumentsList: readonly string[],
  index: number,
  argument: string,
  name: string,
  validate: (value: string | undefined) => string | undefined
): string | undefined {
  if (argument === name) return validate(cleanValue(argumentsList[index + 1] ?? ''))
  if (argument.startsWith(`${name}=`)) return validate(flagValue(argument, name))
  return undefined
}

function readArguments(argumentsList: readonly string[]): LaunchIntent {
  const result: LaunchIntent = {}
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = cleanValue(argumentsList[index] ?? '')
    if (argument === '--plugin') {
      const pluginId = validPluginId(cleanValue(argumentsList[index + 1] ?? ''))
      if (pluginId) result.pluginId = pluginId
      index += 1
      continue
    }
    if (argument.startsWith('--plugin=')) {
      const pluginId = validPluginId(flagValue(argument, '--plugin'))
      if (pluginId) result.pluginId = pluginId
      continue
    }
    if (argument === '--source') {
      const source = validSource(cleanValue(argumentsList[index + 1] ?? ''))
      if (source) result.source = source
      index += 1
      continue
    }
    if (argument.startsWith('--source=')) {
      const source = validSource(flagValue(argument, '--source'))
      if (source) result.source = source
      continue
    }
    if (argument === '--launch-id') {
      const launchId = validLaunchId(cleanValue(argumentsList[index + 1] ?? ''))
      if (launchId) result.launchId = launchId
      index += 1
      continue
    }
    if (argument.startsWith('--launch-id=')) {
      const launchId = validLaunchId(flagValue(argument, '--launch-id'))
      if (launchId) result.launchId = launchId
      continue
    }
    const launchRequestId = contextArgument(argumentsList, index, argument, '--launch-request-id', validContextValue)
    if (launchRequestId !== undefined) {
      result.launchRequestId = launchRequestId
      if (argument === '--launch-request-id') index += 1
      continue
    }
    const launchType = contextArgument(argumentsList, index, argument, '--launch-type', validContextValue)
    if (launchType !== undefined) {
      result.launchType = launchType
      if (argument === '--launch-type') index += 1
      continue
    }
    const launchAttemptNo = contextArgument(argumentsList, index, argument, '--launch-attempt-no', validContextValue)
    if (launchAttemptNo !== undefined) {
      result.launchAttemptNo = launchAttemptNo
      if (argument === '--launch-attempt-no') index += 1
      continue
    }
    const launchMethod = contextArgument(argumentsList, index, argument, '--launch-method', validContextValue)
    if (launchMethod !== undefined) {
      result.launchMethod = launchMethod
      if (argument === '--launch-method') index += 1
      continue
    }
    const installSessionId = contextArgument(argumentsList, index, argument, '--install-session-id', validContextValue)
    if (installSessionId !== undefined) {
      result.installSessionId = installSessionId
      if (argument === '--install-session-id') index += 1
      continue
    }
    const installerMode = contextArgument(argumentsList, index, argument, '--installer-mode', validContextValue)
    if (installerMode !== undefined) {
      result.installerMode = installerMode
      if (argument === '--installer-mode') index += 1
      continue
    }
    if (argument === '--autostart') {
      result.autostart = true
      continue
    }
    const autostart = flagValue(argument, '--autostart')
    if (autostart !== undefined) {
      const value = booleanValue(autostart)
      if (value !== undefined) result.autostart = value
      continue
    }
    if (argument === '--updated') {
      result.updated = true
    }
  }
  return result
}

function readEnvironment(environment: NodeJS.ProcessEnv): LaunchIntent {
  const pluginId = validPluginId(environment.ZTOOLS_PLUGIN_ID ? cleanValue(environment.ZTOOLS_PLUGIN_ID) : undefined)
  const source = validSource(environment.ZTOOLS_SOURCE ? cleanValue(environment.ZTOOLS_SOURCE) : undefined)
  const launchId = validLaunchId(environment.ZTOOLS_LAUNCH_ID ? cleanValue(environment.ZTOOLS_LAUNCH_ID) : undefined)
  const launchRequestId = validContextValue(environment.ZTOOLS_LAUNCH_REQUEST_ID ? cleanValue(environment.ZTOOLS_LAUNCH_REQUEST_ID) : undefined)
  const launchType = validContextValue(environment.ZTOOLS_LAUNCH_TYPE ? cleanValue(environment.ZTOOLS_LAUNCH_TYPE) : undefined)
  const launchAttemptNo = validContextValue(environment.ZTOOLS_LAUNCH_ATTEMPT_NO ? cleanValue(environment.ZTOOLS_LAUNCH_ATTEMPT_NO) : undefined)
  const launchMethod = validContextValue(environment.ZTOOLS_LAUNCH_METHOD ? cleanValue(environment.ZTOOLS_LAUNCH_METHOD) : undefined)
  const installSessionId = validContextValue(environment.ZTOOLS_INSTALL_SESSION_ID ? cleanValue(environment.ZTOOLS_INSTALL_SESSION_ID) : undefined)
  const installerMode = validContextValue(environment.ZTOOLS_INSTALLER_MODE ? cleanValue(environment.ZTOOLS_INSTALLER_MODE) : undefined)
  const registrySource = validContextValue(environment.ZTOOLS_REG_SOURCE ? cleanValue(environment.ZTOOLS_REG_SOURCE) : undefined)
  const autostart = booleanValue(environment.ZTOOLS_AUTOSTART)
  const updated = booleanValue(environment.ZTOOLS_UPDATED)
  const result: LaunchIntent = {
    ...(pluginId ? { pluginId } : {}),
    ...(source ? { source } : {}),
    ...(launchId ? { launchId } : {}),
    ...(launchRequestId ? { launchRequestId } : {}),
    ...(launchType ? { launchType } : {}),
    ...(launchAttemptNo ? { launchAttemptNo } : {}),
    ...(launchMethod ? { launchMethod } : {}),
    ...(installSessionId ? { installSessionId } : {}),
    ...(installerMode ? { installerMode } : {}),
    ...(registrySource ? { registrySource } : {}),
    ...(autostart !== undefined ? { autostart } : {}),
    ...(updated !== undefined ? { updated } : {})
  }
  for (const key of CONTEXT_ENVIRONMENT_KEYS) delete environment[key]
  return result
}

function mergeIntent(argumentIntent: LaunchIntent, environmentIntent: LaunchIntent): LaunchIntent | undefined {
  const merged: LaunchIntent = {
    ...(environmentIntent.pluginId ? { pluginId: environmentIntent.pluginId } : {}),
    ...(environmentIntent.source ? { source: environmentIntent.source } : {}),
    ...(environmentIntent.launchId ? { launchId: environmentIntent.launchId } : {}),
    ...(environmentIntent.launchRequestId ? { launchRequestId: environmentIntent.launchRequestId } : {}),
    ...(environmentIntent.launchType ? { launchType: environmentIntent.launchType } : {}),
    ...(environmentIntent.launchAttemptNo ? { launchAttemptNo: environmentIntent.launchAttemptNo } : {}),
    ...(environmentIntent.launchMethod ? { launchMethod: environmentIntent.launchMethod } : {}),
    ...(environmentIntent.installSessionId ? { installSessionId: environmentIntent.installSessionId } : {}),
    ...(environmentIntent.installerMode ? { installerMode: environmentIntent.installerMode } : {}),
    ...(environmentIntent.registrySource ? { registrySource: environmentIntent.registrySource } : {}),
    ...(environmentIntent.autostart !== undefined ? { autostart: environmentIntent.autostart } : {}),
    ...(environmentIntent.updated !== undefined ? { updated: environmentIntent.updated } : {}),
    ...argumentIntent
  }
  if (merged.pluginId && !merged.source) merged.source = 'plugin-shortcut'
  if (merged.autostart === true && !merged.source) merged.source = 'autostart'
  if (merged.updated === true && !merged.source) merged.source = 'update'
  if (Object.keys(merged).length === 0) return undefined
  return merged
}

export function parseLaunchIntent(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): LaunchIntent | undefined {
  return mergeIntent(readArguments(argumentsList), readEnvironment(environment))
}

export class LaunchIntentDeduplicator {
  readonly #seen = new Set<string>()

  accept(intent: LaunchIntent): boolean {
    if (!intent.launchId) return true
    if (this.#seen.has(intent.launchId)) return false
    this.#seen.add(intent.launchId)
    return true
  }
}
