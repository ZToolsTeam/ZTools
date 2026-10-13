import { Buffer } from 'node:buffer'

export const MAC_NATIVE_WIRE_VERSION = 1
export const MAC_NATIVE_WIRE_HEADER_BYTES = 36
export const MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES = 1024 * 1024

export const MacNativeFrameType = {
  handshake: 1,
  init: 2,
  info: 3,
  call: 4,
  cancel: 5,
  query: 6,
  clear: 7,
  destroy: 8,
  shutdown: 9,
  progress: 0x8001,
  callback: 0x8002,
  response: 0x8003,
  cancelled: 0x8004,
  error: 0x80ff
} as const

export interface MacNativeFrame {
  version: number
  type: number
  owner: bigint
  generation: bigint
  taskId: bigint
  payload: Buffer
}

const knownTypes = new Set<number>(Object.values(MacNativeFrameType))
const maximumU64 = (1n << 64n) - 1n

export function encodeMacNativeFrame(frame: MacNativeFrame): Buffer {
  if (frame.version !== MAC_NATIVE_WIRE_VERSION || !knownTypes.has(frame.type) ||
      frame.owner <= 0n || frame.owner > maximumU64 || frame.generation <= 0n || frame.generation > maximumU64 ||
      frame.taskId < 0n || frame.taskId > maximumU64 || frame.payload.length > MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) {
    throw new Error('MAC_NATIVE_FRAME_INVALID')
  }
  const output = Buffer.allocUnsafe(MAC_NATIVE_WIRE_HEADER_BYTES + frame.payload.length)
  output.write('ZTMN', 0, 4, 'ascii')
  output.writeUInt16LE(frame.version, 4)
  output.writeUInt16LE(frame.type, 6)
  output.writeUInt32LE(frame.payload.length, 8)
  output.writeBigUInt64LE(frame.owner, 12)
  output.writeBigUInt64LE(frame.generation, 20)
  output.writeBigUInt64LE(frame.taskId, 28)
  frame.payload.copy(output, MAC_NATIVE_WIRE_HEADER_BYTES)
  return output
}

export function decodeMacNativeFrame(frame: Buffer): MacNativeFrame {
  if (frame.length < MAC_NATIVE_WIRE_HEADER_BYTES || frame.toString('ascii', 0, 4) !== 'ZTMN') {
    throw new Error('MAC_NATIVE_FRAME_HEADER_INVALID')
  }
  const version = frame.readUInt16LE(4)
  const type = frame.readUInt16LE(6)
  const payloadLength = frame.readUInt32LE(8)
  const owner = frame.readBigUInt64LE(12)
  const generation = frame.readBigUInt64LE(20)
  const taskId = frame.readBigUInt64LE(28)
  if (version !== MAC_NATIVE_WIRE_VERSION || !knownTypes.has(type) || owner === 0n || generation === 0n ||
      payloadLength > MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES || frame.length !== MAC_NATIVE_WIRE_HEADER_BYTES + payloadLength) {
    throw new Error('MAC_NATIVE_FRAME_INVALID')
  }
  return {
    version,
    type,
    owner,
    generation,
    taskId,
    payload: frame.subarray(MAC_NATIVE_WIRE_HEADER_BYTES)
  }
}

export function parseMacNativeOwner(value: string): bigint | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return undefined
  try {
    const owner = BigInt(value)
    return owner <= maximumU64 ? owner : undefined
  } catch {
    return undefined
  }
}
