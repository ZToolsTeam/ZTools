// 先构建客户端，再执行：npx electron tests/scripts/test-macos-launcher-spaces.cjs
// 会短暂创建独立的普通/全屏测试窗口；不读取日常数据，不注册用户快捷键。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, ipcMain, nativeImage, protocol } = require('electron')

if (process.platform !== 'darwin' || !process.versions.electron) {
  throw new Error('此回归需要在 macOS 上使用 Electron 运行')
}
const isSpaceHost = process.argv.includes('--space-host')
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-space-test-'))
app.setPath('userData', dataRoot)
protocol.registerSchemesAsPrivileged([{ scheme: 'ztools', privileges: { standard: true, secure: true } }])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let launcher
let spaceHost
let finished = false
const watchdog = setTimeout(() => finish(new Error('桌面回归超时')), 45000)
process.on('SIGTERM', () => finish())

function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  if (error) console.error(error)
  launcher?.stop()
  spaceHost?.kill('SIGTERM')
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch (cleanupError) {
    console.warn(cleanupError)
  }
  app.exit(error ? 1 : 0)
}

function changeFullscreen(window, fullscreen) {
  if (window.isFullScreen() === fullscreen) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const event = fullscreen ? 'enter-full-screen' : 'leave-full-screen'
    const timer = setTimeout(() => {
      window.removeListener(event, onChanged)
      reject(new Error('全屏切换超时'))
    }, 6000)
    const onChanged = () => { clearTimeout(timer); resolve() }
    window.once(event, onChanged)
    window.setFullScreen(fullscreen)
  })
}

async function runSpaceHost() {
  const window = new BrowserWindow({ width: 800, height: 600, show: false })
  await window.loadURL('data:text/html,<title>Space Test</title><h1>Space Test</h1>')
  process.on('disconnect', () => finish())
  process.on('message', async message => {
    try {
      if (message !== 'status') {
        app.focus({ steal: true })
        window.show()
        window.focus()
        // 等待原生激活完成，再请求全屏，避免将两次 macOS 窗口事务重叠。
        await delay(400)
        await changeFullscreen(window, message === 'fullscreen')
        await delay(700)
      }
      process.send({ event: message, fullscreen: window.isFullScreen(), focused: window.isFocused(), visible: window.isVisible() })
    } catch (error) { finish(error) }
  })
  process.send({ event: 'ready' })
}

function waitForHost(event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      spaceHost.removeListener('message', onMessage)
      spaceHost.removeListener('exit', onExit)
      spaceHost.removeListener('error', onError)
    }
    const onMessage = message => { if (message.event === event) { cleanup(); resolve(message) } }
    const onExit = code => { cleanup(); reject(new Error(`桌面进程提前退出: ${code}`)) }
    const onError = error => { cleanup(); reject(error) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`等待桌面事件超时: ${event}`)) }, 10000)
    spaceHost.on('message', onMessage)
    spaceHost.once('exit', onExit)
    spaceHost.once('error', onError)
  })
}

async function hostRequest(event) {
  const pending = waitForHost(event)
  spaceHost.send(event)
  return pending
}

async function runLauncher() {
  const { LauncherController } = require('../../out/main/windows/launcher-controller.js')
  const { WindowRegistry } = require('../../out/main/windows/window-registry.js')
  app.on('browser-window-created', (_event, window) => {
    window.on('blur', () => console.log(JSON.stringify({ event: 'native-blur-before-handler', at: Date.now(),
      id: window.id, visible: window.isVisible(), focused: window.isFocused(), appHidden: app.isHidden() })))
  })
  // 保留真实 preload、控制器与原生窗口，只替换页面资源和 SDK 握手边界。
  ipcMain.on('ztools:sdk-lane', event => {
    event.returnValue = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }
  })
  protocol.handle('ztools', () => new Response('<html><title>Launcher Test</title><input autofocus placeholder="Launcher Test"></html>',
    { headers: { 'Content-Type': 'text/html' } }))
  const workbench = new BrowserWindow({ width: 800, height: 600, show: false })
  launcher = new LauncherController({ icon: nativeImage.createEmpty(), registry: new WindowRegistry(),
    showMainWindow: () => workbench.show(), hideMainWindow: () => workbench.hide() })
  launcher.prewarm()
  const window = BrowserWindow.getAllWindows().find(candidate => candidate !== workbench)
  let currentMode = 'setup'
  for (const event of ['show', 'hide', 'focus', 'blur']) {
    window.on(event, () => console.log(JSON.stringify({ event, mode: currentMode, at: Date.now(),
      visible: window.isVisible(), focused: window.isFocused(), fullscreen: window.isFullScreen() })))
  }
  await new Promise((resolve, reject) => {
    window.webContents.once('did-finish-load', resolve)
    window.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)))
  })
  assert.equal(window.isFullScreenable(), false, '悬浮条不能成为全屏主窗口')
  assert.equal(window.isVisibleOnAllWorkspaces(), true, '原生 panel 必须支持跨桌面')
  assert.equal(app.dock.isVisible(), true, '预热悬浮条不能改变应用的 Dock/激活策略')
  spaceHost = spawn(process.execPath, [__filename, '--space-host'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  await waitForHost('ready')
  const results = []
  for (const mode of ['normal', 'fullscreen', 'normal', 'fullscreen', 'normal']) {
    currentMode = mode
    const desktopState = await hostRequest(mode)
    assert.equal(desktopState.focused, true, `${mode}: 必须先聚焦目标桌面上的窗口`)
    assert.equal(desktopState.visible, true, `${mode}: 目标桌面窗口必须实际可见`)
    assert.equal(desktopState.fullscreen, mode === 'fullscreen', `${mode}: 目标桌面类型必须符合场景`)
    assert.equal(window.isVisible(), false, '切换到外部窗口后悬浮条必须收起')
    console.log(JSON.stringify({ event: 'before-toggle', mode, at: Date.now(), visible: window.isVisible(), focused: window.isFocused() }))
    launcher.toggle()
    console.log(JSON.stringify({ event: 'after-toggle', mode, at: Date.now(), visible: window.isVisible(), focused: window.isFocused() }))
    await delay(800)
    const hostState = await hostRequest('status')
    const state = { mode, visible: window.isVisible(), focused: window.isFocused(), fullscreen: window.isFullScreen(), hostFocused: hostState.focused }
    results.push(state)
    console.log(JSON.stringify(state))
    assert.equal(state.visible, true, `${mode}: 悬浮条必须可见`)
    assert.equal(state.focused, true, `${mode}: 悬浮条必须获得输入焦点`)
    assert.equal(state.fullscreen, false, `${mode}: 悬浮条不能残留自身全屏状态`)
    assert.equal(hostState.fullscreen, mode === 'fullscreen', '不能改变外部窗口的全屏状态')
    launcher.toggle()
    await delay(300)
    assert.equal(window.isVisible(), false, '第二次唤醒必须收起')
    // 复用 Electron 可执行文件的两个测试进程可能被 macOS 归为同一应用；
    // show 外部测试窗口不等于鼠标点走非激活面板的焦点，因此显式触发原生 blur。
    launcher.toggle()
    await delay(300)
    assert.equal(window.isFocused(), true, '收起后应能再次唤醒')
    window.blur()
    await delay(300)
    assert.equal(window.isVisible(), false, '原生失焦事件必须撤下悬浮条')
  }
  console.log(JSON.stringify({ passed: true, results }))
}

app.whenReady().then(() => isSpaceHost ? runSpaceHost() : runLauncher())
  .then(() => { if (!isSpaceHost) finish() }).catch(finish)
