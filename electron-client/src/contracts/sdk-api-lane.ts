import { errorCodes, ZToolsError } from './errors.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from './protocol-versions.js'

export const SUPPORTED_SDK_API_LANES = [1, 2] as const
export type SdkApiLane = (typeof SUPPORTED_SDK_API_LANES)[number]
export type SdkApiUse = 'stable' | 'file-reference' | 'native-reference'

const knownLanes = new Set<number>(SUPPORTED_SDK_API_LANES)

function unsupported(): never {
  throw new ZToolsError(errorCodes.notSupported, '当前 SDK API lane 不受支持')
}

function invalidTargetLane(): never {
  throw new ZToolsError(errorCodes.pluginPackageInvalid, '插件目标 SDK 契约版本无效')
}

export function validateSdkApiHostMaximum(value: unknown): SdkApiLane {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !knownLanes.has(value)) unsupported()
  return value as SdkApiLane
}

/** Host maximum is independent from the API lane selected for one plugin window. */
export function validateSdkApiLane(value: unknown, hostMaximum: unknown = SDK_HOST_MAXIMUM_CONTRACT_VERSION): SdkApiLane {
  const maximum = validateSdkApiHostMaximum(hostMaximum)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !knownLanes.has(value)) unsupported()
  if (value > maximum) unsupported()
  return value as SdkApiLane
}

/**
 * The target's minimum is an explicit lane opt-in for the current 1→2 migration:
 * omitted/1 remains lane 1 even when the host can also serve lane 2.
 */
export function selectSdkApiLane(
  targetMinimumSdkContractVersion: unknown,
  hostMaximum: unknown = SDK_HOST_MAXIMUM_CONTRACT_VERSION
): SdkApiLane {
  const maximum = validateSdkApiHostMaximum(hostMaximum)
  const minimum = targetMinimumSdkContractVersion === undefined ? 1 : targetMinimumSdkContractVersion
  if (typeof minimum !== 'number' || !Number.isSafeInteger(minimum) || minimum < 1) invalidTargetLane()
  if (!knownLanes.has(minimum)) unsupported()
  if (minimum > maximum) unsupported()
  return minimum as SdkApiLane
}

/** Stable APIs stay available on lane 1; reference-based file/native APIs require lane 2. */
export function requireSdkApiLane(
  laneValue: unknown,
  use: SdkApiUse,
  hostMaximum: unknown = SDK_HOST_MAXIMUM_CONTRACT_VERSION
): SdkApiLane {
  const lane = validateSdkApiLane(laneValue, hostMaximum)
  if (use !== 'stable' && use !== 'file-reference' && use !== 'native-reference') unsupported()
  if (use !== 'stable' && lane !== 2) unsupported()
  return lane
}
