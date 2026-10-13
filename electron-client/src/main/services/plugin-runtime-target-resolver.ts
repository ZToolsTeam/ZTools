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
  if (!isRecord(value)) invalid(`${label} 必须是对象`)
  validateKeys(value, PAYLOAD_KEYS, label)
  if (!isSafeNativeFilePath(value.entry) || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    invalid(`${label} 的 entry 或 sha256 无效`)
  }
  if (value.format === 'pe') {
    if (!/\.(?:dll|exe)$/i.test(value.entry) || !['ia32', 'x64'].includes(value.arch as string)) invalid(`${label} PE 文件必须声明 .dll/.exe 和 ia32/x64`)
  } else if (value.format === 'data') {
    if (Object.hasOwn(value, 'arch') || /\.(?:dll|exe)$/i.test(value.entry)) invalid(`${label} data 不能声明 arch 或 PE 扩展名`)
  } else invalid(`${label}.format 必须是 pe 或 data`)
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
      return unsupported('当前宿主 SDK 契约版本无效')
    }
    return SDK_HOST_MAXIMUM_CONTRACT_VERSION
  }
  if (!isRecord(options)) return unsupported('当前宿主 SDK 契约版本配置无效')
  if (Object.keys(options).some((key) => key !== 'sdkContractVersion' && key !== 'macNativeCatalogLookup')) {
    return unsupported('当前宿主 SDK 契约版本配置包含未知字段')
  }
  if (options.macNativeCatalogLookup !== undefined && typeof options.macNativeCatalogLookup !== 'function') {
    return unsupported('当前宿主 Mac 原生目录配置无效')
  }
  if (!Object.hasOwn(options, 'sdkContractVersion')) {
    return unsupported('当前宿主 SDK 契约版本缺失')
  }
  const value = options.sdkContractVersion
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return unsupported('当前宿主 SDK 契约版本无效')
  }
  return value
}

function validateKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) invalid(`${label} 包含未知字段`)
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/.test(value)) return false
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '..' || segment.includes(':'))
}

function validateTarget(value: unknown, index: number): PluginPlatformTarget {
  const label = `targets[${index}]`
  if (!isRecord(value)) invalid(`${label} 必须是对象`)
  validateKeys(value, TARGET_KEYS, label)
  if (
    typeof value.id !== 'string' || !TARGET_ID_PATTERN.test(value.id) ||
    typeof value.platform !== 'string' || !TARGET_PLATFORMS.has(value.platform) ||
    typeof value.runtime !== 'string' || !TARGET_RUNTIMES.has(value.runtime) ||
    typeof value.arch !== 'string' || !TARGET_ARCHES.has(value.arch)
  ) {
    invalid(`${label} 的 id、platform、runtime 或 arch 无效`)
  }
  if (value.runtime === 'legacy-delphi' && value.platform !== 'windows') {
    invalid(`${label} 的 legacy-delphi runtime 只允许用于 Windows`)
  }
  if (value.platform === 'macos' && value.arch === 'ia32') {
    invalid(`${label} 的 macOS Electron 目标不支持 ia32 架构`)
  }
  if (value.abi !== undefined && (typeof value.abi !== 'string' || !ABI_PATTERN.test(value.abi))) {
    invalid(`${label}.abi 格式无效`)
  }
  if (
    value.minSdkContractVersion !== undefined &&
    (!Number.isSafeInteger(value.minSdkContractVersion) || (value.minSdkContractVersion as number) < 1)
  ) {
    invalid(`${label}.minSdkContractVersion 必须是正整数`)
  }
  return value as unknown as PluginPlatformTarget
}

