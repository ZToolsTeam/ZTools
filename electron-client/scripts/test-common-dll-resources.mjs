import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeHostClient } from '../out/main/native-host/native-host-client.js'
import { FileSystemService } from '../out/main/services/file-system-service.js'
import { DllPluginService } from '../out/main/services/dll-plugin-service.js'

async function unloadAfterCleanup(client, pluginId, dllId) {
  const deadline = Date.now() + 3000
  for (;;) {
    try { return await client.unloadDll(pluginId, dllId) } catch (error) {
      if (error.details?.hostCode !== 'DLL_BUSY' || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.resolve(process.env.ZTOOLS_COMMON_DLL_RESOURCES_TEST_OUTPUT_ROOT ??
  path.join(os.tmpdir(), `ZTools-common-dll-resources-${randomUUID()}`))
await fs.mkdir(fixture, { recursive: false })
const pluginRoot = path.join(fixture, 'Data', 'Plugins')
const resourcesRoot = path.join(fixture, 'resources')
const manifestRoot = resourcesRoot
const dllId = 'ZToolsNativeTestPlugin'
const relative = `${dllId}/${dllId}.dll`
const target = path.join(resourcesRoot, 'CommonPlugins', relative)
const privateTarget = path.join(pluginRoot, 'private-test', relative)
const bytes = await fs.readFile(path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_PLUGIN ??
  path.join(root, 'out/native/test-win32-ia32', `${dllId}.dll`)))
const digest = createHash('sha256').update(bytes).digest('hex')
await fs.mkdir(path.dirname(target), { recursive: true })
await fs.mkdir(path.dirname(privateTarget), { recursive: true })
await fs.mkdir(manifestRoot, { recursive: true })
await fs.writeFile(target, bytes)
await fs.writeFile(privateTarget, bytes)
const resourcesManifest = `<?xml version="1.0" encoding="utf-8"?>
<nativeHostManifest version="1">
  <plugin id="CommonPlugins">
    <dll id="${dllId}" path="${relative}" sha256="${digest}" arch="x86">
      <function name="progressTask"/>
    </dll>
  </plugin>
</nativeHostManifest>
`
const userCommonTarget = path.join(pluginRoot, 'CommonPlugins', relative)
await fs.mkdir(path.dirname(userCommonTarget), { recursive: true })
await fs.writeFile(userCommonTarget, bytes)
const userManifest = `<?xml version="1.0" encoding="utf-8"?>
<nativeHostManifest version="1">
  <plugin id="CommonPlugins">
    <dll id="${dllId}" path="${relative}" sha256="${digest}" arch="x86">
      <function name="progressTask"/>
    </dll>
  </plugin>
  <plugin id="private-test">
    <dll id="${dllId}" path="${relative}" sha256="${digest}" arch="x86">
      <function name="progressTask"/>
    </dll>
  </plugin>
</nativeHostManifest>
`
await fs.writeFile(path.join(manifestRoot, '.ztools-native-host.xml'), resourcesManifest)
await fs.writeFile(path.join(pluginRoot, '.ztools-native-host.xml'), userManifest)
const executable = path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_EXE ??
  path.join(root, 'out/native/win32-ia32/ZToolsNativeHost32.exe'))
const client = new NativeHostClient(executable, {
  pluginRoot,
  trustedManifestSha256: createHash('sha256').update(userManifest).digest('hex'),
  resourcesRoot,
  trustedResourcesManifestSha256: createHash('sha256').update(resourcesManifest).digest('hex')
})
try {
  await client.start()
  await client.checkDllAccess('CommonPlugins', dllId, 'progressTask')
  await client.checkDllAccess('private-test', dllId, 'progressTask')
  const info = await client.getDllInfo('CommonPlugins', dllId)
  assert.equal(info.pluginName, dllId)
  assert.equal(info.functions.includes('progressTask'), false)
  assert.equal((await client.callDll('CommonPlugins', dllId, 'progressTask', {})).code, 0)
  await unloadAfterCleanup(client, 'CommonPlugins', dllId)
  await assert.rejects(client.checkDllAccess('CommonPlugins', dllId, 'NotListed'))
  // A user-data copy and manifest cannot replace an application resource DLL.
  await fs.unlink(target)
  await assert.rejects(client.checkDllAccess('CommonPlugins', dllId, 'progressTask'))
  await fs.writeFile(target, Buffer.concat([bytes, Buffer.from('changed DLL bytes')]))
  await assert.rejects(client.checkDllAccess('CommonPlugins', dllId, 'progressTask'))
  await fs.writeFile(target, bytes)
  await unloadAfterCleanup(client, 'CommonPlugins', dllId)
  const legacyTarget = userCommonTarget
  await fs.unlink(target)
  await fs.rmdir(path.dirname(target))
  await fs.symlink(path.dirname(legacyTarget), path.dirname(target), 'junction')
  await assert.rejects(client.checkDllAccess('CommonPlugins', dllId, 'progressTask'))
  console.log('PASS: independent trusted resource/user manifests, per-function allowlist, DLL digest integrity, no user fallback and junction rejection')
} finally {
  await client.stop()
}

// Optionally exercise the four actual bundled DLLs from an assembled/package resources tree.
if (process.argv[2]) {
  assert.ok(path.isAbsolute(process.argv[2]), 'resources path must be absolute')
  assert.match(process.argv[3] ?? '', /^[a-f0-9]{64}$/i,
    'approved resources manifest SHA-256 is required as argument 3')
  const bundledResources = process.argv[2]
  const bundled = new NativeHostClient(executable, {
    pluginRoot,
    trustedManifestSha256: createHash('sha256').update(userManifest).digest('hex'),
    resourcesRoot: bundledResources,
    trustedResourcesManifestSha256: process.argv[3].toLowerCase()
  })
  try {
    await bundled.start()
    const definitions = JSON.parse(await fs.readFile(path.join(root, 'src/main/services/common-plugins.json'), 'utf8'))
    for (const definition of definitions) {
      const info = await bundled.getDllInfo('CommonPlugins', definition.id)
      assert.equal(info.pluginName, definition.id)
      console.log(`PASS: bundled ${definition.id} loaded from application resources`)
    }
    if (definitions.some((definition) => definition.id === 'ImagePlugin')) {
      const taskId = await bundled.callDllAsync(
        'CommonPlugins',
        'ImagePlugin',
        'GetInfo',
          { path: path.join(fixture, 'missing-image.png') }
      )
      const deadline = Date.now() + 5_000
      let status
      do {
        status = await bundled.queryDllTask('CommonPlugins', 'ImagePlugin', taskId)
        if (status.status === 'error' || status.status === 'completed') break
        await new Promise((resolve) => setTimeout(resolve, 25))
      } while (Date.now() < deadline)
      assert.equal(status?.status, 'error')
      await bundled.clearDllTask('CommonPlugins', 'ImagePlugin', taskId)
      console.log('PASS: ImagePlugin without DllPlugin_Call_Async uses the synchronous task fallback')
      const caller = { type: 'plugin', webContentsId: 901, pluginId: 'image-test', pluginInstanceId: 'image-test-1' }
      const other = { type: 'plugin', webContentsId: 902, pluginId: 'other-test', pluginInstanceId: 'other-test-1' }
      const registry = { onRemoved: () => () => {}, get: id => id === caller.webContentsId ? caller : other }
      const files = new FileSystemService(registry, path.join(fixture, 'Cache'))
      const dlls = new DllPluginService({
        list: async () => ({ success: true, data: [] }),
        withPluginManifest: async (id, action) => action({ id, dllloader: '', requireAdmin: false })
      }, bundled, null,
        { publishHostToPlugin: () => ({ success: true, delivered: 0 }) },
        who => files.getScopedCachePath(who), (data, who) => files.grantDllTemporaryFiles(data, who))
      const input = path.join(fixture, 'input.bmp')
      const bmp = Buffer.alloc(70)
      bmp.write('BM'); bmp.writeUInt32LE(70, 2); bmp.writeUInt32LE(54, 10)
      bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(2, 18); bmp.writeInt32LE(2, 22)
      bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(16, 34)
      await fs.writeFile(input, bmp)
      await files.grantOpenPath(input, caller)
      try {
        for (const mode of ['sync', 'async']) {
          let result
          if (mode === 'sync') {
            const response = await dlls.call({ plugin: 'ImagePlugin', func: 'ImageToBase64', params: { input } }, caller)
            assert.equal(response.success, true)
            result = response.data
          } else {
            const started = await dlls.callAsync({ plugin: 'ImagePlugin', func: 'ImageToBase64', params: { input } }, caller)
            const until = Date.now() + 5000
            do {
              const queried = await dlls.queryTask({ plugin: 'ImagePlugin', taskId: started.taskId }, caller)
              if (queried.taskDone) {
                assert.equal(queried.taskError, undefined)
                result = queried.taskData
                break
              }
              await new Promise(resolve => setTimeout(resolve, 25))
            } while (Date.now() < until)
          }
          if (typeof result?.result === 'string') result = JSON.parse(result.result)
          assert.equal(typeof result?.filePath, 'string', JSON.stringify(result))
          try {
            const size = await files.getFileSize({ path: result.filePath }, caller)
            assert.ok(size.size > 0)
            const chunk = await files.readFileChunk({ path: result.filePath, offset: 0, length: 500 }, caller)
            assert.ok(Buffer.from(chunk.content, 'base64').toString().includes(bmp.toString('base64')))
            await assert.rejects(files.getFileSize({ path: result.filePath }, other))
            const exported = path.join(await files.getScopedTempPath(caller), `${mode}-export.txt`)
            await files.copyFile({ sourcePath: result.filePath, destPath: exported }, caller)
            assert.equal((await files.getFileSize({ path: exported }, caller)).size, size.size)
          } finally { await files.deleteFile({ path: result.filePath }, caller) }
          console.log(`PASS: real ImageToBase64 ${mode} temporary output size, preview, export, cleanup and isolation`)
        }
      } finally {
        await dlls.stop()
        await files.stop()
      }
    }
  } finally {
    await bundled.stop()
  }
}
