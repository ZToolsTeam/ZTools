const WS = globalThis.WebSocket

async function test() {
  const pages = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
  const target = pages.find((p) => p.url.includes('ztools://web/index.html') && !p.url.includes('launcher'))
  if (!target) {
    console.error('No main page target found')
    process.exit(1)
  }
  console.log('Connecting to target:', target.id, target.url)
  const ws = new WS(target.webSocketDebuggerUrl)
  let id = 1
  const pending = new Map()

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = id++
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params }))
    })
  }

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(msg.error)
      else resolve(msg.result)
    }
  })

  await new Promise((r) => ws.addEventListener('open', r))
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.bringToFront')

  const evalCode = async (code) => {
    const r = await send('Runtime.evaluate', {
      expression: code,
      returnByValue: true,
      awaitPromise: true
    })
    return r.result?.value
  }

  // 确保处于主页
  await evalCode(`(async () => {
    window.focus()
    const myItem = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('我的插件'))
    if (myItem) myItem.click()
    await new Promise(r => setTimeout(r, 100))
  })()`)

  console.log('\n--- 1. 测试点击 [设置] ---')
  const settingsRes = await evalCode(`(async () => {
    const item = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('设置'))
    if (!item) return { error: 'Settings not found' }
    const t0 = performance.now()
    item.click()
    await new Promise(r => setTimeout(r, 0))
    const t1 = performance.now()
    return {
      activeClass: item.classList.contains('active'),
      hash: location.hash,
      durationMs: Number((t1 - t0).toFixed(2))
    }
  })()`)
  console.log('设置响应时效:', settingsRes)

  // 回到主页
  await evalCode(`(async () => {
    const myItem = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('我的插件'))
    if (myItem) myItem.click()
    await new Promise(r => setTimeout(r, 100))
  })()`)

  console.log('\n--- 2. 测试点击 [关于] ---')
  const aboutRes = await evalCode(`(async () => {
    const item = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('关于'))
    if (!item) return { error: 'About not found' }
    const t0 = performance.now()
    item.click()
    await new Promise(r => setTimeout(r, 0))
    const t1 = performance.now()
    return {
      activeClass: item.classList.contains('active'),
      hash: location.hash,
      durationMs: Number((t1 - t0).toFixed(2))
    }
  })()`)
  console.log('关于响应时效:', aboutRes)

  // 回到主页
  await evalCode(`(async () => {
    const myItem = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('我的插件'))
    if (myItem) myItem.click()
    await new Promise(r => setTimeout(r, 100))
  })()`)

  console.log('\n--- 3. 测试点击 [反馈建议] ---')
  const wishRes = await evalCode(`(async () => {
    const item = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('反馈建议'))
    if (!item) return { skipped: '当前模式下无反馈建议项' }
    const t0 = performance.now()
    item.click()
    await new Promise(r => setTimeout(r, 0))
    const t1 = performance.now()
    return {
      activeClass: item.classList.contains('active'),
      hash: location.hash,
      durationMs: Number((t1 - t0).toFixed(2))
    }
  })()`)
  console.log('反馈建议响应时效:', wishRes)

  // 回到主页
  await evalCode(`(async () => {
    const myItem = Array.from(document.querySelectorAll('.sidebar-item')).find(el => el.textContent.includes('我的插件'))
    if (myItem) myItem.click()
    await new Promise(r => setTimeout(r, 200))
  })()`)

  ws.close()
}

test().catch(console.error)
