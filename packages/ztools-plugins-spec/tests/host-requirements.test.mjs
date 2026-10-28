import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareAppVersion, resolvePluginMinAppVersion, HOST_API_REQUIREMENTS } from '../src/host-requirements.js'
import { validateCatalogPluginItem, validatePluginManifest } from '../src/validator.js'

function makePlugin(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-host-req-'))
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

describe('最低客户端版本（minAppVersion）', () => {
  it('compareAppVersion 按 4 段数字比较，缺的段按 0', () => {
    assert.equal(compareAppVersion('1.1.8.3', '1.1.8.2'), 1)
    assert.equal(compareAppVersion('1.1.8', '1.1.8.0'), 0)
    assert.equal(compareAppVersion('1.1.10.0', '1.1.9.9'), 1)
    assert.equal(compareAppVersion('2.0.0', 'x'), null)
  })

  it('运行代码用到登记的宿主接口时自动要求对应客户端版本', () => {
    const dir = makePlugin({ 'dist/volume-ipc.js': "callHostTransport('system_list_volumes', {})" })
    const result = resolvePluginMinAppVersion(dir, {})
    assert.deepEqual(result, { minAppVersion: '1.1.8.3', apis: ['system_list_volumes'] })
  })

  it('只看运行代码：src/ 与测试里出现接口名不算', () => {
    const dir = makePlugin({
      'dist/index.js': 'export default 1',
      'src/volume-ipc.ts': "'system_list_volumes'",
      'tests/a.test.mjs': "'clipboard_history_restore'",
      'dist/b.test.js': "'filesystem_move_file_no_replace'"
    })
    assert.deepEqual(resolvePluginMinAppVersion(dir, {}), { minAppVersion: undefined, apis: [] })
  })

  it('plugin.json 手写的版本更高时以手写为准，更低时以接口要求为准', () => {
    const dir = makePlugin({ 'dist/logic.js': "'filesystem_move_file_no_replace'" })
    assert.equal(resolvePluginMinAppVersion(dir, { minAppVersion: '1.2.0.0' }).minAppVersion, '1.2.0.0')
    assert.equal(resolvePluginMinAppVersion(dir, { minAppVersion: '1.1.0.0' }).minAppVersion, '1.1.8.3')
  })

  it('登记表的版本号格式都合法', () => {
    for (const item of HOST_API_REQUIREMENTS) assert.notEqual(compareAppVersion(item.minAppVersion, '1.0.0.0'), null, item.api)
  })

  it('依赖 1.1.8.5 新宿主能力的安装包要求 1.1.8.5（v1.1.8.4 安装包不带这些接口），且不被旧清单要求降级', (t) => {
    const methods = [
      'browser_bookmarks_scan', 'browser_bookmarks_cancel', 'system_power_session',
      'keyboard_lock', 'dns_benchmark', 'docker_manager', 'downloads_manager',
      'environment_manager', 'file_unlock',
      'folder_sync', 'folder_sync_cancel', 'font_manager', 'font_manager_cancel', 'hosts_manager',
      'hotkey_probe', 'lan_network', 'markdown_document', 'media_metadata', 'media_metadata_cancel',
      'monitor_control', 'network_speedtest', 'office_document', 'office_cancel', 'recent_projects',
      'ssh_proxy', 'startup_manager', 'tls_inspect'
    ]
    for (const method of methods) {
      const dir = makePlugin({ 'dist/host-service.js': `callHostTransport('${method}', {})` })
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
      assert.equal(resolvePluginMinAppVersion(dir).minAppVersion, '1.1.8.5', method)
      assert.equal(resolvePluginMinAppVersion(dir, { minAppVersion: '1.1.8.4' }).minAppVersion, '1.1.8.5', method, '手写 1.1.8.4 的旧清单不能把要求降下来')
      assert.equal(resolvePluginMinAppVersion(dir, { minAppVersion: '1.2.0' }).minAppVersion, '1.2.0', method)
    }
    const dir = makePlugin({ 'dist/index.js': "'get_keyboard_lock_status'; 'not_downloads_manager'; 'office_documents_x'; 'my_tls_inspector'" })
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    assert.equal(resolvePluginMinAppVersion(dir).minAppVersion, undefined)
  })

  it('清单与目录条目里的 minAppVersion 格式不对时报错', () => {
    const manifest = { id: 'demo-tool', name: 'Demo', version: '1.0.0', description: 'd', author: 'a', entry: 'dist/index.js', icon: 'icon.svg', permissions: [], minAppVersion: 'latest' }
    assert.ok(validatePluginManifest(manifest).errors.some((e) => e.includes('minAppVersion')))
    const item = { id: 'demo-tool', name: 'Demo', version: '1.0.0' }
    assert.equal(validateCatalogPluginItem({ ...item, minAppVersion: '1.1.8.3' }).valid, true)
    assert.equal(validateCatalogPluginItem({ ...item, minAppVersion: 1 }).valid, false)
  })
})
