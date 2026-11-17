/**
 * ZTools 统一快捷键分发器 (Unified Keymap Dispatcher)
 * 按优先级分发：动作面板 > 声明式舞台 > 搜索候选 > 页面 > 全局
 * 保证每个按键只处理一次并 stopPropagation()
 *
 * 核心键位契约：
 * - Enter: 主动作
 * - Ctrl+Enter / Cmd+Enter: 次动作
 * - Ctrl+K / Cmd+K: 动作面板
 * - Esc / Escape: 逐级返回
 * - Ctrl+M / Cmd+M: 双模态切换 (Launcher <-> Dashboard)
 * - Ctrl+F / Cmd+F: 聚焦搜索
 * - Ctrl+I / Cmd+I: 打开设置
 */

import { onActivated, onDeactivated, onUnmounted, getCurrentInstance } from 'vue'

/** 打开设置的默认快捷键单一信源（macOS 自动按平台展示为 ⌘ I 并归一化匹配） */
export const OPEN_SETTINGS_SHORTCUT = 'Ctrl+I'

export const KEYMAP_SCOPES = Object.freeze({
  ACTION_PANEL: 'action_panel',
  DECLARATIVE: 'declarative',
  SEARCH: 'search',
  PAGE: 'page',
  GLOBAL: 'global'
})

const SCOPE_ORDER = Object.freeze([
  KEYMAP_SCOPES.ACTION_PANEL,
  KEYMAP_SCOPES.DECLARATIVE,
  KEYMAP_SCOPES.SEARCH,
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
  if (isComposingEvent(event)) return ''

  const parts = []
  const hasCtrl = Boolean(event.ctrlKey || event.metaKey)
  const hasAlt = Boolean(event.altKey)
  const hasShift = Boolean(event.shiftKey)

  if (hasCtrl) parts.push('Ctrl')
  if (hasAlt) parts.push('Alt')
  if (hasShift) parts.push('Shift')

  const imeLetter = extractExplicitModifiedLetterFromCode(event)
  let key = event.key || ''
  if (key === 'Escape' || key === 'Esc') {
    key = 'Escape'
  } else if (key === ' ' || event.code === 'Space') {
    key = 'Space'
  } else if (
    key === '，' ||
    (!hasShift && event.code === 'Comma' && (!key || key === 'Process' || key === 'Unidentified'))
  ) {
    key = ','
  } else if (imeLetter) {
    key = imeLetter
  } else if (key.length === 1) {
    key = key.toUpperCase()
  }

  // 如果仅有修饰键本身按下或键名为空，不产生组合键
  if (!key || ['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
    return ''
  }

  parts.push(key)
  return parts.join('+')
}

/**
 * 判断是否为非组字状态下显式触发的 Ctrl/Cmd + 逗号组合键
 * Windows 中文输入法在未组字时按下 Ctrl+, 可能上报 keyCode=229 / key='Process' 或全角 '，'，
 * 此类明确携带 Ctrl/Meta 的物理逗号按键不属于候选词确认，应放行进入快捷键分发。
 */
function isExplicitModifiedCommaKey(event) {
  if (!event || typeof event !== 'object') return false
  if (event.isComposing || event.target?.composing === true) return false
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return false
  return event.code === 'Comma' || event.key === ',' || event.key === '，'
}

/**
 * 从非组字状态下显式携带 Ctrl/Cmd 且由输入法包装的物理字母按键事件中还原大写字母（如 KeyI -> 'I'）
 * Windows 中文输入法在输入框聚焦但未组字时按下 Ctrl+I 等组合键，可能上报 keyCode=229 与 key='Process'/'Unidentified'。
 */
function extractExplicitModifiedLetterFromCode(event) {
  if (!event || typeof event !== 'object') return ''
  if (event.isComposing || event.target?.composing === true) return ''
  if (!(event.ctrlKey || event.metaKey)) return ''
  if (event.key && event.key !== 'Process' && event.key !== 'Unidentified') return ''
  if (typeof event.code !== 'string') return ''
  const match = /^Key([A-Z])$/.exec(event.code)
  return match ? match[1] : ''
}

/**
 * 输入法正在组字（中文拼音候选框打开时按 Enter/空格/方向键是给输入法用的），这类按键一律不当快捷键
 */
export function isComposingEvent(event) {
  if (!event || typeof event !== 'object') return false
  if (event.isComposing || event.target?.composing === true) return true
  // 229 覆盖确认阶段的兼容事件，但放行非组字态下显式携带 Ctrl/Cmd 的逗号或物理字母快捷键
  if (event.keyCode === 229) {
    return !isExplicitModifiedCommaKey(event) && !extractExplicitModifiedLetterFromCode(event)
  }
  return false
}

/**
 * 判断当前焦点是否在快捷键录入隐藏输入框中
 */
export function isHotkeyRecorderInput(target) {
  return Boolean(target?.classList?.contains?.('hotkey-hidden-input'))
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

const INPUT_PROTECTED_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Backspace',
  ' '
])

/**
 * 判断输入框内的按键是否属于原生光标移动/选区/文本删除键
 * 在 PAGE / GLOBAL 作用域中默认让出此类按键，避免输入框改字时触发底层卡片移动或误删插件
 */
export function isInputProtectedKey(event) {
  if (!event || typeof event !== 'object') return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (INPUT_PROTECTED_KEYS.has(event.key) || event.code === 'Space') return true
  return typeof event.key === 'string' && event.key.length === 1
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'radio',
  'checkbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'link'
])

