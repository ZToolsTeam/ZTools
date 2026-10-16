import fs from 'node:fs'
import path from 'node:path'

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json')
  const targets = await res.json()
  const page = targets.find(t => t.type === 'page' && t.url.includes('ztools://web'))
  if (!page) {
    console.error('No ZTools web page target found!')
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
  console.log('CDP connected')

  await send('Page.enable')
  await send('Runtime.enable')

  // 1. 确保在主页面并完全加载
  await send('Runtime.evaluate', {
    expression: 'window.location.hash = "#/"'
  })
  await new Promise(r => setTimeout(r, 1200))

  // 截图 1：展开状态（默认形态，小白基线）
  const snap1 = await send('Page.captureScreenshot', { format: 'png' })
  const out1 = path.resolve('live_main_window_scheme_a.png')
  fs.writeFileSync(out1, Buffer.from(snap1.data, 'base64'))
  console.log('Screenshot 1 saved to:', out1)

  // 2. 触发侧栏折叠
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.querySelector('.sidebar-toggle-btn');
        if (btn) btn.click();
      })()
    `
  })
  await new Promise(r => setTimeout(r, 600))

  // 截图 2：折叠状态（极客宽幅沉浸态）
  const snap2 = await send('Page.captureScreenshot', { format: 'png' })
  const out2 = path.resolve('live_main_window_collapsed.png')
  fs.writeFileSync(out2, Buffer.from(snap2.data, 'base64'))
  console.log('Screenshot 2 saved to:', out2)

  // 3. 恢复展开
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.querySelector('.sidebar-toggle-btn');
        if (btn) btn.click();
      })()
    `
  })
  console.log('Restored expanded state.')
  process.exit(0)
}

main().catch(err => {
  console.error('Capture failed:', err)
  process.exit(1)
})
