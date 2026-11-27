import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NATIVE_TRUST_MANIFEST_FILE,
  NATIVE_TRUST_SIGNATURE_FILE,
  compareSemVer,
  createSignedNativeTrust,
  formatSignatureLine,
  generateNativeTrustKeyPair,
  inspectPeFile,
  parseSemVer,
  parseSignatureLine,
  parseStrictJson,
  resolvePrivateKeyMaterial,
  signNativeTrustPayload,
  signPluginDirectory,
  validateNativeTrustManifestSchema,
  validateRevocationsSchema,
  verifyNativeTrustSignature,
  verifyPluginDirectory
} from '../scripts/sign-native-trust.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 构造最小合法 Win32 x86/x64 PE 二进制（用于测试封闭性与角色分类，零外部依赖） */
function makeMinimalPe({ arch = 'x86', isDll = true, isClrManaged = false } = {}) {
  const peOffset = 0x80
  const is64 = arch === 'x64'
  const optionalSize = is64 ? 0xf0 : 0xe0
  const headerEnd = peOffset + 24 + optionalSize + 40
  const buf = Buffer.alloc(Math.max(headerEnd + 64, 512), 0)
  // DOS MZ + e_lfanew
  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(peOffset, 0x3c)
  // PE\0\0
  buf.writeUInt32LE(0x00004550, peOffset)
  // Machine
  buf.writeUInt16LE(is64 ? 0x8664 : 0x014c, peOffset + 4)
  // NumberOfSections = 1
  buf.writeUInt16LE(1, peOffset + 6)
  // SizeOfOptionalHeader
  buf.writeUInt16LE(optionalSize, peOffset + 20)
  // Characteristics
  const chars = 0x0002 | (isDll ? 0x2000 : 0)
  buf.writeUInt16LE(chars, peOffset + 22)
  // OptionalHeader Magic
  buf.writeUInt16LE(is64 ? 0x020b : 0x010b, peOffset + 24)
  if (isClrManaged) {
    const clrDirOffset = peOffset + 24 + (is64 ? 112 : 96) + 14 * 8
    buf.writeUInt32LE(0x2008, clrDirOffset)
    buf.writeUInt32LE(0x48, clrDirOffset + 4)
  }
  return buf
}

test('SemVer 解析与比较遵循规范（含预发布版本与非法格式拒绝）', () => {
  assert.ok(parseSemVer('1.2.3'))
  assert.ok(parseSemVer('1.2.3-beta.1'))
  assert.equal(parseSemVer('01.2.3'), null)
  assert.equal(parseSemVer('1.2.3-01'), null)
  assert.equal(parseSemVer('1.2'), null)
  assert.equal(compareSemVer('1.2.3', '1.2.3'), 0)
  assert.equal(compareSemVer('1.2.3-alpha.1', '1.2.3'), -1)
  assert.equal(compareSemVer('1.2.3-alpha.1', '1.2.3-alpha.2'), -1)
  assert.equal(compareSemVer('1.2.3-1', '1.2.3-alpha'), -1)
  assert.equal(compareSemVer('2.0.0', '1.9.9'), 1)
})

test('parseStrictJson 严格拦截重复键、超深嵌套、未知转义、BOM 与非法整数', () => {
  assert.deepEqual({ ...parseStrictJson('{"a":1,"b":[true,false,null,"ok"]}') }, { a: 1, b: [true, false, null, 'ok'] })
  assert.throws(() => parseStrictJson('\uFEFF{"a":1}'), /BOM/)
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /重复键/)
  assert.throws(() => parseStrictJson(`{"a":${'['.repeat(10)}1${']'.repeat(10)}}`), /深度/)
  assert.throws(() => parseStrictJson('{"a":-1}'), /非法字符|负数/)
  assert.throws(() => parseStrictJson('{"a":1.5}'), /整数/)
  assert.throws(() => parseStrictJson('{"a":"\\uD800"}'), /代理/)
  assert.throws(() => parseStrictJson('{"a":"\\x41"}'), /转义/)
})

