import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import plist from 'plist'
import { validateNetworkProfile, loadNetworkProfile } from './macos-network-profile.mjs'
import { NETWORK_ENTITLEMENT, NETWORK_HELPER_BUNDLE, NETWORK_HELPER_EXECUTABLE } from './macos-network-bundle.mjs'
import { signMacosRelease } from './sign-macos.mjs'

const identity = 'Developer ID Application: Test (ABCDE12345)'
const bundleId = 'org.example.app.network-topology'
const cert = Buffer.from('隔离测试证书字节，绝非真实凭据')
const identities = `  1) ${createHash('sha1').update(cert).digest('hex')} "${identity}"`
function fixture() {
  return { Platform: ['OSX'], TeamIdentifier: ['ABCDE12345'], ApplicationIdentifierPrefix: ['ABCDE12345'],
    CreationDate: new Date('2000-01-01'), ExpirationDate: new Date('2100-01-01'), ProvisionsAllDevices: true,
    DeveloperCertificates: [cert], Entitlements: { 'com.apple.application-identifier': `ABCDE12345.${bundleId}`,
      'com.apple.developer.team-identifier': 'ABCDE12345', [NETWORK_ENTITLEMENT]: true, 'unrelated.key': true } }
}
const validation = { identity, bundleId, identities, now: new Date('2026-10-27') }

test('描述文件只授予指定进程必要的三项权限，拒绝错应用/团队/证书/平台/期限与开发描述文件', () => {
  assert.deepEqual(Object.keys(validateNetworkProfile(fixture(), validation)).sort(), ['com.apple.application-identifier', 'com.apple.developer.team-identifier', NETWORK_ENTITLEMENT].sort())
  const changes = [
    p => { p.TeamIdentifier = ['OTHER12345'] }, p => { p.Entitlements['com.apple.application-identifier'] = 'ABCDE12345.*' },
    p => { p.Entitlements['com.apple.developer.team-identifier'] = 'OTHER12345' }, p => { p.Platform = ['iOS'] },
    p => { p.ProvisionsAllDevices = false }, p => { p.ProvisionedDevices = ['fake'] },
    p => { p.Entitlements['com.apple.security.get-task-allow'] = true }, p => { p.Entitlements[NETWORK_ENTITLEMENT] = false },
    p => { p.ExpirationDate = new Date('2026-01-01') }, p => { p.CreationDate = new Date('2027-01-01') },
    p => { p.ExpirationDate = new Date('invalid') }, p => { p.DeveloperCertificates = [Buffer.from('wrong')] }
  ]
  for (const change of changes) { const p = fixture(); change(p); assert.throws(() => validateNetworkProfile(p, validation), /NETWORK_PROFILE_/) }
  assert.throws(() => validateNetworkProfile(fixture(), { ...validation, identities: `${identities}\n${identities}` }), /CERTIFICATE_MISMATCH/)
})

test('签名编排：显式提供描述文件才授权，未提供时普通签名，错回执阻断', () => {
  function run({ missing = false, wrongSigned = false, genericPermission = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-profile-sign-'))
    const calls = [], app = path.join(root, 'App.app'), bundle = path.join(app, NETWORK_HELPER_BUNDLE)
    const profilePath = path.join(root, 'network.provisionprofile'), bytes = Buffer.from('测试 CMS 容器')
    fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist.build({ CFBundleIdentifier: bundleId }))
    fs.writeFileSync(profilePath, bytes)
    const mainEnt = path.join(root, 'main.plist'), helperEnt = path.join(root, 'helper.plist')
    fs.writeFileSync(mainEnt, 'fake'); fs.writeFileSync(helperEnt, 'fake')
    const opts = { app, output: path.join(root, 'output'), 'bundle-id': 'org.example.app', 'minimum-os': '13.0', identity,
      'keychain-profile': 'fixture', entitlements: mainEnt, 'helper-entitlements': helperEnt,
      'network-profile': missing ? undefined : profilePath }
    const expected = validateNetworkProfile(fixture(), validation)
    const exec = (tool, args, config) => {
      calls.push({ tool, args })
      if (args[0] === 'cms') { assert.deepEqual(config.input, bytes); return plist.build(fixture()) }
      if (args[0] === 'find-identity') return identities
      if (tool.endsWith('/plutil')) return JSON.stringify({ 'com.apple.security.cs.allow-jit': true, ...(genericPermission ? { [NETWORK_ENTITLEMENT]: true } : {}) })
      if (args.includes('--display')) return plist.build(wrongSigned ? {} : expected)
      if (args[0] === 'notarytool') return JSON.stringify({ status: 'Accepted', id: '11111111-2222-3333-4444-555555555555' })
      return ''
    }
    try {
      const result = signMacosRelease(opts, { platform: 'darwin', fsApi: fs, exec,
        preflight: () => ({ status: 'PASS', appRoot: app }), verify: () => ({ machoFiles: ['Contents/MacOS/App', NETWORK_HELPER_EXECUTABLE] }) })
      if (wrongSigned || genericPermission) {
        assert.equal(result.status, 'FAIL')
        assert.ok(!calls.some(c => c.args[0] === 'notarytool'))
        if (genericPermission) assert.ok(!calls.some(c => c.args.includes('--sign')))
      } else {
        assert.equal(result.status, 'PASS', JSON.stringify(result))
        const nested = calls.find(c => c.args.includes('--sign') && c.args.at(-1) === bundle)
        if (missing) {
          assert.ok(!nested.args.includes('--entitlements'))
          assert.ok(!fs.existsSync(path.join(bundle, 'Contents/embedded.provisionprofile')))
          assert.ok(!calls.some(c => c.args[0] === 'cms'))
        } else {
          assert.deepEqual(fs.readFileSync(path.join(bundle, 'Contents/embedded.provisionprofile')), bytes)
          assert.equal(nested.args[nested.args.indexOf('--entitlements') + 1], path.join(opts.output, 'network-entitlements.plist'))
          assert.deepEqual(plist.parse(fs.readFileSync(path.join(opts.output, 'network-entitlements.plist'), 'utf8')), expected)
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
  run(); run({ missing: true }); run({ wrongSigned: true }); run({ genericPermission: true })
})

test('描述文件读取拒绝相对路径、目录、软链接，CMS 解码失败不继续', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-profile-invalid-'))
  try {
    const file = path.join(root, 'input'), link = path.join(root, 'link')
    fs.writeFileSync(file, 'not CMS'); fs.symlinkSync(file, link)
    for (const p of ['relative', root, link]) assert.throws(() => loadNetworkProfile({ profilePath: p, bundleId, identity }))
    assert.throws(() => loadNetworkProfile({ profilePath: file, bundleId, identity }, { exec: () => { throw new Error('decode failed') } }), /decode failed/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
