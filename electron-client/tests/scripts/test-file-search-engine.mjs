import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(__dirname, '../..')
const indexerExe = process.platform === 'win32'
  ? path.join(clientRoot, 'out', 'native', 'win32-x64', 'bin', 'ztools-indexer.exe')
  : path.join(clientRoot, 'out', 'native', `darwin-${process.arch}`, 'bin', 'ztools-indexer')

function spawnIndexerRpc(exePath) {
  const child = spawn(exePath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const rl = readline.createInterface({ input: child.stdout })
  let reqId = 1
  const pending = new Map()
  rl.on('line', (line) => {
    if (!line.trim()) return
    const msg = JSON.parse(line)
    const waiter = pending.get(msg.id)
    if (!waiter) return
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  })
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = reqId++
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const close = async () => {
    await call('shutdown').catch(() => {})
    rl.close()
    child.kill()
  }
  return { call, close }
}

test('ztools-indexer C++20 引擎：多词/OR/排除/通配符/fzf模糊/全量中文拼音/位掩码过滤/分页与缓存落盘恢复', async (t) => {
  if (!fs.existsSync(indexerExe)) {
    t.skip(`Native indexer binary not built at ${indexerExe}`)
    return
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-indexer-engine-test-'))
  let client = spawnIndexerRpc(indexerExe)
  try {
    fs.mkdirSync(path.join(tmp, 'Downloads', '财务2026'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'src', 'services'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'Downloads', '财务2026', '2026年_财务_报销汇总.xlsx'), Buffer.alloc(4096))
    fs.writeFileSync(path.join(tmp, 'Downloads', '财务2026', '差旅报销单_2026.pdf'), Buffer.alloc(20480))
    fs.writeFileSync(path.join(tmp, 'Downloads', '财务2026', '微信账单导出.csv'), Buffer.alloc(1024))
    fs.writeFileSync(path.join(tmp, 'src', 'services', 'file-search-service.ts'), 'export const ok = true;')
    fs.writeFileSync(path.join(tmp, 'src', 'services', 'tsconfig.super-markdown-check.json'), '{}')
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'file-search-mock.ts'), 'mock')

    const cachePath = path.join(tmp, 'file-index.zidx')
    const idx = await client.call('index_path', { path: tmp, scanner: 'directory', cache_path: cachePath })
    assert.ok(idx.total_indexed >= 6)
    assert.equal(fs.existsSync(cachePath), true)

    // 1. 空格多词 AND
    const rAnd = await client.call('search_files', { query: '2026 报销', limit: 20 })
    assert.equal(rAnd.total_matches, 2)

    // 2. OR 与排除词
    const rOr = await client.call('search_files', { query: 'ext:xlsx | ext:pdf', limit: 20 })
    assert.equal(rOr.total_matches, 2)
    const rNeg = await client.call('search_files', { query: 'file-search !node_modules', limit: 20 })
    assert.equal(rNeg.total_matches, 1)
    assert.equal(rNeg.files[0].name, 'file-search-service.ts')

    // 3. 通配符 + 路径感知
    const rGlob = await client.call('search_files', { query: '*.pdf', limit: 20 })
    assert.deepEqual(rGlob.files.map((f) => f.name), ['差旅报销单_2026.pdf'])
    const rPath = await client.call('search_files', { query: 'src/services file', limit: 20 })
    assert.equal(rPath.files[0].name, 'file-search-service.ts')

    // 4. fzf v2 模糊匹配排序精度：fsearch ts 应把 file-search-service.ts 稳居第 1（压过松散命中 tsconfig...json）
    const rFuzzy = await client.call('search_files', { query: 'fsearch ts !node_modules', limit: 20 })
    assert.equal(rFuzzy.files[0]?.name, 'file-search-service.ts')

    // 5. 全量中文拼音（覆盖旧 31 字之外汉字及修复 微=wei）
    const rPy1 = await client.call('search_files', { query: 'caiwu baoxiao', limit: 20 })
    assert.ok(rPy1.files.some((f) => f.name.includes('财务_报销')))
    const rPy2 = await client.call('search_files', { query: 'weixin', limit: 20 })
    assert.ok(rPy2.files.some((f) => f.name === '微信账单导出.csv'))
    const rPy3 = await client.call('search_files', { query: 'clbxd', limit: 20 })
    assert.ok(rPy3.files.some((f) => f.name === '差旅报销单_2026.pdf'))

    // 6. 引擎内位掩码筛选 + 全盘排序 + 分页
    const rPage1 = await client.call('search_files', {
      query: '2026', content_type: 'document', sort_by: 'size-desc', limit: 2, offset: 0
    })
    assert.equal(rPage1.total_matches, 3)
    assert.deepEqual(rPage1.files.map((f) => f.name), ['差旅报销单_2026.pdf', '2026年_财务_报销汇总.xlsx'])
    assert.equal(rPage1.has_more, true)
    const rPage2 = await client.call('search_files', {
      query: '2026', content_type: 'document', sort_by: 'size-desc', limit: 2, offset: 2
    })
    assert.deepEqual(rPage2.files.map((f) => f.name), ['微信账单导出.csv'])
    assert.equal(rPage2.has_more, false)

    // 7. 磁盘快照秒开恢复 + 损坏缓存安全拒载
    await client.close()
    client = spawnIndexerRpc(indexerExe)
    const loaded = await client.call('load_cache', { cache_path: cachePath })
    assert.equal(loaded.loaded, true)
    assert.equal(loaded.total_indexed, idx.total_indexed)
    const afterLoad = await client.call('search_files', { query: 'caiwu 报销', limit: 10 })
    assert.equal(afterLoad.total_matches, 1)

    // 损坏文件安全返回 loaded: false 不崩溃
    const corruptPath = path.join(tmp, 'corrupt.zidx')
    fs.writeFileSync(corruptPath, 'BROKEN_HEADER')
    await client.close()
    client = spawnIndexerRpc(indexerExe)
    const badLoad = await client.call('load_cache', { cache_path: corruptPath })
    assert.equal(badLoad.loaded, false)
    assert.equal(badLoad.total_indexed, 0)
  } finally {
    await client.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
