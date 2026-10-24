/**
 * 在 SDK 层统一接管 HTML title，通过宿主原生 HWND 显示 Tooltip。
 * 所有加载 ztools-api.js 的 CEF 页面与插件自动生效。
 */
class NativeTooltipInterceptor {
  static TOOLTIP_ATTRIBUTE = 'data-system-tooltip'
  static SHOW_DELAY = 500

  constructor(windowApi, options = {}) {
    this.windowApi = windowApi
    this.window = options.windowObj || window
    this.document = options.documentObj || document
    this.activeTrigger = null
    this.observer = null
    this.showTimer = 0
    this.tooltipVisible = false
    this.started = false
    this.attached = false
    this.generatedAriaLabels = new WeakMap()

    this.handleReady = this.attach.bind(this)
    this.handleMutations = this.onMutations.bind(this)
    this.handleMouseOver = this.onMouseOver.bind(this)
    this.handleMouseOut = this.onMouseOut.bind(this)
    this.handleFocusIn = this.onFocusIn.bind(this)
    this.handleFocusOut = this.onFocusOut.bind(this)
    this.handleKeyDown = this.onKeyDown.bind(this)
    this.hideTooltip = this.hideTooltip.bind(this)
  }

  start() {
    if (this.started) return
    this.started = true
    if (this.document.readyState === 'loading') {
      this.document.addEventListener('DOMContentLoaded', this.handleReady, {
        once: true
      })
    } else {
      this.attach()
    }
  }

  attach() {
    if (this.attached || !this.document.body) return
    this.attached = true
    this.document.body.querySelectorAll('[title]').forEach((element) => {
      this.normalizeTitle(element)
    })

    this.observer = new this.window.MutationObserver(this.handleMutations)
    this.observeDocument()
    this.document.addEventListener('mouseover', this.handleMouseOver, true)
    this.document.addEventListener('mouseout', this.handleMouseOut, true)
    this.document.addEventListener('focusin', this.handleFocusIn, true)
    this.document.addEventListener('focusout', this.handleFocusOut, true)
    this.document.addEventListener('keydown', this.handleKeyDown, true)
    this.document.addEventListener('scroll', this.hideTooltip, true)
    this.window.addEventListener('resize', this.hideTooltip)
    this.window.addEventListener('blur', this.hideTooltip)
  }

  observeDocument() {
    this.observer?.observe(this.document.body, {
      attributes: true,
      attributeFilter: [
        'title',
        NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
      ],
      childList: true,
      subtree: true
    })
  }

  callNative(method, ...args) {
    try {
      return Promise.resolve(this.windowApi?.[method]?.(...args))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  syncAriaLabel(element, text) {
    const generatedLabel = this.generatedAriaLabels.get(element)
    const currentLabel = element.getAttribute('aria-label')

    if (generatedLabel && currentLabel !== generatedLabel) {
      this.generatedAriaLabels.delete(element)
    }
    if (!text) {
      if (generatedLabel && currentLabel === generatedLabel) {
        element.removeAttribute('aria-label')
      }
      this.generatedAriaLabels.delete(element)
      return
    }
    if (!currentLabel || this.generatedAriaLabels.has(element)) {
      element.setAttribute('aria-label', text)
      this.generatedAriaLabels.set(element, text)
    }
  }

  normalizeTitle(element) {
    if (!(element instanceof this.window.Element)) return
    const title = element.getAttribute('title')
    if (title === null) return

    const text = title.trim()
    if (text) {
      element.setAttribute(
        NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE,
        text
      )
    } else {
      element.removeAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
    }
    this.syncAriaLabel(element, text)
    // 必须在 Chromium 开始创建其合成 Tooltip 窗口前移除 title。
    element.removeAttribute('title')
  }

  normalizeTree(root) {
    if (!(root instanceof this.window.Element)) return
    this.normalizeTitle(root)
    root.querySelectorAll('[title]').forEach((element) => {
      this.normalizeTitle(element)
    })
  }

  clearManagedTooltip(element) {
    element.removeAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
    this.syncAriaLabel(element, '')
    if (element === this.activeTrigger) this.hideTooltip()
  }

  syncManagedTooltip(element) {
    const text =
      element
        .getAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
        ?.trim() || ''
    this.syncAriaLabel(element, text)
    if (element !== this.activeTrigger) return
    if (!text) {
      this.hideTooltip()
    } else if (this.tooltipVisible) {
      this.callNative('showTooltip', text).catch((error) =>
        console.error('[ztools] 更新原生 Tooltip 失败:', error)
      )
    }
  }

  onMutations(mutations) {
    this.observer?.disconnect()
    const titleTargets = new Set()
    const tooltipTargets = new Set()
    const addedNodes = []

    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'title') {
          titleTargets.add(mutation.target)
        } else {
          tooltipTargets.add(mutation.target)
        }
      } else {
        mutation.addedNodes.forEach((node) => addedNodes.push(node))
      }
    }

