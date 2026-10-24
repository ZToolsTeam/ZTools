import { describe, expect, it } from 'vitest'
import DatabaseAPI from '../../../public/js/cef-ipc/src/api/db.js'

describe('DatabaseAPI attachment encoding', () => {
  it('encodes binary bytes without changing their values', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255])
    expect(DatabaseAPI.arrayBufferToBase64(bytes.buffer)).toBe('AAF/gP7/')
  })

  it('encodes attachments larger than the JavaScript argument limit', () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index & 0xff
    const encoded = DatabaseAPI.arrayBufferToBase64(bytes.buffer)
    expect(encoded.length).toBe(1_398_104)
    expect(encoded.slice(0, 16)).toBe('AAECAwQFBgcICQoL')
  })
})