/**
 * 判断事件目标是否为当前正获得焦点的独立交互子控件（按钮、复选框、单选胶囊、菜单项等）
 * @param {EventTarget | null} target
 * @param {Element | null} [containerRoot] 容器根节点自身（若焦点就在容器壳层上则不算子控件）
 */
export function isInteractiveControlTarget(target, containerRoot = null) {
  if (!target || typeof target !== 'object' || target === containerRoot) return false
  if (isInputElement(target)) return false
  const tagName = target.tagName ? String(target.tagName).toUpperCase() : ''
  if (tagName === 'BUTTON' || tagName === 'SELECT' || tagName === 'SUMMARY') return true
  if (tagName === 'A' && typeof target.getAttribute === 'function' && target.getAttribute('href') !== null) {
    return true
  }
  const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : ''
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true
  if (typeof target.closest === 'function') {
    const ancestorBtn = target.closest('button, a[href], [role="radio"], [role="checkbox"], [role="menuitem"], [role="switch"], [role="tab"]')
    if (ancestorBtn && ancestorBtn !== containerRoot) return true
  }
  return false
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

const SELECT_OPEN_KEYS = new Set(['Enter', 'ArrowUp', 'ArrowDown', ' '])

/** 按键是否应交给下拉选择框（antd Select，RcSelect 的底层）处理 */
export function isSelectKey(event) {
  const select = event?.target?.closest?.('.ant-select')
  if (!select) return false
  if (select.classList.contains('ant-select-open')) return true
  return SELECT_OPEN_KEYS.has(event.key)
}

// 同一个按键事件只分发一次：窗口捕获阶段的监听与声明式根节点的 @keydown 可能先后收到同一事件
const dispatchedEvents = new WeakSet()

export function dispatchKeyEvent(event) {
  if (!event) return false
  // 捕获阶段先让出输入法选字按键；不能 preventDefault，否则会打断文字确认。
  if (isComposingEvent(event)) return false
  // 焦点在快捷键录入框时，按键全部归录入框处理（含 Esc 取消、Ctrl+F/M 录制等）
  if (isHotkeyRecorderInput(event.target)) return false
  if (typeof event === 'object') {
    if (dispatchedEvents.has(event)) return false
    dispatchedEvents.add(event)
  }
  // 有对话框打开时按键归对话框（Esc 关对话框、回车点按钮），页面快捷键一律不响应
  if (isModalOpen()) return false
  // 焦点在下拉选择框上：展开时按键全部归选择框；收起时回车 / 上下键 / 空格用来展开它，Esc 仍交给页面（返回）
  if (isSelectKey(event)) return false

  const combo = normalizeEventKeyCombo(event)
  const inInput = isInputElement(event.target)
  const protectInputEdit =
    inInput && isInputProtectedKey(event)

  for (const scope of SCOPE_ORDER) {
    const handlers = registry.get(scope) || []
    // 输入框内的光标移动、选区与删除键绝不穿透到 PAGE / GLOBAL 页面级网格快捷键
    if (protectInputEdit && (scope === KEYMAP_SCOPES.PAGE || scope === KEYMAP_SCOPES.GLOBAL)) {
      continue
    }
    let blockedByModal = false
    // 逆序遍历，后注册的优先（LIFO）
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handlerRecord = handlers[i]
      if (!handlerRecord || !handlerRecord.enabled) continue
      if (handlerRecord.modal) blockedByModal = true

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
          } catch (err) {
            console.warn('[Keymap] 阻止默认按键事件失败:', err)
          }
          return true
        }
      } catch (err) {
        console.error(`[Keymap] Error executing handler in scope "${scope}":`, err)
        // 防御性异常隔离，不阻断宿主继续运行
      }
    }
    // 若当前作用域存在激活的模态弹层（如 ActionPanelModal / 卡片右键菜单），阻断向底层作用域穿透
    if (blockedByModal) {
      return false
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
 * @param {'action_panel' | 'declarative' | 'search' | 'page' | 'global'} scope
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
  const initialEnabled = options.enabled !== false
  const record = {
    handler,
    enabled: initialEnabled,
    modal: Boolean(options.modal)
  }
  list.push(record)

  let unregistered = false
  function unregister() {
    if (unregistered) return
    unregistered = true
    const idx = list.indexOf(record)
    if (idx !== -1) {
      list.splice(idx, 1)
    }
  }
  unregister.deactivate = () => {
    if (unregistered) return
    record.enabled = false
  }
  unregister.activate = (restoreInitialOnly = false) => {
    if (unregistered) return
    record.enabled = restoreInitialOnly ? initialEnabled : true
    const idx = list.indexOf(record)
    if (idx !== -1 && idx !== list.length - 1) {
      list.splice(idx, 1)
      list.push(record)
    }
  }
  return unregister
}

/**
 * Vue 3 Composition API 快捷键 hook
 * 在组件生命周期内自动注册并在卸载时成对销毁；支持 KeepAlive 激活/停用切换
 */
export function useKeymap(scope, handler, options = {}) {
  const unregister = registerKeyHandler(scope, handler, options)
  if (getCurrentInstance()) {
    onActivated(() => {
      unregister.activate(true)
    })
    onDeactivated(() => {
      unregister.deactivate()
    })
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
