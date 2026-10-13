import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createNativeHostManifest, readNativeHostManifest } from './native-host-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const declaration = {
  pluginId: 'batch-audio', dllId: 'BatchAudioPlugin', source: 'plugins',
  path: 'lib/BatchAudioPlugin.dll', functions: ['GetFileInfo']
}

test('build trust only names approved plugins with fixed hashes and explicit functions', () => {
  const manifest = readNativeHostManifest(root)
  assert.match(manifest, /plugin id="clipboard-manager"/)
  assert.match(manifest, /plugin id="batch-audio"/)
  assert.match(manifest, /plugin id="batch-video"/)
  assert.match(manifest, /plugin id="batch-media-report"/)
  assert.equal((manifest.match(/<plugin /g) ?? []).length, 4)
  assert.equal((manifest.match(/sha256="[a-f0-9]{64}" arch="x86"/g) ?? []).length, 4)
  const report = manifest.match(/<plugin id="batch-media-report">[\s\S]*?<\/plugin>/)?.[0]
  assert.ok(report)
  assert.equal((report.match(/<function /g) ?? []).length, 1)
  assert.match(report, /function name="GetFileInfo"/)
  assert.ok(!report.includes('GetTaskList'))
  assert.ok(!manifest.includes('name="*"'))
  const audio = createNativeHostManifest(root, [declaration])
  assert.equal((audio.match(/<function /g) ?? []).length, 1)
  assert.match(audio, /function name="GetFileInfo"/)
})

test('untrusted declarations cannot escape, inject XML, duplicate identities, or grant all functions', () => {
  for (const value of [
    { ...declaration, pluginId: '../batch-audio' },
    { ...declaration, path: 'lib/../../outside.dll' },
    { ...declaration, source: 'user-input' },
    { ...declaration, functions: ['*'] },
    { ...declaration, functions: ['GetFileInfo', 'GetFileInfo'] },
    { ...declaration, dllId: 'x" allow="all' }
  ]) assert.throws(() => createNativeHostManifest(root, [value]), /信任声明无效/)
  assert.throws(() => createNativeHostManifest(root, [declaration, declaration]), /信任声明无效/)
})

test('build inputs agree with current reviewed DLL hashes and preserve the historical C24 baseline', () => {
  const evidenceRoot = path.resolve(root, '..', 'plugins', 'create-plugin', 'docs', 'ai-batch-pilot-evidence')
  const freeze = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'C24-frozen-inputs-v1.json'), 'utf8'))
  const videoReview = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'C18-final-acceptance.json'), 'utf8'))
  const reportReview = JSON.parse(fs.readFileSync(path.join(evidenceRoot, 'C26-native-trust-review.json'), 'utf8'))
  const audioReview = JSON.parse(fs.readFileSync(path.resolve(root, '..', 'docs', 'mac-compat-evidence', 'P019',
    'native-trust-review-20261008-preflight.json'), 'utf8'))
  const frozenAudio = freeze.files.find(file => file.path.includes('/batch-audio/lib/') && /BatchAudioPlugin\.dll$/.test(file.path))
  assert.equal(audioReview.pluginId, 'batch-audio')
  assert.equal(audioReview.dll.arch, 'ia32')
  assert.equal(audioReview.dll.previousBaselineSha256, frozenAudio?.sha256)
  assert.equal(audioReview.releaseAcceptance, false)
  const manifest = readNativeHostManifest(root)
  for (const pluginId of ['batch-audio', 'batch-video']) {
    const reviewed = pluginId === 'batch-video'
      ? { sha256: videoReview.dllSha256 }
      : audioReview.dll
    assert.ok(reviewed, pluginId + ' reviewed DLL missing')
    const block = manifest.match(new RegExp('<plugin id="' + pluginId + '">[\\s\\S]*?<\\/plugin>'))?.[0]
    assert.ok(block?.includes('sha256="' + reviewed.sha256 + '"'), pluginId + ' reviewed hash changed')
  }
  const report = manifest.match(/<plugin id="batch-media-report">[\s\S]*?<\/plugin>/)?.[0]
  assert.ok(report?.includes('sha256="' + reportReview.dll.sha256 + '"'))
})
