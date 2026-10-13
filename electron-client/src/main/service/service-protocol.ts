import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { SERVICE_PROTOCOL_VERSION } from '../../contracts/protocol-versions.js'

export const SERVICE_PIPE_NAME = '\\\\.\\pipe\\ZToolsPrivilegedService.v1'
export const SERVICE_SECRET_BYTES = 32
export const SERVICE_NONCE_BYTES = 32
export const SERVICE_PROOF_BYTES = 32
export const SERVICE_FRAME_HEADER_BYTES = 24
export const SERVICE_MAX_FRAME_BYTES = 1024 * 1024
export const SERVICE_MAX_PAYLOAD_BYTES = SERVICE_MAX_FRAME_BYTES - SERVICE_FRAME_HEADER_BYTES
export const SERVICE_AUTHENTICATED_FLAG = 1

const SERVICE_MAGIC = 0x3153545a
const SERVER_DOMAIN = Buffer.from('ZTOOLS_SERVICE_SERVER_V1\0', 'ascii')
const CLIENT_DOMAIN = Buffer.from('ZTOOLS_SERVICE_CLIENT_V1\0', 'ascii')
const SESSION_DOMAIN = Buffer.from('ZTOOLS_SERVICE_SESSION_V1\0', 'ascii')
const CLIENT_FRAME_DOMAIN = Buffer.from('ZTOOLS_SERVICE_FRAME_CLIENT_V1\0', 'ascii')
const SERVER_FRAME_DOMAIN = Buffer.from('ZTOOLS_SERVICE_FRAME_SERVER_V1\0', 'ascii')

export enum ServiceFrameType {
  ClientHello = 1,
  ServerHello = 2,
  ClientAuth = 3,
  Request = 4,
  Response = 5,
  Error = 6,
  TaskChanged = 7
}

export interface ServiceFrame {
  type: ServiceFrameType
  flags: number
  requestId: bigint
  payload: Buffer
}

export type ServiceAuthDirection = 'client-to-service' | 'service-to-client'

function isFrameType(value: number): value is ServiceFrameType {
  return value >= ServiceFrameType.ClientHello && value <= ServiceFrameType.TaskChanged
}

function uint16(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(2)
  encoded.writeUInt16LE(value)
  return encoded
}

function uint32(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(4)
  encoded.writeUInt32LE(value)
  return encoded
}

function uint64(value: bigint): Buffer {
  const encoded = Buffer.allocUnsafe(8)
  encoded.writeBigUInt64LE(value)
  return encoded
}

function hmac(secret: Buffer, parts: readonly Buffer[]): Buffer {
  const digest = createHmac('sha256', secret)
  for (const part of parts) digest.update(part)
  return digest.digest()
}

function validateSecret(secret: Buffer): void {
  if (secret.length !== SERVICE_SECRET_BYTES || secret.every((byte) => byte === 0)) {
    throw new Error('Service secret is invalid')
  }
}

function handshakeValue(
  secret: Buffer,
  domain: Buffer,
  clientProcessId: number,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  validateSecret(secret)
  if (!Number.isSafeInteger(clientProcessId) || clientProcessId <= 0 || clientProcessId > 0xffffffff ||
      clientNonce.length !== SERVICE_NONCE_BYTES || serverNonce.length !== SERVICE_NONCE_BYTES) {
    throw new Error('Service handshake input is invalid')
  }
  return hmac(secret, [
    domain,
    uint16(SERVICE_PROTOCOL_VERSION),
    uint32(clientProcessId),
    clientNonce,
    serverNonce
  ])
}

export function makeServiceServerProof(
  secret: Buffer,
  clientProcessId: number,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return handshakeValue(secret, SERVER_DOMAIN, clientProcessId, clientNonce, serverNonce)
}

export function makeServiceClientProof(
  secret: Buffer,
  clientProcessId: number,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return handshakeValue(secret, CLIENT_DOMAIN, clientProcessId, clientNonce, serverNonce)
}

export function deriveServiceSessionKey(
  secret: Buffer,
  clientProcessId: number,
  clientNonce: Buffer,
  serverNonce: Buffer
): Buffer {
  return handshakeValue(secret, SESSION_DOMAIN, clientProcessId, clientNonce, serverNonce)
}

function frameProof(
  sessionKey: Buffer,
  direction: ServiceAuthDirection,
  frame: ServiceFrame,
  payload: Buffer
): Buffer {
  validateSecret(sessionKey)
  return hmac(sessionKey, [
    direction === 'client-to-service' ? CLIENT_FRAME_DOMAIN : SERVER_FRAME_DOMAIN,
    uint16(SERVICE_PROTOCOL_VERSION),
    uint16(frame.type),
    uint32(SERVICE_AUTHENTICATED_FLAG),
    uint64(frame.requestId),
    uint32(payload.length),
    payload
  ])
}