    titleTargets.forEach((element) => {
      if (element.hasAttribute('title')) this.normalizeTitle(element)
      else this.clearManagedTooltip(element)
    })
    addedNodes.forEach((node) => this.normalizeTree(node))
    tooltipTargets.forEach((element) => this.syncManagedTooltip(element))
    this.observeDocument()
  }

  findTrigger(target) {
    if (!(target instanceof this.window.Element)) return null
    const attribute = NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
    const element = target.closest(`[${attribute}], [title]`)
    if (!element) return null

    if (element.hasAttribute('title')) {
      this.observer?.disconnect()
      this.normalizeTitle(element)
      this.observer?.takeRecords()
      this.observeDocument()
    }
    return element.getAttribute(attribute)?.trim() ? element : null
  }

  scheduleTooltip(element) {
    this.hideTooltip()
    const attribute = NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
    if (!element.getAttribute(attribute)?.trim()) return

    this.activeTrigger = element
    this.showTimer = this.window.setTimeout(() => {
      this.showTimer = 0
      if (this.activeTrigger !== element || !element.isConnected) return

      const text = element.getAttribute(attribute)?.trim()
      if (!text) return
      this.tooltipVisible = true
      this.callNative('showTooltip', text).catch((error) => {
        this.tooltipVisible = false
        console.error('[ztools] 显示原生 Tooltip 失败:', error)
      })
    }, NativeTooltipInterceptor.SHOW_DELAY)
  }

  hideTooltip() {
    if (this.showTimer) {
      this.window.clearTimeout(this.showTimer)
      this.showTimer = 0
    }
    this.activeTrigger = null
    if (!this.tooltipVisible) return

    this.tooltipVisible = false
    this.callNative('hideTooltip').catch((error) =>
      console.error('[ztools] 隐藏原生 Tooltip 失败:', error)
    )
  }

  onMouseOver(event) {
    const element = this.findTrigger(event.target)
    if (element && element !== this.activeTrigger) {
      this.scheduleTooltip(element)
    }
  }

  onMouseOut(event) {
    if (!this.activeTrigger) return
    if (
      event.relatedTarget instanceof this.window.Node &&
      this.activeTrigger.contains(event.relatedTarget)
    ) {
      return
    }
    if (this.activeTrigger.contains(event.target)) this.hideTooltip()
  }

  onFocusIn(event) {
    const element = this.findTrigger(event.target)
    if (element) this.scheduleTooltip(element)
  }

  onFocusOut(event) {
    if (this.activeTrigger?.contains(event.target)) this.hideTooltip()
  }

  onKeyDown(event) {
    if (event.key === 'Escape') this.hideTooltip()
  }

  destroy() {
    this.document.removeEventListener('DOMContentLoaded', this.handleReady)
    this.observer?.disconnect()
    this.observer = null
    this.document.removeEventListener('mouseover', this.handleMouseOver, true)
    this.document.removeEventListener('mouseout', this.handleMouseOut, true)
    this.document.removeEventListener('focusin', this.handleFocusIn, true)
    this.document.removeEventListener('focusout', this.handleFocusOut, true)
    this.document.removeEventListener('keydown', this.handleKeyDown, true)
    this.document.removeEventListener('scroll', this.hideTooltip, true)
    this.window.removeEventListener('resize', this.hideTooltip)
    this.window.removeEventListener('blur', this.hideTooltip)
    this.hideTooltip()
    this.attached = false
    this.started = false
  }
}

export default NativeTooltipInterceptor
