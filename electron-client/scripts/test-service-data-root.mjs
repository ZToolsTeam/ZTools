import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ServiceClient } from '../out/main/service/service-client.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'out/native/service-win32-ia32/ZToolsService.exe')
const fixture = await fs.mkdtemp(path.join(root, 'out', 'service data 测试-'))
const pipe = '\\\\.\\pipe\\ZToolsPrivilegedService.v1'

function run(args, expected) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, timeout: 10000 })
  assert.ifError(result.error)
  assert.equal(result.status, expected, String(result.stderr))
}

async function testConsole(args) {
  // Never connect the test client to an already running installed service.
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe)
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error('Stop the existing ZToolsService before running this test'))
    })
    socket.once('error', (error) => error.code === 'ENOENT' ? resolve() : reject(error))
  })
  const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  const client = new ServiceClient()
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Console startup timed out')), 10000)
      child.once('error', reject)
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Console exited: ${code}`)) })
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ZToolsService ready')) { clearTimeout(timer); resolve() }
      })
    })
    assert.equal(await client.start(), true, JSON.stringify(client.diagnostics))
    // An empty selected directory must not silently fall back to installed plugins.
    await assert.rejects(client.callDll('context-menu', 'ContextMenuPlugin', 'CheckAdmin', {}))
    const dllDirectory = path.join(fixture, 'Plugins/context-menu/lib')
    await fs.mkdir(dllDirectory, { recursive: true })
    const target = path.join(dllDirectory, 'ContextMenuPlugin.dll')
    await fs.copyFile(path.join(root, '../bin/Data/Plugins/context-menu/lib/ContextMenuPlugin.dll'), target)
    const result = await client.callDll('context-menu', 'ContextMenuPlugin', 'CheckAdmin', {})
    assert.equal(result.success, true)
    assert.equal(typeof result.isAdmin, 'boolean')
  } finally {
    client.stop()
    child.kill()
    await exited
  }
}

try {
  for (const args of [
    ['--console', '--data-root'], ['--data-root='],
    ['--data-root', path.join(fixture, 'missing')], ['--data-root', executable],
    ['--data-root', fixture, '--data-root', fixture], ['--console', '--unknown']
  ]) run(args, 2)
  // Both legacy SCM entry and SCM with an override must reach the dispatcher.
  run([], 3)
  run(['--data-root', fixture], 3)
  await testConsole(['--console', '--data-root', fixture])
  await testConsole([`--data-root=${path.relative(root, fixture)}`, '--console'])
  console.log('Service data-root: argument errors, SCM entry, Unicode/spaces, relative paths and real DLL calls passed')
} finally {
  await fs.rm(fixture, { recursive: true, force: true })
}