export function sealServiceFrame(
  sessionKey: Buffer,
  direction: ServiceAuthDirection,
  frame: ServiceFrame
): ServiceFrame {
  if (frame.flags !== 0 || frame.payload.length > SERVICE_MAX_PAYLOAD_BYTES - SERVICE_PROOF_BYTES) {
    throw new Error('Service frame cannot be authenticated')
  }
  const payload = Buffer.from(frame.payload)
  return {
    ...frame,
    flags: SERVICE_AUTHENTICATED_FLAG,
    payload: Buffer.concat([payload, frameProof(sessionKey, direction, frame, payload)])
  }
}

export function openServiceFrame(
  sessionKey: Buffer,
  direction: ServiceAuthDirection,
  frame: ServiceFrame
): ServiceFrame {
  if (frame.flags !== SERVICE_AUTHENTICATED_FLAG || frame.payload.length < SERVICE_PROOF_BYTES) {
    throw new Error('Service frame is not authenticated')
  }
  const contentLength = frame.payload.length - SERVICE_PROOF_BYTES
  const payload = frame.payload.subarray(0, contentLength)
  const supplied = frame.payload.subarray(contentLength)
  const expected = frameProof(sessionKey, direction, frame, payload)
  const valid = timingSafeEqual(supplied, expected)
  expected.fill(0)
  if (!valid) throw new Error('Service frame authentication failed')
  return { ...frame, payload: Buffer.from(payload) }
}

export function encodeServiceFrame(frame: ServiceFrame): Buffer {
  if (!isFrameType(frame.type) ||
      (frame.flags !== 0 && frame.flags !== SERVICE_AUTHENTICATED_FLAG) ||
      frame.requestId < 0n || frame.requestId > 0xffffffffffffffffn ||
      frame.payload.length > SERVICE_MAX_PAYLOAD_BYTES) {
    throw new Error('Service frame is invalid')
  }
  const body = Buffer.allocUnsafe(SERVICE_FRAME_HEADER_BYTES + frame.payload.length)
  body.writeUInt32LE(SERVICE_MAGIC, 0)
  body.writeUInt16LE(SERVICE_PROTOCOL_VERSION, 4)
  body.writeUInt16LE(frame.type, 6)
  body.writeUInt32LE(frame.flags, 8)
  body.writeBigUInt64LE(frame.requestId, 12)
  body.writeUInt32LE(frame.payload.length, 20)
  frame.payload.copy(body, SERVICE_FRAME_HEADER_BYTES)
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32LE(body.length)
  return Buffer.concat([prefix, body])
}

function decodeServiceFrameBody(body: Buffer): ServiceFrame {
  if (body.length < SERVICE_FRAME_HEADER_BYTES || body.length > SERVICE_MAX_FRAME_BYTES ||
      body.readUInt32LE(0) !== SERVICE_MAGIC ||
      body.readUInt16LE(4) !== SERVICE_PROTOCOL_VERSION) {
    throw new Error('Service frame header is invalid')
  }
  const type = body.readUInt16LE(6)
  const flags = body.readUInt32LE(8)
  const payloadLength = body.readUInt32LE(20)
  if (!isFrameType(type) ||
      (flags !== 0 && flags !== SERVICE_AUTHENTICATED_FLAG) ||
      payloadLength > SERVICE_MAX_PAYLOAD_BYTES ||
      body.length !== SERVICE_FRAME_HEADER_BYTES + payloadLength) {
    throw new Error('Service frame metadata is invalid')
  }
  return {
    type,
    flags,
    requestId: body.readBigUInt64LE(12),
    payload: Buffer.from(body.subarray(SERVICE_FRAME_HEADER_BYTES))
  }
}

export class ServiceFrameDecoder {
  #buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): ServiceFrame[] {
    if (chunk.length === 0) return []
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)])
    const frames: ServiceFrame[] = []
    while (this.#buffer.length >= 4) {
      const bodyLength = this.#buffer.readUInt32LE(0)
      if (bodyLength < SERVICE_FRAME_HEADER_BYTES || bodyLength > SERVICE_MAX_FRAME_BYTES) {
        throw new Error('Service frame length is invalid')
      }
      if (this.#buffer.length < 4 + bodyLength) break
      frames.push(decodeServiceFrameBody(this.#buffer.subarray(4, 4 + bodyLength)))
      this.#buffer = this.#buffer.subarray(4 + bodyLength)
    }
    return frames
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new Error('Service stream ended with a partial frame')
  }
}
