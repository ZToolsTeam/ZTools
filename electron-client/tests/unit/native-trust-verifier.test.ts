import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  compareSemVer,
  computeNativeTrustBundleSha256,
  createWindowsNativeTrustInstallVerifier,
  directoryHasPeOrTrustFiles,
  EMPTY_NATIVE_TRUST_REVOCATIONS_JSON,
  loadNativeTrustBundle,
  NATIVE_TRUST_DOMAIN_PREFIX,
  parseSemVer,
  parseSignatureLine,
  parseStrictJson,
  verifyPluginInstallDirectory,
  verifySignedManifestPayload,
  verifySignedPluginCommonLibs,
  type NativeTrustBundle,
  type NativeTrustPublicKeyEntry
} from '../../src/main/services/native-trust-verifier.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'

function sha256Hex(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function generateEphemeralKey(keyId: string, usages: readonly ('native' | 'native-privileged')[]): {
  readonly entry: NativeTrustPublicKeyEntry
  readonly privateKeyPem: string
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  assert.equal(jwk.kty, 'EC')
  assert.equal(jwk.crv, 'P-256')
  const x = Buffer.from(jwk.x as string, 'base64url')
  const y = Buffer.from(jwk.y as string, 'base64url')
  const publicKeyHex = Buffer.concat([x, y]).toString('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    entry: { keyId, publicKeyHex, usages },
    privateKeyPem
  }
}

function signManifestText(manifestText: string, keyId: string, privateKeyPem: string): string {
  const payload = Buffer.concat([NATIVE_TRUST_DOMAIN_PREFIX, Buffer.from(manifestText, 'utf8')])
  const sig = crypto.sign('sha256', payload, { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
  assert.equal(sig.length, 64)
  return `v1:${keyId}:${sig.toString('hex')}\n`
}

function makeFixturePe(arch: 'x86' | 'x64', isDll: boolean, tag = ''): Buffer {
  const bytes = Buffer.alloc(512 + tag.length)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x00004550, 64)
  bytes.writeUInt16LE(arch === 'x86' ? 0x014c : 0x8664, 68)
  bytes.writeUInt16LE(1, 70)
  bytes.writeUInt16LE(arch === 'x86' ? 224 : 240, 84)
  bytes.writeUInt16LE(0x0002 | (isDll ? 0x2000 : 0), 86)
  bytes.writeUInt16LE(arch === 'x86' ? 0x010b : 0x020b, 88)
  if (tag.length > 0) bytes.write(tag, 512, 'utf8')
  return bytes
}

function createBundle(overrides: Partial<NativeTrustBundle> = {}): NativeTrustBundle {
  return {
    publicKeys: overrides.publicKeys ?? [],
    revocations: overrides.revocations ?? {
      schemaVersion: 1,
      revokedKeyIds: [],
      revokedManifestSha256: [],
      revokedFileSha256: [],
      minPluginVersions: {}
    },
    legacyFrozen: overrides.legacyFrozen ?? [],
    bundleSha256: overrides.bundleSha256 ?? computeNativeTrustBundleSha256({})
  }
}

function assertHostRejection(fn: () => unknown, expectedHostCode: string, expectedErrorCode?: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ZToolsError, `应抛出 ZToolsError，实际: ${String(error)}`)
    assert.equal(error.details?.hostCode, expectedHostCode, `期望 hostCode=${expectedHostCode}，实际=${error.details?.hostCode}`)
    if (expectedErrorCode !== undefined) {
      assert.equal(error.code, expectedErrorCode)
    }
    return true
  })
}

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function createZip(entries: ReadonlyArray<{ readonly name: string; readonly data: string | Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((0o100644 & 0xffff) * 0x1_0000) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function makeResponse(body: Buffer): Response {
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return new Response(bytes, { status: 200, headers: { 'content-length': String(body.length) } })
}

test('受限 JSON 解析器拒绝重复键、BOM、超深嵌套、负数/小数、非法转义与孤立代理对', () => {
  assert.deepEqual(parseStrictJson('{"ok":true,"n":0,"max":9007199254740991,"arr":[1,2]}'), Object.assign(Object.create(null), {
    ok: true,
    n: 0,
    max: 9007199254740991,
    arr: [1, 2]
  }))
  assertHostRejection(() => parseStrictJson('\ufeff{"a":1}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":1,"a":2}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":-1}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":1.5}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":01}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":9007199254740992}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":"\\uD800"}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson('{"a":"\\x41"}'), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson(`${'['.repeat(9)}1${']'.repeat(9)}`), 'MANIFEST_INVALID')
  assertHostRejection(() => parseStrictJson(`{"s":"${'a'.repeat(4097)}"}`), 'MANIFEST_INVALID')
  const tooManyKeys = `{${Array.from({ length: 65 }, (_, i) => `"k${i}":${i}`).join(',')}}`
  assertHostRejection(() => parseStrictJson(tooManyKeys), 'MANIFEST_INVALID')
})

test('SemVer 解析与比较以及 bundleSha256 公式与 resources/native 保持逐字节一致', () => {
  assert.equal(parseSemVer('1.2.3')?.patch, 3)
  assert.equal(parseSemVer('01.2.3'), null)
  assert.equal(parseSemVer('1.2.3-01'), null)
  assert.equal(compareSemVer('1.2.3-alpha.1', '1.2.3-alpha.2'), -1)
  assert.equal(compareSemVer('1.2.3-rc.1', '1.2.3'), -1)
  assert.equal(compareSemVer('2.0.0', '1.9.9'), 1)

  const clientRoot = path.resolve(__dirname, '..', '..', '..')
  const nativeDir = path.join(clientRoot, 'resources', 'native')
  const loaded = loadNativeTrustBundle(nativeDir)
  assert.equal(loaded.publicKeys.length >= 2, true)
  assert.equal(loaded.legacyFrozen.length, 5)
  const expectedBundleSha = computeNativeTrustBundleSha256({
    publicKeysText: fs.readFileSync(path.join(nativeDir, 'native-trust-public-keys.json'), 'utf8'),
    revocationsText: fs.readFileSync(path.join(nativeDir, 'native-trust-revocations.json'), 'utf8'),
    legacyFrozenText: fs.readFileSync(path.join(nativeDir, 'legacy-frozen-dlls.json'), 'utf8')
  })
  assert.equal(loaded.bundleSha256, expectedBundleSha)

  // 缺失目录视为空表 Fail-Closed
  const emptyLoaded = loadNativeTrustBundle(path.join(os.tmpdir(), `ztools-nonexistent-trust-${Date.now()}`))
  assert.deepEqual(emptyLoaded.publicKeys, [])
  assert.deepEqual(emptyLoaded.legacyFrozen, [])
  assert.equal(emptyLoaded.bundleSha256, computeNativeTrustBundleSha256({ revocationsText: EMPTY_NATIVE_TRUST_REVOCATIONS_JSON }))
})

test('消费跨语言黄金向量 tests/fixtures/native-trust-vectors/vectors.json 覆盖全部正反例', () => {
  const clientRoot = path.resolve(__dirname, '..', '..', '..')
  const vectorsPath = path.resolve(clientRoot, '..', 'tests', 'fixtures', 'native-trust-vectors', 'vectors.json')
  assert.equal(fs.existsSync(vectorsPath), true, `黄金向量文件缺失: ${vectorsPath}`)
  const fixture = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as {
    publicKeys: NativeTrustPublicKeyEntry[]
    vectors: Record<string, { manifestJson: string; signatureLine: string; manifestSha256?: string; expectedCode?: string }>
  }
  const bundle = createBundle({ publicKeys: fixture.publicKeys })

  const validNormal = fixture.vectors.validNormal!
  const normalRes = verifySignedManifestPayload({
    manifestBytes: Buffer.from(validNormal.manifestJson, 'utf8'),
    signatureText: validNormal.signatureLine,
    expectedPluginId: 'vector-plugin',
    expectedRequireAdmin: false,
    expectedPluginVersion: '1.2.3',
    bundle
  })
  assert.equal(normalRes.manifest.pluginId, 'vector-plugin')
  assert.equal(normalRes.manifestSha256, validNormal.manifestSha256)

  const validPrivileged = fixture.vectors.validPrivileged!
  const privRes = verifySignedManifestPayload({
    manifestBytes: Buffer.from(validPrivileged.manifestJson, 'utf8'),
    signatureText: validPrivileged.signatureLine,
    expectedPluginId: 'vector-priv-plugin',
    expectedRequireAdmin: true,
    expectedPluginVersion: '2.0.0',
    bundle
  })
  assert.equal(privRes.manifest.requireAdmin, true)
  assert.equal(privRes.manifestSha256, validPrivileged.manifestSha256)

  const negativeCases: ReadonlyArray<readonly [string, string, boolean, string]> = [
    ['tamperedPayload', 'vector-plugin', false, 'MANIFEST_UNTRUSTED'],
    ['duplicateKey', 'vector-plugin', false, 'MANIFEST_INVALID'],
    ['deepNesting', 'vector-plugin', false, 'MANIFEST_INVALID'],
    ['unknownField', 'vector-plugin', false, 'MANIFEST_INVALID'],
    ['malformedSig', 'vector-plugin', false, 'MANIFEST_INVALID'],
    ['keyIdMismatch', 'vector-plugin', false, 'MANIFEST_INVALID'],
    ['wrongUsage', 'vector-priv-plugin', true, 'MANIFEST_UNTRUSTED']
  ]
  for (const [name, pluginId, requireAdmin, expectedCode] of negativeCases) {
    const vec = fixture.vectors[name]!
    assertHostRejection(
      () => verifySignedManifestPayload({
        manifestBytes: Buffer.from(vec.manifestJson, 'utf8'),
        signatureText: vec.signatureLine,
        expectedPluginId: pluginId,
        expectedRequireAdmin: requireAdmin,
        bundle
      }),
      expectedCode
    )
  }

  // .sig 行解析负例
  assert.equal(parseSignatureLine('v2:abc:' + '0'.repeat(128)), null)
  assert.equal(parseSignatureLine('v1:abc:' + '0'.repeat(127)), null)
  assert.equal(parseSignatureLine('v1:abc:' + 'a'.repeat(128) + '\nextra'), null)
})

test('目录校验覆盖签名全 PE 封闭性、吊销、回滚、冻结表与特权隔离', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ztools-native-trust-dir-'))
  try {
    const normalKey = generateEphemeralKey('test-normal-key', ['native'])
    const privKey = generateEphemeralKey('test-priv-key', ['native-privileged'])
    const mainDll = makeFixturePe('x86', true, 'main')
    const depDll = makeFixturePe('x86', true, 'dep')
    const helperExe = makeFixturePe('x64', false, 'helper')
    const extraPe = makeFixturePe('x64', false, 'undeclared')

    const pluginDir = path.join(root, 'signed-plugin')
    await fsPromises.mkdir(path.join(pluginDir, 'lib'), { recursive: true })
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'DemoPlugin.dll'), mainDll)
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'Dep.dll'), depDll)
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'helper.exe'), helperExe)

    const manifestObj = {
      schemaVersion: 1,
      keyId: normalKey.entry.keyId,
      pluginId: 'demo-plugin',
      pluginVersion: '1.5.0',
      requireAdmin: false,
      issuedAt: '2026-11-25T00:00:00.000Z',
      files: [
        { role: 'main', dllId: 'DemoPlugin', path: 'lib/DemoPlugin.dll', arch: 'x86', size: mainDll.length, sha256: sha256Hex(mainDll), functions: ['Run'] },
        { role: 'dependency', path: 'lib/Dep.dll', arch: 'x86', size: depDll.length, sha256: sha256Hex(depDll) },
        { role: 'helper', path: 'lib/helper.exe', arch: 'x64', size: helperExe.length, sha256: sha256Hex(helperExe) }
      ]
    }
    const manifestText = `${JSON.stringify(manifestObj, null, 2)}\n`
    const sigText = signManifestText(manifestText, normalKey.entry.keyId, normalKey.privateKeyPem)
    await fsPromises.writeFile(path.join(pluginDir, 'native-trust.json'), manifestText, 'utf8')
    await fsPromises.writeFile(path.join(pluginDir, 'native-trust.sig'), sigText, 'utf8')

    const baseBundle = createBundle({ publicKeys: [normalKey.entry, privKey.entry] })

    // 1. 正向通过
    const ok = verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.5.0',
      expectedRequireAdmin: false,
      bundle: baseBundle
    })
    assert.equal(ok.mode, 'signed')

    // 2. 跨插件移植签名拒绝
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'other-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: baseBundle
      }),
      'MANIFEST_INVALID'
    )

    // 3. 版本号不匹配拒绝
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.1',
        expectedRequireAdmin: false,
        bundle: baseBundle
      }),
      'MANIFEST_INVALID'
    )

    // 4. 吊销清单（keyId / manifestSha256 / fileSha256 / minPluginVersions）
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: createBundle({
          publicKeys: [normalKey.entry],
          revocations: { schemaVersion: 1, revokedKeyIds: [normalKey.entry.keyId], revokedManifestSha256: [], revokedFileSha256: [], minPluginVersions: {} }
        })
      }),
      'MANIFEST_REVOKED',
      errorCodes.permissionDenied
    )
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: createBundle({
          publicKeys: [normalKey.entry],
          revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [sha256Hex(manifestText)], revokedFileSha256: [], minPluginVersions: {} }
        })
      }),
      'MANIFEST_REVOKED',
      errorCodes.permissionDenied
    )
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: createBundle({
          publicKeys: [normalKey.entry],
          revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [], revokedFileSha256: [sha256Hex(helperExe)], minPluginVersions: {} }
        })
      }),
      'MANIFEST_REVOKED',
      errorCodes.permissionDenied
    )
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: createBundle({
          publicKeys: [normalKey.entry],
          revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [], revokedFileSha256: [], minPluginVersions: { 'demo-plugin': '1.6.0' } }
        })
      }),
      'MANIFEST_ROLLBACK',
      errorCodes.permissionDenied
    )

    // 5. 封闭性：目录内夹带未声明 PE 拒绝
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'sneaky.exe'), extraPe)
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: baseBundle
      }),
      'DLL_NOT_ALLOWED'
    )
    await fsPromises.rm(path.join(pluginDir, 'lib', 'sneaky.exe'))

    // 6. 篡改伴生 helper 任意 1 字节 → DLL_INTEGRITY
    const tamperedHelper = Buffer.from(helperExe)
    tamperedHelper[tamperedHelper.length - 1] = (tamperedHelper[tamperedHelper.length - 1] ?? 0) ^ 0xff
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'helper.exe'), tamperedHelper)
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        bundle: baseBundle
      }),
      'DLL_INTEGRITY'
    )
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'helper.exe'), helperExe)

    // 7. 只有 json 没有 sig → MANIFEST_UNAVAILABLE（绝不降级到冻结表）
    await fsPromises.rm(path.join(pluginDir, 'native-trust.sig'))
    const frozenBundle = createBundle({
      publicKeys: [normalKey.entry, privKey.entry],
      legacyFrozen: [{ pluginId: 'demo-plugin', dllId: 'DemoPlugin', sha256: sha256Hex(mainDll), functions: ['Run'] }]
    })
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        declaredMainEntries: ['lib/DemoPlugin.dll'],
        bundle: frozenBundle
      }),
      'MANIFEST_UNAVAILABLE'
    )

    // 8. 无签名旧版兼容分支：命中冻结表返回 legacy-frozen；旧版未签名特权插件放行返回 legacy-unsigned；同名重复主入口拒绝
    await fsPromises.rm(path.join(pluginDir, 'native-trust.json'))
    const legacyOk = verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.5.0',
      expectedRequireAdmin: false,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: frozenBundle
    })
    assert.equal(legacyOk.mode, 'legacy-frozen')

    const legacyPrivOk = verifyPluginInstallDirectory({
      pluginDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.5.0',
      expectedRequireAdmin: true,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: frozenBundle
    })
    assert.equal(legacyPrivOk.mode, 'legacy-unsigned')

    await fsPromises.mkdir(path.join(pluginDir, 'extra'), { recursive: true })
    await fsPromises.writeFile(path.join(pluginDir, 'extra', 'DemoPlugin.dll'), makeFixturePe('x86', true, 'dup-main'))
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.5.0',
        expectedRequireAdmin: false,
        declaredMainEntries: ['lib/DemoPlugin.dll'],
        bundle: frozenBundle
      }),
      'DLL_NOT_ALLOWED'
    )
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true })
  }
})

