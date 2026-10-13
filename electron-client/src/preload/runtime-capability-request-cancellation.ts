import { parseSdkLaneHandshake } from '../contracts/sdk-lane-handshake.js'
import {
  parseRuntimeCapabilityRequestCancellation,
  RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL
} from '../contracts/runtime-capability-request-cancel.js'

interface CancellationPort {
  invoke(channel: string, value: unknown): Promise<unknown>
}

/** Exposes only the fixed screen-permission request cancellation on authenticated plugin top frames. */
export function createRuntimeCapabilityRequestCancellationBridge(
  port: CancellationPort,
  handshake: unknown,
  isMainFrame: boolean
): Readonly<Record<string, (request: unknown) => Promise<unknown>>> | undefined {
  const lane = parseSdkLaneHandshake(handshake)
  if (!isMainFrame || !lane) return undefined
  return Object.freeze({
    runtime_capability_request: (request: unknown) => {
      try {
        return port.invoke(RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL,
          parseRuntimeCapabilityRequestCancellation(request))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}
