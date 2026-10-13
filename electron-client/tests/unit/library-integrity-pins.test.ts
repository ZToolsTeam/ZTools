import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePinnedLibraryChecksum } from '../../src/main/services/library-integrity-pins.js'

const official = {
  libId: 'ffmpeg-1.0.0', downloadUrl: 'https://cdn.ztools.cn/commonlibs-zip/ffmpeg-1.0.0.zip',
  fileSize: 47_751_326, checksum: ''
}
test('legacy metadata can use only its exact independently pinned official archive', () => {
  assert.match(resolvePinnedLibraryChecksum(official), /^[a-f0-9]{64}$/)
  for (const metadata of [
    { ...official, libId: 'ffmpeg-2.0.0' },
    { ...official, downloadUrl: 'http://localhost/ffmpeg.zip' },
    { ...official, fileSize: official.fileSize + 1 },
    { ...official, fileSize: null }
  ]) assert.equal(resolvePinnedLibraryChecksum(metadata), '')
  assert.equal(resolvePinnedLibraryChecksum({ ...official, checksum: 'corrupt' }), 'corrupt')
  assert.equal(resolvePinnedLibraryChecksum({ ...official, checksum: 'a'.repeat(64) }), 'a'.repeat(64))
})