test('§3.5 S3 信任就绪检查与严格 UTF-8 解码：签名插件缺公钥仍拒载，无签名旧插件兼容放行，非法 UTF-8 与 BOM 严格拒绝', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ztools-native-trust-s3-utf8-'))
  try {
    const normalKey = generateEphemeralKey('utf8-normal-key', ['native'])
    const mainDll = makeFixturePe('x86', true, 's3-main')
    const unsignedDir = path.join(root, 'unsigned-plugin')
    await fsPromises.mkdir(path.join(unsignedDir, 'lib'), { recursive: true })
    await fsPromises.writeFile(path.join(unsignedDir, 'lib', 'DemoPlugin.dll'), mainDll)

    // 1. 无签名旧版插件（普通与特权）：不走新验签逻辑，空信任根下兼容放行返回 legacy-unsigned
    const emptyBundle = createBundle({ publicKeys: [], legacyFrozen: [] })
    const unsignedNormalOk = verifyPluginInstallDirectory({
      pluginDir: unsignedDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.0.0',
      expectedRequireAdmin: false,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: emptyBundle
    })
    assert.equal(unsignedNormalOk.mode, 'legacy-unsigned')
    const unsignedPrivOk = verifyPluginInstallDirectory({
      pluginDir: unsignedDir,
      expectedPluginId: 'demo-plugin',
      expectedPluginVersion: '1.0.0',
      expectedRequireAdmin: true,
      declaredMainEntries: ['lib/DemoPlugin.dll'],
      bundle: emptyBundle
    })
    assert.equal(unsignedPrivOk.mode, 'legacy-unsigned')

    // 2. 携带签名清单但缺少对应公钥（普通或特权）时仍严格返回 MANIFEST_UNTRUSTED
    const signedPrivDir = path.join(root, 'signed-priv-plugin')
    await fsPromises.mkdir(path.join(signedPrivDir, 'lib'), { recursive: true })
    await fsPromises.writeFile(path.join(signedPrivDir, 'lib', 'DemoPlugin.dll'), mainDll)
    const privManifestText = JSON.stringify({
      schemaVersion: 1,
      keyId: normalKey.entry.keyId,
      pluginId: 'demo-plugin',
      pluginVersion: '1.0.0',
      requireAdmin: true,
      issuedAt: '2026-04-20T00:00:00Z',
      files: [{ path: 'lib/DemoPlugin.dll', role: 'main', dllId: 'DemoPlugin', arch: 'x86', size: mainDll.length, sha256: sha256Hex(mainDll), functions: ['Run'] }]
    })
    await fsPromises.writeFile(path.join(signedPrivDir, 'native-trust.json'), privManifestText, 'utf8')
    await fsPromises.writeFile(
      path.join(signedPrivDir, 'native-trust.sig'),
      signManifestText(privManifestText, normalKey.entry.keyId, normalKey.privateKeyPem),
      'utf8'
    )

    const normalOnlyWithFrozen = createBundle({
      publicKeys: [normalKey.entry],
      legacyFrozen: [{ pluginId: 'demo-plugin', dllId: 'DemoPlugin', sha256: sha256Hex(mainDll), functions: ['Run'] }]
    })
    assertHostRejection(
      () => verifyPluginInstallDirectory({
        pluginDir: signedPrivDir,
        expectedPluginId: 'demo-plugin',
        expectedPluginVersion: '1.0.0',
        expectedRequireAdmin: true,
        declaredMainEntries: ['lib/DemoPlugin.dll'],
        bundle: normalOnlyWithFrozen
      }),
      'MANIFEST_UNTRUSTED',
      errorCodes.permissionDenied
    )

    // 3. 合法签名但载荷包含非法 UTF-8 字节序列 → 严格解码阶段返回 MANIFEST_INVALID
    const invalidUtf8Bytes = Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    const invalidUtf8Sig = crypto.sign('sha256', Buffer.concat([NATIVE_TRUST_DOMAIN_PREFIX, invalidUtf8Bytes]), {
      key: normalKey.privateKeyPem,
      dsaEncoding: 'ieee-p1363'
    })
    const keyBundle = createBundle({ publicKeys: [normalKey.entry] })
    assertHostRejection(
      () => verifySignedManifestPayload({
        manifestBytes: invalidUtf8Bytes,
        signatureText: `v1:${normalKey.entry.keyId}:${invalidUtf8Sig.toString('hex')}\n`,
        expectedPluginId: 'demo-plugin',
        expectedRequireAdmin: false,
        bundle: keyBundle
      }),
      'MANIFEST_INVALID',
      errorCodes.pluginIntegrity
    )

    // 4. 合法签名但带 UTF-8 BOM → TextDecoder(ignoreBOM: true) 保留 BOM 交由 parseStrictJson 拒绝
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"schemaVersion":1}', 'utf8')])
    const bomSig = crypto.sign('sha256', Buffer.concat([NATIVE_TRUST_DOMAIN_PREFIX, bomBytes]), {
      key: normalKey.privateKeyPem,
      dsaEncoding: 'ieee-p1363'
    })
    assertHostRejection(
      () => verifySignedManifestPayload({
        manifestBytes: bomBytes,
        signatureText: `v1:${normalKey.entry.keyId}:${bomSig.toString('hex')}\n`,
        expectedPluginId: 'demo-plugin',
        expectedRequireAdmin: false,
        bundle: keyBundle
      }),
      'MANIFEST_INVALID',
      errorCodes.pluginIntegrity
    )
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true })
  }
})

