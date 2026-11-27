import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  generateNativeTrustKeyPair,
  signPluginDirectory
} from '../../../scripts/sign-native-trust.mjs'
import {
  computeNativeTrustBundleSha256,
  loadWindowsNativeTrustBundle,
  verifyWindowsNativeTrustMetadata
} from '../../scripts/windows-package-contract.mjs'
import {
  loadNativeTrustBundle,
  verifyPluginInstallDirectory
} from '../../out/main/services/native-trust-verifier.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = path.resolve(root, '..')

function makeMinimalPe({ arch = 'x86', isDll = true } = {}) {
  const peOffset = 0x80
  const is64 = arch === 'x64'
  const optionalSize = is64 ? 0xf0 : 0xe0
  const buf = Buffer.alloc(Math.max(peOffset + 24 + optionalSize + 104, 512), 0)
  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(peOffset, 0x3c)
  buf.writeUInt32LE(0x00004550, peOffset)
  buf.writeUInt16LE(is64 ? 0x8664 : 0x014c, peOffset + 4)
  buf.writeUInt16LE(1, peOffset + 6)
  buf.writeUInt16LE(optionalSize, peOffset + 20)
  buf.writeUInt16LE(0x0002 | (isDll ? 0x2000 : 0), peOffset + 22)
  buf.writeUInt16LE(is64 ? 0x020b : 0x010b, peOffset + 24)
  return buf
}

test('内置信任根 JSON 满足 D5 定稿（5 条冻结表带 functions）且 bundleSha256 跨模块一致', () => {
  const resourcesNative = path.join(root, 'resources', 'native')
  const hasPublicKeys = fs.existsSync(path.join(resourcesNative, 'native-trust-public-keys.json'))
  if (!hasPublicKeys) {
    // 公开源码仓不含内部 JSON：空信任态加载必须成功且 Fail-Closed
    const emptyBundle = loadNativeTrustBundle(resourcesNative)
    assert.deepEqual(emptyBundle.publicKeys, [])
    assert.deepEqual(emptyBundle.legacyFrozen, [])
    return
  }

  const pkgBundle = loadWindowsNativeTrustBundle(resourcesNative)
  const tsBundle = loadNativeTrustBundle(resourcesNative)
  assert.equal(
    pkgBundle.metadata.bundleSha256,
    computeNativeTrustBundleSha256({
      publicKeysText: pkgBundle.files['native-trust-public-keys.json'].text,
      revocationsText: pkgBundle.files['native-trust-revocations.json'].text,
      legacyFrozenText: pkgBundle.files['legacy-frozen-dlls.json'].text
    })
  )
  assert.equal(tsBundle.bundleSha256, pkgBundle.metadata.bundleSha256)
  assert.ok(pkgBundle.metadata.keyIds.includes('ztools-native-prod-2026a'))
  assert.ok(pkgBundle.metadata.keyIds.includes('ztools-native-priv-prod-2026a'))
  assert.equal(pkgBundle.metadata.keyIds.includes('ztools-native-2026-v1'), false, '已作废开发 keyId 严禁存在')
  assert.equal(pkgBundle.metadata.legacyFrozenCount, 5, '冻结表必须恰好 5 条（D5）')
  const frozenIds = tsBundle.legacyFrozen.map((item) => item.pluginId).sort()
  assert.deepEqual(frozenIds, [
    'clipboard-manager',
    'record',
    'screen-color-picker',
    'screenshot',
    'video-downloader'
  ])
  for (const item of tsBundle.legacyFrozen) {
    assert.ok(Array.isArray(item.functions) && item.functions.length > 0, `${item.pluginId} 必须带函数白名单`)
  }
  const verifiedMeta = verifyWindowsNativeTrustMetadata(pkgBundle.metadata)
  assert.equal(verifiedMeta.bundleSha256, pkgBundle.metadata.bundleSha256)
})

