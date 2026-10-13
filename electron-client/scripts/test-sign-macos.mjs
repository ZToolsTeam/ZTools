import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { macSigningOrder, signMacosRelease } from './sign-macos.mjs'

const app = path.resolve('fixture', 'ZTools.app')
const options = { app, output: path.resolve('fixture', 'release'),
  'minimum-os': '12.0',
  identity: 'Developer ID Application: Fixture (ABCDEFGHIJ)', 'keychain-profile': 'test-profile',
  entitlements: path.resolve('fixture', 'main.plist'), 'helper-entitlements': path.resolve('fixture', 'helper.plist') }
const machoFiles = ['Contents/MacOS/ZTools', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Contents/Frameworks/ZTools Helper.app/Contents/MacOS/ZTools Helper', 'Contents/Resources/app.asar.unpacked/native.node']
function harness({ failAt, notaryStatus = 'Accepted', entitlements = { 'com.apple.security.cs.allow-jit': true } } = {}) {
  const calls = [], directories = []
  return { calls, directories, dependencies: {
    platform: 'darwin', preflight: () => ({ status: 'PASS', appRoot: app }),
    verify: () => ({ machoFiles }),
    fsApi: { statSync: () => ({ isFile: () => true }), mkdirSync: (...args) => directories.push(args) },
    exec: (tool, argv, config) => {
      calls.push({ tool, argv, config })
      if (calls.length === failAt) throw new Error('secret identity / password / tool stderr')
      if (tool.endsWith('/plutil')) return JSON.stringify(entitlements)
      if (argv[0] === 'notarytool') return JSON.stringify({ status: notaryStatus, id: '11111111-2222-3333-4444-555555555555' })
      return ''
    }
  } }
}

test('按由内到外签名：Mach-O、Helper、Framework，主App单独最后签', () => {
  const order = macSigningOrder(app, machoFiles)
  for (const item of order) {
    const childIndex = order.indexOf(item)
    for (let i = 0; i < order.length; i++) {
      if (item.target.startsWith(`${order[i].target}${path.sep}`)) assert.ok(childIndex < i)
    }
  }
  assert.ok(!order.some(item => item.target === app))
  for (const bad of [[], ['../outside'], ['/outside'], ['Contents/../outside']]) assert.throws(() => macSigningOrder(app, bad))
})

test('完整编排先验证Universal再签名、公证、staple和最终重新压缩', () => {
  const h = harness()
  const result = signMacosRelease(options, h.dependencies)
  assert.equal(result.status, 'PASS')
  assert.equal(result.scope, 'signing-prototype')
  assert.deepEqual(result.completedStages, ['preflight', 'nested-sign', 'app-sign', 'signature-verify',
    'submission-archive', 'notarize', 'staple', 'gatekeeper', 'distribution-archive'])
  const signed = h.calls.filter(call => call.argv.includes('--sign'))
  assert.equal(signed.at(-1).argv.at(-1), app)
  assert.ok(signed.every(call => !call.argv.includes('--deep')))
  assert.ok(h.calls.every(call => call.config.shell === false && call.config.maxBuffer === 4 * 1024 * 1024))
  const notarize = h.calls.find(call => call.argv[0] === 'notarytool')
  assert.equal(notarize.config.timeout, 600_000)
  assert.deepEqual(notarize.argv.slice(-5), ['--keychain-profile', 'test-profile', '--wait', '--output-format', 'json'])
  assert.ok(h.calls.at(-1).argv.at(-1).endsWith('ZTools-notarized.zip'))
  assert.deepEqual(h.directories.at(-1), [options.output])
})

test('任一工具阶段失败立即停止，脱敏错误；公证非Accepted不staple', () => {
  const success = harness(); signMacosRelease(options, success.dependencies)
  for (let failAt = 1; failAt <= success.calls.length; failAt++) {
    const h = harness({ failAt })
    const result = signMacosRelease(options, h.dependencies)
    assert.equal(result.status, 'FAIL')
    assert.equal(h.calls.length, failAt)
    assert.ok(!JSON.stringify(result).includes('password'))
    assert.ok(!JSON.stringify(result).includes(options.identity))
  }
  const rejected = harness({ notaryStatus: 'Invalid' })
  assert.equal(signMacosRelease(options, rejected.dependencies).stage, 'notarize')
  assert.ok(!rejected.calls.some(call => call.argv[0] === 'stapler'))
})

test('NativeHost policy or bundle presence blocks release signing before output reservation', () => {
  const requested = harness()
  const requestResult = signMacosRelease({ ...options, nativeHostMode: 'enabled' }, requested.dependencies)
  assert.deepEqual(requestResult, {
    status: 'FAIL', phase: 2, stage: 'preflight', completedStages: [],
    code: 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'
  })
  assert.equal(requested.calls.length, 0)
  assert.equal(requested.directories.length, 0)

  const present = harness()
  present.dependencies.verify = () => { throw Object.assign(new Error('MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'), {
    code: 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'
  }) }
  const presentResult = signMacosRelease(options, present.dependencies)
  assert.equal(presentResult.status, 'FAIL')
  assert.equal(presentResult.code, 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE')
  assert.equal(present.directories.length, 0)
  assert.ok(!present.calls.some(call => call.argv.includes('--sign')))
})

test('Windows、缺凭据、未审查entitlements、thin或已占用输出不得伪造成功', () => {
  const h = harness(); h.dependencies.platform = 'win32'
  assert.equal(signMacosRelease(options, h.dependencies).status, 'NOT_RUN')
  assert.equal(h.calls.length, 0)
  const missing = harness()
  assert.equal(signMacosRelease({ ...options, identity: '' }, missing.dependencies).status, 'FAIL')
  assert.equal(missing.calls.length, 0)
  for (const flag of ['com.apple.security.cs.disable-library-validation', 'com.apple.security.get-task-allow', 'com.apple.security.app-sandbox']) {
    const bad = harness({ entitlements: { 'com.apple.security.cs.allow-jit': true, [flag]: true } })
    assert.equal(signMacosRelease(options, bad.dependencies).status, 'FAIL')
    assert.ok(!bad.calls.some(call => call.argv.includes('--sign')))
  }
  const thin = harness(); thin.dependencies.verify = () => { throw new Error('missing x64 slice') }
  assert.equal(signMacosRelease(options, thin.dependencies).status, 'FAIL')
  assert.equal(thin.directories.length, 0)
  const occupied = harness(); occupied.dependencies.fsApi.mkdirSync = () => { throw new Error('EEXIST') }
  assert.equal(signMacosRelease(options, occupied.dependencies).status, 'FAIL')
  assert.ok(!occupied.calls.some(call => call.argv.includes('--sign')))
})
