import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeHostClient } from '../out/main/native-host/native-host-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.resolve(process.argv[2] ?? path.join(
  root, '..', 'plugins', 'create-plugin', 'src', 'plugins'
))
const runtime = path.resolve(process.env.ZTOOLS_MEDIA_DLL_LIFECYCLE_TEST_OUTPUT_ROOT ??
  path.join(os.tmpdir(), `ZTools-media-lifecycle-${randomUUID()}`))
await fs.mkdir(runtime, { recursive: false })
const pluginRoot = path.join(runtime, 'Plugins')
const plugins = [
  ['batch-audio', 'BatchAudioPlugin'],
  ['batch-video', 'BatchVideoPlugin']
]

try {
  // Test the DLLs actually shipped with plugins, not freshly built substitutes.
  for (const [pluginId] of plugins) {
    await fs.cp(path.join(sourceRoot, pluginId, 'lib'), path.join(pluginRoot, pluginId, 'lib'), {
      recursive: true
    })
  }
  const manifestEntries = []
  for (const [pluginId, dllId] of plugins) {
    const target = path.join(pluginRoot, pluginId, 'lib', `${dllId}.dll`)
    const digest = createHash('sha256').update(await fs.readFile(target)).digest('hex')
    manifestEntries.push(`  <plugin id="${pluginId}">\n` +
      `    <dll id="${dllId}" path="lib/${dllId}.dll" sha256="${digest}" arch="x86">\n` +
      '      <function name="GetTaskList"/>\n' +
      '    </dll>\n' +
      '  </plugin>')
  }
  const manifest = `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<nativeHostManifest version="1">\n${manifestEntries.join('\n')}\n</nativeHostManifest>\n`
  await fs.writeFile(path.join(pluginRoot, '.ztools-native-host.xml'), manifest, 'utf8')
  const client = new NativeHostClient(path.resolve(process.env.ZTOOLS_NATIVE_HOST32_TEST_EXE ??
    path.join(root, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe')), {
    pluginRoot,
    trustedManifestSha256: createHash('sha256').update(manifest).digest('hex')
  })
  const lifecycle = []
  client.onLifecycleEvent((event) => lifecycle.push(event))
  try {
    await client.start()
    const pid = client.diagnostics.pid
    for (const [pluginId, dllId] of plugins) {
      const info = await client.getDllInfo(pluginId, dllId)
      assert.equal(info.supportsCancel, true)
      const returned = new Promise((resolve) => {
        const unsubscribe = client.onDllEvent((event) => {
          if (event.pluginId === pluginId && event.type === 'callback-return') {
            unsubscribe()
            resolve(event)
          }
        })
      })
      // A read-only callback call left registered until stop reproduced the
      // stale two-argument CancelTask ABI writing through a garbage pointer.
      const taskId = await client.callDllWithCallback(pluginId, dllId, 'GetTaskList', {})
      let timer
      try {
        const event = await Promise.race([
          returned,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${pluginId} callback timed out`)), 5_000)
          })
        ])
        assert.equal(event.call.code, 0)
      } finally {
        clearTimeout(timer)
      }
      // The DLL's legacy success ACK is not a terminal state transition.
      const beforeCancel = await client.queryDllTask(pluginId, dllId, taskId)
      const cancelCode = 0
      assert.equal(await client.cancelDllTask(pluginId, dllId, taskId), cancelCode)
      const afterCancel = await client.queryDllTask(pluginId, dllId, taskId)
      assert.equal(afterCancel.status, beforeCancel.status)
      await client.clearDllTask(pluginId, dllId, taskId)
      assert.equal((await client.callDll(pluginId, dllId, 'GetTaskList', {})).code, 0)
      await client.unloadDll(pluginId, dllId)
      // Exercise host shutdown's cancellation path as well as explicit cancel.
      await client.callDllWithCallback(pluginId, dllId, 'GetTaskList', {})
    }
    assert.equal(client.diagnostics.pid, pid)
    const report = await client.stop()
    assert.equal(report.completed, true)
    assert.equal(report.forced, false)
    assert.equal(report.cancelAttempted, 2)
    assert.equal(report.cancelFailed, 0)
    assert.equal(lifecycle.some((event) => event.type === 'crashed'), false)
    console.log(`Shipped media DLL lifecycle passed; isolated fixture retained at ${runtime}`)
  } finally {
    await client.stop()
  }
} finally {
  // Keep the per-run fixture for review; each run uses a new UUID output path.
}
