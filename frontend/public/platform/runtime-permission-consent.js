(() => {
  'use strict'
  const normalizeLocale = (raw) => {
    const normalized = String(raw || '').trim().split(/[.@]/)[0].replace(/_/g, '-').toLowerCase()
    return normalized === 'zh' || normalized.startsWith('zh-') ? 'zh-CN' : 'en-US'
  }
  const resolveLocale = () => {
    const raw =
      window.ztoolsRuntimeCapabilityPrompt?.locale ||
      window.__ztoolsElectron?.initialLocale ||
      window.__ztoolsPermissionPrompt?.locale ||
      (typeof navigator !== 'undefined' ? navigator.language : '') ||
      ''
    return normalizeLocale(raw)
  }
  const MESSAGES = {
    'zh-CN': {
      docTitle: '插件屏幕访问权限申请',
      heading: '是否允许该插件获取屏幕画面？',
      pluginNameLabel: '申请插件：',
      pluginIdLabel: '插件标识：',
      scopeNote: '本次授权仅在当前插件打开期间有效。关闭插件窗口或在高级设置中撤销后，将自动失效。',
      deny: '拒绝',
      allow: '允许访问'
    },
    'en-US': {
      docTitle: 'Plugin Screen Access Request',
      heading: 'Allow this plugin to capture your screen?',
      pluginNameLabel: 'Plugin: ',
      pluginIdLabel: 'Plugin ID: ',
      scopeNote: 'This permission is valid only while this plugin remains open. It is revoked automatically when you close the plugin window or revoke it in Settings.',
      deny: 'Deny',
      allow: 'Allow Access'
    }
  }
  const applyLocale = (locale) => {
    const resolved = normalizeLocale(locale)
    const copy = MESSAGES[resolved] || MESSAGES['en-US']
    if (document.documentElement) document.documentElement.lang = resolved
    document.title = copy.docTitle
    const titleEl = document.getElementById('prompt-title')
    const pluginNameLabelEl = document.getElementById('prompt-plugin-name-label')
    const pluginIdLabelEl = document.getElementById('prompt-plugin-id-label')
    const scopeNoteEl = document.getElementById('prompt-scope-note')
    const denyEl = document.querySelector('[data-testid="runtime-capability-deny"]')
    const allowEl = document.querySelector('[data-testid="runtime-capability-allow"]')
    if (titleEl) titleEl.textContent = copy.heading
    if (pluginNameLabelEl) pluginNameLabelEl.textContent = copy.pluginNameLabel
    if (pluginIdLabelEl) pluginIdLabelEl.textContent = copy.pluginIdLabel
    if (scopeNoteEl) scopeNoteEl.textContent = copy.scopeNote
    if (denyEl) denyEl.textContent = copy.deny
    if (allowEl) allowEl.textContent = copy.allow
  }

  applyLocale(resolveLocale())

  const bridge = window.ztoolsRuntimeCapabilityPrompt
  const root = document.querySelector('[data-testid="runtime-capability-prompt"]')
  const allow = document.querySelector('[data-testid="runtime-capability-allow"]')
  const deny = document.querySelector('[data-testid="runtime-capability-deny"]')
  const name = document.querySelector('[data-testid="runtime-capability-plugin-name"]')
  const id = document.querySelector('[data-testid="runtime-capability-plugin-id"]')
  const purpose = document.querySelector('[data-testid="runtime-capability-purpose"]')
  if (!bridge || !root || !allow || !deny || !name || !id || !purpose) return

  let answered = false
  const unsubscribe = bridge.onRequest(request => {
    if (request && typeof request.locale === 'string' && request.locale.trim()) {
      applyLocale(request.locale)
    }
    name.textContent = request.pluginName
    id.textContent = request.pluginId
    purpose.textContent = request.purpose
  })
  const answer = async allowed => {
    if (answered) return
    answered = true
    allow.disabled = true
    deny.disabled = true
    try {
      await bridge.answer(allowed)
    } catch {
      // Main closes or times out the prompt if its one-shot response is no longer active.
    } finally {
      unsubscribe()
    }
  }
  allow.addEventListener('click', () => { void answer(true) })
  deny.addEventListener('click', () => { void answer(false) })
})()
