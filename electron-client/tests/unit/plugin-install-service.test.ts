import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'
import { verifyWindowsPluginNativeFiles } from '../../src/main/services/plugin-native-file-integrity.js'

interface ZipEntry {
  name: string
  data: string | Buffer
  mode?: number
}

interface PublishedEvent {
  type: string
  payload: Record<string, unknown>
}

function runtimeRoot(name: string): string {
  return path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-${name}`)
}

const windowsIa32Electron = { platform: 'win32', runtime: 'electron', arch: 'ia32' } as const
const windowsX64Electron = { platform: 'win32', runtime: 'electron', arch: 'x64' } as const
const macArm64Electron = { platform: 'darwin', runtime: 'electron', arch: 'arm64' } as const

function fixturePe(arch: 'ia32' | 'x64', dll: boolean): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ', 0, 'ascii'); bytes.writeUInt32LE(64, 0x3c)
  bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(arch === 'ia32' ? 0x14c : 0x8664, 68)
  bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(arch === 'ia32' ? 224 : 240, 84)
  bytes.writeUInt16LE(2 | (dll ? 0x2000 : 0), 86); bytes.writeUInt16LE(arch === 'ia32' ? 0x10b : 0x20b, 88)
  return bytes
}

function payloadPackage(version: string, alter?: (files: ZipEntry[], manifest: any) => void): Buffer {
  const host = fixturePe('ia32', true), helper = fixturePe('x64', false), model = Buffer.from('model fixture')
  const manifest = { id: 'plugin.test', name: 'payload fixture', version, entry: 'index.html',
    targets: [{ id: 'win-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }],
    nativeComponents: [{ id: 'host', kind: 'dll', targetId: 'win-x64', arch: 'ia32', abi: 'ztools-native-host/v1',
      entry: 'lib/host.dll', protocolVersion: 1, sha256: sha256(host), payloadFiles: [
        { entry: 'lib/helper.exe', format: 'pe', arch: 'x64', sha256: sha256(helper) },
        { entry: 'lib/model.bin', format: 'data', sha256: sha256(model) }
      ] }]
  }
  const files: ZipEntry[] = [{ name: 'index.html', data: version }, { name: 'lib/host.dll', data: host },
    { name: 'lib/helper.exe', data: helper }, { name: 'lib/model.bin', data: model }]
  alter?.(files, manifest)
  return createZip([{ name: 'plugin.json', data: JSON.stringify(manifest) }, ...files])
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

function createZip(entries: ZipEntry[]): Buffer {
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
    local.writeUInt16LE(0, 8)
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
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((((entry.mode ?? 0o100644) & 0xffff) * 0x1_0000) >>> 0, 38)
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

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function pluginTreeSnapshot(root: string): Promise<{ entries: Array<Record<string, unknown>>; sha256: string }> {
  const entries: Array<Record<string, unknown>> = []
  const visit = async (relative = ''): Promise<void> => {
    const directory = path.join(root, relative)
    const children = await fs.readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name
      if (child.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory' })
        await visit(childRelative)
      } else if (child.isFile()) {
        const bytes = await fs.readFile(path.join(root, childRelative))
        entries.push({ path: childRelative, type: 'file', size: bytes.length, sha256: sha256(bytes) })
      } else throw new Error(`PLUGIN_TREE_ENTRY_NOT_REGULAR:${childRelative}`)
    }
  }
  await visit()
  return { entries, sha256: sha256(Buffer.from(JSON.stringify(entries), 'utf8')) }
}

function pluginZip(
  version: string,
  commonLibs: string[] = [],
  extraManifestFields: Record<string, unknown> = {}
): Buffer {
  return createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'plugin.test',
        name: '测试插件',
        version,
        entry: 'index.html',
        commonLibs,
        ...extraManifestFields
      })
    },
    { name: 'index.html', data: `<html>${version}</html>` }
  ])
}

function nativePluginZip(version: string): Buffer {
  return createZip([
    {
      name: 'plugin.json',
      data: JSON.stringify({
        id: 'plugin.test',
        name: '测试原生插件',
        version,
        entry: 'index.html',
        dllloader: 'lib/TestPlugin.dll'
      })
    },
    { name: 'index.html', data: `<html>${version}</html>` },
    { name: 'lib/TestPlugin.dll', data: `dll-${version}` }
  ])
}

function createPublisher(events: PublishedEvent[]): {
  publishHostToMain(type: string, payload: unknown): { success: true; delivered: number }
} {
  return {
    publishHostToMain(type, payload) {
      events.push({ type, payload: payload as Record<string, unknown> })
      return { success: true, delivered: 1 }
    }
  }
}

function response(body: Buffer, status = 200): Response {
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return new Response(bytes, {
    status,
    headers: { 'content-length': String(body.length) }
  })
}

function installParams(archive: Buffer, version: string) {
  return {
    pluginId: 'plugin.test',
    url: 'https://cdn.example/plugin.zip',
    version,
    checksum: sha256(archive),
    fileSize: archive.length
  }
}

for (const failure of ['none', 'hash', 'host-hash', 'machine', 'unknown-machine', 'classification', 'data-pe', 'missing', 'zero', 'truncated', 'offset', 'symlink', 'extra-lib'] as const) {
  test(`Windows payload ZIP integrity and old-install preservation: ${failure}`, async context => {
    const root = runtimeRoot('payload-zip-' + failure), events: PublishedEvent[] = []
    let archive = pluginZip('1.0.0', [], { targets: [{ id: 'win-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }], nativeComponents: [] })
    const service = new PluginInstallService(root, createPublisher(events), {
      runtimeTarget: windowsX64Electron, fetchImpl: (async () => response(archive)) as typeof fetch
    })
    context.after(async () => { await service.stop() })
    await service.startInstall(installParams(archive, '1.0.0'), false); await service.waitForIdle()
    const installed = path.join(root, 'Plugins', 'plugin.test')
    const before = await pluginTreeSnapshot(installed)
    archive = payloadPackage('2.0.0', (files, manifest) => {
      const helper = files.find(file => file.name === 'lib/helper.exe')!
      const model = files.find(file => file.name === 'lib/model.bin')!
      if (failure === 'hash') model.data = 'changed model'
      else if (failure === 'host-hash') manifest.nativeComponents[0].sha256 = 'f'.repeat(64)
      else if (failure === 'machine') manifest.nativeComponents[0].payloadFiles[0].arch = 'ia32'
      else if (failure === 'unknown-machine') (helper.data as Buffer).writeUInt16LE(0x1234, 68)
      else if (failure === 'classification') helper.data = fixturePe('x64', true)
      else if (failure === 'data-pe') model.data = fixturePe('ia32', false)
      else if (failure === 'missing') files.splice(files.indexOf(model), 1)
      else if (failure === 'zero') model.data = Buffer.alloc(0)
      else if (failure === 'truncated') helper.data = Buffer.from('MZ')
      else if (failure === 'offset') (helper.data as Buffer).writeUInt32LE(0xffff_fff0, 0x3c)
      else if (failure === 'symlink') { helper.mode = 0o120777; helper.data = 'host.dll' }
      else if (failure === 'extra-lib') files.push({ name: 'lib/hidden.exe', data: fixturePe('x64', false) })
    })
    await service.startInstall(installParams(archive, '2.0.0'), true); await service.waitForIdle()
    assert.equal(events.at(-1)?.payload.success, failure === 'none')
    if (failure !== 'none') assert.deepEqual(await pluginTreeSnapshot(installed), before)
    else {
      assert.equal(await fs.readFile(path.join(installed, 'lib/model.bin'), 'utf8'), 'model fixture')
      assert.equal(sha256(await fs.readFile(path.join(installed, 'lib/helper.exe'))), sha256(fixturePe('x64', false)))
      let called = false
      await service.withPluginManifest('plugin.test', async () => { called = true })
      assert.equal(called, true, 'payload admission does not require a worker or NativeHost execution port')
    }
  })
}

test('Windows source-object verifier checks links, bounded reads, cancellation and FD release', async context => {
  const root = runtimeRoot('payload-source-objects')
  await fs.mkdir(path.join(root, 'lib', 'real'), { recursive: true })
  const source = path.join(root, 'lib', 'real', 'model.bin'), bytes = Buffer.alloc(256 * 1024, 1)
  await fs.writeFile(source, bytes)
  const originalOpen = fs.open
  let activeHandles = 0
  fs.open = async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args), originalClose = handle.close.bind(handle)
    activeHandles++
    handle.close = async () => { try { await originalClose() } finally { activeHandles-- } }
    return handle
  }
  context.after(() => { fs.open = originalOpen })
  const file = { entry: 'lib/real/model.bin', format: 'data' as const, sha256: sha256(bytes) }
  await verifyWindowsPluginNativeFiles(root, [file], { maxBytes: bytes.length, checkActive: () => undefined })
  await assert.rejects(verifyWindowsPluginNativeFiles(root, [file], { maxBytes: bytes.length - 1, checkActive: () => undefined }),
    (error: any) => error?.code === errorCodes.pluginPackageInvalid)
  let checks = 0
  await assert.rejects(verifyWindowsPluginNativeFiles(root, [file], { maxBytes: bytes.length, checkActive: () => {
    if (++checks >= 4) throw new ZToolsError(errorCodes.callerDestroyed, 'cancelled fixture')
  } }), (error: any) => error?.code === errorCodes.callerDestroyed)
  assert.equal(activeHandles, 0, 'all verifier handles close on cancellation')
  await fs.rename(source, source + '.moved'); await fs.rename(source + '.moved', source)
  let stopChecks = 0
  await assert.rejects(verifyWindowsPluginNativeFiles(root, [file], { maxBytes: bytes.length, checkActive: () => {
    if (++stopChecks >= 4) throw new ZToolsError(errorCodes.appStopping, 'stopping fixture')
  } }), (error: any) => error?.code === errorCodes.appStopping)
  assert.equal(activeHandles, 0, 'all verifier handles close during application exit')
  await fs.rename(source, source + '.moved'); await fs.rename(source + '.moved', source)
  await fs.symlink(path.join(root, 'lib', 'real'), path.join(root, 'lib', 'linked'), 'junction')
  await assert.rejects(verifyWindowsPluginNativeFiles(root, [{ ...file, entry: 'lib/linked/model.bin' }],
    { maxBytes: bytes.length, checkActive: () => undefined }), (error: any) => error?.code === errorCodes.pluginPackageInvalid)
  assert.equal(await fs.readFile(source).then(value => sha256(value)), file.sha256)
  assert.equal(activeHandles, 0)
  context.diagnostic('Ordinary source directory file validation only; no source-directory install API or native execution.')
})

for (const tamper of ['file', 'extra-lib', 'version', 'payload-removal'] as const) {
test(`Windows payload staging ${tamper} after backup restores the old installation`, async context => {
  const root = runtimeRoot('payload-commit-tamper-' + tamper), events: PublishedEvent[] = []
  let archive = pluginZip('1.0.0', [], { targets: [{ id: 'win-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }], nativeComponents: [] })
  let tampered = false
  const service = new PluginInstallService(root, createPublisher(events), {
    runtimeTarget: windowsX64Electron, fetchImpl: (async () => response(archive)) as typeof fetch,
    async renameImpl(source, destination) {
      await fs.rename(source, destination)
      if (String(destination).includes('.plugin.test.backup-')) {
        const transactions = await fs.readdir(path.join(root, '.electron-installer'))
        const transaction = transactions.find(name => name.startsWith('plugin-plugin.test-'))!
        const staging = path.join(root, '.electron-installer', transaction, 'staging')
        if (tamper === 'file') await fs.writeFile(path.join(staging, 'lib', 'model.bin'), 'tampered after validation')
        else if (tamper === 'extra-lib') await fs.writeFile(path.join(staging, 'lib', 'hidden.exe'), fixturePe('x64', false))
        else {
          const changed = JSON.parse(await fs.readFile(path.join(staging, 'plugin.json'), 'utf8'))
          if (tamper === 'version') changed.version = '3.0.0'
          else delete changed.nativeComponents[0].payloadFiles
          await fs.writeFile(path.join(staging, 'plugin.json'), JSON.stringify(changed))
        }
        tampered = true
      }
    }
  })
  context.after(async () => { await service.stop() })
  await service.startInstall(installParams(archive, '1.0.0'), false); await service.waitForIdle()
  const installed = path.join(root, 'Plugins', 'plugin.test'), before = await pluginTreeSnapshot(installed)
  archive = payloadPackage('2.0.0')
  await service.startInstall(installParams(archive, '2.0.0'), true); await service.waitForIdle()
  assert.equal(tampered, true)
  assert.equal(events.at(-1)?.payload.success, false)
  assert.equal(events.at(-1)?.payload.errorCode, tamper === 'extra-lib' ? errorCodes.pluginPackageInvalid : errorCodes.pluginIntegrity)
  assert.deepEqual(await pluginTreeSnapshot(installed), before)
})
}

test('Windows payload runtime admission does not rehash model contents on each manifest lookup', async context => {
  const root = runtimeRoot('payload-runtime-lightweight'), events: PublishedEvent[] = [], archive = payloadPackage('1.0.0')
  const service = new PluginInstallService(root, createPublisher(events), {
    runtimeTarget: windowsX64Electron, fetchImpl: (async () => response(archive)) as typeof fetch
  })
  context.after(async () => { await service.stop() })
  await service.startInstall(installParams(archive, '1.0.0'), false); await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, true)
  await fs.writeFile(path.join(root, 'Plugins', 'plugin.test', 'lib', 'model.bin'), 'mutable model contents')
  await service.withPluginManifest('plugin.test', async () => undefined)
  context.diagnostic('Runtime lookup checks ordinary paths/limits only. Install hashes prove admission-time bytes, not OS object signing or runtime trust.')
})

test('installs a verified plugin and verified shared library', async (context) => {
  const root = runtimeRoot('plugin-install')
  const events: PublishedEvent[] = []
  const library = createZip([{ name: 'bin/tool.exe', data: 'library-binary' }])
  const plugin = pluginZip('1.2.3', ['toolkit-1.0.0'])
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://cdn.example/plugin.zip') return response(plugin)
    if (url === 'https://cdn.example/library.zip') return response(library)
    if (url === 'https://api.example/api/commonlibs/toolkit-1.0.0') {
      return Response.json({
        success: true,
        data: {
          libId: 'toolkit-1.0.0',
          downloadUrl: 'https://cdn.example/library.zip',
          fileSize: library.length,
          checksum: sha256(library)
        }
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl,
    apiBase: 'https://api.example/',
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const started = await service.startInstall(installParams(plugin, '1.2.3'), false)
  assert.equal(started.success, true)
  assert.equal(started.isUpdate, false)
  await service.waitForIdle()

  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>1.2.3</html>')
  assert.equal(await fs.readFile(path.join(root, 'Libraries', 'toolkit-1.0.0', 'bin', 'tool.exe'), 'utf8'), 'library-binary')
  const marker = JSON.parse(await fs.readFile(
    path.join(root, 'Libraries', 'toolkit-1.0.0', '.ztools-library.json'),
    'utf8'
  )) as Record<string, unknown>
  assert.deepEqual(marker, { version: 1, libId: 'toolkit-1.0.0', checksum: sha256(library) })
  const list = await service.list()
  assert.equal(list.data[0]?.pluginId, 'plugin.test')
  let legacyWindowsLane: number | undefined
  const loadedManifest = await service.withPluginManifest('plugin.test', async (value, runtimeMetadata) => {
    legacyWindowsLane = runtimeMetadata?.sdkApiLane
    return value
  })
  assert.equal(loadedManifest.entry, 'index.html')
  assert.equal(legacyWindowsLane, 1, 'a targetless legacy Windows package remains on SDK lane 1')
  assert.ok(events.some((event) => event.type === 'plugin_download_progress' && event.payload.phase === 'library'))
  assert.ok(events.some((event) => event.type === 'plugin_install_complete' && event.payload.success === true))
})

test('updates a shared library only after its checksum is verified', async (context) => {
  const root = runtimeRoot('library-update-verified-checksum')
  let plugin = pluginZip('1.0.0', ['toolkit-1.0.0'])
  let library = createZip([{ name: 'bin/tool.exe', data: 'library-v1' }])
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === 'https://cdn.example/plugin.zip') return response(plugin)
    if (url === 'https://cdn.example/library.zip') return response(library)
    if (url === 'https://api.example/api/commonlibs/toolkit-1.0.0') {
      return Response.json({
        success: true,
        data: {
          libId: 'toolkit-1.0.0',
          downloadUrl: 'https://cdn.example/library.zip',
          fileSize: library.length,
          checksum: sha256(library)
        }
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const service = new PluginInstallService(root, createPublisher([]), {
    fetchImpl,
    apiBase: 'https://api.example/',
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(plugin, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(await fs.readFile(path.join(root, 'Libraries', 'toolkit-1.0.0', 'bin', 'tool.exe'), 'utf8'), 'library-v1')

  plugin = pluginZip('2.0.0', ['toolkit-1.0.0'])
  library = createZip([{ name: 'bin/tool.exe', data: 'library-version-two' }])
  await service.startInstall(installParams(plugin, '2.0.0'), true)
  await service.waitForIdle()

  assert.equal(
    await fs.readFile(path.join(root, 'Libraries', 'toolkit-1.0.0', 'bin', 'tool.exe'), 'utf8'),
    'library-version-two'
  )
})

test('keeps the CommonPlugins runtime directory outside plugin management', async (context) => {
  const root = runtimeRoot('common-plugins-reserved')
  const service = new PluginInstallService(root, createPublisher([]), {
    fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.list()
  await fs.mkdir(path.join(root, 'Plugins', 'CommonPlugins'), { recursive: true })
  assert.equal((await service.list()).data.some((item) => item.pluginId === 'CommonPlugins'), false)

  await assert.rejects(
    service.startInstall({
      pluginId: 'CommonPlugins',
      url: 'https://cdn.example/plugin.zip',
      version: '1.0.0',
      checksum: '0'.repeat(64),
      fileSize: 0
    }, false),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    service.uninstall({ pluginId: 'commonplugins' }),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
})

test('preserves the previous plugin tree outside the code root during update', async (context) => {
  const root = runtimeRoot('plugin-data-preserve')
  const initial = pluginZip('1.0.0')
  const update = pluginZip('2.0.0')
  let body = initial
  const initialService = new PluginInstallService(root, createPublisher([]), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  await initialService.startInstall(installParams(initial, '1.0.0'), false)
  await initialService.waitForIdle()
  await fs.writeFile(path.join(root, 'Plugins', 'plugin.test', 'user-data.json'), '{"keep":true}')
  await initialService.stop()

  const events: PublishedEvent[] = []
  body = update
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(update, '2.0.0'), true)
  await service.waitForIdle()

  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>2.0.0</html>')
  const legacyRoot = path.join(root, 'PluginData', 'plugin.test', 'legacy')
  const preserved = await fs.readdir(legacyRoot)
  assert.equal(preserved.length, 1)
  assert.equal(
    await fs.readFile(path.join(legacyRoot, preserved[0] as string, 'user-data.json'), 'utf8'),
    '{"keep":true}'
  )
  assert.ok(events.some((event) => event.type === 'plugin_data_preserved' && event.payload.reason === 'update'))
})

test('installs and updates a legacy Windows DLL package after verifying its archive digest', async (context) => {
  const root = runtimeRoot('legacy-native-update')
  let body = nativePluginZip('1.0.0')
  const service = new PluginInstallService(root, createPublisher([]), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  await service.startInstall(installParams(body, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'lib', 'TestPlugin.dll'), 'utf8'), 'dll-1.0.0')
  body = nativePluginZip('2.0.0')
  await service.startInstall(installParams(body, '2.0.0'), true)
  await service.waitForIdle()
  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'lib', 'TestPlugin.dll'), 'utf8'), 'dll-2.0.0')
})

test('exposes invalid installed manifests with a concrete list error', async (context) => {
  const root = runtimeRoot('plugin-invalid-list')
  const invalidRoot = path.join(root, 'Plugins', 'broken-plugin')
  await fs.mkdir(invalidRoot, { recursive: true })
  await fs.writeFile(path.join(invalidRoot, 'plugin.json'), '{"id":"broken-plugin"}')
  const events: PublishedEvent[] = []
  const service = new PluginInstallService(root, createPublisher(events))
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const result = await service.list()
  const invalid = result.data.find((item) => item.pluginId === 'broken-plugin')
  assert.equal(invalid?.available, false)
  assert.equal(invalid?.errorCode, 'PLUGIN_PACKAGE_INVALID')
  assert.equal(events.at(-1)?.type, 'plugin_manifest_invalid')
  assert.equal(events.at(-1)?.payload.pluginId, 'broken-plugin')
})

test('rejects checksum mismatch and zip-slip without touching the plugin root', async (context) => {
  const root = runtimeRoot('plugin-reject')
  const events: PublishedEvent[] = []
  const valid = pluginZip('1.0.0')
  const traversal = createZip([
    { name: '../outside.txt', data: 'escape' },
    { name: 'plugin.json', data: '{}' }
  ])
  let body = valid
  let fetchCalls = 0
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => {
      fetchCalls += 1
      return response(body)
    }) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const missingChecksum = installParams(valid, '1.0.0')
  delete (missingChecksum as { checksum?: string }).checksum
  await assert.rejects(
    service.startInstall(missingChecksum, false),
    (error) => error instanceof ZToolsError && error.code === errorCodes.pluginIntegrity
  )
  assert.equal(fetchCalls, 0, 'a missing digest is rejected before any archive request')

  await service.startInstall({ ...installParams(valid, '1.0.0'), checksum: 'f'.repeat(64) }, false)
  await service.waitForIdle()
  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, 'PLUGIN_INTEGRITY_ERROR')

  body = traversal
  await service.startInstall(installParams(traversal, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(await fs.access(path.join(root, 'outside.txt')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, 'PLUGIN_PACKAGE_INVALID')
})

test('rolls back the previous plugin when the atomic replacement fails', async (context) => {
  const root = runtimeRoot('plugin-rollback')
  const initial = pluginZip('1.0.0')
  const update = pluginZip('2.0.0')
  let body = initial
  const initialService = new PluginInstallService(root, createPublisher([]), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  await initialService.startInstall(installParams(initial, '1.0.0'), false)
  await initialService.waitForIdle()
  await initialService.stop()

  const events: PublishedEvent[] = []
  body = update
  const renameImpl: typeof fs.rename = async (source, destination) => {
    const sourcePath = String(source)
    const destinationPath = String(destination)
    if (sourcePath.endsWith(`${path.sep}staging`) && destinationPath.endsWith(`${path.sep}Plugins${path.sep}plugin.test`)) {
      throw Object.assign(new Error('injected rename failure'), { code: 'EACCES' })
    }
    await fs.rename(source, destination)
  }
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    renameImpl,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(update, '2.0.0'), true)
  await service.waitForIdle()

  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>1.0.0</html>')
  assert.equal(events.at(-1)?.payload.success, false)
})

test('uninstalls atomically and recovers an interrupted backup on startup', async (context) => {
  const root = runtimeRoot('plugin-recovery')
  const pluginRoot = path.join(root, 'Plugins')
  const workRoot = path.join(root, '.electron-installer')
  const transactionId = '11111111-1111-4111-8111-111111111111'
  const backupName = `.plugin.test.backup-${transactionId}`
  const transaction = path.join(workRoot, `plugin-plugin.test-${transactionId}`)
  await fs.mkdir(path.join(pluginRoot, backupName), { recursive: true })
  await fs.writeFile(path.join(pluginRoot, backupName, 'plugin.json'), JSON.stringify({
    id: 'plugin.test',
    name: '恢复插件',
    version: '1.0.0',
    entry: 'index.html'
  }))
  await fs.writeFile(path.join(pluginRoot, backupName, 'index.html'), 'recovered')
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'plugin.test': { enabled: false, use_count: 3 }
  }))
  await fs.mkdir(transaction, { recursive: true })
  await fs.writeFile(path.join(transaction, 'journal.json'), JSON.stringify({
    version: 1,
    kind: 'plugin',
    id: 'plugin.test',
    backupName
  }))
  const events: PublishedEvent[] = []
  const service = new PluginInstallService(root, createPublisher(events), { runtimeTarget: windowsIa32Electron })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const list = await service.list()
  assert.equal(list.data.length, 1)
  assert.equal(await fs.readFile(path.join(pluginRoot, 'plugin.test', 'index.html'), 'utf8'), 'recovered')
  await service.uninstall({ pluginId: 'plugin.test' })
  assert.equal(await fs.access(path.join(pluginRoot, 'plugin.test')).then(() => true, () => false), false)
  const preserved = await fs.readdir(path.join(root, 'PluginData', 'plugin.test', 'legacy'))
  assert.equal(preserved.length, 1)
  assert.equal(
    await fs.readFile(path.join(root, 'PluginData', 'plugin.test', 'legacy', preserved[0] as string, 'index.html'), 'utf8'),
    'recovered'
  )
  const pluginState = JSON.parse(
    (await fs.readFile(path.join(root, 'plugin_state.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as Record<string, unknown>
  assert.deepEqual(pluginState, {})
  assert.equal(events.at(-1)?.type, 'plugin_uninstalled')
})

test('manifest readers overlap while maintenance waits for every reader to finish', { timeout: 10_000 }, async (context) => {
  const root = runtimeRoot('plugin-readers')
  const archive = nativePluginZip('1.0.0')
  const service = new PluginInstallService(root, createPublisher([]), {
    fetchImpl: (async () => response(archive)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()

  let enterFirst!: () => void
  const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let releaseSecond!: () => void
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
  const busy = (error: unknown): boolean =>
    error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  const first = service.withPluginManifest('plugin.test', async (manifest) => {
    enterFirst()
    await firstGate
    return manifest.dllloader
  })
  try {
    await firstEntered
    // A window can still be starting while the plugin resolves its DLL.
    assert.equal(await service.withPluginManifest('plugin.test', async (manifest) => manifest.dllloader), 'lib/TestPlugin.dll')
    let enterSecond!: () => void
    const secondEntered = new Promise<void>((resolve) => { enterSecond = resolve })
    const second = service.withPluginManifest('plugin.test', async () => {
      enterSecond()
      await secondGate
    })
    try {
      await secondEntered
      releaseFirst()
      await first
      await assert.rejects(service.uninstall({ pluginId: 'PLUGIN.TEST' }), busy)
      await assert.rejects(service.startInstall(installParams(archive, '1.0.0'), true), busy)
      await assert.rejects(service.withPluginDirectory('plugin.test', async () => undefined), busy)
      await assert.rejects(service.restorePreservedData('plugin.test', 'snapshot', []), busy)
    } finally {
      releaseSecond()
      await second
    }
    // Callback failures must also release their shared access.
    const failure = new Error('reader failed')
    await assert.rejects(service.withPluginManifest('plugin.test', async () => { throw failure }), failure)
    await service.uninstall({ pluginId: 'plugin.test' })
  } finally {
    releaseFirst()
    releaseSecond()
    await first
  }
})

test('stop aborts an active download and waits for the operation to settle', async (context) => {
  const root = runtimeRoot('plugin-stop')
  const events: PublishedEvent[] = []
  let downloadStarted!: () => void
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve
  })
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    downloadStarted()
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  }) as typeof fetch
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  const archive = pluginZip('1.0.0')
  const first = service.startInstall(installParams(archive, '1.0.0'), false)
  await assert.rejects(
    service.startInstall(installParams(archive, '1.0.0'), false),
    (error: any) => error?.code === 'PLUGIN_BUSY'
  )
  await first
  await started
  await assert.rejects(
    service.withPluginManifest('plugin.test', async () => undefined),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.pluginBusy
  )
  await service.stop()

  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, 'APP_STOPPING')
})

test('rejects targetless macOS installs instead of inferring compatibility', async (context) => {
  const root = runtimeRoot('plugin-macos-targetless')
  const events: PublishedEvent[] = []
  const archive = pluginZip('1.0.0')
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(archive)) as typeof fetch,
    runtimeTarget: macArm64Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()

  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(events.at(-1)?.payload.error), /未声明 targets/)
})

test('enforces the host SDK contract version before install and plugin open', async (context) => {
  const root = runtimeRoot('plugin-min-sdk-contract-version')
  const events: PublishedEvent[] = []
  const requiresV2 = pluginZip('2.0.0', [], {
    targets: [{
      id: 'mac-universal',
      platform: 'macos',
      runtime: 'electron',
      arch: 'universal',
      minSdkContractVersion: 2
    }],
    nativeComponents: []
  })
  const compatibleV1 = pluginZip('1.0.0', [], {
    targets: [{
      id: 'mac-universal',
      platform: 'macos',
      runtime: 'electron',
      arch: 'universal',
      minSdkContractVersion: 1
    }],
    nativeComponents: []
  })
  let body = requiresV2
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: macArm64Electron,
    hostMaximumSdkContractVersion: 1
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(requiresV2, '2.0.0'), false)
  await service.waitForIdle()
  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(events.at(-1)?.payload.error), /要求 SDK 契约版本 2/)

  body = compatibleV1
  await service.startInstall(installParams(compatibleV1, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, true)
  let selectedMacV1Lane: number | undefined
  await service.withPluginManifest('plugin.test', async (_manifest, runtimeMetadata) => {
    selectedMacV1Lane = runtimeMetadata?.sdkApiLane
  })
  assert.equal(selectedMacV1Lane, 1, 'an explicit minSdkContractVersion 1 target selects lane 1')

  const manifestPath = path.join(root, 'Plugins', 'plugin.test', 'plugin.json')
  const installedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    targets: Array<Record<string, unknown>>
  }
  const installedTarget = installedManifest.targets[0]
  assert.ok(installedTarget)
  installedTarget.minSdkContractVersion = 2
  await fs.writeFile(manifestPath, JSON.stringify(installedManifest))

  let openActionCalled = false
  await assert.rejects(
    service.withPluginManifest('plugin.test', async (manifest) => {
      openActionCalled = true
      return manifest
    }),
    (error: any) => error?.code === errorCodes.notSupported && /要求 SDK 契约版本 2/.test(error.message)
  )
  assert.equal(openActionCalled, false, 'an incompatible manifest must be rejected before the open action')
})

test('rejects an incompatible update before switching the installed plugin directory', async (context) => {
  const root = runtimeRoot('plugin-macos-update-reject')
  const events: PublishedEvent[] = []
  const compatible = pluginZip('1.0.0', [], {
    targets: [{ id: 'mac-universal', platform: 'macos', runtime: 'electron', arch: 'universal' }],
    nativeComponents: []
  })
  const windowsOnly = pluginZip('2.0.0', [], {
    targets: [{ id: 'windows-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }],
    nativeComponents: []
  })
  let body = compatible
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: macArm64Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(compatible, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>1.0.0</html>')

  body = windowsOnly
  await service.startInstall(installParams(windowsOnly, '2.0.0'), true)
  await service.waitForIdle()

  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>1.0.0</html>')
  const installedManifest = JSON.parse(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'plugin.json'), 'utf8'))
  assert.equal(installedManifest.version, '1.0.0')
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(events.at(-1)?.payload.error), /未声明适用于 macos Electron arm64/)
})

test('rejects a Windows SDK v2 update and preserves the complete installed SDK v1 tree', async (context) => {
  const root = runtimeRoot('plugin-windows-sdk2-update-reject')
  const events: PublishedEvent[] = []
  const target = (minSdkContractVersion: number) => [{ id: 'windows-electron-x64', platform: 'windows',
    runtime: 'electron', arch: 'x64', minSdkContractVersion }]
  const compatible = createZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'plugin.test', name: '测试插件', version: '1.0.0',
      entry: 'index.html', targets: target(1), nativeComponents: [] }) },
    { name: 'index.html', data: '<html>1.0.0</html>' },
    { name: 'assets/marker.txt', data: 'installed-sdk-v1-tree' }
  ])
  const incompatible = createZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'plugin.test', name: '测试插件', version: '1.0.1',
      entry: 'index.html', targets: target(2), nativeComponents: [] }) },
    { name: 'index.html', data: '<html>1.0.1</html>' },
    { name: 'assets/marker.txt', data: 'rejected-sdk-v2-tree' }
  ])
  let body = compatible
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsX64Electron,
    hostMaximumSdkContractVersion: 1
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const install = await service.startInstall(installParams(compatible, '1.0.0'), false)
  assert.equal(install.success, true)
  assert.equal(install.isUpdate, false)
  await service.waitForIdle()
  assert.equal(events.at(-1)?.payload.success, true)

  const pluginDirectory = path.join(root, 'Plugins', 'plugin.test')
  const before = await pluginTreeSnapshot(pluginDirectory)
  assert.equal(JSON.parse(await fs.readFile(path.join(pluginDirectory, 'plugin.json'), 'utf8')).version, '1.0.0')

  body = incompatible
  const accepted = await service.startInstall(installParams(incompatible, '1.0.1'), true)
  assert.equal(accepted.success, true)
  assert.equal(accepted.isUpdate, true)
  assert.match(accepted.operationId, /^[0-9a-f-]{36}$/i)
  await service.waitForIdle()

  const terminal = events.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === accepted.operationId)
  assert.equal(terminal?.payload.success, false)
  assert.equal(terminal?.payload.isUpdate, true)
  assert.equal(terminal?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(terminal?.payload.error), /要求 SDK 契约版本 2，当前宿主版本为 1/)
  assert.equal('version' in (terminal?.payload ?? {}), false, 'failed terminal events do not expose a version')

  const after = await pluginTreeSnapshot(pluginDirectory)
  assert.deepEqual(after, before)
  assert.equal(JSON.parse(await fs.readFile(path.join(pluginDirectory, 'plugin.json'), 'utf8')).version, '1.0.0')
  assert.equal(await fs.readFile(path.join(pluginDirectory, 'index.html'), 'utf8'), '<html>1.0.0</html>')
  assert.equal(await fs.readFile(path.join(pluginDirectory, 'assets', 'marker.txt'), 'utf8'), 'installed-sdk-v1-tree')
})

test('requires an attached reference runtime for SDK v2 admission while SDK v1 remains usable', async (context) => {
  const root = runtimeRoot('plugin-windows-sdk2-runtime-gate')
  const events: PublishedEvent[] = []
  const target = (minSdkContractVersion: number) => [{ id: 'windows-electron-x64', platform: 'windows',
    runtime: 'electron', arch: 'x64', minSdkContractVersion }]
  const compatible = pluginZip('1.0.0', [], { targets: target(1), nativeComponents: [] })
  const sdk2 = pluginZip('1.0.1', [], { targets: target(2), nativeComponents: [] })
  let body = compatible
  let runtimeReady = false
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(body)) as typeof fetch,
    runtimeTarget: windowsX64Electron,
    referenceRuntimeReady: () => runtimeReady
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const installedV1 = await service.startInstall(installParams(compatible, '1.0.0'), false)
  assert.equal(installedV1.success, true)
  await service.waitForIdle()
  assert.equal(events.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === installedV1.operationId)?.payload.success, true)
  const openedV1 = await service.withPluginManifest('plugin.test', async (_manifest, metadata) => metadata?.sdkApiLane)
  assert.equal(openedV1, 1, 'SDK v1 remains available while the reference runtime is unavailable')

  const pluginDirectory = path.join(root, 'Plugins', 'plugin.test')
  const beforeRejectedUpdate = await pluginTreeSnapshot(pluginDirectory)
  body = sdk2
  const rejectedUpdate = await service.startInstall(installParams(sdk2, '1.0.1'), true)
  assert.equal(rejectedUpdate.success, true)
  assert.equal(rejectedUpdate.isUpdate, true)
  await service.waitForIdle()
  const rejectedTerminal = events.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === rejectedUpdate.operationId)
  assert.equal(rejectedTerminal?.payload.success, false)
  assert.equal(rejectedTerminal?.payload.isUpdate, true)
  assert.equal(rejectedTerminal?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(rejectedTerminal?.payload.error), /引用文件运行时已就绪/)
  assert.deepEqual(await pluginTreeSnapshot(pluginDirectory), beforeRejectedUpdate,
    'an unavailable runtime must leave the complete installed SDK v1 tree unchanged')

  runtimeReady = true
  const acceptedUpdate = await service.startInstall(installParams(sdk2, '1.0.1'), true)
  assert.equal(acceptedUpdate.success, true)
  await service.waitForIdle()
  assert.equal(events.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === acceptedUpdate.operationId)?.payload.success, true)
  const openedV2 = await service.withPluginManifest('plugin.test', async (_manifest, metadata) => metadata?.sdkApiLane)
  assert.equal(openedV2, 2)

  runtimeReady = false
  await assert.rejects(
    service.withPluginManifest('plugin.test', async () => undefined),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported &&
      /引用文件运行时已就绪/.test(error.message),
    'an installed SDK v2 package must not open after the Main readiness provider turns false'
  )
})

test('defaults SDK v2 runtime readiness to false for install and open admission', async (context) => {
  const root = runtimeRoot('plugin-windows-sdk2-readiness-default')
  const target = [{ id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64',
    minSdkContractVersion: 2 }]
  const sdk2 = pluginZip('1.0.0', [], { targets: target, nativeComponents: [] })
  const failedEvents: PublishedEvent[] = []
  const unavailableService = new PluginInstallService(root, createPublisher(failedEvents), {
    fetchImpl: (async () => response(sdk2)) as typeof fetch,
    runtimeTarget: windowsX64Electron,
    hostMaximumSdkContractVersion: 2
  })
  let readyService: PluginInstallService | undefined
  let reopenService: PluginInstallService | undefined
  context.after(async () => {
    await unavailableService.stop()
    await readyService?.stop()
    await reopenService?.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  const rejectedInstall = await unavailableService.startInstall(installParams(sdk2, '1.0.0'), false)
  assert.equal(rejectedInstall.success, true)
  await unavailableService.waitForIdle()
  const rejectedTerminal = failedEvents.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === rejectedInstall.operationId)
  assert.equal(rejectedTerminal?.payload.success, false)
  assert.equal(rejectedTerminal?.payload.errorCode, errorCodes.notSupported)
  assert.match(String(rejectedTerminal?.payload.error), /引用文件运行时已就绪/)
  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)

  await unavailableService.stop()
  const readyEvents: PublishedEvent[] = []
  readyService = new PluginInstallService(root, createPublisher(readyEvents), {
    fetchImpl: (async () => response(sdk2)) as typeof fetch,
    runtimeTarget: windowsX64Electron,
    hostMaximumSdkContractVersion: 2,
    referenceRuntimeReady: () => true
  })
  const installed = await readyService.startInstall(installParams(sdk2, '1.0.0'), false)
  assert.equal(installed.success, true)
  await readyService.waitForIdle()
  assert.equal(readyEvents.find(event => event.type === 'plugin_install_complete' &&
    event.payload.operationId === installed.operationId)?.payload.success, true)
  const pluginDirectory = path.join(root, 'Plugins', 'plugin.test')
  const installedTree = await pluginTreeSnapshot(pluginDirectory)
  await readyService.stop()

  reopenService = new PluginInstallService(root, createPublisher([]), {
    runtimeTarget: windowsX64Electron,
    hostMaximumSdkContractVersion: 2
  })
  await assert.rejects(
    reopenService.withPluginManifest('plugin.test', async () => undefined),
    (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported &&
      /引用文件运行时已就绪/.test(error.message),
    'omitting the Main readiness provider must fail closed for an installed SDK v2 package'
  )
  assert.deepEqual(await pluginTreeSnapshot(pluginDirectory), installedTree,
    'refusing to open must not mutate the installed package')
})

test('installs a macOS JavaScript target while leaving Windows DLL components unselected', async (context) => {
  const root = runtimeRoot('plugin-macos-multitarget')
  const events: PublishedEvent[] = []
  const archive = pluginZip('1.0.0', [], {
    targets: [
      { id: 'mac-js', platform: 'macos', runtime: 'electron', arch: 'any' },
      {
        id: 'windows-ia32',
        platform: 'windows',
        runtime: 'electron',
        arch: 'ia32',
        minSdkContractVersion: 2
      }
    ],
    nativeComponents: [
      {
        id: 'windows-dll',
        kind: 'dll',
        targetId: 'windows-ia32',
        arch: 'ia32',
        abi: 'ztools-native-host/v1',
        entry: 'lib/windows-plugin.dll',
        protocolVersion: 1
      }
    ]
  })
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(archive)) as typeof fetch,
    runtimeTarget: macArm64Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()

  assert.equal(events.at(-1)?.payload.success, true)
  let selectedMacLane: number | undefined
  const openedManifest = await service.withPluginManifest('plugin.test', async (value, runtimeMetadata) => {
    selectedMacLane = runtimeMetadata?.sdkApiLane
    return value
  })
  assert.equal(openedManifest.targets instanceof Array, true)
  assert.equal(selectedMacLane, 1, 'the Windows v2 target does not change the selected Mac target lane')
  assert.deepEqual(openedManifest.nativeComponents, [
    {
      id: 'windows-dll',
      kind: 'dll',
      targetId: 'windows-ia32',
      arch: 'ia32',
      abi: 'ztools-native-host/v1',
      entry: 'lib/windows-plugin.dll',
      protocolVersion: 1
    }
  ])
})

test('rejects a selected native component with no real file before install commit', async (context) => {
  const root = runtimeRoot('plugin-windows-missing-component')
  const events: PublishedEvent[] = []
  const archive = pluginZip('1.0.0', [], {
    targets: [{ id: 'windows-ia32', platform: 'windows', runtime: 'electron', arch: 'ia32' }],
    nativeComponents: [{
      id: 'windows-worker',
      kind: 'worker',
      targetId: 'windows-ia32',
      arch: 'ia32',
      abi: 'node-api/v1',
      entry: 'native/missing-worker'
    }]
  })
  const service = new PluginInstallService(root, createPublisher(events), {
    fetchImpl: (async () => response(archive)) as typeof fetch,
    runtimeTarget: windowsIa32Electron
  })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()

  assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
  assert.equal(events.at(-1)?.payload.errorCode, errorCodes.pluginPackageInvalid)
  assert.match(String(events.at(-1)?.payload.error), /native component 文件不存在/)
})

test('withPluginManifest rejects a pre-existing targetless directory on macOS', async (context) => {
  const root = runtimeRoot('plugin-macos-legacy-directory')
  const pluginRoot = path.join(root, 'Plugins', 'plugin.test')
  await fs.mkdir(pluginRoot, { recursive: true })
  await fs.writeFile(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'plugin.test',
    name: '旧版插件',
    version: '1.0.0',
    entry: 'index.html'
  }))
  await fs.writeFile(path.join(pluginRoot, 'index.html'), '<html>legacy</html>')
  const service = new PluginInstallService(root, createPublisher([]), { runtimeTarget: macArm64Electron })
  context.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  let actionCalled = false
  await assert.rejects(
    service.withPluginManifest('plugin.test', async () => {
      actionCalled = true
    }),
    (error: any) => error?.code === errorCodes.notSupported && /未声明 targets/.test(error.message)
  )
  assert.equal(actionCalled, false)
})

for (const outcome of ['success', 'unload-rejected', 'replacement-failed'] as const) {
  test('native update maintenance lease: ' + outcome, async (context) => {
    const root = runtimeRoot('native-maintenance-' + outcome)
    const events: PublishedEvent[] = [], sequence: string[] = []
    const targetFields = { targets: [{ id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }], nativeComponents: [] }
    const first = pluginZip('1.0.0', [], targetFields), second = pluginZip('2.0.0', [], targetFields)
    let body = first, locked = false, replacements = 0
    const service = new PluginInstallService(root, createPublisher(events), {
      runtimeTarget: { platform: 'win32', runtime: 'electron', arch: 'x64' },
      fetchImpl: (async () => response(body)) as typeof fetch,
      async preparePluginReplace(manifest) {
        assert.equal(manifest.id, 'plugin.test')
        assert.equal(manifest.version, '1.0.0')
        sequence.push('prepare')
        if (outcome === 'unload-rejected') throw new Error('DLL_BUSY')
        locked = true
        return () => { assert.equal(locked, true); locked = false; sequence.push('release') }
      },
      async renameImpl(source, destination) {
        assert.equal(locked, true)
        sequence.push('rename')
        replacements++
        if (outcome === 'replacement-failed' && String(source).endsWith(path.sep + 'staging')) {
          throw Object.assign(new Error('injected replacement failure'), { code: 'EACCES' })
        }
        await fs.rename(source, destination)
      }
    })
    context.after(async () => { await service.stop() }) // Retain controlled evidence; no test cleanup.
    await service.list() // Await initialization before creating a second service on this test root.
    // The fresh installation has no native replacement lease or old-directory rename.
    const firstService = new PluginInstallService(root, createPublisher([]), {
      runtimeTarget: { platform: 'win32', runtime: 'electron', arch: 'x64' },
      fetchImpl: (async () => response(first)) as typeof fetch
    })
    await firstService.startInstall(installParams(first, '1.0.0'), false)
    await firstService.waitForIdle(); await firstService.stop()
    body = second
    await service.startInstall(installParams(second, '2.0.0'), true)
    await service.waitForIdle()
    assert.equal(locked, false)
    assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), outcome === 'success' ? '<html>2.0.0</html>' : '<html>1.0.0</html>')
    assert.equal(events.at(-1)?.payload.success, outcome === 'success')
    if (outcome === 'unload-rejected') { assert.equal(replacements, 0); assert.deepEqual(sequence, ['prepare']) }
    else { assert.equal(sequence[0], 'prepare'); assert.equal(sequence.at(-1), 'release'); assert.equal(sequence.filter(item => item === 'release').length, 1) }
  })
}

for (const approved of [true, false]) {
  test('Mac native catalog checks actual extracted SHA and every manifest use: ' + approved, async (context) => {
    const root = runtimeRoot('mac-native-catalog-' + approved), events: PublishedEvent[] = []
    const bytes = Buffer.from('synthetic native fixture; no Darwin execution')
    const component = { id: 'native-test', targetId: 'mac-universal', kind: 'shared-library', arch: 'universal',
      abi: 'ztools-mac-native/v1', protocolVersion: 1, entry: 'lib/native-test.dylib' }
    const manifest = { id: 'plugin.test', name: 'test', version: '1.0.0', entry: 'index.html',
      targets: [{ id: 'mac-universal', platform: 'macos', runtime: 'electron', arch: 'universal' }], nativeComponents: [component] }
    const zip = createZip([{ name: 'plugin.json', data: JSON.stringify(manifest) },
      { name: 'index.html', data: '<html>test</html>' }, { name: component.entry, data: bytes }])
    let ready = true
    const service = new PluginInstallService(root, createPublisher(events), {
      runtimeTarget: macArm64Electron, fetchImpl: (async () => response(zip)) as typeof fetch,
      macNativeCatalogLookup(pluginId, componentId) {
        return ready && pluginId === 'plugin.test' && componentId === component.id
          ? { relativePath: component.entry, sha256: approved ? sha256(bytes) : 'f'.repeat(64) } : undefined
      }
    })
    context.after(async () => { await service.stop() })
    await service.startInstall(installParams(zip, '1.0.0'), false)
    await service.waitForIdle()
    assert.equal(events.at(-1)?.payload.success, approved)
    if (!approved) {
      assert.equal(events.at(-1)?.payload.errorCode, errorCodes.pluginIntegrity)
      assert.equal(await fs.access(path.join(root, 'Plugins', 'plugin.test')).then(() => true, () => false), false)
      return
    }
    await service.withPluginManifest('plugin.test', async (_manifest, metadata) => {
      assert.equal(metadata?.sdkApiLane, 1)
      assert.deepEqual(metadata?.macNativeComponents, [component])
    })
    ready = false
    let actionCalled = false
    await assert.rejects(service.withPluginManifest('plugin.test', async () => { actionCalled = true }), { code: errorCodes.notSupported })
    assert.equal(actionCalled, false)
    ready = true
    await fs.writeFile(path.join(root, 'Plugins', 'plugin.test', 'lib', 'native-test.dylib'), 'changed native file')
    await assert.rejects(service.withPluginManifest('plugin.test', async () => { actionCalled = true }), { code: errorCodes.pluginIntegrity })
    assert.equal(actionCalled, false)
  })
}

test('install terminal is correlated and native replacement is released before notification', async (context) => {
  const root = runtimeRoot('terminal-native-release'), events: PublishedEvent[] = []
  let archive = nativePluginZip('1.0.0')
  let released = false
  let releaseObserved: unknown
  const publisher = createPublisher(events)
  const service = new PluginInstallService(root, {
    publishHostToMain(type, payload) {
      const event = payload as Record<string, unknown>
      if (type === 'plugin_install_complete' && event.version === '2.0.0') releaseObserved = released
      return publisher.publishHostToMain(type, payload)
    }
  }, {
    runtimeTarget: windowsIa32Electron,
    fetchImpl: (async () => response(archive)) as typeof fetch,
    preparePluginReplace: async () => () => { released = true }
  })
  context.after(async () => { await service.stop() })
  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()
  archive = nativePluginZip('2.0.0')
  const accepted = await service.startInstall(installParams(archive, '2.0.0'), true)
  await service.waitForIdle()
  assert.equal(releaseObserved, true)
  const terminal = events.find(event => event.type === 'plugin_install_complete' && event.payload.version === '2.0.0')
  assert.equal(terminal?.payload.operationId, accepted.operationId)
  assert.equal(terminal?.payload.success, true)
})

test('failure terminal releases the plugin for immediate retry and preserves operation identity', async (context) => {
  const root = runtimeRoot('terminal-retry'), events: PublishedEvent[] = []
  const valid = pluginZip('1.0.0'), invalid = Buffer.from('not a zip')
  let archive: Buffer = invalid
  let retry: Promise<unknown> | undefined
  let service: PluginInstallService
  const publisher = createPublisher(events)
  service = new PluginInstallService(root, {
    publishHostToMain(type, payload) {
      const event = payload as Record<string, unknown>
      if (type === 'plugin_install_complete' && event.success === false && !retry) {
        archive = valid
        retry = service.startInstall(installParams(valid, '1.0.0'), false).catch(error => error)
      }
      return publisher.publishHostToMain(type, payload)
    }
  }, { runtimeTarget: windowsIa32Electron, fetchImpl: (async () => response(archive)) as typeof fetch })
  context.after(async () => { await service.stop() })
  const accepted = await service.startInstall(installParams(invalid, '1.0.0'), false)
  await service.waitForIdle()
  assert.equal(events.find(event => event.type === 'plugin_install_complete' && event.payload.success === false)?.payload.operationId, accepted.operationId)
  const retryAccepted = await retry as { success?: boolean }
  assert.equal(retryAccepted.success, true)
  await service.waitForIdle()
  assert.equal(await fs.readFile(path.join(root, 'Plugins', 'plugin.test', 'index.html'), 'utf8'), '<html>1.0.0</html>')
})

test('telemetry failure cannot turn a committed install into a failed terminal', async (context) => {
  const root = runtimeRoot('terminal-telemetry'), events: PublishedEvent[] = []
  const archive = pluginZip('1.0.0')
  const service = new PluginInstallService(root, createPublisher(events), {
    runtimeTarget: windowsIa32Electron, fetchImpl: (async () => response(archive)) as typeof fetch,
    analytics: () => { throw new Error('controlled analytics failure') }
  })
  context.after(async () => { await service.stop() })
  const accepted = await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()
  const terminal = events.filter(event => event.type === 'plugin_install_complete')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]?.payload.success, true)
  assert.equal(terminal[0]?.payload.operationId, accepted.operationId)
})

test('a terminal listener can acquire a directory lease that old operation cleanup cannot release', async (context) => {
  const root = runtimeRoot('terminal-reader'), archive = pluginZip('1.0.0')
  let releaseRead!: () => void
  const hold = new Promise<void>(resolve => { releaseRead = resolve })
  let entered!: () => void
  const startedRead = new Promise<void>(resolve => { entered = resolve })
  let readFailure: unknown
  let reading: Promise<void> | undefined
  let service: PluginInstallService
  service = new PluginInstallService(root, {
    publishHostToMain(type) {
      if (type === 'plugin_install_complete') {
        reading = service.withPluginDirectory('plugin.test', async () => { entered(); await hold })
          .catch(error => { readFailure = error; entered() })
      }
      return { success: true, delivered: 1 }
    }
  }, { runtimeTarget: windowsIa32Electron, fetchImpl: (async () => response(archive)) as typeof fetch })
  context.after(async () => { releaseRead(); await reading; await service.stop() })
  await service.startInstall(installParams(archive, '1.0.0'), false)
  await service.waitForIdle()
  await startedRead
  assert.equal(readFailure, undefined)
  await assert.rejects(service.startInstall(installParams(archive, '1.0.0'), true), { code: errorCodes.pluginBusy })
})
