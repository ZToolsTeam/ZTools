import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const electronClientRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(electronClientRoot, '..')
const outputDir = path.resolve(projectRoot, 'docs/screenshots/macos-parity')
fs.mkdirSync(outputDir, { recursive: true })

const CDP_PORT = parseInt(process.env.CDP_PORT || '9236', 10)

async function waitForCdpTarget(port, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const pages = await res.json()
        const page = pages.find(p => p.type === 'page' && (p.url.includes('ztools://') || p.url.includes('index.html'))) || pages.find(p => p.type === 'page')
        if (page && page.webSocketDebuggerUrl) {
          return page
        }
      }
    } catch {
      // retry
    }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`Timeout waiting for CDP page target on port ${port}`)
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 1
    this.pending = new Map()
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (err) => reject(err)
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            if (msg.error) rej(new Error(msg.error.message))
            else res(msg.result)
          }
        } catch {}
      }
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.seq++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return res?.result?.value
  }

  async captureScreenshot(filepath) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png'
    })
    const buf = Buffer.from(res.data, 'base64')
    fs.writeFileSync(filepath, buf)
    return { filepath, bytes: buf.length }
  }

  close() {
    if (this.ws) this.ws.close()
  }
}

const MACOS_PARITY_TARGETS = [
  { id: 'everything-file-search', batch: 'P1-1', name: 'Spotlight 文件秒搜与 Quick Look' },
  { id: 'window-management', batch: 'P1-2', name: 'macOS 窗口极速分屏与多屏调度' },
  { id: 'clipboard-history', batch: 'P1-3', name: '剪贴板历史与 Cmd+V 焦点直贴' },
  { id: 'snippets', batch: 'P1-4', name: '快捷短语与 {cursor} 光标回退' },
  { id: 'system', batch: 'P1-5', name: 'macOS 系统控制动作中枢' },
  { id: 'apple-shortcuts', batch: 'P1-6', name: 'macOS 快捷指令 (Apple Shortcuts)' },
  { id: 'kill-process', batch: 'P1-7', name: 'macOS 进程管理与核心守护进程保护' },
  { id: 'color-picker', batch: 'P1-8', name: '屏幕取色器与 WCAG 对比度分析' },
  { id: 'applications', batch: 'P2-1', name: 'macOS 应用管理与 ~/Library 残留卸载' },
  { id: 'navigation', batch: 'P2-2', name: '窗口切换与顶部菜单栏搜索 (Navigation)' },
  { id: 'screenshots', batch: 'P2-3', name: 'macOS 截图历史、OCR 与双栏预览' },
  { id: 'audio-device', batch: 'P2-4', name: 'CoreAudio 音频输入/输出设备切换' },
  { id: 'wifi-password-reveal', batch: 'P2-5', name: 'macOS 钥匙串 Wi-Fi 密码提取与二维码' },
  { id: 'windows-taskbar', batch: 'P2-6', name: '任务栏与 macOS Dock 程序坞治理' },
  { id: 'clean-keyboard', batch: 'P2-7', name: '清洁键盘锁与全键拦截模式' },
  { id: 'downloads-manager', batch: 'P2-8', name: '~/Downloads 下载目录智能整理' },
  { id: 'disk-analyzer', batch: 'P3-1', name: 'POSIX 根卷 / 磁盘空间分析中枢' },
  { id: 'qr-code', batch: 'P3-2', name: 'ISO/IEC 18004 标准二维码生成与解析' },
  { id: 'password-vault', batch: 'P3-2', name: 'AES-256-GCM 认证加密本地密码保险箱' },
  { id: 'dictionary', batch: 'P3-2', name: '英汉双解科技词典与原生 TTS 发音' },
  { id: 'homebrew', batch: 'P3-3', name: 'Homebrew (Formulae & Casks) 包管理器' },
  { id: 'script-commands', batch: 'P3-4', name: 'Script Commands 自定义脚本工作台' },
  { id: 'raycast-focus', batch: 'P3-4', name: 'Raycast Focus 专注时钟与应用屏蔽' },
  { id: 'calendar', batch: 'P3-4', name: 'Calendar 日程表与视频会议直达' },
  { id: 'web-searches', batch: 'P3-4', name: 'Web Searches 多源搜索、浏览器标签与通讯录' },
  { id: 'batch-video', batch: 'P3-5', name: '批量视频转码与瘦身工作台 (范式三标杆)' }
]

