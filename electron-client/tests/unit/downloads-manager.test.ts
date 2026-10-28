import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canCall, isAllowedMethod, isPlatformSupportedMethod, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { requirePluginPermission } from '../../src/main/ipc/plugin-principal.js'
import { BuiltinPluginHostService } from '../../src/main/services/builtin-plugin-host-service.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 91, pluginId: 'download-fixture' }

test('下载目录接口支持双平台，Windows DLL 的平台限制不改变', () => {
  const request = parseRequest({ messageId: 'download_test', method: 'downloads_manager', params: { action: 'discover', customDirs: [] } })
  assert.ok(isAllowedMethod(request.method))
  assert.equal(canCall(request.method, caller), true)
  for (const platform of ['darwin', 'win32']) assert.equal(isPlatformSupportedMethod(request.method, platform), true)
  assert.equal(isPlatformSupportedMethod('dllplugin_call', 'darwin'), false)
  validateMethodParams(request.method, request.params)
})

test('下载目录请求拒绝清理动作、函数注入、路径穿越和无界输入', () => {
  for (const params of [{ action: 'validate', dirPath: '/tmp/fixture' }, { action: 'validate', dirPath: 'C:\\Downloads' }]) {
    validateMethodParams('downloads_manager', params)
  }
  for (const params of [{}, { action: 'delete', dirPath: '/tmp/fixture' },
    { action: 'discover', customDirs: [], func: 'delete' }, { action: 'discover', customDirs: 'wrong' },
    { action: 'discover', customDirs: Array(257).fill('/tmp/fixture') },
    ...['relative', '/tmp/../outside', '/tmp/\0bad', '/' + 'a'.repeat(32768)].map(dirPath => ({ action: 'validate', dirPath }))]) {
    assert.throws(() => validateMethodParams('downloads_manager', params), { code: 'INVALID_REQUEST' })
  }
})

test('下载接口需要插件身份和文件权限，不能回退成宿主身份', async () => {
  const manifests = { async withPluginManifest<T>(_id: string, action: (manifest: Record<string, unknown>) => Promise<T>) { return action({ permissions: [] }) } }
  await assert.rejects(requirePluginPermission(caller, 'fs', manifests), { code: 'PLUGIN_PERMISSION_REQUIRED' })
  await assert.rejects(requirePluginPermission({ type: 'main', webContentsId: 1 }, 'fs', manifests), { code: 'PLUGIN_IDENTITY_REQUIRED' })
  const attributed: CallerIdentity = { type: 'main', webContentsId: 1, attributedPlugin: { pluginId: 'downloads-manager', sessionId: 'test', source: 'installed', permissions: new Set(['fs']) } }
  assert.equal((await requirePluginPermission(attributed, 'fs', manifests)).pluginId, 'downloads-manager')
})

test('实际目录发现与校验保留文件，路径授权不能跨窗口复用', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-download-route-')))
  const directory = path.join(root, 'Downloads'), file = path.join(directory, 'empty.txt')
  await fs.mkdir(directory); await fs.writeFile(file, '')
  t.mock.method(os, 'homedir', () => root)
  const other: CallerIdentity = { ...caller, webContentsId: 92 }
  const registry = { onRemoved: () => () => {}, get: (id: number) => id === 91 ? caller : other } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const host = new BuiltinPluginHostService({ pathAuthority: files })
  const signal = new AbortController().signal
  try {
    const validate = (dirPath: string, owner = caller) => host.handlePluginCall('DownloadsManagerPlugin', 'validateCustomDir', { dirPath }, signal, owner) as Promise<{ ok: boolean; path?: string }>
    assert.equal((await validate(directory)).ok, false)
    await files.grantOpenPath(directory, caller)
    assert.deepEqual((await validate(directory)).path, directory)
    assert.equal((await validate(directory, other)).ok, false)
    await files.grantOpenPath(file, caller)
    assert.equal((await validate(file)).ok, false)
    const result = await host.handlePluginCall('DownloadsManagerPlugin', 'discoverSources', { customDirs: [directory] }, signal, caller) as { sources: Array<{ path: string }> }
    assert.equal(result.sources.filter(source => source.path === directory).length, 1)
    assert.deepEqual(await fs.readFile(file), Buffer.alloc(0))
  } finally { await host.stop(); await files.stop(); await fs.rm(root, { recursive: true, force: true }) }
})
