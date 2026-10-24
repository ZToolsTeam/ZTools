import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createNativeHostManifest, readNativeHostManifest } from './native-host-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 商业 DLL 与评审证据只在内部仓库；公开源码里这些用例记为跳过（NOT_RUN），不算失败
const internalDllRootsPresent = fs.existsSync(path.resolve(root, '..', 'bin', 'Data', 'Plugins')) &&
  fs.existsSync(path.resolve(root, '..', 'plugins', 'create-plugin', 'src', 'plugins'))
const internalOnly = internalDllRootsPresent ? {} : { skip: 'NOT_RUN: 缺少内部商业 DLL 目录（公开源码）' }
const declaration = {
  pluginId: 'batch-audio', dllId: 'BatchAudioPlugin', source: 'plugins',
  path: 'lib/BatchAudioPlugin.dll', functions: ['GetFileInfo']
}

test('build trust only names approved plugins with fixed hashes and explicit functions', internalOnly, () => {
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

test('build inputs agree with current reviewed DLL hashes and preserve the historical C24 baseline', internalOnly, () => {
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

// 构造只含 PE 头的最小假 DLL（machine 字段决定架构），用于隔离工作区测试
function fakePe(machine) {
  const buffer = Buffer.alloc(128)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(64, 0x3c)
  buffer.write('PE\0\0', 64, 'ascii')
  buffer.writeUInt16LE(machine, 68)
  return buffer
}

function makeWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-native-manifest-'))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const clientRoot = path.join(workspace, 'electron-client')
  fs.mkdirSync(clientRoot)
  return { workspace, clientRoot }
}

const binDeclaration = {
  pluginId: 'clipboard-manager', dllId: 'ClipboardManagerPlugin', source: 'bin',
  path: 'lib/ClipboardManagerPlugin.dll', functions: ['GetStatus']
}

test('public checkout without commercial DLL roots builds an empty but valid trust manifest', (t) => {
  const { clientRoot } = makeWorkspace(t)
  const warnings = []
  const manifest = createNativeHostManifest(clientRoot, [declaration, binDeclaration], {
    warn: (message) => warnings.push(message)
  })
  assert.equal(manifest, '<?xml version="1.0" encoding="utf-8"?>\n<nativeHostManifest version="1">\n</nativeHostManifest>\n')
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((message) => message.includes('跳过')))
  // 声明本身不合法时，即使源目录缺失也必须拒绝（跳过不能绕过校验）
  assert.throws(() => createNativeHostManifest(clientRoot, [{ ...declaration, functions: ['*'] }], { warn() {} }), /信任声明无效/)
})

test('existing DLL root keeps strict checks: missing DLL, wrong arch and symlink are rejected', (t) => {
  const { workspace, clientRoot } = makeWorkspace(t)
  const libRoot = path.join(workspace, 'plugins', 'create-plugin', 'src', 'plugins', 'batch-audio', 'lib')
  fs.mkdirSync(libRoot, { recursive: true })
  // 源目录存在但 DLL 缺失：内部构建照旧报错，不能被当成公开源码悄悄跳过
  assert.throws(() => createNativeHostManifest(clientRoot, [declaration], { warn() {} }), /ENOENT/)
  fs.writeFileSync(path.join(libRoot, 'BatchAudioPlugin.dll'), fakePe(0x8664))
  assert.throws(() => createNativeHostManifest(clientRoot, [declaration], { warn() {} }), /x86/)
  fs.rmSync(path.join(libRoot, 'BatchAudioPlugin.dll'))
  const outside = path.join(workspace, 'outside.dll')
  fs.writeFileSync(outside, fakePe(0x014c))
  fs.symlinkSync(outside, path.join(libRoot, 'BatchAudioPlugin.dll'))
  assert.throws(() => createNativeHostManifest(clientRoot, [declaration], { warn() {} }), /普通文件/)
})

test('partial checkout keeps present DLLs with fixed hashes and skips only the absent root', (t) => {
  const { workspace, clientRoot } = makeWorkspace(t)
  const libRoot = path.join(workspace, 'plugins', 'create-plugin', 'src', 'plugins', 'batch-audio', 'lib')
  fs.mkdirSync(libRoot, { recursive: true })
  const bytes = fakePe(0x014c)
  fs.writeFileSync(path.join(libRoot, 'BatchAudioPlugin.dll'), bytes)
  const warnings = []
  const manifest = createNativeHostManifest(clientRoot, [binDeclaration, declaration], {
    warn: (message) => warnings.push(message)
  })
  assert.equal((manifest.match(/<plugin /g) ?? []).length, 1)
  assert.match(manifest, /plugin id="batch-audio"/)
  assert.ok(!manifest.includes('clipboard-manager'))
  const digest = createHash('sha256').update(bytes).digest('hex')
  assert.ok(manifest.includes(`sha256="${digest}"`))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /clipboard-manager/)
})
