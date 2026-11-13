// 先构建客户端，再执行：npx electron tests/scripts/test-macos-region-spaces.cjs
// 会短暂创建独立的全屏测试窗口与框选遮罩；不截取屏幕像素，不读取日常数据。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, ipcMain, protocol, screen } = require('electron')

if (process.platform !== 'darwin' || !process.versions.electron) {
  throw new Error('此回归需要在 macOS 上使用 Electron 运行')
}
const isSpaceHost = process.argv.includes('--space-host')
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-region-space-test-'))
app.setPath('userData', dataRoot)
protocol.registerSchemesAsPrivileged([{ scheme: 'ztools', privileges: { standard: true, secure: true } }])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let spaceHost
let finished = false
const watchdog = setTimeout(() => finish(new Error('框选桌面回归超时')), 45000)
process.on('SIGTERM', () => finish())
// 遮罩关闭后测试进程可能暂时没有窗口，不能让默认行为提前退出。
app.on('window-all-closed', () => {})

function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  if (error) console.error(error)
  spaceHost?.kill('SIGTERM')
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.exit(error ? 1 : 0)
}

async function runSpaceHost() {
  const window = new BrowserWindow({ width: 800, height: 600, show: false })
  await window.loadURL('data:text/html,<title>Space Test</title><h1>Space Test</h1>')
  process.on('disconnect', () => finish())
  app.focus({ steal: true })
  window.show()
  window.focus()
  // 等待原生激活完成，再请求全屏，避免将两次 macOS 窗口事务重叠。
  await delay(400)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('全屏切换超时')), 6000)
    window.once('enter-full-screen', () => { clearTimeout(timer); resolve() })
    window.setFullScreen(true)
  })
  await delay(700)
  process.send({ event: 'fullscreen', fullscreen: window.isFullScreen(), focused: window.isFocused() })
}

async function runSelection() {
  const { MacRegionSelection } = require('../../out/main/platform/macos/region-selection.js')
  // 保留真实 preload、选择器状态机与原生遮罩窗口，只替换页面资源和 SDK 握手边界。
  ipcMain.on('ztools:sdk-lane', event => { event.returnValue = null })
  protocol.handle('ztools', () => new Response('<html><title>Region Test</title><body style="background:rgba(0,0,0,.2)"></body></html>',
    { headers: { 'Content-Type': 'text/html' } }))
  assert.equal(app.dock.isVisible(), true, '测试开始前 Dock 必须可见')
  spaceHost = spawn(process.execPath, [__filename, '--space-host'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const hostState = await new Promise((resolve, reject) => {
    spaceHost.once('message', resolve)
    spaceHost.once('exit', code => reject(new Error(`桌面进程提前退出: ${code}`)))
  })
  assert.equal(hostState.fullscreen, true, '必须先进入外部全屏桌面')

  const selection = new MacRegionSelection(path.resolve(__dirname, '../../out/preload/main.js'), { platform: 'darwin', timeoutMs: 20000 })
  const controller = new AbortController()
  const display = screen.getPrimaryDisplay().bounds
  const pending = selection.select([display], controller.signal)
  let overlay
  for (let attempt = 0; attempt < 50 && !overlay?.isVisible(); attempt++) {
    await delay(100)
    overlay = BrowserWindow.getAllWindows()[0]
  }
  assert.ok(overlay?.isVisible(), '框选遮罩必须显示')
  await delay(500)
  const state = { visible: overlay.isVisible(), focused: overlay.isFocused(), allSpaces: overlay.isVisibleOnAllWorkspaces(),
    fullscreen: overlay.isFullScreen(), dock: app.dock.isVisible() }
  console.log(JSON.stringify(state))
  assert.equal(state.allSpaces, true, '原生 panel 遮罩必须支持跨桌面')
  assert.equal(state.focused, true, '遮罩必须获得输入焦点以响应 Esc')
  assert.equal(state.fullscreen, false, '遮罩不能成为全屏主窗口')
  assert.equal(state.dock, true, '显示遮罩不能隐藏 Dock 或改变应用激活策略')

  controller.abort()
  await assert.rejects(pending, '取消后选择必须以错误结束')
  await delay(500)
  assert.equal(BrowserWindow.getAllWindows().length, 0, '取消后遮罩必须全部关闭')
  assert.equal(app.dock.isVisible(), true, '遮罩关闭后 Dock 必须保持可见')
  console.log(JSON.stringify({ passed: true, state }))
}

app.whenReady().then(() => isSpaceHost ? runSpaceHost() : runSelection())
  .then(() => { if (!isSpaceHost) finish() }).catch(finish)