test('签名、吊销、回滚、冻结表与空信任态完整状态机校验', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-trust-manifest-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))

  const kp = generateNativeTrustKeyPair('test-manifest-key', ['native'])
  const pluginDir = path.join(work, 'demo-plugin')
  const libDir = path.join(pluginDir, 'lib')
  fs.mkdirSync(libDir, { recursive: true })
  const mainBytes = makeMinimalPe({ arch: 'x86', isDll: true })
  const helperBytes = makeMinimalPe({ arch: 'x64', isDll: false })
  fs.writeFileSync(path.join(libDir, 'DemoPlugin.dll'), mainBytes)
  fs.writeFileSync(path.join(libDir, 'helper.exe'), helperBytes)
  const mainSha = crypto.createHash('sha256').update(mainBytes).digest('hex')

  // 1. 合法签名放行
  const signed = signPluginDirectory({
    pluginDir,
    pluginId: 'demo-plugin',
    pluginVersion: '1.2.0',
    requireAdmin: false,
    keyId: kp.keyId,
    mainEntries: [{ path: 'lib/DemoPlugin.dll', dllId: 'DemoPlugin', functions: ['Ping'] }],
    privateKeyPem: kp.privateKeyPem,
    keyUsages: kp.usages
  })

  const bundle = {
    publicKeys: [{ keyId: kp.keyId, publicKeyHex: kp.publicKeyHex, usages: ['native'] }],
    revocations: {
      schemaVersion: 1,
      revokedKeyIds: [],
      revokedManifestSha256: [],
      revokedFileSha256: [],
      minPluginVersions: {}
    },
    legacyFrozen: [],
    bundleSha256: '0'.repeat(64)
  }

  const ok = verifyPluginInstallDirectory({
    pluginDir,
    expectedPluginId: 'demo-plugin',
    expectedPluginVersion: '1.2.0',
    expectedRequireAdmin: false,
    bundle
  })
  assert.equal(ok.verified, true)
  assert.equal(ok.mode, 'signed')

  const expectRejected = (fn, hostCode) => {
    assert.throws(fn, (err) => err?.details?.hostCode === hostCode)
  }

  // 2. 空信任态（开源仓无公钥且无冻结表）必须返回 MANIFEST_UNTRUSTED
  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: false,
      bundle: { ...bundle, publicKeys: [] }
    }),
    'MANIFEST_UNTRUSTED'
  )

  // 3. 吊销清单（keyId / manifestSha256 / fileSha256）与最低版本回滚
  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: false,
      bundle: { ...bundle, revocations: { ...bundle.revocations, revokedKeyIds: [kp.keyId] } }
    }),
    'MANIFEST_REVOKED'
  )

  const manifestSha = crypto.createHash('sha256').update(Buffer.from(signed.manifestText, 'utf8')).digest('hex')
  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: false,
      bundle: { ...bundle, revocations: { ...bundle.revocations, revokedManifestSha256: [manifestSha] } }
    }),
    'MANIFEST_REVOKED'
  )

  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: false,
      bundle: { ...bundle, revocations: { ...bundle.revocations, minPluginVersions: { 'demo-plugin': '1.3.0' } } }
    }),
    'MANIFEST_ROLLBACK'
  )

  // 4. 无签名冻结表兜底（且受 fileSha256 吊销约束；batch-audio 未收录一律拒绝）
  fs.rmSync(path.join(pluginDir, 'native-trust.json'))
  fs.rmSync(path.join(pluginDir, 'native-trust.sig'))
  fs.rmSync(path.join(libDir, 'helper.exe'))
  const frozenBundle = {
    ...bundle,
    legacyFrozen: [{ pluginId: 'demo-plugin', dllId: 'DemoPlugin', sha256: mainSha, functions: ['Ping'] }]
  }
  const frozenOk = verifyPluginInstallDirectory({
    pluginDir,
    expectedPluginId: 'demo-plugin',
    expectedPluginVersion: '1.2.0',
    expectedRequireAdmin: false,
    declaredMainEntries: ['lib/DemoPlugin.dll'],
    bundle: frozenBundle
  })
  assert.equal(frozenOk.verified, true)
  assert.equal(frozenOk.mode, 'legacy-frozen')

  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: false,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: { ...frozenBundle, revocations: { ...bundle.revocations, revokedFileSha256: [mainSha] } }
    }),
    'MANIFEST_REVOKED'
  )

  // 无签名旧版特权插件兼容放行（返回 legacy-unsigned），但被吊销文件仍严格拒绝
  const legacyPrivOk = verifyPluginInstallDirectory({
    pluginDir,
    expectedPluginId: 'demo-plugin',
    expectedPluginVersion: '1.2.0',
    expectedRequireAdmin: true,
    declaredMainEntries: ['lib/DemoPlugin.dll'],
    bundle: frozenBundle
  })
  assert.equal(legacyPrivOk.verified, true)
  assert.equal(legacyPrivOk.mode, 'legacy-unsigned')

  expectRejected(
    () => verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.2.0',
      expectedRequireAdmin: true,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: { ...frozenBundle, revocations: { ...bundle.revocations, revokedFileSha256: [mainSha] } }
    }),
    'MANIFEST_REVOKED'
  )
})

test('docs/native-trust-evidence 历史归档目录保持可读（仅作为历史审计基线）', () => {
  const evidenceRoot = path.join(repoRoot, 'docs', 'native-trust-evidence')
  if (!fs.existsSync(evidenceRoot)) return
  assert.equal(fs.existsSync(path.join(evidenceRoot, 'C24-frozen-inputs-v1.json')), true)
})
