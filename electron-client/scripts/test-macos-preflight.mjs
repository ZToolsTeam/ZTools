import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { inspectMacApp, parseMacTestArguments, compareOsVersions } from './macos-preflight.mjs'

const app = path.resolve('fixture', 'Test.app')
const options = { app, output: path.resolve('reports'), 'bundle-id': 'test.ztools.fixture',
  'minimum-os': '12.0', 'expect-process-arch': 'arm64' }
function setup({ info = {}, system = '13.0', arches = 'arm64 x86_64' } = {}) {
  const calls = []
  return { calls, dependencies: {
    platform: 'darwin',
    readAppPackage: () => ({ version: '1.1.7.1' }),
    fsApi: {
      realpathSync: value => value,
      statSync: value => ({ isDirectory: () => value === app, isFile: () => value !== app }),
      accessSync() {},
      readFileSync: value => value.endsWith('ztools-bundle-versions.json')
        ? JSON.stringify({ schemaVersion: 1, appVersion: '1.1.7.1', shortVersion: '1.1.7', buildVersion: '1171' })
        : value.endsWith('.json')
        ? JSON.stringify({ manifestVersion: 1, target: { platform: 'macos', runtime: 'electron', arch: 'universal' } })
        : Buffer.from('test Mach-O')
    },
    exec: (tool, args, runOptions) => {
      calls.push({ tool, args, runOptions })
      if (tool.endsWith('/plutil')) return JSON.stringify({ CFBundleIdentifier: options['bundle-id'],
        CFBundleExecutable: 'ZTools', CFBundleShortVersionString: '1.1.7', CFBundleVersion: '1171', LSMinimumSystemVersion: '12.0', ...info })
      if (tool.endsWith('/sw_vers')) return system
      if (tool.endsWith('/lipo')) return arches
      throw new Error('unexpected tool')
    }
  } }
}

test('Windows早期NOT_RUN，不访问App或运行Mac工具', () => {
  assert.deepEqual(inspectMacApp(options, { platform: 'win32',
    fsApi: new Proxy({}, { get() { throw new Error('must not touch filesystem') } }),
    exec() { assert.fail('must not spawn') }
  }), { status: 'NOT_RUN', code: 'DARWIN_REQUIRED' })
})

test('注入Mac预检核实元数据、双切片和依赖；不冒充进程架构或实际Electron版本', () => {
  const h = setup()
  const result = inspectMacApp(options, h.dependencies)
  assert.equal(result.status, 'PASS')
  assert.equal(result.processArch, null)
  assert.equal(result.electronVersion, null)
  assert.match(result.executableSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(h.calls.map(c => c.tool), ['/usr/bin/plutil', '/usr/bin/sw_vers', '/usr/bin/lipo'])
  for (const call of h.calls) assert.deepEqual(call.runOptions,
    { encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 })
  assert.deepEqual(h.calls[0].args, ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')])
})

test('错误Bundle ID、OS元数据、thin slice和未知工具输出失败关闭', () => {
  for (const [input, code] of [
    [{ info: { CFBundleIdentifier: 'wrong.id' } }, 'BUNDLE_ID_MISMATCH'],
    [{ info: { CFBundleShortVersionString: '1.1.7.1' } }, 'INVALID_BUNDLE_VERSION'],
    [{ info: { CFBundleVersion: '1.2.3.4' } }, 'INVALID_BUNDLE_VERSION'],
    [{ info: { CFBundleShortVersionString: '1.1.8' } }, 'APP_VERSION_METADATA_MISMATCH'],
    [{ info: { CFBundleExecutable: '../other' } }, 'INVALID_EXECUTABLE'],
    [{ info: { LSMinimumSystemVersion: '13.0' } }, 'MINIMUM_OS_POLICY_MISMATCH'],
    [{ system: '11.9' }, 'OS_BELOW_MINIMUM'],
    [{ arches: 'arm64' }, 'UNIVERSAL_REQUIRED'],
    [{ arches: 'diagnostic error' }, 'INVALID_MACHO_ARCHITECTURES']
  ]) assert.equal(inspectMacApp(options, setup(input).dependencies).code, code)
  const h = setup()
  h.dependencies.exec = () => { throw new Error('private tool/path secret') }
  const result = inspectMacApp(options, h.dependencies)
  assert.equal(result.status, 'NOT_RUN')
  assert.ok(!JSON.stringify(result).includes('secret'))
})

test('OS最低版本边界：低于/等于/高于、patch、格式和溢出', () => {
  assert.equal(compareOsVersions('11.9', '12.0'), -1)
  assert.equal(compareOsVersions('12.0', '12.0.0'), 0)
  assert.equal(compareOsVersions('12.0.1', '12.0'), 1)
  assert.throws(() => compareOsVersions('unknown', '12.0'))
  assert.throws(() => compareOsVersions('9999999999999999999.0', '12.0'))
})

test('CLI拒绝裸相对路径、未知参数、缺失策略和报告写进App', () => {
  const args = ['--app', app, '--output', options.output, '--bundle-id', options['bundle-id'],
    '--minimum-os', '12.0', '--expect-process-arch', 'arm64']
  assert.deepEqual(parseMacTestArguments(args), Object.assign(Object.create(null), options))
  assert.equal(parseMacTestArguments(['--help']).help, true)
  for (const bad of [[], [...args, '--unknown'], args.map(v => v === app ? 'relative.app' : v),
    args.map(v => v === options.output ? path.join(app, 'reports') : v),
    args.map(v => v === 'arm64' ? 'ia32' : v)]) assert.throws(() => parseMacTestArguments(bad))
})
