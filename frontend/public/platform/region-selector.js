(() => {
  'use strict'
  const api = window.__ztoolsRegionSelection
  const box = document.getElementById('selection'), hint = document.getElementById('hint')
  const confirm = document.getElementById('confirm'), cancel = document.getElementById('cancel')
  if (!api || typeof api.submit !== 'function' || typeof api.cancel !== 'function') { hint.textContent = '区域选择入口不可用'; return }
  let start, rect, pointerId, finished = false
  const point = event => ({ x: Math.min(innerWidth, Math.max(0, event.clientX)), y: Math.min(innerHeight, Math.max(0, event.clientY)) })
  const update = end => {
    const x = Math.floor(Math.min(start.x, end.x)), y = Math.floor(Math.min(start.y, end.y))
    rect = { x, y, width: Math.ceil(Math.max(start.x, end.x)) - x, height: Math.ceil(Math.max(start.y, end.y)) - y }
    box.style.display = 'block'; box.style.left = `${rect.x}px`; box.style.top = `${rect.y}px`; box.style.width = `${rect.width}px`; box.style.height = `${rect.height}px`
    confirm.disabled = !rect.width || !rect.height; hint.textContent = `${rect.width} × ${rect.height} DIP · Enter 截取 · Esc 取消`
  }
  const submit = () => { if (finished || !rect?.width || !rect?.height) return; finished = true; api.submit(rect) }
  const dismiss = () => { if (finished) return; finished = true; api.cancel() }
  document.addEventListener('pointerdown', event => {
    if (finished || event.button !== 0 || event.target.closest('#toolbar')) return
    pointerId = event.pointerId; start = point(event); update(start)
    try { document.documentElement.setPointerCapture(pointerId) } catch {}
  })
  document.addEventListener('pointermove', event => { if (!finished && start && event.pointerId === pointerId) update(point(event)) })
  document.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId) return
    try { document.documentElement.releasePointerCapture(pointerId) } catch {}
    pointerId = undefined
  })
  document.addEventListener('pointercancel', () => { pointerId = undefined; start = undefined; rect = undefined; box.style.display = 'none'; confirm.disabled = true })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss() }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit() }
  })
  document.addEventListener('contextmenu', event => { event.preventDefault(); dismiss() })
  confirm.addEventListener('click', submit); cancel.addEventListener('click', dismiss)
})()
