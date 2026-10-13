const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const clientPath = path.join(__dirname, '../public/js/cef-ipc/src/client.js')
const buildPath = path.join(__dirname, '../public/js/cef-ipc/build.cjs')
const contractPath = path.join(__dirname, '../../electron-client/src/contracts/reference-transport.ts')
const clientSource = fs.readFileSync(clientPath, 'utf8')
const buildSource = fs.readFileSync(buildPath, 'utf8')
const contractSource = fs.readFileSync(contractPath, 'utf8')
const mutationMethods = contractSource.match(/export const REFERENCE_MUTATING_METHODS = \[([\s\S]*?)\] as const/)
const referenceMethods = contractSource.match(/export const REFERENCE_METHODS = \[\.\.\.REFERENCE_MUTATING_METHODS,([\s\S]*?)\] as const/)
assert.ok(mutationMethods && referenceMethods, 'canonical reference method lists must remain statically readable')

const parseMethods = block => [...block.matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1])
const canonicalReferenceMethods = [...parseMethods(mutationMethods[1]), ...parseMethods(referenceMethods[1])]

function createBridge(contractVersion, methods = {}, cancellations = {}) {
  return { contractVersion, transport: { methods, cancellations } }
}

function createMethodMap(names) {
  return Object.fromEntries(names.map(method => [method, () => Promise.resolve({ success: true })]))
}

function instantiateClient(host, config = {}) {
  const constructed = []
  class Transport {
    constructor(value) { this.config = value; constructed.push('Transport') }
    getElectronTransport() { return null }
    call() { return Promise.resolve({ success: true }) }
    handleMessage() {}
    destroy() {}
  }
  class ReferenceTransport extends Transport {
    constructor(value) { super(value); this.supportsAbortSignal = true; constructed[constructed.length - 1] = 'ReferenceTransport' }
  }
  const api = name => class {
    constructor(transport, ...args) { this.transport = transport; this.args = args; constructed.push(name) }
  }
  const types = {
    Transport,
    ReferenceTransport,
    FileSystemAPI: api('FileSystemAPI'),
    ReferenceFileSystemAPI: api('ReferenceFileSystemAPI'),
    DatabaseAPI: api('DatabaseAPI'),
    CredentialsAPI: api('CredentialsAPI'),
    SystemAPI: api('SystemAPI'),
    WindowAPI: api('WindowAPI'),
    ReferenceWindowAPI: api('ReferenceWindowAPI'),
    PluginAPI: api('PluginAPI'),
    SettingsAPI: api('SettingsAPI'),
    ConfigAPI: api('ConfigAPI'),
    UserAPI: api('UserAPI'),
    Events: api('Events'),
    ClipboardAPI: api('ClipboardAPI'),
    ReferenceClipboardAPI: api('ReferenceClipboardAPI'),
    ScreenAPI: api('ScreenAPI'),
    ShellAPI: api('ShellAPI'),
    NetworkAPI: api('NetworkAPI'),
    ReferenceNetworkAPI: api('ReferenceNetworkAPI'),
    ProcessAPI: api('ProcessAPI'),
    OCRAPI: api('OCRAPI'),
    TriggerAPI: api('TriggerAPI'),
    PrivilegedAPI: api('PrivilegedAPI'),
    UpdateAPI: api('UpdateAPI'),
    AnalyticsAPI: api('AnalyticsAPI'),
    ImageAPI: api('ImageAPI'),
    FFmpegAPI: api('FFmpegAPI'),
    DLLPluginAPI: api('DLLPluginAPI'),
    ScreenshotAPI: api('ScreenshotAPI'),
    ZipAPI: api('ZipAPI'),
    ReferenceSQLiteAPI: api('ReferenceSQLiteAPI')
  }
  const window = { __ztoolsElectron: host, addEventListener() {}, removeEventListener() {} }
  const context = vm.createContext({ window, console: { error() {}, warn() {} }, ...types })
  const { ZToolsClient, SDK2_REFERENCE_METHODS } = vm.runInContext(`${clientSource}\n({ ZToolsClient, SDK2_REFERENCE_METHODS })`, context)
  let client
  try { client = new ZToolsClient(config) }
  catch (error) { error.constructed = constructed; throw error }
  return { client, constructed, types, sdk2Methods: Array.from(SDK2_REFERENCE_METHODS) }
}

