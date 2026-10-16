import fs from 'node:fs'
import path from 'node:path'

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json/list')
  const targets = await res.json()
  const page = targets.find(t => t.type === 'page')
  if (!page) {
    console.error('No page target found!')
    process.exit(1)
  }
  console.log('Connecting to:', page.title, page.url)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(msg.error)
      else resolve(msg.result)
    }
  }

  await new Promise((resolve) => { ws.onopen = resolve })
  console.log('CDP WebSocket connected')

  await send('Page.enable')
  await send('Runtime.enable')

  // 1. 刷新页面以载入最新的前端与声明式组件
  console.log('Reloading page...')
  await send('Page.reload', { ignoreCache: true })
  await new Promise(r => setTimeout(r, 2500))

  // 2. 导航到 process-monitor
  console.log('Navigating to #/declarative/process-monitor...')
  await send('Runtime.evaluate', {
    expression: 'window.location.hash = "#/declarative/process-monitor"'
  })

  // 等待 3 秒以使 ProcessMonitorCommand 完成数据拉取与视图绘制
  await new Promise(r => setTimeout(r, 3000))

  // 3. 检查页面状态
  const inspectRes = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hash: window.location.hash,
      bodyTextSnippet: document.body.innerText.slice(0, 400),
      hasMetricCards: document.querySelectorAll('.metric-card').length,
      hasSegmentedControl: !!document.querySelector('.segmented-control'),
      listItemsCount: document.querySelectorAll('.declarative-list-item').length,
      hasDetailPanel: !!document.querySelector('.declarative-detail-sidebar, .detail-container, [data-detail-panel]')
    })`,
    returnByValue: true
  })
  console.log('Current Page Inspection:', JSON.parse(inspectRes.result.value))

  // 4. 截取主界面全景
  const screenshotRes = await send('Page.captureScreenshot', {
    format: 'png',
    quality: 100
  })

  const outputDir = path.resolve('docs/screenshots/plugins')
  fs.mkdirSync(outputDir, { recursive: true })
  const screenshotPath = path.join(outputDir, '03-process-monitor.png')
  fs.writeFileSync(screenshotPath, Buffer.from(screenshotRes.data, 'base64'))
  console.log('Screenshot saved to:', screenshotPath)

  ws.close()
}

main().catch(console.error)
