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

  it('清单与目录条目里的 minAppVersion 格式不对时报错', () => {
    const manifest = { id: 'demo-tool', name: 'Demo', version: '1.0.0', description: 'd', author: 'a', entry: 'dist/index.js', icon: 'icon.svg', permissions: [], minAppVersion: 'latest' }
    assert.ok(validatePluginManifest(manifest).errors.some((e) => e.includes('minAppVersion')))
    const item = { id: 'demo-tool', name: 'Demo', version: '1.0.0' }
    assert.equal(validateCatalogPluginItem({ ...item, minAppVersion: '1.1.8.3' }).valid, true)
    assert.equal(validateCatalogPluginItem({ ...item, minAppVersion: 1 }).valid, false)
  })
})
