import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from '../../contracts/protocol-versions.js'

export interface PluginRuntimeIdentity {
  readonly platform: string
  readonly runtime: string
  readonly arch: string
}

export interface PluginPlatformTarget extends Record<string, unknown> {
  id: string
  platform: 'windows' | 'macos'
  runtime: 'electron' | 'legacy-delphi'
  arch: 'any' | 'ia32' | 'x64' | 'arm64' | 'universal'
  minSdkContractVersion?: number
}

export interface PluginNativeComponent extends Record<string, unknown> {
  id: string
  kind: 'dll' | 'shared-library' | 'worker'
  targetId: string
  arch: Exclude<PluginPlatformTarget['arch'], 'any'>
  abi: string
  entry: string
  protocolVersion?: number
  hostComponentId?: string
  sha256?: string
  payloadFiles?: PluginNativePayloadFile[]
}

/** Packaging metadata only; never a loadable component or worker declaration. */
export interface PluginNativePayloadFile {
  entry: string
  format: 'pe' | 'data'
  arch?: 'ia32' | 'x64'
  sha256: string
}

export interface ResolvedPluginNativePayloadFile extends PluginNativePayloadFile {
  readonly targetId: string
  readonly ownerComponentId: string
}

export interface ResolvedPluginRuntimeTarget {
  readonly target?: PluginPlatformTarget
  readonly nativeComponents: readonly PluginNativeComponent[]
  readonly legacyWindows: boolean
  readonly payloadFiles?: readonly ResolvedPluginNativePayloadFile[]
}

export interface PluginRuntimeTargetResolverOptions {
  readonly sdkContractVersion?: number
  readonly macNativeCatalogLookup?: MacNativeCatalogLookup
}

/** Injected only by Main from a trusted, ready Mac Host; never a manifest field. */
export type MacNativeCatalogLookup = (pluginId: string, componentId: string) => {
  readonly relativePath: string
  readonly sha256: string
} | undefined

const TARGET_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const ABI_PATTERN = /^[a-z][a-z0-9.-]*(?:\/v|@)(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,2}$/
const TARGET_KEYS = new Set([
  'id', 'platform', 'runtime', 'arch', 'abi', 'minSdkContractVersion'
])
const COMPONENT_KEYS = new Set([
  'id', 'kind', 'targetId', 'arch', 'abi', 'entry', 'protocolVersion', 'hostComponentId', 'sha256', 'payloadFiles'
])
const PAYLOAD_KEYS = new Set(['entry', 'format', 'arch', 'sha256'])
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function isSafeNativeFilePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('lib/') || /[\\\u0000-\u001f\u007f:*?<>"|]/.test(value)) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' &&
    !/[. ]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
}

function validatePayload(value: unknown, label: string): PluginNativePayloadFile {
  if (!isRecord(value)) invalid(`${label} must be an object`)
  validateKeys(value, PAYLOAD_KEYS, label)
  if (!isSafeNativeFilePath(value.entry) || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    invalid(`${label} has an invalid entry or sha256`)
  }
  if (value.format === 'pe') {
    if (!/\.(?:dll|exe)$/i.test(value.entry) || !['ia32', 'x64'].includes(value.arch as string)) invalid(`${label} PE file must declare .dll/.exe and ia32/x64`)
  } else if (value.format === 'data') {
    if (Object.hasOwn(value, 'arch') || /\.(?:dll|exe)$/i.test(value.entry)) invalid(`${label} data entry cannot declare arch or a PE extension`)
  } else invalid(`${label}.format must be pe or data`)
  return value as unknown as PluginNativePayloadFile
}
const TARGET_PLATFORMS = new Set(['windows', 'macos'])
const TARGET_RUNTIMES = new Set(['electron', 'legacy-delphi'])
const TARGET_ARCHES = new Set(['any', 'ia32', 'x64', 'arm64', 'universal'])
const COMPONENT_KINDS = new Set(['dll', 'shared-library', 'worker'])
const NATIVE_HOST32_DLL_ABI = 'ztools-native-host/v1'
const WINDOWS_PE_DEPENDENCY_ABI = 'windows-pe/v1'
export const MAC_NATIVE_ABI = 'ztools-mac-native/v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new ZToolsError(errorCodes.pluginPackageInvalid, message)
}

