async function initialize() {
  const status = document.querySelector('#status')
  const diagnostics = document.querySelector('#diagnostics')
  const bridge = window.__ztoolsElectron
  if (!bridge) throw new Error('Electron preload 未注入')
  const ready = await bridge.app.ready()
  if (!ready.success) throw new Error(ready.error.message)
  const result = await bridge.app.getDiagnostics()
  if (!result.success) throw new Error(result.error.message)
  status.textContent = '宿主已连接'
  diagnostics.textContent = JSON.stringify(result.data, null, 2)
}

initialize().catch((error) => {
  const status = document.querySelector('#status')
  status.textContent = error instanceof Error ? error.message : '初始化失败'
})
