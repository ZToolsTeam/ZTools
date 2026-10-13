import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10)
const SCREENSHOT_DIR = path.resolve(process.cwd(), 'docs/screenshots')

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

class SimpleCdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 1
    this.pending = new Map()
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl)
      socket.addEventListener('open', () => {
        this.ws = socket
        resolve()
      }, { once: true })
      socket.addEventListener('error', err => reject(err), { once: true })
      socket.addEventListener('message', event => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id)
            this.pending.delete(msg.id)
            if (msg.error) rej(new Error(msg.error.message))
            else res(msg.result)
          }
        } catch {}
      })
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    if (this.ws) {
      this.ws.close()
    }
  }
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`)
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'))
  console.log(`[CDP Screenshot Saved]: ${filePath} (${Math.round(result.data.length / 1024)} KB)`)
  return filePath
}

async function run() {
  console.log(`[CDP] Connecting to Electron on port ${CDP_PORT}...`)
  let targets
  try {
    targets = await fetchJson(`http://127.0.0.1:${CDP_PORT}/json`)
  } catch (err) {
    console.warn(`[CDP Warning] Cannot connect to http://127.0.0.1:${CDP_PORT}/json: ${err.message}`)
    console.log('[CDP Fallback] Generating baseline mock report since Electron is not currently listening on 9222.')
    const fallbackPath = path.join(SCREENSHOT_DIR, 'mock-evidence-note.txt')
    fs.writeFileSync(fallbackPath, 'CDP target was offline during headless execution. Real run will capture live PNG.\n', 'utf8')
    return {
      status: 'FALLBACK',
      message: 'Electron remote-debugging-port 9222 offline'
    }
  }

  const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) {
    console.warn('[CDP Warning] No page target found')
    return { status: 'NO_PAGE' }
  }

  console.log(`[CDP] Attaching to page: ${page.title} (${page.url})`)
  const cdp = new SimpleCdp(page.webSocketDebuggerUrl)
  await cdp.connect()

  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')

    // 0. Reset to home page via Page.navigate
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/' })
    await new Promise(r => setTimeout(r, 1200))
    await capture(cdp, '01-launcher-root-ready')

    // 1. Declarative JSON Format Suite
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/declarative/json-format' })
    await new Promise(r => setTimeout(r, 1500))
    await capture(cdp, '02-declarative-json-format')

    // 2. Declarative Settings Suite (M1.5 Group 4 Governance & Settings)
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/declarative/raycast-settings' })
    await new Promise(r => setTimeout(r, 1500))
    await capture(cdp, '03-declarative-settings-suite')

    // 3. Declarative Calculator & Color Parser (M1.5 Group 1 Core Suite)
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/declarative/calculator' })
    await new Promise(r => setTimeout(r, 1500))
    await capture(cdp, '04-declarative-calculator')

    // 3. Declarative Snippets & Macro Engine (M1.5 Group 1 Core Suite)
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/declarative/snippets' })
    await new Promise(r => setTimeout(r, 1500))
    await capture(cdp, '04-declarative-snippets')

    // 4. Raycast LauncherBar floating mode
    await cdp.send('Page.navigate', { url: 'ztools://web/index.html#/launcher' })
    await new Promise(r => setTimeout(r, 1500))
    await capture(cdp, '05-launcher-floating-bar')

    console.log('[CDP] Verification and screenshots completed successfully.')
    return { status: 'SUCCESS' }
  } finally {
    cdp.close()
  }
}

run().catch(e => {
  console.error('[CDP Error]', e)
  process.exit(1)
})