function unsupported(message: string): never {
  throw new ZToolsError(errorCodes.notSupported, message)
}

function resolveSdkContractVersion(options?: PluginRuntimeTargetResolverOptions): number {
  if (options === undefined) {
    if (!Number.isSafeInteger(SDK_HOST_MAXIMUM_CONTRACT_VERSION) || SDK_HOST_MAXIMUM_CONTRACT_VERSION < 1) {
      return unsupported('Invalid host SDK contract version')
    }
    return SDK_HOST_MAXIMUM_CONTRACT_VERSION
  }
  if (!isRecord(options)) return unsupported('Invalid host SDK contract version options')
  if (Object.keys(options).some((key) => key !== 'sdkContractVersion' && key !== 'macNativeCatalogLookup')) {
    return unsupported('Host SDK contract version options contain unknown fields')
  }
  if (options.macNativeCatalogLookup !== undefined && typeof options.macNativeCatalogLookup !== 'function') {
    return unsupported('Invalid host Mac native catalog lookup option')
  }
  if (!Object.hasOwn(options, 'sdkContractVersion')) {
    return unsupported('Missing host SDK contract version')
  }
  const value = options.sdkContractVersion
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return unsupported('Invalid host SDK contract version')
  }
  return value
}

function validateKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) invalid(`${label} contains unknown fields`)
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) return false
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '..' || segment.includes(':'))
}

function validateTarget(value: unknown, index: number): PluginPlatformTarget {
  const label = `targets[${index}]`
  if (!isRecord(value)) invalid(`${label} must be an object`)
  validateKeys(value, TARGET_KEYS, label)
  if (
    typeof value.id !== 'string' || !TARGET_ID_PATTERN.test(value.id) ||
    typeof value.platform !== 'string' || !TARGET_PLATFORMS.has(value.platform) ||
    typeof value.runtime !== 'string' || !TARGET_RUNTIMES.has(value.runtime) ||
    typeof value.arch !== 'string' || !TARGET_ARCHES.has(value.arch)
  ) {
    invalid(`${label} has invalid id, platform, runtime, or arch`)
  }
  if (value.runtime === 'legacy-delphi' && value.platform !== 'windows') {
    invalid(`${label} legacy-delphi runtime is only allowed on Windows`)
  }
  if (value.platform === 'macos' && value.arch === 'ia32') {
    invalid(`${label} macOS Electron target does not support ia32 architecture`)
  }
  if (value.abi !== undefined && (typeof value.abi !== 'string' || !ABI_PATTERN.test(value.abi))) {
    invalid(`${label}.abi has invalid format`)
  }
  if (
    value.minSdkContractVersion !== undefined &&
    (!Number.isSafeInteger(value.minSdkContractVersion) || (value.minSdkContractVersion as number) < 1)
  ) {
    invalid(`${label}.minSdkContractVersion must be a positive integer`)
  }
  return value as unknown as PluginPlatformTarget
}

