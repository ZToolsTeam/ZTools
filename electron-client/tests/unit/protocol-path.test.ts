import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Protocol, Session } from 'electron'
import { resolveSafeFile } from '../../src/main/protocol/safe-path.js'
import {
  COMPATIBILITY_MIGRATION_PATH,
  installPluginZToolsProtocol,
  pluginResourcePath
} from '../../src/main/protocol/ztools-protocol.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import {
  PluginSessionManager,
  pluginSessionPartition
} from '../../src/main/windows/plugin-session-manager.js'

test('resolveSafeFile accepts an existing file under root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-protocol-'))
  const target = path.join(root, 'index.html')
  await fs.writeFile(target, 'ok')
  assert.equal(await resolveSafeFile(root, '/index.html'), await fs.realpath(target))
})

test('resolveSafeFile rejects traversal and double encoding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-protocol-'))
  await assert.rejects(resolveSafeFile(root, '/../outside.txt'))
  await assert.rejects(resolveSafeFile(root, '/%252e%252e/outside.txt'))
  await assert.rejects(resolveSafeFile(root, '/C%3A/Windows/win.ini'))
})

test('plugin protocol strips only its bound plugin id', () => {
  assert.equal(
    pluginResourcePath('ztools://plugins/plugin.test/assets/app.js', 'plugin.test'),
    '/assets/app.js'
  )
  assert.throws(() =>
    pluginResourcePath('ztools://plugins/plugin.other/index.html', 'plugin.test')
  )
  assert.throws(() =>
    pluginResourcePath('ztools://plugins/%2570lugin.test/secret', 'plugin.test')
  )
  assert.throws(() =>
    pluginResourcePath('ztools://web/plugin.test/index.html', 'plugin.test')
  )
})

test('plugin protocol serves the isolated compatibility page before plugin files', async () => {
  let handler: ((request: Request) => Promise<Response>) | undefined
  const targetProtocol = {
    handle(_scheme: string, callback: (request: Request) => Promise<Response>) {
      handler = callback
    }
  } as unknown as Pick<Protocol, 'handle'>
  const files = {
    async resolveFileCapability() {
      throw new Error('not used')
    }
  } as unknown as FileSystemService

  installPluginZToolsProtocol(
    {
      web: 'C:\\web',
      plugin: 'C:\\plugins\\plugin.test',
      cache: 'C:\\cache',
      temp: 'C:\\temp',
      migrationPage: '<!doctype html><title>migration</title>'
    },
    files,
    'plugin.test',
    targetProtocol
  )

  assert.ok(handler)
  const response = await handler({
    method: 'GET',
    url: 'ztools://plugins' + COMPATIBILITY_MIGRATION_PATH
  } as Request)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<!doctype html><title>migration</title>')
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8')
})

test('plugin session partitions are persistent, stable and isolated by plugin id', () => {
  const first = pluginSessionPartition('Plugin.Test')
  assert.match(first, /^persist:ztools-plugin-[a-f0-9]{64}$/)
  assert.equal(first, pluginSessionPartition('plugin.test'))
  assert.notEqual(first, pluginSessionPartition('plugin.other'))
})

test('plugin session manager prepares one session per normalized plugin id', async () => {
  const created: Array<{ partition: string; target: Session; handles: string[] }> = []
  let preparedRoots = 0
  const files = {
    async preparePluginProtocolRoots(pluginId: string) {
      preparedRoots += 1
      return {
        cache: path.join('C:\\plugin-cache', pluginId),
        temp: path.join('C:\\plugin-cache', pluginId, 'Temp')
      }
    },
    async resolveFileCapability() {
      throw new Error('not used')
    }
  } as unknown as FileSystemService
  const manager = new PluginSessionManager({
    webRoot: 'C:\\web',
    pluginRoot: 'C:\\plugins',
    files,
    createSession(partition) {
      const handles: string[] = []
      const target = {
        protocol: {
          handle(scheme: string) {
            handles.push(scheme)
          }
        },
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {} }
      } as unknown as Session
      created.push({ partition, target, handles })
      return target
    }
  })

  const [first, same] = await Promise.all([
    manager.get('Plugin.Test'),
    manager.get('plugin.test')
  ])
  const other = await manager.get('plugin.other')

  assert.equal(first, same)
  assert.notEqual(first, other)
  assert.equal(preparedRoots, 2)
  assert.deepEqual(created.map(({ partition }) => partition), [
    pluginSessionPartition('plugin.test'),
    pluginSessionPartition('plugin.other')
  ])
  assert.deepEqual(created.map(({ handles }) => handles), [['ztools'], ['ztools']])
})
