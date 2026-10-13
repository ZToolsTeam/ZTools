import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import {
  encodeNativeHostFrame,
  MAX_NATIVE_HOST_FRAME_BYTES,
  MAX_NATIVE_HOST_PAYLOAD_BYTES,
  NativeHostFrameDecoder,
  NativeHostFrameType,
  NATIVE_HOST_PROTOCOL_VERSION,
  type NativeHostFrame
} from '../../src/main/native-host/protocol.js'

function frame(payload = Buffer.from('{"value":1}')): NativeHostFrame {
  return {
    protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
    type: NativeHostFrameType.Request,
    sessionId: 'session-1',
    requestId: 'request-1',
    pluginId: 'plugin-1',
    dllId: 'ImagePlugin',
    method: 'call',
    payload
  }
}

test('NativeHost frame codec preserves all required fields across fragmented chunks', () => {
  const encoded = encodeNativeHostFrame(frame())
  const decoder = new NativeHostFrameDecoder()
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), [])
  assert.deepEqual(decoder.push(encoded.subarray(3, 19)), [])
  const result = decoder.push(encoded.subarray(19))
  assert.equal(result.length, 1)
  assert.deepEqual(result[0], frame())
  decoder.finish()
})

test('NativeHost frame decoder handles coalesced frames', () => {
  const decoder = new NativeHostFrameDecoder()
  const first = frame(Buffer.from('{}'))
  const second = { ...frame(Buffer.from('{"second":true}')), requestId: 'request-2' }
  assert.deepEqual(decoder.push(Buffer.concat([
    encodeNativeHostFrame(first),
    encodeNativeHostFrame(second)
  ])), [first, second])
})

test('NativeHost frame codec rejects oversized and malformed data', () => {
  assert.throws(() => encodeNativeHostFrame(frame(Buffer.alloc(MAX_NATIVE_HOST_PAYLOAD_BYTES + 1))))
  const oversizedPrefix = Buffer.alloc(4)
  oversizedPrefix.writeUInt32LE(MAX_NATIVE_HOST_FRAME_BYTES + 1)
  assert.throws(() => new NativeHostFrameDecoder().push(oversizedPrefix))

  const encoded = encodeNativeHostFrame(frame())
  encoded.writeUInt32LE(1, 16)
  assert.throws(() => new NativeHostFrameDecoder().push(encoded))
  assert.throws(() => {
    const decoder = new NativeHostFrameDecoder()
    decoder.push(encodeNativeHostFrame(frame()).subarray(0, 10))
    decoder.finish()
  })
})
