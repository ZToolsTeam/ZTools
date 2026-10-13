import fs from 'node:fs'
import path from 'node:path'

async function getTargets() {
  const res = await fetch('http://127.0.0.1:9222/json')
  return await res.json()
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.id = 0
    this.callbacks = new Map()
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (err) => reject(err)
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data)
        if (data.id && this.callbacks.has(data.id)) {
          const { resolve, reject } = this.callbacks.get(data.id)
          this.callbacks.delete(data.id)
          if (data.error) reject(new Error(data.error.message))
          else resolve(data.result)
        }
      }
    })
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.callbacks.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async captureScreenshot(outputPath) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const buffer = Buffer.from(res.data, 'base64')
    fs.writeFileSync(outputPath, buffer)
    console.log(`[CDP] 截图已保存到: ${outputPath} (${buffer.length} bytes)`)
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    return res.result?.value
  }

  close() {
    if (this.ws) {
      this.ws.close()
    }
  }
}

async function main() {
  const mode = process.argv[2] || 'screenshot_all'
  const targets = await getTargets()
  console.log(`[CDP] 发现 ${targets.length} 个目标页面:`)
  for (const t of targets) {
    console.log(` - [${t.type}] ${t.title || 'untitled'} (${t.url}) -> ${t.id}`)
  }

  // 1. 查找大工作台页面 (url 包含 index.html#/)
  const dashboardTarget = targets.find((t) => t.url.includes('#/') && !t.url.includes('#/launcher')) || targets[0]
  if (dashboardTarget && (mode === 'screenshot_all' || mode === 'dashboard' || mode === 'trigger_launcher')) {
    console.log(`[CDP] 连接大工作台: ${dashboardTarget.title}`)
    const client = new CdpClient(dashboardTarget.webSocketDebuggerUrl)
    await client.connect()
    await client.send('Page.enable')

    // 截取大工作台
    await client.captureScreenshot('current_live_dashboard.png')

    if (mode === 'trigger_launcher') {
      console.log('[CDP] 在大工作台触发极客模式...')
      const evalRes = await client.eval(`
        (() => {
          const hasLauncher = Boolean(window.__ztoolsLauncher);
          const hasLauncherShow = typeof window.__ztoolsLauncher?.show === 'function';
          let error = null;
          if (hasLauncherShow) {
            window.__ztoolsLauncher.show().catch(err => { error = String(err); });
          }
          return { hasLauncher, hasLauncherShow, error };
        })()
      `)
      console.log('[CDP] 触发结果:', evalRes)
    }
    client.close()
  }

  // 等待悬浮窗打开并刷新 target 列表
  if (mode === 'trigger_launcher' || mode === 'launcher' || mode === 'screenshot_all') {
    await new Promise((r) => setTimeout(r, 1000))
    const freshTargets = await getTargets()
    const launcherTarget = freshTargets.find((t) => t.url.includes('#/launcher'))
    if (launcherTarget) {
      console.log(`[CDP] 连接极客悬浮窗: ${launcherTarget.url}`)
      const client = new CdpClient(launcherTarget.webSocketDebuggerUrl)
      await client.connect()
      await client.send('Page.enable')
      await client.captureScreenshot('current_live_launcher.png')
      
      const inspectData = await client.eval(`
        (() => {
          const items = Array.from(document.querySelectorAll('.launcher-window-root [class*="rounded-xl"]')).map(el => {
            const title = el.querySelector('.truncate')?.textContent?.trim()
            const iconClass = el.querySelector('i')?.className
            return { title, iconClass }
          })
          const buttons = Array.from(document.querySelectorAll('.launcher-window-root button')).map(b => b.textContent?.trim())
          return { itemsCount: items.length, sampleItems: items.slice(0, 5), buttons }
        })()
      `)
      console.log('[CDP] 极客悬浮窗 DOM 探测数据:', JSON.stringify(inspectData, null, 2))
      client.close()
    } else {
      console.log('[CDP] 未检测到极客悬浮窗页面 target')
    }
  }
}

main().catch((err) => {
  console.error('[CDP] 执行错误:', err)
  process.exit(1)
})
