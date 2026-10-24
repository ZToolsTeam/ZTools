/**
 * v-switch-keyboard 指令
 * 限制 a-switch 组件的键盘响应行为：
 * - 允许单独按下 Enter 或 Space 切换
 * - 阻止所有包含修饰键的组合键
 * - 阻止其他无关按键
 */
export const vSwitchKeyboard = {
  mounted(el) {
    const handler = (event) => {
      // 检查是否有修饰键
      const hasModifier =
        event.altKey || event.ctrlKey || event.shiftKey || event.metaKey

      if (hasModifier) {
        // 有修饰键的组合键一律阻止
        event.preventDefault()
        event.stopPropagation()
        return
      }

      // 无修饰键时，仅允许 Enter 和 Space
      const allowedKeys = ['Enter', ' ']
      if (!allowedKeys.includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    // 在捕获阶段监听，确保在 a-switch 内部处理之前拦截
    el.addEventListener('keydown', handler, true)
    // 保存引用以便卸载时移除
    el._switchKeyboardHandler = handler
  },

  unmounted(el) {
    if (el._switchKeyboardHandler) {
      el.removeEventListener('keydown', el._switchKeyboardHandler, true)
      delete el._switchKeyboardHandler
    }
  }
}