test('PluginInstallService 安装期原生信任门禁：签名通过、未声明 PE 夹带回滚、跨平台仅 macOS 原生声明纯 JS 插件不误拒', async (context) => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ztools-install-trust-'))
  const normalKey = generateEphemeralKey('install-test-key', ['native'])
  const bundle = createBundle({ publicKeys: [normalKey.entry] })
  const verifier = createWindowsNativeTrustInstallVerifier(bundle)
  const windowsTarget = { platform: 'win32', runtime: 'electron', arch: 'x64' } as const

  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const publisher = {
    publishHostToMain(type: string, payload: unknown): { success: true; delivered: number } {
      events.push({ type, payload: payload as Record<string, unknown> })
      return { success: true, delivered: 1 }
    }
  }

  let currentArchive: Buffer = Buffer.alloc(0)
  const service = new PluginInstallService(root, publisher, {
    fetchImpl: (async () => makeResponse(currentArchive)) as typeof fetch,
    runtimeTarget: windowsTarget,
    nativeTrustVerifier: verifier
  })
  context.after(async () => {
    await service.stop()
    await fsPromises.rm(root, { recursive: true, force: true })
  })

  // 用例 1：仅 macOS 声明 nativeComponents、Windows 侧纯 JS 且无 PE 文件的跨平台插件 → 正常放行
  const macOnlyJsZip = createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'cross-js-plugin',
        name: '跨平台纯 JS 插件',
        version: '1.0.0',
        entry: 'index.html',
        targets: [
          { id: 'win-js', platform: 'windows', runtime: 'electron', arch: 'any' },
          { id: 'mac-native', platform: 'macos', runtime: 'electron', arch: 'universal' }
        ],
        nativeComponents: [
          { id: 'mac-worker', kind: 'worker', targetId: 'mac-native', arch: 'universal', abi: 'ztools-mac-worker/v1', entry: 'native/mac-worker' }
        ]
      })
    },
    { name: 'index.html', data: '<html>ok</html>' }
  ])
  currentArchive = macOnlyJsZip
  await service.startInstall({
    pluginId: 'cross-js-plugin',
    url: 'https://cdn.example/cross-js.zip',
    version: '1.0.0',
    checksum: sha256Hex(macOnlyJsZip),
    fileSize: macOnlyJsZip.length
  }, false)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, true)
  assert.equal(directoryHasPeOrTrustFiles(path.join(root, 'Plugins', 'cross-js-plugin')), false)

  // 用例 2：未声明 dllloader / nativeComponents 但夹带 PE 文件 → 触发条件 ③ 拦截并回滚
  const winX64Targets = [{ id: 'win-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }]
  const sneakyPeZip = createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'sneaky-pe-plugin',
        name: '夹带 PE 插件',
        version: '1.0.0',
        entry: 'index.html',
        targets: winX64Targets,
        nativeComponents: []
      })
    },
    { name: 'index.html', data: '<html>bad</html>' },
    { name: 'assets/hidden.exe', data: makeFixturePe('x64', false, 'sneaky') }
  ])
  currentArchive = sneakyPeZip
  await service.startInstall({
    pluginId: 'sneaky-pe-plugin',
    url: 'https://cdn.example/sneaky.zip',
    version: '1.0.0',
    checksum: sha256Hex(sneakyPeZip),
    fileSize: sneakyPeZip.length
  }, false)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, false)
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.permissionDenied)
  assert.equal(fs.existsSync(path.join(root, 'Plugins', 'sneaky-pe-plugin')), false)

  // 用例 3：带合法签名清单的原生插件 → 安装成功；夹带额外未声明 PE → 中止并回滚
  const mainDll = makeFixturePe('x86', true, 'signed-main')
  const trustManifest = `${JSON.stringify({
    schemaVersion: 1,
    keyId: normalKey.entry.keyId,
    pluginId: 'signed-native',
    pluginVersion: '1.2.0',
    requireAdmin: false,
    issuedAt: '2026-11-25T00:00:00.000Z',
    files: [
      { role: 'main', dllId: 'SignedPlugin', path: 'lib/SignedPlugin.dll', arch: 'x86', size: mainDll.length, sha256: sha256Hex(mainDll), functions: ['Ping'] }
    ]
  }, null, 2)}\n`
  const trustSig = signManifestText(trustManifest, normalKey.entry.keyId, normalKey.privateKeyPem)
  const signedNativeComponents = [{
    id: 'signed-dll',
    kind: 'dll',
    targetId: 'win-x64',
    arch: 'ia32',
    abi: 'ztools-native-host/v1',
    entry: 'lib/SignedPlugin.dll',
    protocolVersion: 1
  }]
  const validSignedZip = createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'signed-native',
        name: '已签名原生插件',
        version: '1.2.0',
        entry: 'index.html',
        dllloader: 'lib/SignedPlugin.dll',
        targets: winX64Targets,
        nativeComponents: signedNativeComponents
      })
    },
    { name: 'index.html', data: '<html>signed</html>' },
    { name: 'lib/SignedPlugin.dll', data: mainDll },
    { name: 'native-trust.json', data: trustManifest },
    { name: 'native-trust.sig', data: trustSig }
  ])
  currentArchive = validSignedZip
  await service.startInstall({
    pluginId: 'signed-native',
    url: 'https://cdn.example/signed-native.zip',
    version: '1.2.0',
    checksum: sha256Hex(validSignedZip),
    fileSize: validSignedZip.length
  }, false)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, true)
  assert.equal(fs.existsSync(path.join(root, 'Plugins', 'signed-native', 'lib', 'SignedPlugin.dll')), true)

  // 升级夹带未声明 PE → 失败且旧版本完好回滚
  const extraPeUpdateZip = createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'signed-native',
        name: '已签名原生插件',
        version: '1.2.0',
        entry: 'index.html',
        dllloader: 'lib/SignedPlugin.dll',
        targets: winX64Targets,
        nativeComponents: signedNativeComponents
      })
    },
    { name: 'index.html', data: '<html>tampered</html>' },
    { name: 'lib/SignedPlugin.dll', data: mainDll },
    { name: 'lib/extra.exe', data: makeFixturePe('x64', false, 'extra') },
    { name: 'native-trust.json', data: trustManifest },
    { name: 'native-trust.sig', data: trustSig }
  ])
  currentArchive = extraPeUpdateZip
  await service.startInstall({
    pluginId: 'signed-native',
    url: 'https://cdn.example/signed-native-bad.zip',
    version: '1.2.0',
    checksum: sha256Hex(extraPeUpdateZip),
    fileSize: extraPeUpdateZip.length
  }, true)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, false)
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.permissionDenied)
  assert.equal(fs.readFileSync(path.join(root, 'Plugins', 'signed-native', 'index.html'), 'utf8'), '<html>signed</html>')
})

