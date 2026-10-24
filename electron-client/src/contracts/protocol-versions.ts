export const ELECTRON_VERSION = '43.4.1' as const
export const enum ProtocolVersionValues {
  SDK_CONTRACT = 1,
  SDK_HOST_MAXIMUM_CONTRACT = 2,
  RUNTIME_CAPABILITY_CONTRACT = 1
}
/** Maximum SDK lane this host can serve; each window still receives a Main-selected lane. */
export const SDK_HOST_MAXIMUM_CONTRACT_VERSION = ProtocolVersionValues.SDK_HOST_MAXIMUM_CONTRACT
/** Fail-closed bridge version for windows without a valid Main lane handshake. */
export const SDK_LEGACY_CONTRACT_VERSION = ProtocolVersionValues.SDK_CONTRACT
/** Backwards-compatible name for the host maximum, never a per-window selection. */
export const SDK_CONTRACT_VERSION = SDK_HOST_MAXIMUM_CONTRACT_VERSION
/** Runtime capability record shape has its own version, independent of SDK API lanes. */
export const RUNTIME_CAPABILITY_CONTRACT_VERSION = ProtocolVersionValues.RUNTIME_CAPABILITY_CONTRACT
export const RUNTIME_IDENTITY_CONTRACT_VERSION = 1 as const
export const NATIVE_HOST_PROTOCOL_VERSION = 1 as const
export const SERVICE_PROTOCOL_VERSION = 1 as const
