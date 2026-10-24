import { Buffer } from 'node:buffer'

export const NATIVE_HOST_PROTOCOL_VERSION = 1
export const MAX_NATIVE_HOST_FRAME_BYTES = 1024 * 1024
export const MAX_NATIVE_HOST_PAYLOAD_BYTES = 768 * 1024
export const NATIVE_HOST_SECRET_BYTES = 32
export const NATIVE_HOST_NONCE_BYTES = 32
export const NATIVE_HOST_PROOF_BYTES = 32

const HEADER_BYTES = 36
const MAX_TEXT_BYTES = 128
const MAGIC = Buffer.from('ZTH1', 'ascii')
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export enum NativeHostFrameType {
  Hello = 1,
  HelloAck = 2,
  Request = 3,
  Response = 4,
  Event = 5,
  Error = 6
}

export interface NativeHostFrame {
  protocolVersion: number
  type: NativeHostFrameType
  sessionId: string
  requestId: string
  pluginId: string
  dllId: string
  method: string
  payload: Buffer
}

function encodedText(value: string, allowEmpty: boolean): Buffer {
  if ((!allowEmpty && value.length === 0) || value.includes('\0')) {
    throw new Error('NativeHost frame text is invalid')
  }
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.length > MAX_TEXT_BYTES) throw new Error('NativeHost frame text is too large')
  return encoded
}

function decodedText(value: Buffer, allowEmpty: boolean): string {
  if ((!allowEmpty && value.length === 0) || value.length > MAX_TEXT_BYTES) {
    throw new Error('NativeHost frame text is invalid')
  }
  const decoded = textDecoder.decode(value)
  if (decoded.includes('\0')) throw new Error('NativeHost frame text is invalid')
  return decoded
}

function isFrameType(value: number): value is NativeHostFrameType {
  return value >= NativeHostFrameType.Hello && value <= NativeHostFrameType.Error
}

export function encodeNativeHostFrame(frame: NativeHostFrame): Buffer {
  if (!isFrameType(frame.type)) throw new Error('NativeHost frame type is invalid')
  if (!Number.isInteger(frame.protocolVersion) || frame.protocolVersion < 0 || frame.protocolVersion > 0xffff) {
    throw new Error('NativeHost protocol version is invalid')
  }
  const textValues = [
    encodedText(frame.sessionId, false),
    encodedText(frame.requestId, false),
    encodedText(frame.pluginId, true),
    encodedText(frame.dllId, true),
    encodedText(frame.method, false)
  ]
  const payload = Buffer.from(frame.payload)
  if (payload.length > MAX_NATIVE_HOST_PAYLOAD_BYTES) throw new Error('NativeHost payload is too large')
  const bodyLength = HEADER_BYTES + textValues.reduce((sum, value) => sum + value.length, 0) + payload.length
  if (bodyLength > MAX_NATIVE_HOST_FRAME_BYTES) throw new Error('NativeHost frame is too large')

  const output = Buffer.allocUnsafe(4 + bodyLength)
  output.writeUInt32LE(bodyLength, 0)
  MAGIC.copy(output, 4)
  output.writeUInt16LE(frame.protocolVersion, 8)
  output.writeUInt16LE(frame.type, 10)
  output.writeUInt32LE(0, 12)
  let lengthOffset = 16
  for (const value of textValues) {
    output.writeUInt32LE(value.length, lengthOffset)
    lengthOffset += 4
  }
  output.writeUInt32LE(payload.length, lengthOffset)
  let dataOffset = 4 + HEADER_BYTES
  for (const value of textValues) {
    value.copy(output, dataOffset)
    dataOffset += value.length
  }
  payload.copy(output, dataOffset)
  return output
}

function decodeBody(body: Buffer): NativeHostFrame {
  if (body.length < HEADER_BYTES || !body.subarray(0, 4).equals(MAGIC)) {
    throw new Error('NativeHost frame header is invalid')
  }
  const protocolVersion = body.readUInt16LE(4)
  const type = body.readUInt16LE(6)
  if (!isFrameType(type) || body.readUInt32LE(8) !== 0) {
    throw new Error('NativeHost frame metadata is invalid')
  }
  const lengths: number[] = []
  for (let offset = 12; offset <= 32; offset += 4) lengths.push(body.readUInt32LE(offset))
  const payloadLength = lengths[5]
  if (payloadLength === undefined || payloadLength > MAX_NATIVE_HOST_PAYLOAD_BYTES) {
    throw new Error('NativeHost payload length is invalid')
  }
  const expectedLength = HEADER_BYTES + lengths.reduce((sum, value) => sum + value, 0)
  if (expectedLength !== body.length) throw new Error('NativeHost frame field lengths are invalid')

  let offset = HEADER_BYTES
  const read = (length: number, allowEmpty: boolean): string => {
    const value = decodedText(body.subarray(offset, offset + length), allowEmpty)
    offset += length
    return value
  }
  const sessionLength = lengths[0]
  const requestLength = lengths[1]
  const pluginLength = lengths[2]
  const dllLength = lengths[3]
  const methodLength = lengths[4]
  if (
    sessionLength === undefined || requestLength === undefined || pluginLength === undefined ||
    dllLength === undefined || methodLength === undefined
  ) {
    throw new Error('NativeHost frame lengths are incomplete')
  }
  return {
    protocolVersion,
    type,
    sessionId: read(sessionLength, false),
    requestId: read(requestLength, false),
    pluginId: read(pluginLength, true),
    dllId: read(dllLength, true),
    method: read(methodLength, false),
    payload: Buffer.from(body.subarray(offset))
  }
}

export class NativeHostFrameDecoder {
  #buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): NativeHostFrame[] {
    if (chunk.length === 0) return []
    this.#buffer = this.#buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#buffer, chunk])
    const frames: NativeHostFrame[] = []
    while (this.#buffer.length >= 4) {
      const bodyLength = this.#buffer.readUInt32LE(0)
      if (bodyLength < HEADER_BYTES || bodyLength > MAX_NATIVE_HOST_FRAME_BYTES) {
        console.error(`[NativeHost Frame Error] bodyLength=${bodyLength}, buffer hex=${this.#buffer.subarray(0, 100).toString('hex')}, utf8=${JSON.stringify(this.#buffer.subarray(0, 100).toString('utf8'))}`)
        throw new Error('NativeHost frame length is invalid')
      }
      if (this.#buffer.length < 4 + bodyLength) break
      frames.push(decodeBody(this.#buffer.subarray(4, 4 + bodyLength)))
      this.#buffer = this.#buffer.subarray(4 + bodyLength)
    }
    return frames
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new Error('NativeHost stream ended with a partial frame')
  }
}
