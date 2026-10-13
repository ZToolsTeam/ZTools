import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.resolve(__dirname, '../../docs/screenshots/plugins')
fs.mkdirSync(outputDir, { recursive: true })

async function getWsUrl() {
  const res = await fetch('http://127.0.0.1:9222/json/list')
  const pages = await res.json()
  const page = pages.find(p => p.type === 'page' && p.url.includes('ztools://')) || pages[0]
  if (!page || !page.webSocketDebuggerUrl) {
    throw new Error('未找到 Electron 页面 WebSocket 调试地址')
  }
  return page.webSocketDebuggerUrl
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
        const msg = JSON.parse(event.data)
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(msg.error.message))
          else res(msg.result)
        }
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
    return res.result?.value
  }

  async captureScreenshot(filepath) {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    const buf = Buffer.from(res.data, 'base64')
    fs.writeFileSync(filepath, buf)
    return filepath
  }

  close() {
    if (this.ws) this.ws.close()
  }
}

async function run() {
  const wsUrl = await getWsUrl()
  const cdp = new CdpClient(wsUrl)
  await cdp.connect()
  console.log('Connected to CDP:', wsUrl)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  // 诊断检查
  const diag = await cdp.evaluate(`
    (() => {
      return {
        route: window.__router?.currentRoute?.value,
        href: window.location.href
      };
    })()
  `)
  const testPlugins = ['calculator', 'clipboard-history', 'raycast-settings']

  for (const pluginId of testPlugins) {
    console.log(`Navigating to declarative plugin: ${pluginId}`)
    await cdp.evaluate(`
      if (window.__router) {
        window.__router.push({ name: 'declarative', params: { pluginId: '${pluginId}' } });
      } else {
        window.location.hash = '#/declarative/${pluginId}';
      }
    `)

    await new Promise(r => setTimeout(r, 1200))

    const title = await cdp.evaluate(`document.title`)
    const bodyText = await cdp.evaluate(`document.body.innerText.slice(0, 300)`)
    console.log(`Plugin: ${pluginId} | Title: ${title} | Text preview:\n${bodyText}\n---`)

    const screenshotPath = path.join(outputDir, `test-${pluginId}.png`)
    await cdp.captureScreenshot(screenshotPath)
    console.log(`Saved screenshot to: ${screenshotPath}`)
  }

  cdp.close()
}

run().catch(err => {
  console.error('Test run failed:', err)
  process.exit(1)
})
