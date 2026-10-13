import { parseSdkLaneHandshake } from '../contracts/sdk-lane-handshake.js'
import {
  NETWORK_REQUEST_CANCEL_CHANNEL,
  parseNetworkRequestCancellation
} from '../contracts/network-request-cancel.js'

interface CancellationPort {
  invoke(channel: string, value: unknown): Promise<unknown>
}

/** Exposes one fixed network cancellation method to trusted plugin SDK top frames. */
export function createNetworkRequestCancellationBridge(
  port: CancellationPort,
  handshake: unknown,
  isMainFrame: boolean
): Readonly<Record<string, (request: unknown) => Promise<unknown>>> | undefined {
  const lane = parseSdkLaneHandshake(handshake)
  if (!isMainFrame || !lane) return undefined
  return Object.freeze({
    network_http_request: (request: unknown) => {
      try {
        return port.invoke(NETWORK_REQUEST_CANCEL_CHANNEL, parseNetworkRequestCancellation(request))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  })
}