test('ServiceClient 新增 MANIFEST_REVOKED 与 MANIFEST_ROLLBACK 中英文 i18n 文案完整', () => {
  const clientRoot = path.resolve(__dirname, '..', '..', '..')
  const zh = JSON.parse(fs.readFileSync(path.join(clientRoot, 'src/main/i18n/locales/zh-CN.json'), 'utf8')) as Record<string, string>
  const en = JSON.parse(fs.readFileSync(path.join(clientRoot, 'src/main/i18n/locales/en-US.json'), 'utf8')) as Record<string, string>
  for (const key of ['serviceClient.rejection.MANIFEST_REVOKED', 'serviceClient.rejection.MANIFEST_ROLLBACK']) {
    assert.equal(typeof zh[key], 'string')
    assert.ok(zh[key]!.trim().length > 0, `zh-CN 缺少 ${key}`)
    assert.equal(typeof en[key], 'string')
    assert.ok(en[key]!.trim().length > 0, `en-US 缺少 ${key}`)
  }
})

test('方案 A：签名插件 commonLibs 离线验签、防篡改、特权硬拒绝与 PluginInstallService 联动', async () => {
  const normalKey = generateEphemeralKey('commonlib-normal-k1', ['native'])
  const privKey = generateEphemeralKey('commonlib-priv-k1', ['native-privileged'])
  const bundle: NativeTrustBundle = {
    publicKeys: [normalKey.entry, privKey.entry],
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

  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ztools-signed-commonlibs-'))
  try {
    const mainDll = makeFixturePe('x86', true, 'doc-converter')
    const pluginDir = path.join(root, 'Plugins', 'doc-converter')
    await fsPromises.mkdir(path.join(pluginDir, 'lib'), { recursive: true })
    await fsPromises.writeFile(path.join(pluginDir, 'index.html'), '<html>doc</html>')
    await fsPromises.writeFile(path.join(pluginDir, 'lib', 'DocConverterPlugin.dll'), mainDll)
    // 注意：plugin.json 里故意写入未签名伪造的 commonLibs，验证宿主绝不采信未签名字段
    await fsPromises.writeFile(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'doc-converter',
        name: 'Doc Converter',
        version: '1.0.0',
        entry: 'index.html',
        dllloader: 'lib/DocConverterPlugin.dll',
        requireAdmin: false,
        commonLibs: ['forged-unsigned-tool-9.9.9'],
        targets: [{ id: 'win-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }],
        nativeComponents: [{
          id: 'doc-converter-dll',
          kind: 'dll',
          targetId: 'win-x64',
          arch: 'ia32',
          abi: 'ztools-native-host/v1',
          entry: 'lib/DocConverterPlugin.dll',
          protocolVersion: 1
        }]
      })
    )

    const signedManifestObj = {
      schemaVersion: 1,
      keyId: normalKey.entry.keyId,
      pluginId: 'doc-converter',
      pluginVersion: '1.0.0',
      requireAdmin: false,
      issuedAt: '2026-11-27T00:00:00.000Z',
      files: [{
        role: 'main',
        dllId: 'DocConverterPlugin',
        path: 'lib/DocConverterPlugin.dll',
        arch: 'x86',
        size: mainDll.length,
        sha256: sha256Hex(mainDll),
        functions: ['Convert']
      }],
      commonLibs: ['pandoc-3.6.0', 'imagemagick-7.1.0']
    }
    const manifestText = `${JSON.stringify(signedManifestObj, null, 2)}\n`
    const sigText = signManifestText(manifestText, normalKey.entry.keyId, normalKey.privateKeyPem)
    await fsPromises.writeFile(path.join(pluginDir, 'native-trust.json'), manifestText, 'utf8')
    await fsPromises.writeFile(path.join(pluginDir, 'native-trust.sig'), sigText, 'utf8')

    // 1. 离线验签准确提取签名中的 commonLibs
    const extracted = verifySignedPluginCommonLibs({
      pluginDir,
      expectedPluginId: 'doc-converter',
      expectedPluginVersion: '1.0.0',
      expectedRequireAdmin: false,
      bundle
    })
    assert.deepEqual(extracted, ['pandoc-3.6.0', 'imagemagick-7.1.0'])

    // 2. 通过 PluginInstallService 真实装配：withPluginManifest 与 listSignedCommonLibDependencies 仅采信已验签清单
    const verifier = createWindowsNativeTrustInstallVerifier(bundle)
    const service = new PluginInstallService(
      root,
      { publishHostToMain: () => ({ success: true, delivered: 0 }) },
      {
        runtimeTarget: { platform: 'win32', arch: 'x64', runtime: 'electron' },
        nativeTrustVerifier: verifier
      }
    )
    try {
      await service.withPluginManifest('doc-converter', async (_manifest, metadata) => {
        assert.deepEqual(metadata?.signedCommonLibs, ['pandoc-3.6.0', 'imagemagick-7.1.0'])
      })
      const deps = await service.listSignedCommonLibDependencies()
      assert.deepEqual(deps, [{
        pluginId: 'doc-converter',
        toolIds: ['pandoc-3.6.0', 'imagemagick-7.1.0']
      }])
    } finally {
      await service.stop()
    }

    // 3. 护栏 1：篡改 native-trust.json 中的 commonLibs 立即触发 MANIFEST_UNTRUSTED
    const tamperedText = manifestText.replace('pandoc-3.6.0', 'evil-tool-1.0.0')
    await fsPromises.writeFile(path.join(pluginDir, 'native-trust.json'), tamperedText, 'utf8')
    assert.throws(
      () => verifySignedPluginCommonLibs({
        pluginDir,
        expectedPluginId: 'doc-converter',
        expectedPluginVersion: '1.0.0',
        expectedRequireAdmin: false,
        bundle
      }),
      (err: unknown) => err instanceof ZToolsError && err.details?.hostCode === 'MANIFEST_UNTRUSTED'
    )

    // 4. 护栏 2：即使使用合法 native-privileged 私钥签发，特权插件携带 commonLibs 仍必须被 Schema 硬拒绝
    const privManifestText = `${JSON.stringify({
      ...signedManifestObj,
      keyId: privKey.entry.keyId,
      requireAdmin: true,
      commonLibs: ['pandoc-3.6.0']
    }, null, 2)}\n`
    const privSigText = signManifestText(privManifestText, privKey.entry.keyId, privKey.privateKeyPem)
    assert.throws(
      () => verifySignedManifestPayload({
        manifestBytes: Buffer.from(privManifestText, 'utf8'),
        signatureText: privSigText,
        expectedPluginId: 'doc-converter',
        expectedPluginVersion: '1.0.0',
        expectedRequireAdmin: true,
        bundle
      }),
      (err: unknown) => err instanceof ZToolsError && err.details?.hostCode === 'MANIFEST_INVALID'
    )
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true })
  }
})