async function main() {
  const electronBin = process.platform === 'win32'
    ? path.join(electronClientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(electronClientRoot, 'node_modules', '.bin', 'electron')

  const userDataDir = path.resolve(projectRoot, '.tmp-cdp-userdata')
  const appDataDir = path.resolve(projectRoot, '.tmp-cdp-appdata')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(appDataDir, { recursive: true })

  const childEnv = {
    ...process.env,
    APPDATA: appDataDir,
    LOCALAPPDATA: appDataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
  delete childEnv.ELECTRON_RUN_AS_NODE

  console.log(`🚀 Launching real Electron instance with CDP port ${CDP_PORT}...`)
  const child = spawn(
    electronBin,
    [
      '.',
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1'
    ],
    {
      cwd: electronClientRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv
    }
  )
  child.stdout?.on('data', (chunk) => {
    const line = chunk.toString().trim()
    if (line) console.log(`[Electron] ${line}`)
  })
  child.stderr?.on('data', (chunk) => {
    const line = chunk.toString().trim()
    if (line) console.error(`[Electron:err] ${line}`)
  })

  try {
    const pageTarget = await waitForCdpTarget(CDP_PORT, 45000)
    console.log(`✅ Attached to CDP page: ${pageTarget.title} (${pageTarget.url})`)

    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl)
    await cdp.connect()

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 760,
      deviceScaleFactor: 1.5,
      mobile: false
    })
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      userAgentMetadata: {
        platform: 'macOS',
        platformVersion: '14.6.1',
        architecture: 'arm',
        model: '',
        mobile: false
      }
    })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin';`
    })

    // Wait for initial window.loadURL('ztools://web/index.html') to finish completely
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await cdp.evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('#app')?.innerHTML)`)
      if (ready) break
      await new Promise(r => setTimeout(r, 250))
    }

    // Ensure the Electron BrowserWindow is shown and sized nicely, and switch platform override to darwin
    await cdp.evaluate(`
      (async () => {
        window.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin';
        try {
          await window.__ztoolsElectron?.transport?.methods?.window_show?.({});
          await window.__ztoolsElectron?.transport?.methods?.window_set_size?.({ params: { width: 1180, height: 760, animate: false } });
        } catch {}
      })()
    `)

    const report = []

    // 00. Capture macOS Home Dashboard (pin macOS flagship plugins & expand all tiles so macOS built-in suite is prominently visible)
    await cdp.evaluate(`
      (async () => {
        window.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin';
        const macPinned = [
          'homebrew',
          'apple-shortcuts',
          'navigation',
          'raycast-focus',
          'script-commands',
          'calendar',
          'web-searches',
          'everything-file-search'
        ];
        const macOrder = [
          'homebrew',
          'apple-shortcuts',
          'navigation',
          'raycast-focus',
          'script-commands',
          'calendar',
          'web-searches',
          'everything-file-search',
          'window-management',
          'clipboard-history',
          'snippets',
          'system',
          'kill-process',
          'color-picker',
          'applications',
          'screenshots',
          'audio-device',
          'wifi-password-reveal',
          'windows-taskbar',
          'clean-keyboard',
          'downloads-manager',
          'disk-analyzer',
          'qr-code',
          'password-vault',
          'dictionary'
        ];
        try {
          await window.ztools?.config?.set?.('my-page.pinned', JSON.stringify(macPinned), false, 'my_page_settings.json');
          await window.ztools?.config?.set?.('my-page.recent-order', JSON.stringify(macOrder), false, 'my_page_settings.json');
        } catch {}
      })()
    `)
    await cdp.evaluate(`window.location.hash = '#/declarative/system'`)
    await new Promise(r => setTimeout(r, 400))
    await cdp.evaluate(`window.location.hash = '#/'`)
    await new Promise(r => setTimeout(r, 1200))
    await cdp.evaluate(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const expandBtn = buttons.find(b => (b.innerText || '').includes('查看全部'));
        if (expandBtn) expandBtn.click();
      })()
    `)
    await new Promise(r => setTimeout(r, 600))

    const homeInfo = await cdp.evaluate(`
      (() => {
        const text = document.body.innerText || '';
        return {
          title: document.title,
          hasHomebrew: text.includes('Homebrew'),
          hasAppleShortcuts: text.includes('macOS 快捷指令') || text.includes('Shortcuts'),
          hasNavigation: text.includes('窗口切换与菜单') || text.includes('Navigation'),
          sample: text.slice(0, 350).replace(/\\s+/g, ' ')
        };
      })()
    `)
    const homeShot = await cdp.captureScreenshot(path.join(outputDir, '00-macos-home-dashboard.png'))
    console.log(`📸 [00] macOS 工作台首页: ${(homeShot.bytes / 1024).toFixed(1)} KB | Homebrew=${homeInfo?.hasHomebrew}, Shortcuts=${homeInfo?.hasAppleShortcuts}`)
    report.push({
      index: 0,
      batch: 'Overview',
      id: 'macos-home-dashboard',
      name: 'macOS 极客工作台首页 (37 款官方内置插件矩阵)',
      filename: '00-macos-home-dashboard.png',
      filepath: homeShot.filepath,
      sizeKB: Number((homeShot.bytes / 1024).toFixed(1)),
      passed: homeShot.bytes > 20000,
      uiInfo: homeInfo
    })

    const FORBIDDEN_MOCK_MARKERS = [
      '/Users/geek/Projects',
      'sk-proj-9a8b7c6d5e4f3g2h1i0j',
      'AirPods Pro (2nd Gen)',
      'ZTools-Office-5G',
      'Geek-Home-WiFi6',
      'Cursor — ZTools (macOS)',
      'Q4_Financial_Model_2026.xlsx'
    ]

    // 01 ~ 25: Capture each macOS parity built-in plugin
    for (let i = 0; i < MACOS_PARITY_TARGETS.length; i++) {
      const target = MACOS_PARITY_TARGETS[i]
      const num = String(i + 1).padStart(2, '0')
      const filename = `${num}-${target.id}.png`
      const filepath = path.join(outputDir, filename)

      const platformMode = target.id === 'batch-video' ? 'win32' : 'darwin'
      await cdp.evaluate(`
        window.__ZTOOLS_PLATFORM_OVERRIDE__ = '${platformMode}';
        window.location.hash = '#/declarative/${target.id}';
      `)
      await new Promise(r => setTimeout(r, 650))

      // Wait until async host IPC loading finishes (spinner disappears)
      for (let waitStep = 0; waitStep < 18; waitStep++) {
        const stillLoading = await cdp.evaluate(`
          Boolean(document.querySelector('.declarative-mica-shell .animate-spin'))
        `)
        if (!stillLoading) break
        await new Promise(r => setTimeout(r, 220))
      }
      await new Promise(r => setTimeout(r, 250))

      const uiInfo = await cdp.evaluate(`
        (() => {
          const bodyText = document.body.innerText || '';
          const shell = document.querySelector('.declarative-mica-shell');
          const isError = bodyText.includes('未找到指定的声明式应用') || bodyText.includes('当前系统暂不可用');
          const headerTitle = document.querySelector('.truncate')?.innerText || '';
          const searchInput = document.querySelector('input')?.placeholder || '';
          const transportCheck = Boolean(window.__ztoolsElectron?.transport?.methods?.brew_exec && window.__ztoolsElectron?.transport?.methods?.navigation_search_menu_items);
          const shellButtons = shell ? Array.from(shell.querySelectorAll('button')).map(b => (b.innerText || '').trim().replace(/\\s+/g, ' ')).filter(Boolean) : [];
          return {
            hasShell: Boolean(shell),
            isError,
            headerTitle,
            searchInput,
            transportCheck,
            visibleActionButtonsCount: shellButtons.length,
            visibleActionButtonsSample: shellButtons.slice(0, 10),
            bodyText,
            sampleText: bodyText.slice(0, 360).replace(/\\s+/g, ' ')
          };
        })()
      `)

      const matchedMockMarkers = FORBIDDEN_MOCK_MARKERS.filter(m => (uiInfo?.bodyText || '').includes(m))
      if (uiInfo) delete uiInfo.bodyText

      const shot = await cdp.captureScreenshot(filepath)
      const passed =
        Boolean(uiInfo?.hasShell) &&
        !uiInfo?.isError &&
        matchedMockMarkers.length === 0 &&
        (uiInfo?.visibleActionButtonsCount || 0) >= 3 &&
        shot.bytes > 15000
      console.log(
        `📸 [${num}/${MACOS_PARITY_TARGETS.length}] (${target.batch}) ${target.id}: ${(shot.bytes / 1024).toFixed(1)} KB | Buttons=${uiInfo?.visibleActionButtonsCount} | MockMarkers=${matchedMockMarkers.length} | ${passed ? '✅ PASS' : '❌ FAIL'}`
      )
      if (matchedMockMarkers.length > 0) {
        console.warn(`   ⚠️ Detected mock markers in ${target.id}:`, matchedMockMarkers)
      }

      report.push({
        index: i + 1,
        batch: target.batch,
        id: target.id,
        name: target.name,
        filename,
        filepath,
        sizeKB: Number((shot.bytes / 1024).toFixed(1)),
        passed,
        matchedMockMarkers,
        uiInfo
      })
    }

    const reportPath = path.join(outputDir, 'macos-parity-cdp-report.json')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    console.log(`\n🎉 CDP 截图与审查全部完成！共生成 ${report.length} 张真实渲染截图，报告已保存至: ${reportPath}`)

    cdp.close()
  } finally {
    try {
      child.kill()
    } catch {}
  }
}

main().catch(err => {
  console.error('❌ CDP execution failed:', err)
  process.exit(1)
})
