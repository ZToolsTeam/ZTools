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

  const send = (expr) =>
    new Promise((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data).result?.result?.value)
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: expr, returnByValue: true }
        })
      )
    })

  const routeInfo = await send(
    'JSON.stringify(document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$router?.currentRoute?.value)'
  )
  console.log('路由信息:', routeInfo)
  ws.close()
}

main().catch(console.error)