test('signPluginDirectory 强制显式主入口、自动归类 dependency/helper，且封闭性验签阻断夹带 PE 与篡改', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-sign-test-'))
  try {
    const libDir = path.join(tempRoot, 'lib')
    const subDir = path.join(libDir, 'bin')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(libDir, 'DemoPlugin.dll'), makeMinimalPe({ arch: 'x86', isDll: true }))
    fs.writeFileSync(path.join(libDir, 'DepX86.dll'), makeMinimalPe({ arch: 'x86', isDll: true }))
    fs.writeFileSync(path.join(libDir, 'WinRing0x64.dll'), makeMinimalPe({ arch: 'x64', isDll: true }))
    fs.writeFileSync(path.join(libDir, 'Managed.dll'), makeMinimalPe({ arch: 'x86', isDll: true, isClrManaged: true }))
    fs.writeFileSync(path.join(subDir, 'helper.exe'), makeMinimalPe({ arch: 'x64', isDll: false }))
    fs.writeFileSync(path.join(libDir, 'driver.sys'), makeMinimalPe({ arch: 'x64', isDll: false }))
    fs.writeFileSync(path.join(tempRoot, 'build-info.json'), JSON.stringify({ builtAt: '2026-11-20T10:00:00.000Z' }))

    const normalKey = generateNativeTrustKeyPair('test-normal-1', ['native'])
    const privKey = generateNativeTrustKeyPair('test-priv-1', ['native-privileged'])

    // 缺少显式 mainEntries 时拒绝
    assert.throws(
      () => signPluginDirectory({
        pluginDir: tempRoot,
        pluginId: 'demo',
        pluginVersion: '1.0.0',
        keyId: normalKey.keyId,
        privateKeyPem: normalKey.privateKeyPem,
        keyUsages: normalKey.usages
      }),
      /mainEntries/
    )

    // 用普通密钥签特权清单被 usage 校验拦截
    assert.throws(
      () => signPluginDirectory({
        pluginDir: tempRoot,
        pluginId: 'demo',
        pluginVersion: '1.0.0',
        requireAdmin: true,
        keyId: normalKey.keyId,
        mainEntries: [{ path: 'lib/DemoPlugin.dll', dllId: 'DemoPlugin', functions: ['Run'] }],
        privateKeyPem: normalKey.privateKeyPem,
        keyUsages: normalKey.usages
      }),
      /不允许签发/
    )

    const signed = signPluginDirectory({
      pluginDir: tempRoot,
      pluginId: 'demo',
      pluginVersion: '1.0.0',
      requireAdmin: false,
      keyId: normalKey.keyId,
      mainEntries: [{ path: 'lib/DemoPlugin.dll', dllId: 'DemoPlugin', functions: ['Run', '__setLocale'] }],
      privateKeyPem: normalKey.privateKeyPem,
      keyUsages: normalKey.usages
    })

    assert.equal(signed.manifest.issuedAt, '2026-11-20T10:00:00.000Z')
    assert.ok(parseSignatureLine(signed.signatureText))
    const byPath = new Map(signed.manifest.files.map((f) => [f.path, f]))
    assert.equal(byPath.get('lib/DemoPlugin.dll').role, 'main')
    assert.equal(byPath.get('lib/DepX86.dll').role, 'dependency')
    assert.equal(byPath.get('lib/WinRing0x64.dll').role, 'helper')
    assert.equal(byPath.get('lib/Managed.dll').role, 'helper')
    assert.equal(byPath.get('lib/bin/helper.exe').role, 'helper')
    assert.equal(byPath.get('lib/driver.sys').role, 'helper')

    const publicKeys = [
      { keyId: normalKey.keyId, publicKeyHex: normalKey.publicKeyHex, usages: normalKey.usages },
      { keyId: privKey.keyId, publicKeyHex: privKey.publicKeyHex, usages: privKey.usages }
    ]

    const verified = verifyPluginDirectory({
      pluginDir: tempRoot,
      publicKeys,
      expectedPluginId: 'demo',
      expectedRequireAdmin: false
    })
    assert.equal(verified.manifest.pluginId, 'demo')

    // 吊销清单拦截（keyId / manifestSha256 / fileSha256 / minPluginVersions）
    assert.throws(
      () => verifyPluginDirectory({
        pluginDir: tempRoot,
        publicKeys,
        revocations: { schemaVersion: 1, revokedKeyIds: [normalKey.keyId], revokedManifestSha256: [], revokedFileSha256: [], minPluginVersions: {} }
      }),
      /已被吊销/
    )
    assert.throws(
      () => verifyPluginDirectory({
        pluginDir: tempRoot,
        publicKeys,
        revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [verified.manifestSha256], revokedFileSha256: [], minPluginVersions: {} }
      }),
      /清单哈希已被吊销/
    )
    assert.throws(
      () => verifyPluginDirectory({
        pluginDir: tempRoot,
        publicKeys,
        revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [], revokedFileSha256: [byPath.get('lib/DepX86.dll').sha256], minPluginVersions: {} }
      }),
      /文件哈希已被吊销/
    )
    assert.throws(
      () => verifyPluginDirectory({
        pluginDir: tempRoot,
        publicKeys,
        revocations: { schemaVersion: 1, revokedKeyIds: [], revokedManifestSha256: [], revokedFileSha256: [], minPluginVersions: { demo: '1.0.1' } }
      }),
      /低于最低安全版本/
    )

    // 放入未声明的 PE 文件 → 封闭性检查拒绝
    const extraPath = path.join(libDir, 'Smuggled.dll')
    fs.writeFileSync(extraPath, makeMinimalPe({ arch: 'x86', isDll: true }))
    assert.throws(() => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys }), /未在 native-trust\.json 中声明/)
    fs.unlinkSync(extraPath)

    // 缺失清单声明文件 → 报语义清晰的 DLL_UNAVAILABLE 错误（非裸 ENOENT）
    const helperPath = path.join(subDir, 'helper.exe')
    const helperBackup = fs.readFileSync(helperPath)
    fs.unlinkSync(helperPath)
    assert.throws(
      () => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys }),
      /DLL_UNAVAILABLE:.*清单声明的文件不存在/
    )
    fs.writeFileSync(helperPath, helperBackup)

    // 篡改 helper 1 字节 → 完整性拒绝
    const orig = fs.readFileSync(helperPath)
    orig[orig.length - 1] ^= 0xff
    fs.writeFileSync(helperPath, orig)
    assert.throws(() => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys }), /完整性不匹配/)
    fs.writeFileSync(helperPath, helperBackup)

    // 清单篡改 1 字节 → 先验签失败；但若调用方显式指定 expectedRequireAdmin 且公钥用途不匹配，则在验签前即拒绝
    const mPath = path.join(tempRoot, NATIVE_TRUST_MANIFEST_FILE)
    const rawM = fs.readFileSync(mPath, 'utf8')
    fs.writeFileSync(mPath, rawM.replace('1.0.0', '1.0.1'), 'utf8')
    assert.throws(
      () => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys, expectedRequireAdmin: true }),
      /用途不匹配 native-privileged/
    )
    assert.throws(() => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys }), /签名验证失败/)

    // 合法签名但载荷包含非法 UTF-8 字节序列 → 严格解码阶段拒绝
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    fs.writeFileSync(mPath, invalidUtf8)
    fs.writeFileSync(
      path.join(tempRoot, NATIVE_TRUST_SIGNATURE_FILE),
      formatSignatureLine(normalKey.keyId, signNativeTrustPayload(invalidUtf8, normalKey.privateKeyPem)),
      'utf8'
    )
    assert.throws(() => verifyPluginDirectory({ pluginDir: tempRoot, publicKeys }), /非法 UTF-8/)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('resolvePrivateKeyMaterial 严禁回退 .local-keys，支持显式密钥文件并校验 usage', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-key-resolve-'))
  try {
    const fakeLocal = path.join(tempRoot, '.local-keys')
    fs.mkdirSync(fakeLocal, { recursive: true })
    const k1 = generateNativeTrustKeyPair('ztools-native-prod-2026a', ['native'])
    fs.writeFileSync(path.join(fakeLocal, 'ztools-native-2026-v1.private.pem'), k1.privateKeyPem)

    // 显式指定不存在的 --key-file 时给出明确报错，而非回退到笼统报错
    const missingKeyFile = path.join(tempRoot, 'nonexistent-keys.json')
    assert.throws(
      () => resolvePrivateKeyMaterial({ keyFilePath: missingKeyFile, rootDir: tempRoot, env: {} }),
      /指定的密钥文件不存在/
    )

    // 绝不读取 .local-keys
    assert.throws(
      () => resolvePrivateKeyMaterial({ rootDir: tempRoot, env: {} }),
      /未找到原生 DLL 签名私钥/
    )

    // 写入 native-trust-private-keys.json，校验 usage 隔离
    const keyFile = path.join(tempRoot, 'native-trust-private-keys.json')
    fs.writeFileSync(keyFile, JSON.stringify({
      schemaVersion: 1,
      keys: [
        { keyId: k1.keyId, usages: ['native'], publicKeyHex: k1.publicKeyHex, privateKeyPem: k1.privateKeyPem }
      ]
    }))
    const resolved = resolvePrivateKeyMaterial({ rootDir: tempRoot, requireAdmin: false, env: {} })
    assert.equal(resolved.keyId, k1.keyId)
    assert.throws(
      () => resolvePrivateKeyMaterial({ rootDir: tempRoot, requireAdmin: true, env: {} }),
      /未找到匹配密钥/
    )
    assert.throws(
      () => resolvePrivateKeyMaterial({ rootDir: tempRoot, keyId: k1.keyId, requireAdmin: true, env: {} }),
      /不一致/
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('跨语言黄金向量与内置信任资源校验：无私钥 PEM 头且正反例均符合预期', () => {
  const vectorPath = path.join(REPO_ROOT, 'tests', 'fixtures', 'native-trust-vectors', 'vectors.json')
  const rawText = fs.readFileSync(vectorPath, 'utf8')
  assert.doesNotMatch(rawText, /BEGIN (?:EC |ENCRYPTED )?PRIVATE KEY/, '黄金向量绝对禁止包含 PEM 私钥头')
  const bundle = JSON.parse(rawText)
  const keyById = new Map(bundle.publicKeys.map((k) => [k.keyId, k]))

  // 正例
  for (const name of ['validNormal', 'validPrivileged']) {
    const v = bundle.vectors[name]
    const sig = parseSignatureLine(v.signatureLine)
    assert.ok(sig, name)
    const key = keyById.get(sig.keyId)
    assert.ok(key, name)
    assert.equal(verifyNativeTrustSignature(Buffer.from(v.manifestJson, 'utf8'), sig.signatureHex, key.publicKeyHex), true, name)
    const parsed = parseStrictJson(v.manifestJson)
    validateNativeTrustManifestSchema(parsed)
    assert.equal(parsed.keyId, sig.keyId)
  }

  // 反例：篡改载荷 → 验签失败
  {
    const v = bundle.vectors.tamperedPayload
    const sig = parseSignatureLine(v.signatureLine)
    const key = keyById.get(sig.keyId)
    assert.equal(verifyNativeTrustSignature(Buffer.from(v.manifestJson, 'utf8'), sig.signatureHex, key.publicKeyHex), false)
  }
  // 反例：合法签名的重复键 / 超深嵌套 / 未知字段 → 验签通过但严格解析或 schema 校验失败
  for (const name of ['duplicateKey', 'deepNesting', 'unknownField']) {
    const v = bundle.vectors[name]
    const sig = parseSignatureLine(v.signatureLine)
    const key = keyById.get(sig.keyId)
    assert.equal(verifyNativeTrustSignature(Buffer.from(v.manifestJson, 'utf8'), sig.signatureHex, key.publicKeyHex), true, `${name} 必须为有效签名`)
    assert.throws(() => {
      const parsed = parseStrictJson(v.manifestJson)
      validateNativeTrustManifestSchema(parsed)
    }, `${name} 必须在解析或 schema 阶段拒绝`)
  }
  // 反例：.sig 格式错误
  assert.equal(parseSignatureLine(bundle.vectors.malformedSig.signatureLine), null)
  // 反例：keyId 不一致
  {
    const v = bundle.vectors.keyIdMismatch
    const sig = parseSignatureLine(v.signatureLine)
    const parsed = parseStrictJson(v.manifestJson)
    assert.notEqual(sig.keyId, parsed.keyId)
  }

  // 校验仓库内吊销表和冻结表（恰好 5 条，符合 D5）
  const revPath = path.join(REPO_ROOT, 'electron-client', 'resources', 'native', 'native-trust-revocations.json')
  validateRevocationsSchema(parseStrictJson(fs.readFileSync(revPath, 'utf8')))
  const frozenPath = path.join(REPO_ROOT, 'electron-client', 'resources', 'native', 'legacy-frozen-dlls.json')
  const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'))
  assert.equal(frozen.length, 5, '冻结表必须恰好 5 条（D5）')
  for (const item of frozen) {
    assert.ok(Array.isArray(item.functions) && item.functions.length > 0, `${item.pluginId} 必须带 functions`)
  }
})

test('createSignedNativeTrust 与 inspectPeFile 基础边界校验', () => {
  const kp = generateNativeTrustKeyPair('unit-k1', ['native'])
  const signed = createSignedNativeTrust({
    pluginId: 'p1',
    pluginVersion: '0.1.0',
    requireAdmin: false,
    keyId: kp.keyId,
    files: [{
      role: 'main',
      dllId: 'P1',
      path: 'lib/P1.dll',
      arch: 'x86',
      size: 128,
      sha256: 'a'.repeat(64),
      functions: ['Ping']
    }],
    privateKeyPem: kp.privateKeyPem,
    keyUsages: kp.usages
  })
  assert.ok(signed.signatureText.startsWith(`v1:${kp.keyId}:`))
  assert.equal(inspectPeFile(fileURLToPath(import.meta.url)), null, '非 PE 文件返回 null')
})

test('方案 A：native-trust.json 可选 commonLibs 签发、校验与特权隔离硬拒绝', () => {
  const normalKp = generateNativeTrustKeyPair('unit-commonlib-normal', ['native'])
  const privKp = generateNativeTrustKeyPair('unit-commonlib-priv', ['native-privileged'])
  const baseFiles = [{
    role: 'main',
    dllId: 'DocConverterPlugin',
    path: 'lib/DocConverterPlugin.dll',
    arch: 'x86',
    size: 256,
    sha256: 'b'.repeat(64),
    functions: ['Convert']
  }]

  // 1. 普通插件声明 commonLibs 签发成功
  const signedWithLibs = createSignedNativeTrust({
    pluginId: 'doc-converter',
    pluginVersion: '1.0.0',
    requireAdmin: false,
    keyId: normalKp.keyId,
    files: baseFiles,
    commonLibs: ['pandoc-3.6.0', 'imagemagick-7.1.0'],
    privateKeyPem: normalKp.privateKeyPem,
    keyUsages: normalKp.usages
  })
  assert.deepEqual(signedWithLibs.manifest.commonLibs, ['pandoc-3.6.0', 'imagemagick-7.1.0'])
  validateNativeTrustManifestSchema(signedWithLibs.manifest)

  // 2. 空 commonLibs 省略字段，保持与历史 7 字段完全向后兼容
  const signedWithoutLibs = createSignedNativeTrust({
    pluginId: 'doc-converter',
    pluginVersion: '1.0.0',
    requireAdmin: false,
    keyId: normalKp.keyId,
    files: baseFiles,
    commonLibs: [],
    privateKeyPem: normalKp.privateKeyPem,
    keyUsages: normalKp.usages
  })
  assert.equal(Object.prototype.hasOwnProperty.call(signedWithoutLibs.manifest, 'commonLibs'), false)

  // 3. 护栏 2：特权插件（requireAdmin=true）严禁声明 commonLibs
  assert.throws(
    () => createSignedNativeTrust({
      pluginId: 'priv-tool',
      pluginVersion: '1.0.0',
      requireAdmin: true,
      keyId: privKp.keyId,
      files: baseFiles,
      commonLibs: ['pandoc-3.6.0'],
      privateKeyPem: privKp.privateKeyPem,
      keyUsages: privKp.usages
    }),
    /特权插件.*commonLibs/
  )
  assert.throws(
    () => validateNativeTrustManifestSchema({
      ...signedWithLibs.manifest,
      requireAdmin: true,
      commonLibs: []
    }),
    /特权插件.*commonLibs/
  )

  // 4. 非法与重复工具 ID 拦截
  for (const badLibs of [['Pandoc-3.6.0'], ['../escape'], ['con'], ['pandoc-1.0.0', 'pandoc-1.0.0']]) {
    assert.throws(
      () => createSignedNativeTrust({
        pluginId: 'doc-converter',
        pluginVersion: '1.0.0',
        requireAdmin: false,
        keyId: normalKp.keyId,
        files: baseFiles,
        commonLibs: badLibs,
        privateKeyPem: normalKp.privateKeyPem,
        keyUsages: normalKp.usages
      })
    )
  }
})
