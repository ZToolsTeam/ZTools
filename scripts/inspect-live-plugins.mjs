import fs from 'node:fs'

async function main() {
  const res = await fetch('http://127.0.0.1:9222/json')
  const targets = await res.json()
  const target = targets.find((t) => t.url.includes('ztools://web/index.html'))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  let id = 0
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      const handler = (evt) => {
        const d = JSON.parse(evt.data)
        if (d.id === msgId) {
          ws.removeEventListener('message', handler)
          if (d.error) reject(new Error(d.error.message))
          else resolve(d.result)
        }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })

  // Return to home page #/
  await send('Runtime.evaluate', {
    expression: `(async () => {
      const app = document.querySelector('#app')?.__vue_app__
      const router = app?.config?.globalProperties?.$router
      if (router) {
        await router.push({ name: 'my' })
      }
    })()`,
    awaitPromise: true
  })
  await new Promise((r) => setTimeout(r, 1000))

  const shotHome = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync('current_live_home_final.png', Buffer.from(shotHome.data, 'base64'))
  console.log('[CDP] Saved current_live_home_final.png')

  ws.close()
}

main().catch(console.error)
