import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import readline from 'node:readline'
import { buildAllSidecars } from '../../scripts/build-sidecars.mjs'
import { assertPeMachine, PE_MACHINE_X64 } from '../../scripts/windows-pe-architecture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const outBinDir = path.join(rootDir, 'out', 'native', 'win32-x64', 'bin')

// Minimal JSON-RPC helper for direct process testing
function createRpcClient(exePath, args = [], defaultTimeoutMs = 30000) {
  const child = spawn(exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const rl = readline.createInterface({ input: child.stdout })

  let reqId = 1
  const pending = new Map()
  let stderr = ''
  let closePromise
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString() })
  const rejectPending = error => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }
  child.on('error', rejectPending)
  child.stdin.on('error', rejectPending)
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    rejectPending(new Error(`Sidecar exited code=${code} signal=${signal}: ${stderr}`))
    resolve({ code, signal })
  }))
  const terminateTree = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 5000 })
      if (result.error) console.warn('Sidecar tree termination failed:', result.error.message)
    } else {
      child.kill('SIGKILL')
    }
  }

  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch (err) {
      console.warn('Ignoring non-JSON sidecar output:', String(err))
      return
    }
    if (!msg || typeof msg !== 'object') {
      console.warn('Ignoring malformed sidecar response')
      return
    }
    const waiter = pending.get(msg.id)
    if (!waiter) return
    clearTimeout(waiter.timer)
    pending.delete(msg.id)
    if (msg.error) waiter.reject(new Error(msg.error.message))
    else waiter.resolve(msg.result)
  })

  function call(method, params = {}, timeoutMs = defaultTimeoutMs) {
    const id = reqId++
    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
      return Promise.reject(new Error(`Sidecar is unavailable: ${stderr}`))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`RPC_TIMEOUT id=${id} method=${method} after=${timeoutMs}ms: ${stderr}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (!error || !pending.has(id)) return
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      })
    })
  }

  return {
    child,
    call,
    async close() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            await call('shutdown', {}, 3000)
            child.stdin.end()
          } catch (error) {
            console.warn('Graceful sidecar shutdown failed:', error.message)
            terminateTree()
          }
        }
        let timer
        const timeout = new Promise(resolve => { timer = setTimeout(() => { terminateTree(); resolve(null) }, 5000) })
        try {
          const result = await Promise.race([exited, timeout])
          if (!result) throw new Error('Sidecar did not exit within the shutdown deadline')
          return result
        } finally {
          clearTimeout(timer)
          rejectPending(new Error('Sidecar test client closed'))
          child.stdin.destroy()
          rl.close()
        }
      })()
      return closePromise
    }
  }
}

async function testIndexerSmallDatasetConcurrency(indexerExe) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-indexer-regression-'))
  let completedSearches = 0
  try {
    // 空目录、单文件、任务数小于/大于 worker 数的真实目录，绝不扫描用户目录。
    for (const count of [0, 1, 24, os.availableParallelism() + 1]) {
      const root = path.join(fixture, `files-${count}`)
      fs.mkdirSync(root)
      for (let index = 0; index < count; index++) {
        fs.writeFileSync(path.join(root, `candidate_${index}.txt`), String(index))
      }
      const client = createRpcClient(indexerExe, [], 3000)
      let completed = false
      try {
        assert.equal(await client.call('ping'), 'pong')
        const indexed = await client.call('index_path', { path: root, scanner: 'directory' })
        assert.equal(indexed.total_indexed, count)
        const rounds = count === 24 ? 10000 : 1000
        for (let round = 0; round < rounds; round++) {
          const missing = round % 2 === 0
          const result = await client.call('search_files', {
            query: missing ? 'absent_release_probe' : 'candidate_', limit: 10
          })
          assert.equal(result.count, missing ? 0 : Math.min(count, 10))
          assert.equal(result.total_matches, missing ? 0 : count)
          for (const file of result.files) assert.equal(path.dirname(file.path), root)
          completedSearches++
          if (round % 100 === 0) assert.equal(await client.call('ping'), 'pong')
        }
        assert.equal(await client.call('ping'), 'pong')
        completed = true
      } finally {
        const exit = await client.close()
        if (completed) {
          assert.equal(exit.code, 0, 'Indexer must finish shutdown and join its workers without force-kill')
          assert.equal(exit.signal, null)
        }
      }
      console.log(`    Real files=${count}: repeated search, ping and graceful exit passed (${completedSearches} searches total)`)
    }
    assert.ok(completedSearches >= 10000)
  } finally {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    assert.ok(path.resolve(fixture).startsWith(tempRoot), 'Only the owned temporary fixture may be removed')
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function runTests() {
  console.log('======================================================================')
  console.log(' [MODULE 3] UIAccess Worker & Fast File Indexer Test Suite')
  console.log('======================================================================\n')

  const report = {
    timestamp: new Date().toISOString(),
    artifacts: {},
    tests: [],
    benchmark: null,
    passed: true
  }

  function recordTest(name, fn) {
    return async () => {
      const start = performance.now()
      try {
        await fn()
        const duration = Math.round(performance.now() - start)
        console.log(`  [PASS] ${name} (${duration}ms)`)
        report.tests.push({ name, status: 'PASSED', durationMs: duration })
      } catch (err) {
        const duration = Math.round(performance.now() - start)
        console.error(`  [FAIL] ${name} (${duration}ms):`, err.message)
        report.tests.push({ name, status: 'FAILED', durationMs: duration, error: err.message })
        report.passed = false
        throw err
      }
    }
  }

  if (process.argv.includes('--indexer-regression-only')) {
    const indexerExe = path.join(outBinDir, 'ztools-indexer.exe')
    assert.ok(fs.existsSync(indexerExe), 'Build the indexer before running its isolated regression')
    assertPeMachine(indexerExe, PE_MACHINE_X64)
    await recordTest('File Indexer: Real Small-Dataset Completion Regression', () => testIndexerSmallDatasetConcurrency(indexerExe))()
    return report
  }

  // 1. Build and verify artifacts
  await recordTest('Build & Verify Native Sidecar Executables', async () => {
    const buildRes = buildAllSidecars()
    assert.ok(fs.existsSync(buildRes.uiaccess.exePath), 'ztools-uiaccess.exe must exist')
    assert.ok(fs.existsSync(buildRes.uiaccessStandard.exePath), 'ztools-uiaccess-standard.exe must exist')
    assert.ok(fs.existsSync(buildRes.indexer.exePath), 'ztools-indexer.exe must exist')

    assertPeMachine(buildRes.uiaccess.exePath, PE_MACHINE_X64)
    assertPeMachine(buildRes.uiaccessStandard.exePath, PE_MACHINE_X64)
    assertPeMachine(buildRes.indexer.exePath, PE_MACHINE_X64)

    report.artifacts = {
      uiaccess: buildRes.uiaccess,
      uiaccessStandard: buildRes.uiaccessStandard,
      indexer: buildRes.indexer
    }
  })()

  // 2. Test JSON-RPC Protocol Roundtrip on ztools-uiaccess-standard
  const uiaccessExe = path.join(outBinDir, 'ztools-uiaccess-standard.exe')
  await recordTest('JSON-RPC Round-trip & Ping on UIAccess Worker', async () => {
    const client = createRpcClient(uiaccessExe, ['--mock'])
    try {
      const pong = await client.call('ping')
      assert.equal(pong, 'pong', 'ping should return pong')

      // Test invalid method error handling
      await assert.rejects(async () => {
        await client.call('non_existent_method_xyz')
      }, /Method not found/)
    } finally {
      await client.close()
    }
  })()

  // 3. Test UIAccess Capabilities (Active Window, Selected Text, Browser URL)
  await recordTest('UIAccess Worker: Active Window, Selection, and Browser URL', async () => {
    const client = createRpcClient(uiaccessExe, ['--mock'])
    try {
      // Test mock active window
      const win = await client.call('get_active_window')
      assert.equal(win.active, true)
      assert.equal(win.pid, 4321)
      assert.equal(win.title, 'Test Window - Edge Browser')
      assert.equal(win.process_name, 'msedge.exe')

      // Test selected text extraction
      const sel = await client.call('get_selected_text')
      assert.equal(sel.text, 'ZTools UIAccess Test Selected Text')
      assert.equal(sel.source, 'uia_text_pattern')

      // Test Chromium/Edge active tab URL
      const browser = await client.call('get_browser_url')
      assert.equal(browser.found, true)
      assert.equal(browser.url, 'https://ztools.local/test')
      assert.equal(browser.browser, 'msedge')

      // Test dynamic state update via set_mock_state
      await client.call('set_mock_state', {
        selected_text: 'Dynamic updated text from UI Automation',
        browser_url: 'https://github.com/microsoft/edge',
        browser_name: 'chrome'
      })

      const updatedSel = await client.call('get_selected_text')
      assert.equal(updatedSel.text, 'Dynamic updated text from UI Automation')

      const updatedUrl = await client.call('get_browser_url')
      assert.equal(updatedUrl.url, 'https://github.com/microsoft/edge')
      assert.equal(updatedUrl.browser, 'chrome')
    } finally {
      await client.close()
    }
  })()

  // 3.1 Test Window Management Native Capabilities
  await recordTest('UIAccess Worker: Window Management Actions & Fault Injections', async () => {
    const client = createRpcClient(uiaccessExe, ['--mock'])
    try {
      // Set mock monitor: 1920x1040 (40px taskbar) and mock window: 100,100, 800x600
      await client.call('set_mock_state', {
        mock_monitor: { x: 0, y: 0, width: 1920, height: 1040 },
        mock_window: { x: 100, y: 100, width: 800, height: 600 }
      })

      // 1. Left Half
      const leftRes = await client.call('manage_window', { action: 'left-half' })
      assert.equal(leftRes.success, true)
      assert.equal(leftRes.action, 'left-half')
      assert.equal(leftRes.rect.x, 0)
      assert.equal(leftRes.rect.y, 0)
      assert.equal(leftRes.rect.width, 960)
      assert.equal(leftRes.rect.height, 1040)

      // 2. Right Half
      const rightRes = await client.call('manage_window', { action: 'right-half' })
      assert.equal(rightRes.success, true)
      assert.equal(rightRes.rect.x, 960)
      assert.equal(rightRes.rect.width, 960)
      assert.equal(rightRes.rect.height, 1040)

      // 3. Top Half & Bottom Half
      const topRes = await client.call('manage_window', { action: 'top-half' })
      assert.equal(topRes.rect.height, 520)
      assert.equal(topRes.rect.y, 0)

      const bottomRes = await client.call('manage_window', { action: 'bottom-half' })
      assert.equal(bottomRes.rect.y, 520)
      assert.equal(bottomRes.rect.height, 520)

      // 4. Maximize
      const maxRes = await client.call('manage_window', { action: 'maximize' })
      assert.equal(maxRes.rect.width, 1920)
      assert.equal(maxRes.rect.height, 1040)

      // 5. First/Center/Last Thirds
      const firstThird = await client.call('manage_window', { action: 'first-third' })
      assert.equal(firstThird.rect.x, 0)
      assert.equal(firstThird.rect.width, 640)

      const centerThird = await client.call('manage_window', { action: 'center-third' })
      assert.equal(centerThird.rect.x, 640)
      assert.equal(centerThird.rect.width, 640)

      const lastThird = await client.call('manage_window', { action: 'last-third' })
      assert.equal(lastThird.rect.x, 1280)
      assert.equal(lastThird.rect.width, 640)

      // 6. Two Thirds
      const first2Thirds = await client.call('manage_window', { action: 'first-two-thirds' })
      assert.equal(first2Thirds.rect.width, 1280)

      const last2Thirds = await client.call('manage_window', { action: 'last-two-thirds' })
      assert.equal(last2Thirds.rect.x, 640)
      assert.equal(last2Thirds.rect.width, 1280)

      // 7. Make larger & make smaller
      const largerRes = await client.call('manage_window', { action: 'make-larger' })
      assert.ok(largerRes.rect.width >= 800)

      const smallerRes = await client.call('manage_window', { action: 'make-smaller' })
      assert.ok(smallerRes.rect.width >= 300)

      // 8. Fault Injection: Invalid Action
      await assert.rejects(async () => {
        await client.call('manage_window', { action: 'destroy_my_screen' })
      }, /Invalid window management action/)

      // 9. Fault Injection: Missing Action param
      await assert.rejects(async () => {
        await client.call('manage_window', {})
      }, /Missing action param/)
    } finally {
      await client.close()
    }
  })()

  // 3.2 Test Snippets Engine & Dynamic Template Expansion
  await recordTest('UIAccess Worker: Snippets Engine & Keystroke Simulation', async () => {
    const client = createRpcClient(uiaccessExe, ['--mock'])
    try {
      // 1. Set snippets
      const setRes = await client.call('set_snippets', {
        snippets: [
          { id: 'snip-1', name: 'Email Address', keyword: ':email', snippet: 'contact@ztools.org', enabled: true },
          { id: 'snip-2', name: 'Shrug Face', keyword: ':shrug', snippet: '¯\\_(ツ)_/¯', enabled: true },
          { id: 'snip-3', name: 'Dynamic Note', keyword: ':note', snippet: 'Date: {date} | Clip: {clipboard} | Cursor: [{cursor}]', enabled: true },
          { id: 'snip-4', name: 'Disabled Snippet', keyword: ':disabled', snippet: 'I am off', enabled: false }
        ]
      })
      assert.equal(setRes.success, true)
      assert.equal(setRes.count, 4)

      // 2. Get snippets
      const getRes = await client.call('get_snippets')
      assert.equal(getRes.snippets.length, 4)
      assert.equal(getRes.snippets[0].keyword, ':email')

      // 3. Expand simple snippet
      const expandSimple = await client.call('expand_snippet', { keyword: ':email' })
      assert.equal(expandSimple.found, true)
      assert.equal(expandSimple.expanded, 'contact@ztools.org')
      assert.equal(expandSimple.cursor_offset, 0)

      // 4. Expand dynamic snippet with date, clipboard, and cursor
      const today = new Date().toISOString().slice(0, 10)
      const expandDynamic = await client.call('expand_snippet', {
        keyword: ':note',
        clipboard: 'Reverse Engineering Raycast'
      })
      assert.equal(expandDynamic.found, true)
      assert.ok(expandDynamic.expanded.includes(`Date: ${today}`), 'Should include current formatted date')
      assert.ok(expandDynamic.expanded.includes('Clip: Reverse Engineering Raycast'), 'Should include clipboard text')
      assert.ok(expandDynamic.expanded.endsWith('Cursor: []'), 'Should strip {cursor} tag')
      assert.equal(expandDynamic.cursor_offset, 1, 'Cursor should be positioned right inside the brackets')

      // 5. Simulate keystrokes matching
      const simMatch = await client.call('simulate_keystrokes', {
        input: 'Please send message to :email',
        clipboard: ''
      })
      assert.equal(simMatch.matched, true)
      assert.equal(simMatch.keyword, ':email')
      assert.equal(simMatch.backspace_count, 6)
      assert.equal(simMatch.expanded, 'contact@ztools.org')

      // 6. Simulate keystrokes non-matching
      const simNoMatch = await client.call('simulate_keystrokes', {
        input: 'Regular typing without any triggers',
        clipboard: ''
      })
      assert.equal(simNoMatch.matched, false)

      // 7. Simulate keystrokes on disabled snippet
      const simDisabled = await client.call('simulate_keystrokes', {
        input: 'Testing :disabled',
        clipboard: ''
      })
      assert.equal(simDisabled.matched, false, 'Disabled snippet should not trigger')

      // 8. Test PasteToActive RPC
      const pasteRes = await client.call('paste_to_active', { target_hwnd: 0 })
      assert.equal(pasteRes.success, true)

      // 9. Fault Injection: Expand missing keyword
      await assert.rejects(async () => {
        await client.call('expand_snippet', {})
      }, /Missing keyword param/)

      // 10. Non-existent snippet returns found: false
      const nonExistent = await client.call('expand_snippet', { keyword: ':non_existent_404' })
      assert.equal(nonExistent.found, false)
    } finally {
      await client.close()
    }
  })()


  // 4. Test File Indexer: Directory Indexing & Chinese Pinyin Fuzzy Match
  const indexerExe = path.join(outBinDir, 'ztools-indexer.exe')
  await recordTest('File Indexer: Real Small-Dataset Completion Regression', () => testIndexerSmallDatasetConcurrency(indexerExe))()
  await recordTest('File Indexer: Directory Scan & Chinese Pinyin Fuzzy Match', async () => {
    const client = createRpcClient(indexerExe)
    try {
      const pong = await client.call('ping')
      assert.equal(pong, 'pong')

      // Index the electron-client native directory
      const nativeDir = path.join(rootDir, 'native')
      const indexRes = await client.call('index_path', { path: nativeDir, scanner: 'auto' })
      assert.ok(indexRes.total_indexed > 0, 'Should index files from native directory')
      console.log(`    Indexed ${indexRes.total_indexed} files from native dir in ${indexRes.elapsed_ms}ms using ${indexRes.scanner_used}`)

      // Search for "main"
      const searchRes = await client.call('search_files', { query: 'main', limit: 10 })
      assert.ok(searchRes.count > 0, 'Should find main files')
      assert.ok(searchRes.files.some(f => f.name.includes('main')), 'Result should contain main.cpp')

      // Verify concurrent ping & search_files do not block while heavy indexing runs
      const heavyIndexPromise = client.call('generate_mock_dataset', { count: 300000 })
      const pingStart = performance.now()
      const concurrentPong = await client.call('ping')
      const pingElapsed = performance.now() - pingStart
      assert.equal(concurrentPong, 'pong', 'Concurrent ping during indexing must return pong')
      assert.ok(pingElapsed < 500, `Concurrent ping should not be blocked by indexing (took ${pingElapsed.toFixed(2)}ms)`)
      await heavyIndexPromise

      // 4.1 中文目录名、超 4 层目录 Stage 1+2 边界接续零重复/零遗漏校验
      const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-indexer-test-'))
      const junctionsToCleanup = []
      try {
        const deepOnlyRoot = path.join(tempBase, '深层校验根目录')
        const deepDirs = [
          path.join(deepOnlyRoot, '一级中文目录_测试'),
          path.join(deepOnlyRoot, '一级中文目录_测试', '二级中文目录_微信'),
          path.join(deepOnlyRoot, '一级中文目录_测试', '二级中文目录_微信', '三级中文目录_文档'),
          path.join(deepOnlyRoot, '一级中文目录_测试', '二级中文目录_微信', '三级中文目录_文档', '四级中文目录_计算器'),
          path.join(deepOnlyRoot, '一级中文目录_测试', '二级中文目录_微信', '三级中文目录_文档', '四级中文目录_计算器', '五级中文目录_边界后'),
          path.join(deepOnlyRoot, '一级中文目录_测试', '二级中文目录_微信', '三级中文目录_文档', '四级中文目录_计算器', '五级中文目录_边界后', '六级中文目录_极限深度')
        ]
        for (let i = 0; i < deepDirs.length; i++) {
          fs.mkdirSync(deepDirs[i], { recursive: true })
          fs.writeFileSync(path.join(deepDirs[i], `stage_check_lvl${i + 1}_中文样本.txt`), `level ${i + 1}`)
        }
        // 共 6 个目录 + 6 个文件 = 12 个条目，使用 staged: true 强制走 Stage 1 (depth 4) + Stage 2 (boundary_dirs) 合并流程
        const stagedDeepRes = await client.call('index_path', { path: deepOnlyRoot, scanner: 'directory', staged: true })
        assert.equal(stagedDeepRes.total_indexed, 12, `Stage 1+2 should index exact 12 entries without omission or duplication (actual: ${stagedDeepRes.total_indexed})`)

        const stageLevelSearch = await client.call('search_files', { query: 'stage_check_lvl', limit: 50 })
        assert.equal(stageLevelSearch.count, 6, 'All 6 depth levels must be returned by Stage 1+2')
        const uniqueStagePaths = new Set(stageLevelSearch.files.map(f => f.path))
        assert.equal(uniqueStagePaths.size, 6, 'Stage 1+2 must not produce duplicate file paths')

        const cnDirSearch = await client.call('search_files', { query: '六级中文目录', limit: 20 })
        assert.ok(cnDirSearch.files.some(f => f.is_dir && f.name === '六级中文目录_极限深度'), 'Deep Chinese directory name must be indexed and searchable')

        const cnFileSearch = await client.call('search_files', { query: '中文样本', limit: 20 })
        assert.equal(cnFileSearch.count, 6, 'All 6 deep Chinese files should be searchable')

        // 4.2 Windows 精细过滤策略与 Junction 重解析点 / 循环联接防死循环验证
        const complexRoot = path.join(tempBase, '复杂过滤与联接测试')
        const externalTarget = path.join(tempBase, '外部联接真实目标')
        fs.mkdirSync(complexRoot, { recursive: true })
        fs.mkdirSync(path.join(externalTarget, '外接深层子目录'), { recursive: true })
        fs.writeFileSync(path.join(externalTarget, 'junction_external_doc_外部联接文档.txt'), 'external')
        fs.writeFileSync(path.join(externalTarget, '外接深层子目录', 'junction_deep_target_深层目标.txt'), 'external-deep')

        // 黑名单过滤验证：node_modules 与 __pycache__
        fs.mkdirSync(path.join(complexRoot, 'node_modules', 'pkg'), { recursive: true })
        fs.writeFileSync(path.join(complexRoot, 'node_modules', 'pkg', 'ignored_nm_file.js'), 'ignored')
        fs.mkdirSync(path.join(complexRoot, '__pycache__'), { recursive: true })
        fs.writeFileSync(path.join(complexRoot, '__pycache__', 'ignored_pyc_file.pyc'), 'ignored')

        // AppData / ProgramData 精细放行与拦截验证
        const fakeAppData = path.join(complexRoot, 'UserHome', 'AppData')
        const fakeStartMenu = path.join(fakeAppData, 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        const fakeAppDataTemp = path.join(fakeAppData, 'Local', 'Temp')
        const fakeWindowsApps = path.join(fakeAppData, 'Local', 'Microsoft', 'WindowsApps')
        const fakeLocalPrograms = path.join(fakeAppData, 'Local', 'Programs', 'MyCodeApp')
        fs.mkdirSync(fakeStartMenu, { recursive: true })
        fs.mkdirSync(fakeAppDataTemp, { recursive: true })
        fs.mkdirSync(fakeWindowsApps, { recursive: true })
        fs.mkdirSync(fakeLocalPrograms, { recursive: true })
        fs.writeFileSync(path.join(fakeStartMenu, '模拟微信快捷方式.lnk'), 'lnk')
        fs.writeFileSync(path.join(fakeAppDataTemp, 'should_skip_appdata_temp_noise.tmp'), 'noise')
        fs.writeFileSync(path.join(fakeWindowsApps, 'should_skip_windowsapps_noise.exe'), 'alias')
        fs.writeFileSync(path.join(fakeLocalPrograms, 'my_local_program_entry.exe'), 'exe')

        const fakeProgramData = path.join(complexRoot, 'ProgramData')
        const fakePdStartMenu = path.join(fakeProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        const fakePdCache = path.join(fakeProgramData, 'Package Cache')
        fs.mkdirSync(fakePdStartMenu, { recursive: true })
        fs.mkdirSync(fakePdCache, { recursive: true })
        fs.writeFileSync(path.join(fakePdStartMenu, '全局开始菜单应用.lnk'), 'lnk')
        fs.writeFileSync(path.join(fakePdCache, 'should_skip_pkg_cache.msi'), 'cache')

        // Program Files 浅层（3 层内可扫、4 层以后截断）验证
        const pfShallowDir = path.join(complexRoot, 'Program Files', 'VendorA', 'AppB', 'Bin')
        const pfTooDeepDir = path.join(pfShallowDir, 'SubCache', 'TooDeep')
        fs.mkdirSync(pfTooDeepDir, { recursive: true })
        fs.writeFileSync(path.join(pfShallowDir, 'pf_shallow_app_entry.exe'), 'exe')
        fs.writeFileSync(path.join(pfTooDeepDir, 'pf_too_deep_ignored.dat'), 'ignored')

        if (process.platform === 'win32') {
          // 为模拟的 AppData 和 ProgramData 设置真实的 Windows 隐藏属性（+H）
          spawnSync('attrib', ['+H', fakeAppData], { windowsHide: true })
          spawnSync('attrib', ['+H', fakeProgramData], { windowsHide: true })

          // 1) 正常外部 Junction（使用 mklink /J 验证目录联接可被深入扫描）
          const normalJunction = path.join(complexRoot, '中文目录联接_ExternalLink')
          const mkRes1 = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', normalJunction, externalTarget], { windowsHide: true })
          assert.equal(mkRes1.status, 0, `mklink /J failed: ${mkRes1.stderr?.toString()}`)
          junctionsToCleanup.push(normalJunction)

          // 2) 多级目录内的祖先循环 Junction 与互指环 Junction
          const loopLevel1 = path.join(complexRoot, 'loop_a')
          const loopLevel2 = path.join(loopLevel1, 'loop_b')
          fs.mkdirSync(loopLevel2, { recursive: true })
          fs.writeFileSync(path.join(loopLevel2, 'loop_inner_file.txt'), 'ok')

          const loopToParent = path.join(loopLevel2, 'loop_back_to_a')
          const mkRes2 = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', loopToParent, loopLevel1], { windowsHide: true })
          assert.equal(mkRes2.status, 0, 'mklink /J loop_back_to_a failed')
          junctionsToCleanup.push(loopToParent)

          const loopToRoot = path.join(loopLevel2, 'loop_back_to_root')
          const mkRes3 = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', loopToRoot, complexRoot], { windowsHide: true })
          assert.equal(mkRes3.status, 0, 'mklink /J loop_back_to_root failed')
          junctionsToCleanup.push(loopToRoot)

          const extSelfLoop = path.join(externalTarget, 'external_self_loop')
          const mkRes4 = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', extSelfLoop, externalTarget], { windowsHide: true })
          assert.equal(mkRes4.status, 0, 'mklink /J external_self_loop failed')
          junctionsToCleanup.push(extSelfLoop)

          const ringA = path.join(complexRoot, 'ring_a')
          const ringB = path.join(complexRoot, 'ring_b')
          fs.mkdirSync(ringA, { recursive: true })
          fs.mkdirSync(ringB, { recursive: true })
          fs.writeFileSync(path.join(ringA, 'ring_a_file.txt'), 'a')
          fs.writeFileSync(path.join(ringB, 'ring_b_file.txt'), 'b')
          const ringAToB = path.join(ringA, 'to_b')
          const ringBToA = path.join(ringB, 'to_a')
          assert.equal(spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', ringAToB, ringB], { windowsHide: true }).status, 0)
          assert.equal(spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', ringBToA, ringA], { windowsHide: true }).status, 0)
          junctionsToCleanup.push(ringAToB, ringBToA)
        }

        const complexRes = await client.call('index_path', { path: complexRoot, scanner: 'directory', staged: true })
        assert.ok(complexRes.total_indexed > 0, 'Complex directory scan should succeed without hanging on junction loops')
        assert.ok(complexRes.elapsed_ms < 5000, `Junction loop guard must finish quickly (actual: ${complexRes.elapsed_ms}ms)`)

        // 校验白名单与过滤命中情况
        assert.equal((await client.call('search_files', { query: '模拟微信快捷方式', limit: 10 })).count, 1, 'AppData Start Menu shortcut must be indexed')
        assert.equal((await client.call('search_files', { query: '全局开始菜单应用', limit: 10 })).count, 1, 'ProgramData Start Menu shortcut must be indexed')
        assert.equal((await client.call('search_files', { query: 'my_local_program_entry', limit: 10 })).count, 1, 'AppData\\Local\\Programs entry must be indexed')
        assert.equal((await client.call('search_files', { query: 'pf_shallow_app_entry', limit: 10 })).count, 1, 'Program Files shallow entry must be indexed')

        assert.equal((await client.call('search_files', { query: 'pf_too_deep_ignored', limit: 10 })).count, 0, 'Program Files deep cache must be skipped')
        assert.equal((await client.call('search_files', { query: 'should_skip_appdata_temp_noise', limit: 10 })).count, 0, 'AppData\\Local\\Temp noise must be skipped')
        assert.equal((await client.call('search_files', { query: 'should_skip_windowsapps_noise', limit: 10 })).count, 0, 'WindowsApps alias must be skipped')
        assert.equal((await client.call('search_files', { query: 'should_skip_pkg_cache', limit: 10 })).count, 0, 'ProgramData non-StartMenu cache must be skipped')
        assert.equal((await client.call('search_files', { query: 'ignored_nm_file', limit: 10 })).count, 0, 'node_modules must be skipped')
        assert.equal((await client.call('search_files', { query: 'ignored_pyc_file', limit: 10 })).count, 0, '__pycache__ must be skipped')

        if (process.platform === 'win32') {
          const extDocRes = await client.call('search_files', { query: 'junction_external_doc', limit: 10 })
          assert.equal(extDocRes.count, 1, 'Normal Windows Junction target file must be indexed')
          const extDeepRes = await client.call('search_files', { query: 'junction_deep_target', limit: 10 })
          assert.equal(extDeepRes.count, 1, 'Normal Windows Junction deep subdir file must be indexed')
          assert.ok((await client.call('search_files', { query: 'loop_inner_file', limit: 10 })).count >= 1, 'Directory containing loop junction must still index normal files')
          assert.ok((await client.call('search_files', { query: 'ring_a_file', limit: 10 })).count >= 1, 'Mutually linked ring_a file must be indexed without infinite loop')
          assert.ok((await client.call('search_files', { query: 'ring_b_file', limit: 10 })).count >= 1, 'Mutually linked ring_b file must be indexed without infinite loop')
        }
      } finally {
        for (const jPath of junctionsToCleanup) {
          try {
            fs.rmdirSync(jPath)
          } catch {
            // Ignore cleanup failure for non-existent junction
          }
        }
        try {
          fs.rmSync(tempBase, { recursive: true, force: true })
        } catch {
          // Ignore temp cleanup failure
        }
      }

      // 4.2.5 热插拔增量同步验证：模拟移动硬盘 / U 盘插入与拔出，验证只扫新增卷且拔出立即清理旧路径
      const hotplugBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-indexer-hotplug-'))
      try {
        const volA = path.join(hotplugBase, 'DriveA_Fixed')
        const volB = path.join(hotplugBase, 'DriveB_UsbRemovable')
        fs.mkdirSync(volA, { recursive: true })
        fs.mkdirSync(volB, { recursive: true })
        fs.writeFileSync(path.join(volA, 'fixed_report_alpha.docx'), 'alpha')
        fs.writeFileSync(path.join(volB, 'usb_contract_beta.docx'), 'beta')

        const initSync = await client.call('sync_drives', { roots: [volA] })
        assert.equal(initSync.changed, true)
        assert.equal(initSync.added_count, 1)
        assert.equal(initSync.total_indexed, 1)
        assert.equal((await client.call('search_files', { query: 'fixed_report_alpha', limit: 10 })).count, 1)
        assert.equal((await client.call('search_files', { query: 'usb_contract_beta', limit: 10 })).count, 0)

        // 插入 U 盘（volB）：仅增量扫描 volB 并合并
        const plugSync = await client.call('sync_drives', { roots: [volA, volB] })
        assert.equal(plugSync.changed, true)
        assert.equal(plugSync.added_count, 1)
        assert.equal(plugSync.removed_count, 0)
        assert.equal(plugSync.total_indexed, 2)
        assert.equal((await client.call('search_files', { query: '.docx', limit: 10 })).count, 2, 'Both fixed and newly plugged USB drive files must match extension query')

        // 卷列表无变化时零开销跳过
        const noopSync = await client.call('sync_drives', { roots: [volA, volB] })
        assert.equal(noopSync.changed, false)
        assert.equal(noopSync.added_count, 0)
        assert.equal(noopSync.removed_count, 0)

        // 拔出 U 盘（volB）：立即剔除 volB 条目，保留 volA 条目
        const unplugSync = await client.call('sync_drives', { roots: [volA] })
        assert.equal(unplugSync.changed, true)
        assert.equal(unplugSync.removed_count, 1)
        assert.equal(unplugSync.total_indexed, 1)
        assert.equal((await client.call('search_files', { query: 'usb_contract_beta', limit: 10 })).count, 0, 'Unplugged USB drive file must be removed immediately')
        assert.equal((await client.call('search_files', { query: 'fixed_report_alpha', limit: 10 })).count, 1, 'Fixed drive file must remain intact after USB unplug')
      } finally {
        fs.rmSync(hotplugBase, { recursive: true, force: true })
      }

      // 4.3 全新进程验证全盘并发扫描 ("*")，验证多盘（含固定硬盘与就绪可移动盘）并发索引与多盘结果覆盖
      const allDrivesClient = createRpcClient(indexerExe, [], 300000)
      try {
        const allDrivesRes = await allDrivesClient.call('index_path', { path: '*', scanner: 'auto' }, 300000)
        const indexedDrives = Array.isArray(allDrivesRes.indexed_drives) ? allDrivesRes.indexed_drives : []
        console.log(`    Indexed ${allDrivesRes.total_indexed} files from drives [${indexedDrives.join(', ')}] in ${allDrivesRes.elapsed_ms}ms (${allDrivesRes.scanner_used})`)
        assert.equal(allDrivesRes.scanner_used, 'all_drives_concurrent')
        assert.ok(indexedDrives.length >= 1, 'Must report at least one indexed drive')
        assert.ok(allDrivesRes.total_indexed > 1000, `Full drive index should exceed legacy 701 count (actual: ${allDrivesRes.total_indexed})`)

        const statsRes = await allDrivesClient.call('get_stats')
        assert.equal(statsRes.indexing, false)
        assert.ok(Array.isArray(statsRes.indexed_drives) && statsRes.indexed_drives.length === indexedDrives.length)
      } finally {
        await allDrivesClient.close()
      }
    } finally {
      await client.close()
    }
  })()

  // 5. Million-File (1,000,000 files) Stress Benchmark & Latency Verification (< 10ms)
  await recordTest('File Indexer: 1,000,000 Files Stress Benchmark (< 10ms guarantee)', async () => {
    const client = createRpcClient(indexerExe)
    try {
      console.log('    Generating 1,000,000 file records in memory...')
      const genRes = await client.call('generate_mock_dataset', { count: 1000000 })
      assert.equal(genRes.total_indexed, 1000000, 'Should index exactly 1,000,000 files')
      console.log(`    Generated & Flat-Trie-indexed 1,000,000 files in ${genRes.elapsed_ms}ms`)

      const queries = [
        { q: 'wx', desc: 'Chinese acronym (微信 -> wx)' },
        { q: 'jsq', desc: 'Chinese acronym (计算器 -> jsq)' },
        { q: 'wzry', desc: 'Chinese acronym (王者荣耀 -> wzry)' },
        { q: 'bdwp', desc: 'Chinese acronym (百度网盘 -> bdwp)' },
        { q: '微信', desc: 'Exact Chinese Hanzi (微信)' },
        { q: '计算器', desc: 'Exact Chinese Hanzi (计算器)' },
        { q: 'visual', desc: 'English prefix (Visual Studio Code)' },
        { q: 'Chrome', desc: 'English browser name (Chrome)' },
        { q: 'weixin', desc: 'Full Pinyin match (weixin)' },
        { q: 'Code', desc: 'Common English word substring' }
      ]

      const latencyResults = []
      for (const item of queries) {
        const res = await client.call('search_files', { query: item.q, limit: 20 })
        assert.ok(res.elapsed_ms < 10.0, `Query '${item.q}' must complete in < 10ms (actual: ${res.elapsed_ms}ms)`)
        assert.ok(res.count > 0, `Query '${item.q}' should return results`)

        latencyResults.push({
          query: item.q,
          desc: item.desc,
          count: res.count,
          total_matches: res.total_matches,
          elapsed_us: res.elapsed_us,
          elapsed_ms: res.elapsed_ms
        })

        console.log(`    Query [${item.q}] (${item.desc}): ${res.elapsed_ms}ms (${res.elapsed_us}us) - ${res.count} results`)
      }

      const avgMs = latencyResults.reduce((a, b) => a + b.elapsed_ms, 0) / latencyResults.length
      const maxMs = Math.max(...latencyResults.map(r => r.elapsed_ms))
      const minMs = Math.min(...latencyResults.map(r => r.elapsed_ms))

      console.log(`    ------------------------------------------------------------------`)
      console.log(`    1,000,000 Files Benchmark Summary:`)
      console.log(`    Min Latency: ${minMs.toFixed(3)}ms | Max Latency: ${maxMs.toFixed(3)}ms | Avg Latency: ${avgMs.toFixed(3)}ms`)
      console.log(`    SLA Compliance (< 10ms): 100% Passed!`)
      console.log(`    ------------------------------------------------------------------`)

      report.benchmark = {
        totalFiles: 1000000,
        minMs,
        maxMs,
        avgMs,
        queries: latencyResults
      }
    } finally {
      await client.close()
    }
  })()

  // 6. Test SidecarManager in Main Process (Lifecycle, Heartbeat, Auto-restart, Degradation)
  await recordTest('SidecarManager: Lifecycle, Keepalive, Crash Auto-Recovery & Degradation', async () => {
    // Dynamic import of compiled SidecarManager
    const { SidecarManager } = await import('../../out/main/services/sidecar-manager.js')
    const manager = new SidecarManager()

    try {
      await manager.startAll()
      const status = manager.getStatus()
      console.log('    Initial Status:', JSON.stringify(status))

      assert.ok(status.indexer.state === 'running', 'Indexer should be running')
      assert.ok(status.indexer.pid !== null, 'Indexer should have a PID')

      // Verify honest degradation when indexer is running but has 0 indexed entries
      const emptyFallbackSearch = await manager.searchFiles('nonexistent_empty_index_probe', 10)
      assert.equal(emptyFallbackSearch.degraded, true, 'Non-empty query falling back to local-fs on empty index must report degraded=true')

      // Test indexer via SidecarManager with real directory so crash recovery can auto re-index
      const recoveryFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-manager-recovery-'))
      try {
        fs.writeFileSync(path.join(recoveryFixture, 'crash_recovery_sentinel.docx'), 'sentinel')
        const idxRes = await manager.indexPath(recoveryFixture, 'directory')
        assert.equal(idxRes.total_indexed, 1)
        const preCrash = await manager.searchFiles('crash_recovery_sentinel', 10)
        assert.equal(preCrash.count, 1)

        // Test Crash Detection, Automatic Restart & Automatic Re-Indexing:
        const originalPid = manager['indexerProcess'].pid
        assert.ok(originalPid !== null, 'Original PID should exist')
        console.log(`    Simulating crash on indexer PID ${originalPid}...`)

        manager['indexerProcess'].child.kill('SIGKILL')

        // Wait for auto-restart backoff (500ms) + auto re-index
        await new Promise(r => setTimeout(r, 1800))

        const restartedStatus = manager.getStatus()
        console.log('    Post-crash Status:', JSON.stringify(restartedStatus))
        assert.equal(restartedStatus.indexer.state, 'running', 'Indexer should have automatically recovered to running state')
        assert.notEqual(restartedStatus.indexer.pid, originalPid, 'New process should have a different PID')
        assert.equal(restartedStatus.indexer.restarts, 1, 'Restart counter should be incremented')

        // Verify that requests succeed AND index was automatically restored on the recovered process
        const pingRes = await manager['indexerProcess'].sendRequest('ping')
        assert.equal(pingRes, 'pong', 'Recovered indexer process should respond to RPC')
        const postCrash = await manager.searchFiles('crash_recovery_sentinel', 10)
        assert.equal(postCrash.count, 1, 'Indexer must automatically re-index previous target after crash recovery')
      } finally {
        fs.rmSync(recoveryFixture, { recursive: true, force: true })
      }

      // Test mock dataset search via SidecarManager
      const mockRes = await manager.generateMockDataset(10000)
      assert.equal(mockRes.total_indexed, 10000)
      const searchRes = await manager.searchFiles('wx', 10)
      assert.ok(searchRes.count > 0)
      console.log(`    Manager searchFiles('wx'): ${searchRes.count} results in ${searchRes.elapsed_ms}ms`)

      // Test active window query (falls back gracefully if unsigned/background)
      const win = await manager.getActiveWindow()
      assert.ok(typeof win.active === 'boolean')

      // Test Graceful Degradation:
      // When stopped or unavailable, searchFiles should use in-memory JS fallback without throwing
      await manager.stop()
      const degradedSearch = await manager.searchFiles('test', 10)
      assert.ok(degradedSearch.degraded === true, 'Should use degraded fallback when stopped')
      console.log('    Graceful degradation verified: fallback responded cleanly')
    } finally {
      await manager.stop()
    }
  })()

  console.log('\n======================================================================')
  console.log(' ALL TESTS PASSED SUCCESSFULLY! (100% PASS RATE)')
  console.log('======================================================================')

  return report
}

try {
  const report = await runTests()
  // Save test report to disk
  const reportPath = path.join(rootDir, 'artifacts', 'sidecars-test-report.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`Test report saved to: ${reportPath}`)
  process.exit(0)
} catch (err) {
  console.error('\nTest suite failed:', err)
  process.exit(1)
}
