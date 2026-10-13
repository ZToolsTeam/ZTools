import fs from 'node:fs'

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json')
  const targets = await res.json()
  const launcherTarget = targets.find((t) => t.url.includes('mode=launcher'))
  if (!launcherTarget) {
    console.log('未找到 launcher target')
    return
  }
  console.log(`[CDP] 连接极客悬浮窗: ${launcherTarget.id}`)
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

  // 查看页面 HTML 关键部分
  const domInfo = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const isLauncherRoot = Boolean(document.querySelector('.launcher-window-root'));
        const input = document.querySelector('input');
        const inputPlaceholder = input ? input.placeholder : null;
        const items = Array.from(document.querySelectorAll('.launcher-window-root [class*="rounded-xl"]')).map(el => {
          const title = el.querySelector('.truncate')?.textContent?.trim();
          const faIcon = el.querySelector('i')?.className;
          return { title, faIcon };
        });
        const buttons = Array.from(document.querySelectorAll('.launcher-window-root button')).map(b => b.textContent?.trim());
        return { isLauncherRoot, inputPlaceholder, itemsCount: items.length, sampleItems: items.slice(0, 6), buttons };
      })()
    `,
    returnByValue: true
  })
  console.log('[CDP] 悬浮窗 DOM 数据:', JSON.stringify(domInfo.result?.value, null, 2))

  // 截取悬浮窗图片
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('current_live_launcher.png', Buffer.from(shot.data, 'base64'))
  console.log('[CDP] 极客悬浮窗截图已保存到: current_live_launcher.png')

  ws.close()
}

main().catch(console.error)