test('SDK2 method allowlist matches Main and remains duplicate-free', () => {
  const { sdk2Methods } = instantiateClient(createBridge(1))
  assert.deepEqual(sdk2Methods, canonicalReferenceMethods)
  assert.equal(new Set(sdk2Methods).size, sdk2Methods.length)
})

test('SDK bundler loads every selected adapter before client composition', () => {
  const adapters = [
    'core/reference-transport.js',
    'api/fs-reference.js',
    'api/file-producers-reference.js',
    'api/network-reference.js',
    'client.js'
  ]
  let previous = -1
  for (const adapter of adapters) {
    const position = buildSource.indexOf(`'${adapter}'`)
    assert.ok(position > previous, `${adapter} must load after its dependencies and before Client`)
    previous = position
  }
})

test('contract 1 keeps the legacy client composition, regardless of renderer config', () => {
  const { client, types } = instantiateClient(createBridge(1), { contractVersion: 2, lane: 2 })
  assert.ok(client.transport instanceof types.Transport)
  assert.ok(!(client.transport instanceof types.ReferenceTransport))
  assert.ok(client.fs instanceof types.FileSystemAPI)
  assert.ok(client.credentials instanceof types.CredentialsAPI)
  assert.strictEqual(client.credentials.transport, client.transport)
  assert.ok(client.window instanceof types.WindowAPI)
  assert.ok(client.clipboard instanceof types.ClipboardAPI)
  assert.ok(client.network instanceof types.NetworkAPI)
})

test('contract 2 selects reference transport and path-safe file consumers', () => {
  const methods = createMethodMap(canonicalReferenceMethods)
  const cancellations = createMethodMap(canonicalReferenceMethods)
  const { client, types } = instantiateClient(createBridge(2, methods, cancellations))
  assert.ok(client.transport instanceof types.ReferenceTransport)
  assert.equal(client.transport.supportsAbortSignal, true)
  assert.ok(client.fs instanceof types.ReferenceFileSystemAPI)
  assert.ok(client.credentials instanceof types.CredentialsAPI)
  assert.strictEqual(client.credentials.transport, client.transport)
  assert.ok(client.window instanceof types.ReferenceWindowAPI)
  assert.ok(client.clipboard instanceof types.ReferenceClipboardAPI)
  assert.ok(client.network instanceof types.ReferenceNetworkAPI)
  for (const consumer of [client.fs, client.window, client.clipboard, client.network]) {
    assert.strictEqual(consumer.transport, client.transport)
  }
  assert.strictEqual(client.clipboard.args[0], client.events)
})

test('contract 2 rejects an incomplete or inherited per-method bridge before client startup', () => {
  const cases = [
    bridge => { delete bridge.transport.methods.filesystem_read_file },
    bridge => { delete bridge.transport.cancellations.window_show_open_dialog },
    bridge => {
      const methods = Object.assign(Object.create({ filesystem_read_file: () => Promise.resolve() }), bridge.transport.methods)
      delete methods.filesystem_read_file
      bridge.transport.methods = methods
    },
    bridge => { bridge.transport.cancellations.filesystem_write_file = true }
  ]
  for (const mutate of cases) {
    const bridge = createBridge(2, createMethodMap(canonicalReferenceMethods), createMethodMap(canonicalReferenceMethods))
    mutate(bridge)
    assert.throws(() => instantiateClient(bridge), error =>
      error.code === 'NOT_SUPPORTED' && error.message === 'SDK合约2宿主缺少完整的逐方法调用与取消入口' && error.constructed.length === 0)
  }
})