function validateComponent(value: unknown, index: number): PluginNativeComponent {
  const label = `nativeComponents[${index}]`
  if (!isRecord(value)) invalid(`${label} must be an object`)
  validateKeys(value, COMPONENT_KEYS, label)
  if (value.arch === 'any') invalid(`${label}.arch cannot be "any"; native components must declare a concrete architecture`)
  if (
    typeof value.id !== 'string' || !TARGET_ID_PATTERN.test(value.id) ||
    typeof value.targetId !== 'string' || !TARGET_ID_PATTERN.test(value.targetId) ||
    typeof value.kind !== 'string' || !COMPONENT_KINDS.has(value.kind) ||
    typeof value.arch !== 'string' || !TARGET_ARCHES.has(value.arch) ||
    typeof value.abi !== 'string' || !ABI_PATTERN.test(value.abi) ||
    !isSafeRelativePath(value.entry)
  ) {
    invalid(`${label} has invalid id, kind, targetId, arch, abi, or entry`)
  }
  if (value.protocolVersion !== undefined && (!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1)) {
    invalid(`${label}.protocolVersion must be a positive integer`)
  }
  if (value.hostComponentId !== undefined &&
      (typeof value.hostComponentId !== 'string' || !TARGET_ID_PATTERN.test(value.hostComponentId))) {
    invalid(`${label}.hostComponentId has invalid format`)
  }
  if (value.kind === 'dll' && !value.entry.toLowerCase().endsWith('.dll')) {
    invalid(`${label}.entry DLL path must end with .dll`)
  }
  if (Object.hasOwn(value, 'sha256') && (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256))) {
    invalid(`${label}.sha256 must be a 64-character lowercase hex string`)
  }
  if (Object.hasOwn(value, 'payloadFiles')) {
    if (!Array.isArray(value.payloadFiles)) invalid(`${label}.payloadFiles must be an array`)
    value.payloadFiles.forEach((item, index) => validatePayload(item, `${label}.payloadFiles[${index}]`))
  }
  return value as unknown as PluginNativeComponent
}

function isNativeHost32X64Binding(
  target: PluginPlatformTarget,
  component: PluginNativeComponent
): boolean {
  return target.platform === 'windows' &&
    target.runtime === 'electron' &&
    target.arch === 'x64' &&
    component.kind === 'dll' &&
    component.arch === 'ia32' &&
    component.abi === NATIVE_HOST32_DLL_ABI &&
    component.protocolVersion === 1
}

function isNativeHost32X64DependencyBinding(
  target: PluginPlatformTarget,
  component: PluginNativeComponent,
  hostComponent: PluginNativeComponent | undefined
): boolean {
  return target.platform === 'windows' &&
    target.runtime === 'electron' &&
    target.arch === 'x64' &&
    component.kind === 'shared-library' &&
    component.arch === 'ia32' &&
    component.abi === WINDOWS_PE_DEPENDENCY_ABI &&
    component.hostComponentId !== undefined &&
    hostComponent !== undefined &&
    hostComponent.targetId === target.id &&
    hostComponent.kind === 'dll' &&
    hostComponent.arch === 'ia32' &&
    hostComponent.abi === NATIVE_HOST32_DLL_ABI &&
    hostComponent.protocolVersion === 1
}

function expectedPlatform(platform: string): 'windows' | 'macos' {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  unsupported(`Platform ${platform} is not yet supported for running plugins`)
}

function archMatches(target: PluginPlatformTarget, runtime: PluginRuntimeIdentity): boolean {
  if (target.arch === runtime.arch) return true
  if (target.arch === 'any') return true
  return target.platform === 'macos' && target.arch === 'universal' &&
    (runtime.arch === 'x64' || runtime.arch === 'arm64')
}

