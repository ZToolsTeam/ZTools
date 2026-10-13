import { IPC_CALL_CHANNEL } from '../contracts/ipc.js'
import {
  REFERENCE_CANCEL_CHANNEL,
  REFERENCE_METHODS,
  parseReferenceCancellation,
  parseReferenceRequest
} from '../contracts/reference-transport.js'
import { parseSdkLaneHandshake } from '../contracts/sdk-lane-handshake.js'

interface ReferenceTransportPort {
  invoke(channel: string, value: unknown): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A lane-2 bridge exists only after the fixed Main handshake validates for the top frame.
 * No Renderer-supplied lane, method name, or channel can change this decision.
 */
export function createReferenceTransportBridge(
  port: ReferenceTransportPort,
  handshake: unknown,
  isMainFrame: boolean
) {
  if (!isMainFrame || parseSdkLaneHandshake(handshake)?.windowSdkApiLane !== 2) return undefined

  const methods: Record<string, (request: unknown) => Promise<unknown>> = {}
  const cancellations: Record<string, (request: unknown) => Promise<unknown>> = {}
  for (const method of REFERENCE_METHODS) {
    methods[method] = (request: unknown) => {
      try {
        if (!isRecord(request) || Object.keys(request).some(key => !['messageId', 'params', 'timeoutMs'].includes(key))) {
          throw new Error('文件请求无效或包含未知字段')
        }
        return port.invoke(IPC_CALL_CHANNEL, parseReferenceRequest({ ...request, method }))
      } catch (error) { return Promise.reject(error) }
    }
    cancellations[method] = (request: unknown) => {
      try {
        if (!isRecord(request) || Object.keys(request).some(key => !['messageId', 'reason'].includes(key))) {
          throw new Error('文件取消请求无效或包含未知字段')
        }
        return port.invoke(REFERENCE_CANCEL_CHANNEL, parseReferenceCancellation({ ...request, method }))
      } catch (error) { return Promise.reject(error) }
    }
  }
  return Object.freeze({ methods: Object.freeze(methods), cancellations: Object.freeze(cancellations) })
}