function validateComponent(value: unknown, index: number): PluginNativeComponent {
  const label = `nativeComponents[${index}]`
  if (!isRecord(value)) invalid(`${label} 必须是对象`)
  validateKeys(value, COMPONENT_KEYS, label)
  if (value.arch === 'any') invalid(`${label}.arch 不能是 any；原生组件必须声明实际架构`)
  if (
    typeof value.id !== 'string' || !TARGET_ID_PATTERN.test(value.id) ||
    typeof value.targetId !== 'string' || !TARGET_ID_PATTERN.test(value.targetId) ||
    typeof value.kind !== 'string' || !COMPONENT_KINDS.has(value.kind) ||
    typeof value.arch !== 'string' || !TARGET_ARCHES.has(value.arch) ||
    typeof value.abi !== 'string' || !ABI_PATTERN.test(value.abi) ||
    !isSafeRelativePath(value.entry)
  ) {
    invalid(`${label} 的 id、kind、targetId、arch、abi 或 entry 无效`)
  }
  if (value.protocolVersion !== undefined && (!Number.isInteger(value.protocolVersion) || (value.protocolVersion as number) < 1)) {
    invalid(`${label}.protocolVersion 必须是正整数`)
  }
  if (value.hostComponentId !== undefined &&
      (typeof value.hostComponentId !== 'string' || !TARGET_ID_PATTERN.test(value.hostComponentId))) {
    invalid(`${label}.hostComponentId 格式无效`)
  }
  if (value.kind === 'dll' && !value.entry.toLowerCase().endsWith('.dll')) {
    invalid(`${label}.entry 的 DLL 路径必须以 .dll 结尾`)
  }
  if (Object.hasOwn(value, 'sha256') && (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256))) {
    invalid(`${label}.sha256 必须是 64 位小写十六进制`)
  }
  if (Object.hasOwn(value, 'payloadFiles')) {
    if (!Array.isArray(value.payloadFiles)) invalid(`${label}.payloadFiles 必须是数组`)
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
  unsupported(`当前系统平台 ${platform} 尚不支持插件运行`)
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
  if (!isRecord(manifestValue)) invalid('plugin.json 必须是对象')
  const platform = expectedPlatform(runtime.platform)
  if (runtime.runtime !== 'electron') unsupported(`当前插件宿主 runtime=${runtime.runtime} 尚不支持`)
  if (platform === 'macos' && runtime.arch === 'ia32') {
    unsupported('macOS Electron 不支持 ia32 进程架构；Universal 包应以 arm64 或 x64 进程运行')
  }
  if (!new Set(['ia32', 'x64', 'arm64']).has(runtime.arch)) {
    unsupported(`当前 Electron 架构 ${runtime.arch} 尚不支持插件运行`)
  }

  const dllloader = manifestValue.dllloader
  const requireAdmin = manifestValue.requireAdmin
  if (dllloader !== undefined && typeof dllloader !== 'string') invalid('dllloader 必须是字符串')
  if (requireAdmin !== undefined && typeof requireAdmin !== 'boolean') invalid('requireAdmin 必须是布尔值')
  const declaresLegacyDll = typeof dllloader === 'string' && dllloader !== ''
  const declaresAdminDll = requireAdmin === true
  if (platform === 'macos' && (declaresLegacyDll || declaresAdminDll)) {
    unsupported('macOS 不支持旧版 dllloader/requireAdmin 字段；请使用目标绑定的组件声明')
  }
  const commonLibs = manifestValue.commonLibs
  if (commonLibs !== undefined && (!Array.isArray(commonLibs) || commonLibs.some((item) => typeof item !== 'string'))) {
    invalid('commonLibs 必须是字符串数组')
  }
  if (platform === 'macos' && Array.isArray(commonLibs) && commonLibs.length > 0) {
    unsupported('macOS 当前不支持未绑定运行目标的 commonLibs；请先完成目标专属依赖解析')
  }

  const hasTargets = Object.hasOwn(manifestValue, 'targets')
  const hasComponents = Object.hasOwn(manifestValue, 'nativeComponents')
  if (!hasTargets) {
    if (hasComponents) invalid('nativeComponents 必须通过 targets 声明目标绑定')
    if (platform === 'macos') {
      unsupported('插件未声明 targets，无法确认它兼容当前 macOS Electron 环境')
    }
    if (runtime.arch !== 'ia32') {
      unsupported(`未声明 targets 的旧版插件仅兼容 Windows Electron ia32，当前架构为 ${runtime.arch}`)
    }
    return { nativeComponents: [], legacyWindows: true }
  }
  if (!Array.isArray(manifestValue.targets)) invalid('targets 必须是目标对象数组')
  if (manifestValue.targets.length === 0) invalid('targets 至少要声明一个目标')
  if (!hasComponents || !Array.isArray(manifestValue.nativeComponents)) {
    invalid('声明 targets 时 nativeComponents 必须是数组；纯 JS 插件使用 []')
  }

  const targets = manifestValue.targets.map((item, index) => validateTarget(item, index))
  const targetsById = new Map<string, PluginPlatformTarget>()
  for (const target of targets) {
    if (targetsById.has(target.id)) invalid(`targets.id 重复：${target.id}`)
    targetsById.set(target.id, target)
  }

  const componentIds = new Set<string>()
  const components = manifestValue.nativeComponents.map((item, index) => validateComponent(item, index))
  const componentsById = new Map<string, PluginNativeComponent>()
  for (const component of components) {
    if (componentIds.has(component.id)) invalid(`nativeComponents.id 重复：${component.id}`)
    componentIds.add(component.id)
    componentsById.set(component.id, component)
  }
  for (const component of components) {
    const target = targetsById.get(component.targetId)
    if (!target) invalid(`nativeComponents.${component.id} 引用了未知 targetId：${component.targetId}`)
    const hostComponent = component.hostComponentId === undefined
      ? undefined
      : componentsById.get(component.hostComponentId)

    if (Object.hasOwn(component, 'payloadFiles')) {
      if (target.platform !== 'windows' || target.runtime !== 'electron' || component.kind !== 'dll' ||
          component.arch !== 'ia32' || component.abi !== NATIVE_HOST32_DLL_ABI || component.protocolVersion !== 1 ||
          !component.sha256 || !isSafeNativeFilePath(component.entry)) {
        invalid(`nativeComponents.${component.id}.payloadFiles 仅允许带 sha256 的 Windows Electron ia32 NativeHost DLL`)
      }
    }
    if (hostComponent && Object.hasOwn(hostComponent, 'payloadFiles') &&
        (!component.sha256 || !isSafeNativeFilePath(component.entry))) {
      invalid(`nativeComponents.${component.id} 绑定 payload Host 时必须声明安全 lib 路径和 sha256`)
    }

    if (component.hostComponentId !== undefined) {
      if (component.kind !== 'shared-library' || component.abi !== WINDOWS_PE_DEPENDENCY_ABI) {
        invalid(`nativeComponents.${component.id}.hostComponentId 仅适用于 windows-pe/v1 shared-library`)
      }
      if (!hostComponent) {
        invalid(`nativeComponents.${component.id}.hostComponentId 引用了未知组件：${component.hostComponentId}`)
      }
      if (hostComponent.targetId !== component.targetId) {
        invalid(`nativeComponents.${component.id}.hostComponentId 必须引用同一 target 的 DLL`)
      }
      if (
        hostComponent.kind !== 'dll' || hostComponent.arch !== 'ia32' ||
        hostComponent.abi !== NATIVE_HOST32_DLL_ABI || hostComponent.protocolVersion !== 1
      ) {
        invalid(`nativeComponents.${component.id}.hostComponentId 必须引用 ia32 ${NATIVE_HOST32_DLL_ABI} DLL，protocolVersion=1`)
      }
    }

    if (component.abi === NATIVE_HOST32_DLL_ABI) {
      if (component.kind !== 'dll' || target.platform !== 'windows' || target.runtime !== 'electron') {
        invalid(`nativeComponents.${component.id} 的 ${NATIVE_HOST32_DLL_ABI} ABI 仅支持 Windows Electron DLL`)
      }
      if (component.arch !== 'ia32') {
        invalid(`nativeComponents.${component.id}.arch 使用 ${NATIVE_HOST32_DLL_ABI} 时必须是 ia32`)
      }
      if (component.protocolVersion !== 1) {
        invalid(`nativeComponents.${component.id}.protocolVersion 使用 ${NATIVE_HOST32_DLL_ABI} 时必须显式为 1`)
      }
    }

    if (component.abi === WINDOWS_PE_DEPENDENCY_ABI) {
      if (component.kind !== 'shared-library' || target.platform !== 'windows' || target.runtime !== 'electron') {
        invalid(`nativeComponents.${component.id} 的 ${WINDOWS_PE_DEPENDENCY_ABI} ABI 仅支持 Windows Electron shared-library`)
      }
      if (component.arch !== 'ia32') {
        invalid(`nativeComponents.${component.id}.arch 使用 ${WINDOWS_PE_DEPENDENCY_ABI} 时必须是 ia32`)
      }
      if (!component.entry.toLowerCase().endsWith('.dll')) {
        invalid(`nativeComponents.${component.id}.entry 使用 ${WINDOWS_PE_DEPENDENCY_ABI} 时必须是 .dll`)
      }
    }

    if (component.abi === MAC_NATIVE_ABI && (
      component.kind !== 'shared-library' || target.platform !== 'macos' || target.runtime !== 'electron' ||
      !['x64', 'arm64', 'universal'].includes(component.arch) || component.protocolVersion !== 1 ||
      component.hostComponentId !== undefined ||
      !/^lib\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.dylib$/.test(component.entry)
    )) {
      invalid(`nativeComponents.${component.id} 的 ${MAC_NATIVE_ABI} ABI 必须绑定 macOS Electron dylib，protocolVersion=1`)
    }

    if (
      component.arch !== target.arch &&
      !isNativeHost32X64Binding(target, component) &&
      !isNativeHost32X64DependencyBinding(target, component, hostComponent)
    ) {
      invalid(
        `nativeComponents.${component.id}.arch 必须与 target ${target.id} 的 arch 精确相等；` +
        `Windows Electron x64 target 的 ia32 例外要求 ${NATIVE_HOST32_DLL_ABI} DLL 或绑定该 DLL 的 ${WINDOWS_PE_DEPENDENCY_ABI} shared-library`
      )
    }
    if (component.kind === 'dll' && target.platform !== 'windows') {
      invalid(`nativeComponents.${component.id} 的 DLL 组件只能绑定 Windows target`)
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
      if (targetEntries.has(key)) invalid(`target ${component.targetId} 原生文件路径重复：${file.entry}`)
      targetEntries.add(key)
      const format = file.format === 'component' && /\.(dll|exe)$/i.test(file.entry) ? 'pe' : file.format
      const identity = JSON.stringify([format, file.arch, file.sha256])
      const previous = sharedEntries.get(entry)
      if (hasPayloadContract && previous !== undefined && previous !== identity) {
        invalid(`跨 target 原生文件声明不一致：${file.entry}`)
      }
      sharedEntries.set(entry, identity)
    }
  }

  for (const target of targets) {
    if (target.arch === 'any' && components.some((component) => component.targetId === target.id)) {
      invalid(`target ${target.id} 使用 arch=any 时只能是纯 JS 目标`)
    }
  }

  if (declaresLegacyDll && !components.some((component) =>
    component.kind === 'dll' && component.entry === dllloader && targetsById.get(component.targetId)?.platform === 'windows'
  )) {
    invalid('声明 dllloader 时必须有 entry 完全一致的 Windows DLL nativeComponent')
  }
  if (declaresAdminDll && !components.some((component) =>
    component.kind === 'dll' && targetsById.get(component.targetId)?.platform === 'windows'
  )) {
    invalid('requireAdmin=true 时必须声明绑定到 Windows target 的 DLL nativeComponent')
  }

  const matchingTargets = targets.filter((target) =>
    target.platform === platform && target.runtime === 'electron' && archMatches(target, runtime)
  )
  if (matchingTargets.length === 0) {
    unsupported(`插件未声明适用于 ${platform} Electron ${runtime.arch} 的运行目标`)
  }
  if (matchingTargets.length > 1) {
    invalid(`插件声明了多个适用于 ${platform} Electron ${runtime.arch} 的目标，无法安全选择`)
  }

  const target = matchingTargets[0]
  if (!target) invalid('无法解析当前插件运行目标')
  const minimumSdkContractVersion = target.minSdkContractVersion
  if (minimumSdkContractVersion !== undefined && minimumSdkContractVersion > sdkContractVersion) {
    unsupported(
      `插件目标 ${target.id} 要求 SDK 契约版本 ${minimumSdkContractVersion}，当前宿主版本为 ${sdkContractVersion}`
    )
  }
  const nativeComponents = components.filter((component) => component.targetId === target.id)
  if (platform === 'macos' && nativeComponents.length > 0) {
    if (!options?.macNativeCatalogLookup) {
      unsupported(`macOS 目标 ${target.id} 当前只能安装纯 JavaScript 插件；原生组件需等待可信 Mac Host 支持`)
    }
    if (typeof manifestValue.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifestValue.id)) {
      invalid('Mac 原生组件需要有效的插件 id')
    }
    for (const component of nativeComponents) {
      if (component.kind !== 'shared-library' || component.abi !== MAC_NATIVE_ABI ||
          component.protocolVersion !== 1 || component.hostComponentId !== undefined ||
          !/^lib\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.dylib$/.test(component.entry)) {
        unsupported('当前 Mac Host 仅支持目标绑定的原生 ABI v1 dylib 组件')
      }
      let approved: ReturnType<MacNativeCatalogLookup>
      try { approved = options.macNativeCatalogLookup(manifestValue.id, component.id) }
      catch { unsupported('可信 Mac 原生目录查询失败') }
      if (!approved || approved.relativePath !== component.entry || !/^[a-f0-9]{64}$/.test(approved.sha256)) {
        unsupported('Mac 原生组件未匹配当前 App 的可信目录')
      }
    }
  }
  const payloadFiles = nativeComponents.flatMap(component => (component.payloadFiles ?? []).map(file => ({
    ...file, targetId: component.targetId, ownerComponentId: component.id
  })))
  return { target, nativeComponents, legacyWindows: false, ...(payloadFiles.length > 0 ? { payloadFiles } : {}) }
}
