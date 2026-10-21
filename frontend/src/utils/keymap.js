/**
 * ZTools 统一快捷键分发器 (Unified Keymap Dispatcher)
 * 严格按照优先级分发按键：动作面板 (action_panel) > 声明式舞台 (declarative) > 页面 (page) > 全局 (global)
 * 保证每个按键只处理一次并 stopPropagation()
 *
 * 核心键位契约：
 * - Enter: 主动作
 * - Ctrl+Enter / Cmd+Enter: 次动作
 * - Ctrl+K / Cmd+K: 动作面板
 * - Esc / Escape: 逐级返回
 * - Ctrl+M / Cmd+M: 双模态切换 (Launcher <-> Dashboard)
 * - Ctrl+F / Cmd+F: 聚焦搜索
 */

import { onUnmounted, getCurrentInstance } from 'vue'

export const KEYMAP_SCOPES = Object.freeze({
  ACTION_PANEL: 'action_panel',
  DECLARATIVE: 'declarative',
  PAGE: 'page',
  GLOBAL: 'global'
})

const SCOPE_ORDER = Object.freeze([
  KEYMAP_SCOPES.ACTION_PANEL,
  KEYMAP_SCOPES.DECLARATIVE,
  KEYMAP_SCOPES.PAGE,
  KEYMAP_SCOPES.GLOBAL
])

// 存储各作用域的处理器集合（按注册顺序堆叠）
const registry = new Map(SCOPE_ORDER.map((scope) => [scope, []]))

let isListenerAttached = false

/**
 * 规范化按键标识，用于 keymap 映射匹配
 * 返回格式如: 'Ctrl+K', 'Ctrl+Enter', 'Escape', 'Enter', 'ArrowDown' 等
 */
export function normalizeEventKeyCombo(event) {
  if (!event || typeof event !== 'object') return ''

  const parts = []
  const hasCtrl = Boolean(event.ctrlKey || event.metaKey)
  const hasAlt = Boolean(event.altKey)
  const hasShift = Boolean(event.shiftKey)

  if (hasCtrl) parts.push('Ctrl')
  if (hasAlt) parts.push('Alt')
  if (hasShift) parts.push('Shift')

  let key = event.key || ''
  if (key === 'Escape' || key === 'Esc') {
    key = 'Escape'
  } else if (key === ' ' || event.code === 'Space') {
    key = 'Space'
  } else if (key.length === 1) {
    key = key.toUpperCase()
  }

  // 如果仅有修饰键本身按下，不产生组合键
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
    return ''
  }

  parts.push(key)
  return parts.join('+')
}

/**
 * 判断当前焦点是否在可输入控件中
 */
export function isInputElement(target) {
  if (!target || typeof target !== 'object') return false
  const tagName = target.tagName ? target.tagName.toUpperCase() : ''
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    Boolean(target.isContentEditable)
  )
}

/**
 * 统一分发键盘事件
 * @param {KeyboardEvent} event 
 * @returns {boolean} 是否被某个作用域的处理器拦截并处理
 */
/** 页面上是否有打开着的 Ant Design 对话框（关闭后 wrap 仍留在 DOM 里，只是 display: none） */
export function isModalOpen() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false
  for (const wrap of document.querySelectorAll('.ant-modal-wrap')) {
    if (wrap.style?.display === 'none') continue
    if (typeof getComputedStyle === 'function' && getComputedStyle(wrap).display === 'none') continue
    return true
  }
  return false
}

export function dispatchKeyEvent(event) {
  if (!event) return false
  // 捕获阶段先让出输入法选字按键；不能 preventDefault，否则会打断文字确认。
  // 229 覆盖确认阶段的兼容事件，composing 复用 Vue v-model 的组合输入状态。
  if (event.isComposing || event.keyCode === 229 || event.target?.composing === true) return false
  // 有对话框打开时按键归对话框（Esc 关对话框、回车点按钮），页面快捷键一律不响应
  if (isModalOpen()) return false

  const combo = normalizeEventKeyCombo(event)
  const inInput = isInputElement(event.target)

  for (const scope of SCOPE_ORDER) {
    const handlers = registry.get(scope) || []
    // 逆序遍历，后注册的优先（LIFO）
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handlerRecord = handlers[i]
      if (!handlerRecord || !handlerRecord.enabled) continue

      try {
        let handled = false
        if (typeof handlerRecord.handler === 'function') {
          handled = handlerRecord.handler(event, { combo, scope, inInput }) === true
        } else if (handlerRecord.handler && typeof handlerRecord.handler === 'object') {
          // 键位映射表匹配
          const map = handlerRecord.handler
          const fn = map[combo] || (combo === 'Escape' ? map['Esc'] : undefined)
          if (typeof fn === 'function') {
            const res = fn(event, { combo, scope, inInput })
            handled = res !== false
          } else if (typeof map.onKeyDown === 'function') {
            handled = map.onKeyDown(event, { combo, scope, inInput }) === true
          }
        }

        if (handled) {
          try {
            if (typeof event.preventDefault === 'function') event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          } catch {
            // 忽略事件只读或 Mock 环境下的异常
          }
          return true
        }
      } catch (err) {
        console.error(`[Keymap] Error executing handler in scope "${scope}":`, err)
        // 防御性异常隔离，不阻断宿主继续运行
      }
    }
  }

  return false
}

function handleGlobalWindowKeyDown(event) {
  dispatchKeyEvent(event)
}

/**
 * 确保全局事件监听器已就绪
 */
export function ensureKeymapListener() {
  if (isListenerAttached) return
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', handleGlobalWindowKeyDown, { capture: true })
    isListenerAttached = true
  }
}

/**
 * 移除全局事件监听器
 */
export function teardownKeymapListener() {
  if (!isListenerAttached) return
  if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
    window.removeEventListener('keydown', handleGlobalWindowKeyDown, { capture: true })
    isListenerAttached = false
  }
}

/**
 * 向指定作用域注册快捷键处理器
 * @param {'action_panel' | 'declarative' | 'page' | 'global'} scope 
 * @param {Function | Record<string, Function>} handler 
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @returns {() => void} 注销函数
 */
export function registerKeyHandler(scope, handler, options = {}) {
  if (!SCOPE_ORDER.includes(scope)) {
    throw new Error(`[Keymap] 无效的作用域: "${scope}"，可用作用域为: ${SCOPE_ORDER.join(', ')}`)
  }
  if (!handler || (typeof handler !== 'function' && typeof handler !== 'object')) {
    throw new Error('[Keymap] 处理器必须为函数或按键映射对象')
  }

  ensureKeymapListener()

  const list = registry.get(scope)
  const record = {
    handler,
    enabled: options.enabled !== false
  }
  list.push(record)

  let unregistered = false
  return function unregister() {
    if (unregistered) return
    unregistered = true
    const idx = list.indexOf(record)
    if (idx !== -1) {
      list.splice(idx, 1)
    }
  }
}

/**
 * Vue 3 Composition API 快捷键 hook
 * 在组件生命周期内自动注册并在卸载时成对销毁
 */
export function useKeymap(scope, handler, options = {}) {
  const unregister = registerKeyHandler(scope, handler, options)
  if (getCurrentInstance()) {
    onUnmounted(() => {
      unregister()
    })
  }
  return unregister
}

/**
 * 重置所有注册信息（供测试套件使用）
 */
export function _resetKeymapForTesting() {
  for (const list of registry.values()) {
    list.length = 0
  }
  teardownKeymapListener()
}
