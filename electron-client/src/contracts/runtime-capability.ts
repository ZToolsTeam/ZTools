export const RUNTIME_CAPABILITY_IDS = Object.freeze([
  'screen.capture',
  'clipboard.files.read',
  'system.hibernate'
] as const)

/** Host-only event sent when a subscribed owner must refresh a permission snapshot. */
export const RUNTIME_PERMISSION_CHANGED_EVENT = 'runtime_permission_changed'

const runtimeCapabilityIdSet: ReadonlySet<string> = new Set(RUNTIME_CAPABILITY_IDS)

export type RuntimeCapabilityId = (typeof RUNTIME_CAPABILITY_IDS)[number]

export type CapabilityImplementationStatus = 'supported' | 'unsupported' | 'unavailable'
export type CapabilityAuthorizationStatus = 'not-requested' | 'granted' | 'denied' | 'unknown'
export type CapabilityOsPermissionStatus =
  | 'not-required'
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

export interface RuntimeCapabilityTarget {
  platform: 'windows' | 'macos'
  runtime: 'electron'
  arch: 'ia32' | 'x64' | 'arm64'
}

export interface RuntimeCapabilityRecord {
  contractVersion: number
  target: RuntimeCapabilityTarget
  capability: RuntimeCapabilityId
  implementation: CapabilityImplementationStatus
  authorization: CapabilityAuthorizationStatus
  osPermission: CapabilityOsPermissionStatus
  revision: number
  reasonCode?: string
}

export function isRuntimeCapabilityId(value: unknown): value is RuntimeCapabilityId {
  return typeof value === 'string' && runtimeCapabilityIdSet.has(value)
}
