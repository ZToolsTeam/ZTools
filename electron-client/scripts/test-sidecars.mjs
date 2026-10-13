import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import readline from 'node:readline'
import { buildAllSidecars } from './build-sidecars.mjs'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const outBinDir = path.join(rootDir, 'out', 'native', 'win32-x64', 'bin')

// Minimal JSON-RPC helper for direct process testing
function createRpcClient(exePath, args = []) {
  const child = spawn(exePath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const rl = readline.createInterface({ input: child.stdout })

  let reqId = 1
  const pending = new Map()

  rl.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) {
          reject(new Error(msg.error.message))
        } else {
          resolve(msg.result)
        }
      }
    } catch (err) {
      // Ignore non-json
    }
  })

  return {
    child,
    call(method, params = {}) {
      const id = reqId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    async close() {
      try {
        await this.call('shutdown', {})
      } catch {
        // Ignore shutdown error
      }
      child.kill('SIGTERM')
      rl.close()
    }
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
    const { SidecarManager } = await import('../out/main/services/sidecar-manager.js')
    const manager = new SidecarManager()

    try {
      await manager.startAll()
      const status = manager.getStatus()
      console.log('    Initial Status:', JSON.stringify(status))

      assert.ok(status.indexer.state === 'running', 'Indexer should be running')
      assert.ok(status.indexer.pid !== null, 'Indexer should have a PID')

      // Test indexer via SidecarManager
      const mockRes = await manager.generateMockDataset(10000)
      assert.equal(mockRes.total_indexed, 10000)
      const searchRes = await manager.searchFiles('wx', 10)
      assert.ok(searchRes.count > 0)
      console.log(`    Manager searchFiles('wx'): ${searchRes.count} results in ${searchRes.elapsed_ms}ms`)

      // Test active window query (falls back gracefully if unsigned/background)
      const win = await manager.getActiveWindow()
      assert.ok(typeof win.active === 'boolean')

      // Test Crash Detection & Automatic Restart:
      // Kill the indexer child process directly to simulate a crash
      const originalPid = manager['indexerProcess'].pid
      assert.ok(originalPid !== null, 'Original PID should exist')
      console.log(`    Simulating crash on indexer PID ${originalPid}...`)

      // Trigger unexpected exit
      manager['indexerProcess'].child.kill('SIGKILL')

      // Wait for auto-restart backoff (500ms + margin)
      await new Promise(r => setTimeout(r, 1200))

      const restartedStatus = manager.getStatus()
      console.log('    Post-crash Status:', JSON.stringify(restartedStatus))
      assert.equal(restartedStatus.indexer.state, 'running', 'Indexer should have automatically recovered to running state')
      assert.notEqual(restartedStatus.indexer.pid, originalPid, 'New process should have a different PID')
      assert.equal(restartedStatus.indexer.restarts, 1, 'Restart counter should be incremented')

      // Verify that requests succeed on the recovered process
      const pingRes = await manager['indexerProcess'].sendRequest('ping')
      assert.equal(pingRes, 'pong', 'Recovered indexer process should respond to RPC')

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