/** Resolve and validate the package's current-platform Electron target before install or execution. */
export function resolvePluginRuntimeTarget(
  manifestValue: unknown,
  runtime: PluginRuntimeIdentity,
  options?: PluginRuntimeTargetResolverOptions
): ResolvedPluginRuntimeTarget {
  const sdkContractVersion = resolveSdkContractVersion(options)
  if (!isRecord(manifestValue)) invalid('plugin.json must be an object')
  const platform = expectedPlatform(runtime.platform)
  if (runtime.runtime !== 'electron') unsupported(`Plugin host runtime=${runtime.runtime} is not supported`)
  if (platform === 'macos' && runtime.arch === 'ia32') {
    unsupported('macOS Electron does not support ia32 process architecture; universal packages must run under arm64 or x64')
  }
  if (!new Set(['ia32', 'x64', 'arm64']).has(runtime.arch)) {
    unsupported(`Electron architecture ${runtime.arch} is not supported for running plugins`)
  }

  const dllloader = manifestValue.dllloader
  const requireAdmin = manifestValue.requireAdmin
  if (dllloader !== undefined && typeof dllloader !== 'string') invalid('dllloader must be a string')
  if (requireAdmin !== undefined && typeof requireAdmin !== 'boolean') invalid('requireAdmin must be a boolean')
  const declaresLegacyDll = typeof dllloader === 'string' && dllloader !== ''
  const declaresAdminDll = requireAdmin === true
  if (platform === 'macos' && (declaresLegacyDll || declaresAdminDll)) {
    unsupported('macOS does not support legacy dllloader/requireAdmin fields; use target-bound component declarations')
  }
  const commonLibs = manifestValue.commonLibs
  if (commonLibs !== undefined && (!Array.isArray(commonLibs) || commonLibs.some((item) => typeof item !== 'string'))) {
    invalid('commonLibs must be an array of strings')
  }
  if (platform === 'macos' && Array.isArray(commonLibs) && commonLibs.length > 0) {
    unsupported('macOS does not support target-unbound commonLibs; declare target-specific dependencies instead')
  }

  const hasTargets = Object.hasOwn(manifestValue, 'targets')
  const hasComponents = Object.hasOwn(manifestValue, 'nativeComponents')
  if (!hasTargets) {
    if (hasComponents) invalid('nativeComponents must declare target bindings via targets')
    if (platform === 'macos') {
      unsupported('Plugin does not declare targets; compatibility with this macOS Electron environment cannot be verified')
    }
    if (runtime.arch !== 'ia32') {
      unsupported(`Legacy plugins without targets are only compatible with Windows Electron ia32 (current architecture: ${runtime.arch})`)
    }
    return { nativeComponents: [], legacyWindows: true }
  }
  if (!Array.isArray(manifestValue.targets)) invalid('targets must be an array of target objects')
  if (manifestValue.targets.length === 0) invalid('targets must declare at least one target')
  if (!hasComponents || !Array.isArray(manifestValue.nativeComponents)) {
    invalid('nativeComponents must be an array when targets is declared; use [] for pure JS plugins')
  }

  const targets = manifestValue.targets.map((item, index) => validateTarget(item, index))
  const targetsById = new Map<string, PluginPlatformTarget>()
  for (const target of targets) {
    if (targetsById.has(target.id)) invalid(`Duplicate targets.id: ${target.id}`)
    targetsById.set(target.id, target)
  }

  const componentIds = new Set<string>()
  const components = manifestValue.nativeComponents.map((item, index) => validateComponent(item, index))
  const componentsById = new Map<string, PluginNativeComponent>()
  for (const component of components) {
    if (componentIds.has(component.id)) invalid(`Duplicate nativeComponents.id: ${component.id}`)
    componentIds.add(component.id)
    componentsById.set(component.id, component)
  }
  for (const component of components) {
    const target = targetsById.get(component.targetId)
    if (!target) invalid(`nativeComponents.${component.id} references unknown targetId: ${component.targetId}`)
    const hostComponent = component.hostComponentId === undefined
      ? undefined
      : componentsById.get(component.hostComponentId)

    if (Object.hasOwn(component, 'payloadFiles')) {
      if (target.platform !== 'windows' || target.runtime !== 'electron' || component.kind !== 'dll' ||
          component.arch !== 'ia32' || component.abi !== NATIVE_HOST32_DLL_ABI || component.protocolVersion !== 1 ||
          !component.sha256 || !isSafeNativeFilePath(component.entry)) {
        invalid(`nativeComponents.${component.id}.payloadFiles is only allowed on Windows Electron ia32 NativeHost DLLs with sha256`)
      }
    }
    if (hostComponent && Object.hasOwn(hostComponent, 'payloadFiles') &&
        (!component.sha256 || !isSafeNativeFilePath(component.entry))) {
      invalid(`nativeComponents.${component.id} bound to a payload host must declare a safe lib path and sha256`)
    }

    if (component.hostComponentId !== undefined) {
      if (component.kind !== 'shared-library' || component.abi !== WINDOWS_PE_DEPENDENCY_ABI) {
        invalid(`nativeComponents.${component.id}.hostComponentId is only applicable to windows-pe/v1 shared-library components`)
      }
      if (!hostComponent) {
        invalid(`nativeComponents.${component.id}.hostComponentId references unknown component: ${component.hostComponentId}`)
      }
      if (hostComponent.targetId !== component.targetId) {
        invalid(`nativeComponents.${component.id}.hostComponentId must reference a DLL in the same target`)
      }
      if (
        hostComponent.kind !== 'dll' || hostComponent.arch !== 'ia32' ||
        hostComponent.abi !== NATIVE_HOST32_DLL_ABI || hostComponent.protocolVersion !== 1
      ) {
        invalid(`nativeComponents.${component.id}.hostComponentId must reference an ia32 ${NATIVE_HOST32_DLL_ABI} DLL with protocolVersion=1`)
      }
    }

    if (component.abi === NATIVE_HOST32_DLL_ABI) {
      if (component.kind !== 'dll' || target.platform !== 'windows' || target.runtime !== 'electron') {
        invalid(`nativeComponents.${component.id} ${NATIVE_HOST32_DLL_ABI} ABI only supports Windows Electron DLLs`)
      }
      if (component.arch !== 'ia32') {
        invalid(`nativeComponents.${component.id}.arch must be ia32 when using ${NATIVE_HOST32_DLL_ABI}`)
      }
      if (component.protocolVersion !== 1) {
        invalid(`nativeComponents.${component.id}.protocolVersion must explicitly be 1 when using ${NATIVE_HOST32_DLL_ABI}`)
      }
    }

    if (component.abi === WINDOWS_PE_DEPENDENCY_ABI) {
      if (component.kind !== 'shared-library' || target.platform !== 'windows' || target.runtime !== 'electron') {
        invalid(`nativeComponents.${component.id} ${WINDOWS_PE_DEPENDENCY_ABI} ABI only supports Windows Electron shared-library components`)
      }
      if (component.arch !== 'ia32') {
        invalid(`nativeComponents.${component.id}.arch must be ia32 when using ${WINDOWS_PE_DEPENDENCY_ABI}`)
      }
      if (!component.entry.toLowerCase().endsWith('.dll')) {
        invalid(`nativeComponents.${component.id}.entry must end with .dll when using ${WINDOWS_PE_DEPENDENCY_ABI}`)
      }
    }

    if (component.abi === MAC_NATIVE_ABI && (
      component.kind !== 'shared-library' || target.platform !== 'macos' || target.runtime !== 'electron' ||
      !['x64', 'arm64', 'universal'].includes(component.arch) || component.protocolVersion !== 1 ||
      component.hostComponentId !== undefined ||
      !/^lib\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.dylib$/.test(component.entry)
    )) {
      invalid(`nativeComponents.${component.id} ${MAC_NATIVE_ABI} ABI must bind a macOS Electron dylib with protocolVersion=1`)
    }

    if (
      component.arch !== target.arch &&
      !isNativeHost32X64Binding(target, component) &&
      !isNativeHost32X64DependencyBinding(target, component, hostComponent)
    ) {
      invalid(
        `nativeComponents.${component.id}.arch must exactly match target ${target.id} arch; ` +
        `Windows Electron x64 target ia32 exception requires ${NATIVE_HOST32_DLL_ABI} DLL or a ${WINDOWS_PE_DEPENDENCY_ABI} shared-library bound to it`
      )
    }
    if (component.kind === 'dll' && target.platform !== 'windows') {
      invalid(`nativeComponents.${component.id} DLL component can only bind to a Windows target`)
    }
  }

  const targetEntries = new Set<string>()
  const sharedEntries = new Map<string, string>()
  const hasPayloadContract = components.some(owner => Object.hasOwn(owner, 'payloadFiles'))
  for (const component of components) {
    const files = [{ entry: component.entry, format: 'component', arch: component.arch, sha256: component.sha256 },
      ...(component.payloadFiles ?? [])]
    for (const file of files) {
      const entry = file.entry.replaceAll('\\', '/').split('/').filter(segment => segment !== '' && segment !== '.').join('/').toLowerCase()
      const key = `${component.targetId}:${entry}`
      if (targetEntries.has(key)) invalid(`Duplicate native file path in target ${component.targetId}: ${file.entry}`)
      targetEntries.add(key)
      const format = file.format === 'component' && /\.(dll|exe)$/i.test(file.entry) ? 'pe' : file.format
      const identity = JSON.stringify([format, file.arch, file.sha256])
      const previous = sharedEntries.get(entry)
      if (hasPayloadContract && previous !== undefined && previous !== identity) {
        invalid(`Inconsistent native file declaration across targets: ${file.entry}`)
      }
      sharedEntries.set(entry, identity)
    }
  }

  for (const target of targets) {
    if (target.arch === 'any' && components.some((component) => component.targetId === target.id)) {
      invalid(`target ${target.id} with arch=any must be a pure JS target`)
    }
  }

  if (declaresLegacyDll && !components.some((component) =>
    component.kind === 'dll' && component.entry === dllloader && targetsById.get(component.targetId)?.platform === 'windows'
  )) {
    invalid('Declaring dllloader requires a Windows DLL nativeComponent with an exact matching entry')
  }
  if (declaresAdminDll && !components.some((component) =>
    component.kind === 'dll' && targetsById.get(component.targetId)?.platform === 'windows'
  )) {
    invalid('requireAdmin=true requires a DLL nativeComponent bound to a Windows target')
  }

  const matchingTargets = targets.filter((target) =>
    target.platform === platform && target.runtime === 'electron' && archMatches(target, runtime)
  )
  if (matchingTargets.length === 0) {
    unsupported(`Plugin does not declare a runtime target for ${platform} Electron ${runtime.arch}`)
  }
  if (matchingTargets.length > 1) {
    invalid(`Plugin declares multiple targets for ${platform} Electron ${runtime.arch}; cannot choose safely`)
  }

  const target = matchingTargets[0]
  if (!target) invalid('Unable to resolve current plugin runtime target')
  const minimumSdkContractVersion = target.minSdkContractVersion
  if (minimumSdkContractVersion !== undefined && minimumSdkContractVersion > sdkContractVersion) {
    unsupported(
      `Plugin target ${target.id} requires SDK contract version ${minimumSdkContractVersion}, but current host version is ${sdkContractVersion}`
    )
  }
  const nativeComponents = components.filter((component) => component.targetId === target.id)
  if (platform === 'macos' && nativeComponents.length > 0) {
    if (!options?.macNativeCatalogLookup) {
      unsupported(`macOS target ${target.id} currently supports pure JavaScript plugins only; native components require a trusted Mac Host`)
    }
    if (typeof manifestValue.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifestValue.id)) {
      invalid('Mac native components require a valid plugin id')
    }
    for (const component of nativeComponents) {
      if (component.kind !== 'shared-library' || component.abi !== MAC_NATIVE_ABI ||
          component.protocolVersion !== 1 || component.hostComponentId !== undefined ||
          !/^lib\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.dylib$/.test(component.entry)) {
        unsupported('Current Mac Host only supports target-bound native ABI v1 dylib components')
      }
      let approved: ReturnType<MacNativeCatalogLookup>
      try { approved = options.macNativeCatalogLookup(manifestValue.id, component.id) }
      catch { unsupported('Trusted Mac native catalog lookup failed') }
      if (!approved || approved.relativePath !== component.entry || !/^[a-f0-9]{64}$/.test(approved.sha256)) {
        unsupported('Mac native component does not match the current app trusted catalog')
      }
    }
  }
  const payloadFiles = nativeComponents.flatMap(component => (component.payloadFiles ?? []).map(file => ({
    ...file, targetId: component.targetId, ownerComponentId: component.id
  })))
  return { target, nativeComponents, legacyWindows: false, ...(payloadFiles.length > 0 ? { payloadFiles } : {}) }
}
