// 首屏同步主题、强调色与语言初始化脚本（从 index.html 抽离以配合严格 CSP 策略，禁止内联脚本）
;(function () {
  try {
    var isDark = localStorage.getItem('ztools_theme') === 'dark'
    document.documentElement.classList.toggle('dark', !!isDark)
    var accent = localStorage.getItem('ztools_accent')
    var validAccents = ['ember', 'glacier', 'jade', 'iris', 'crimson', 'mono']
    document.documentElement.dataset.accent = validAccents.indexOf(accent) !== -1 ? accent : 'ember'

    var matchLocale = function (raw) {
      if (typeof raw !== 'string') return ''
      var cleaned = raw.trim().split(/[.@]/)[0].trim().replace(/_/g, '-').toLowerCase()
      if (!cleaned || cleaned === 'system' || cleaned === 'auto' || cleaned === 'default') return ''
      if (cleaned === 'zh' || cleaned.indexOf('zh-') === 0) return 'zh-CN'
      if (cleaned === 'en' || cleaned.indexOf('en-') === 0) return 'en-US'
      return ''
    }
    var hostInitial = window.__ztoolsElectron && window.__ztoolsElectron.initialLocale
    var storedLocale = localStorage.getItem('ztools_locale')
    var navLocale = typeof navigator !== 'undefined' ? navigator.language : ''
    var resolvedLocale = ''
    if (typeof hostInitial === 'string' && hostInitial.trim()) {
      resolvedLocale = matchLocale(hostInitial) || matchLocale(navLocale) || 'en-US'
    } else if (typeof storedLocale === 'string' && storedLocale.trim()) {
      var storedNorm = storedLocale.trim().toLowerCase()
      resolvedLocale = storedNorm === 'system'
        ? (matchLocale(navLocale) || 'en-US')
        : (matchLocale(storedLocale) || 'en-US')
    } else {
      resolvedLocale = matchLocale(navLocale) || 'en-US'
    }
    document.documentElement.lang = resolvedLocale
    document.title = resolvedLocale === 'zh-CN'
      ? 'ZTools - 免费纯净的高效办公工具箱'
      : 'ZTools - Free, Clean Productivity Hub'
  } catch (err) {
    // 忽略受限上下文中 localStorage 不可用等初始化异常
    void err
  }
})()
