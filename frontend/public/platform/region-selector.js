(() => {
  'use strict'
  const resolveLocale = () => {
    const raw =
      window.__ztoolsElectron?.initialLocale ||
      window.__ztoolsPermissionPrompt?.locale ||
      (typeof navigator !== 'undefined' ? navigator.language : '') ||
      ''
    const normalized = String(raw).trim().split(/[.@]/)[0].replace(/_/g, '-').toLowerCase()
    return normalized === 'zh' || normalized.startsWith('zh-') ? 'zh-CN' : 'en-US'
  }
  const MESSAGES = {
    'zh-CN': {
      title: '选择截图区域',
      initialHint: '拖动选择当前屏幕的区域 · Esc 取消',
      confirm: '截取 · Enter',
      cancel: '取消',
      unavailable: '区域选择入口不可用',
      selectionHint: (width, height) => `${width} × ${height} DIP · Enter 截取 · Esc 取消`
    },
    'en-US': {
      title: 'Select Capture Area',
      initialHint: 'Drag to select an area on this screen · Esc to cancel',
      confirm: 'Capture · Enter',
      cancel: 'Cancel',
      unavailable: 'Region selection is unavailable',
      selectionHint: (width, height) => `${width} × ${height} DIP · Enter to capture · Esc to cancel`
    }
  }
  const locale = resolveLocale()
  const copy = MESSAGES[locale] || MESSAGES['en-US']
  const api = window.__ztoolsRegionSelection
  const box = document.getElementById('selection'), hint = document.getElementById('hint')
  const confirm = document.getElementById('confirm'), cancel = document.getElementById('cancel')
  if (document.documentElement) document.documentElement.lang = locale
  document.title = copy.title
  if (hint) hint.textContent = copy.initialHint
  if (confirm) confirm.textContent = copy.confirm
  if (cancel) cancel.textContent = copy.cancel
  if (!api || typeof api.submit !== 'function' || typeof api.cancel !== 'function') {
    if (hint) hint.textContent = copy.unavailable
    return
  }
  let start, rect, pointerId, finished = false
  const point = event => ({ x: Math.min(innerWidth, Math.max(0, event.clientX)), y: Math.min(innerHeight, Math.max(0, event.clientY)) })
  const update = end => {
    const x = Math.floor(Math.min(start.x, end.x)), y = Math.floor(Math.min(start.y, end.y))
    rect = { x, y, width: Math.ceil(Math.max(start.x, end.x)) - x, height: Math.ceil(Math.max(start.y, end.y)) - y }
    box.style.display = 'block'; box.style.left = `${rect.x}px`; box.style.top = `${rect.y}px`; box.style.width = `${rect.width}px`; box.style.height = `${rect.height}px`
    confirm.disabled = !rect.width || !rect.height; hint.textContent = copy.selectionHint(rect.width, rect.height)
  }
  const submit = () => { if (finished || !rect?.width || !rect?.height) return; finished = true; api.submit(rect) }
  const dismiss = () => { if (finished) return; finished = true; api.cancel() }
  document.addEventListener('pointerdown', event => {
    if (finished || event.button !== 0 || event.target.closest('#toolbar')) return
    pointerId = event.pointerId; start = point(event); update(start)
    try { document.documentElement.setPointerCapture(pointerId) } catch { /* 忽略非活动指针捕获异常 */ }
  })
  document.addEventListener('pointermove', event => { if (!finished && start && event.pointerId === pointerId) update(point(event)) })
  document.addEventListener('pointerup', event => {
    if (event.pointerId !== pointerId) return
    try { document.documentElement.releasePointerCapture(pointerId) } catch { /* 忽略释放指针捕获异常 */ }
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
