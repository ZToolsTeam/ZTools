/** macOS 实机验收：先 npm run build:test，再用 Electron 执行此文件。 */
const { app, globalShortcut } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { HotkeyProbeService, nativeHotkeyProbe } = require('../out-test/src/main/services/hotkey-probe-service.js')
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-hotkey-probe-'))
app.setPath('userData', dataRoot)
let child, held
const watchdog = setTimeout(() => { console.error('实机热键测试超时'); child?.kill('SIGTERM'); app.exit(1) }, 20000)
app.on('will-quit', () => { clearTimeout(watchdog); if (held) globalShortcut.unregister(held); fs.rmSync(dataRoot, { recursive: true, force: true }) })
function waitForOutput(proc, expected) {
  return new Promise((resolve, reject) => {
    let output = ''
    const data = b => { output += b.toString(); if (output.includes(expected)) { cleanup(); resolve() } }
    const ended = () => { cleanup(); reject(new Error(`子进程未就绪：${output}`)) }
    const cleanup = () => { proc.stdout.off('data', data); proc.off('exit', ended); proc.off('error', ended) }
    proc.stdout.on('data', data); proc.once('exit', ended); proc.once('error', ended)
  })
}
app.whenReady().then(async () => {
  app.dock?.hide()
  if (process.platform !== 'darwin') throw new Error('本验收需要 macOS')
  const childMode = process.argv.indexOf('--hold')
  if (childMode !== -1) {
    held = process.argv[childMode + 1]
    if (!globalShortcut.register(held, () => undefined)) throw new Error('子进程注册失败')
    process.stdin.once('data', () => { globalShortcut.unregister(held); held = null; app.quit() })
    console.log('HOTKEY_HOLDER_READY'); return
  }
  const keyMapping = path.join(dataRoot, 'key-mapping-test')
  execFileSync('xcrun', ['clang++', '-fobjc-arc', path.join(__dirname, '../native/ZToolsMacHotkeys/key_mapping_test.mm'), '-framework', 'Foundation', '-framework', 'Carbon', '-o', keyMapping])
  process.stdout.write(execFileSync(keyMapping, { encoding: 'utf8' }))
  const native = nativeHotkeyProbe(path.join(__dirname, '../out/mac-hotkeys-native/native/ZToolsMacHotkeys'))
  const service = new HotkeyProbeService(native, globalShortcut, () => app.isReady())
  const probe = combos => service.probe({ combos })
  const evidence = []
  const combo = 'Control+Alt+Shift+Command+F13'
  assert.equal((await probe([combo])).results[0].status, 'registered', '测试专用键已占用，停止以免干扰其他应用')
  assert.ok(combo, '找不到可供隔离验收的快捷键'); assert.equal(globalShortcut.isRegistered(combo), false)
  evidence.push({ check: '实际注册成功且返回前已释放', combo, passed: true })
  held = combo; assert.equal(globalShortcut.register(combo, () => undefined), true)
  assert.equal((await probe([combo])).results[0].status, 'owned'); assert.equal(globalShortcut.isRegistered(combo), true)
  globalShortcut.unregister(combo); held = null; evidence.push({ check: '当前进程已有注册保留', passed: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(process.execPath, [__filename, '--hold', combo], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', b => process.stderr.write(b))
  await waitForOutput(child, 'HOTKEY_HOLDER_READY')
  assert.equal((await probe([combo])).results[0].status, 'registered'); assert.equal(globalShortcut.isRegistered(combo), false)
  evidence.push({ check: '其他进程共享注册不能完整识别，结果不宣称无冲突', passed: true })
  const ended = once(child, 'exit'); child.stdin.write('release\n'); const [exitCode] = await ended; assert.equal(exitCode, 0); child = null
  assert.equal((await probe([combo])).results[0].status, 'registered'); assert.equal(globalShortcut.isRegistered(combo), false)
  evidence.push({ check: '其他进程退出释放后恢复可注册', passed: true })
  const holder = path.join(dataRoot, 'exclusive-holder')
  execFileSync('xcrun', ['clang++', path.join(__dirname, 'fixtures/hotkey-holder.mm'), '-framework', 'Carbon', '-o', holder])
  child = spawn(holder, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  await waitForOutput(child, 'HOTKEY_HOLDER_READY')
  assert.equal((await probe([combo])).results[0].status, 'occupied')
  const nativeEnded = once(child, 'exit'); child.stdin.write('release\n'); assert.equal((await nativeEnded)[0], 0); child = null
  assert.equal((await probe([combo])).results[0].status, 'registered')
  evidence.push({ check: '真实独占进程占用检测及退出后恢复', passed: true })
  for (let i = 0; i < 20; i++) assert.equal((await probe([combo])).results[0].status, 'registered')
  assert.equal(globalShortcut.isRegistered(combo), false); evidence.push({ check: '重复20次，临时原生进程退出，无持有残留', passed: true })
  globalShortcut.setSuspended(true)
  try { await assert.rejects(probe([combo]), /暂停/) } finally { globalShortcut.setSuspended(false) }
  evidence.push({ check: '真实暂停状态拒绝探测', passed: true })
  console.log(JSON.stringify({ success: true, platform: process.platform, electron: process.versions.electron, evidence }, null, 2)); app.quit()
}).catch(error => { console.error(error); child?.kill('SIGTERM'); if (held) globalShortcut.unregister(held); app.exit(1) })
