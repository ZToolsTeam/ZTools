import fs from 'node:fs'

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json')
  const targets = await res.json()
  const launcherTarget = targets.find((t) => t.url.includes('mode=launcher'))
  if (!launcherTarget) {
    console.log('未找到 launcher target')
    return
  }
  const ws = new WebSocket(launcherTarget.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))

  let msgId = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++msgId
      const handler = (e) => {
        const data = JSON.parse(e.data)
        if (data.id === id) {
          ws.removeEventListener('message', handler)
          if (data.error) reject(new Error(data.error.message))
          else resolve(data.result)
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Page.enable')

  // 1. 模拟输入拼音 "yp" 搜索音频
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const input = document.querySelector('input');
        input.value = 'yp';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `
  })

  // 等待过滤完成
  await new Promise((r) => setTimeout(r, 200))

  // 截图：拼音搜索效果
  const shotYp = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('current_live_launcher_search_yp.png', Buffer.from(shotYp.data, 'base64'))
  console.log('[CDP] 拼音搜索 yp 截图已保存: current_live_launcher_search_yp.png')

  // 2. 模拟按下 Ctrl+K 唤出 ActionPanel
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      })()
    `
  })
  await new Promise((r) => setTimeout(r, 300))

  const shotActionPanel = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('current_live_launcher_action_panel.png', Buffer.from(shotActionPanel.data, 'base64'))
  console.log('[CDP] ActionPanel 截图已保存: current_live_launcher_action_panel.png')

  ws.close()
}

main().catch(console.error)
