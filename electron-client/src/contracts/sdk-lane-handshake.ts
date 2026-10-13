import { validateSdkApiHostMaximum, validateSdkApiLane, type SdkApiLane } from './sdk-api-lane.js'

/** Fixed Main/preload metadata channel. It never accepts a requested lane or arbitrary IPC method. */
export const SDK_LANE_HANDSHAKE_CHANNEL = 'ztools:sdk-lane' as const
export interface SdkLaneHandshake {
  readonly hostMaximumSdkContractVersion: SdkApiLane
  readonly windowSdkApiLane: SdkApiLane
}

/** Shape validation only; the Main listener must authenticate the actual sender and main frame. */
export function parseSdkLaneHandshake(value: unknown): Readonly<SdkLaneHandshake> | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const source = value as Record<string, unknown>
    if (!Object.hasOwn(source, 'hostMaximumSdkContractVersion') || !Object.hasOwn(source, 'windowSdkApiLane') ||
        Object.keys(source).some(key => key !== 'hostMaximumSdkContractVersion' && key !== 'windowSdkApiLane')) return undefined
    const hostMaximumSdkContractVersion = validateSdkApiHostMaximum(source.hostMaximumSdkContractVersion)
    const windowSdkApiLane = validateSdkApiLane(source.windowSdkApiLane, hostMaximumSdkContractVersion)
    return Object.freeze({ hostMaximumSdkContractVersion, windowSdkApiLane })
  } catch { return undefined }
}
