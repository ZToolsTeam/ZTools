import { h } from 'vue'
import { message } from 'ant-design-vue'
import { CircleCheckIcon, CircleXIcon, InfoIcon, TriangleAlertIcon } from '@lucide/vue'
import { SpinnerIcon } from '@/utils/appIcons'

// 提示图标与界面其它图标统一用 Lucide 线性图标（antd 默认是实心圆底图标）；颜色取主题语义色
const toastIcon = (Icon, color) => h(Icon, { class: 'toast-icon', style: { color }, 'aria-hidden': 'true' })

const DEFAULT_DURATION = 3 // antd 使用秒为单位

/**
 * 成功提示（绿色）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），默认 3000ms
 */
function success(msg, d) {
  message.success({
    content: msg,
    icon: toastIcon(CircleCheckIcon, 'var(--rc-success)'),
    duration: d ? d / 1000 : DEFAULT_DURATION
  })
}

/**
 * 错误提示（红色）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），默认 3000ms
 */
function error(msg, d) {
  message.error({
    content: msg,
    icon: toastIcon(CircleXIcon, 'var(--rc-error)'),
    duration: d ? d / 1000 : DEFAULT_DURATION
  })
}

/**
 * 信息提示（蓝色）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），默认 3000ms
 */
function info(msg, d) {
  message.info({
    content: msg,
    icon: toastIcon(InfoIcon, 'var(--rc-text-secondary)'),
    duration: d ? d / 1000 : DEFAULT_DURATION
  })
}

/**
 * 警告提示（橙色）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），默认 3000ms
 */
function warning(msg, d) {
  message.warning({
    content: msg,
    icon: toastIcon(TriangleAlertIcon, 'var(--rc-warning)'),
    duration: d ? d / 1000 : DEFAULT_DURATION
  })
}

/**
 * 加载提示（带加载图标）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），0 表示不自动关闭
 * @returns {Function} 关闭函数
 */
function loading(msg, d = 0) {
  return message.loading({
    content: msg,
    icon: toastIcon(SpinnerIcon, 'var(--rc-accent-text)'),
    duration: d ? d / 1000 : 0
  })
}

/**
 * Toast 通知（非阻塞，轻量级）
 * 用于普通提示，3秒后自动消失
 * @param {string} type - 类型：success | error | info | warning
 * @param {string} msg - 提示内容
 * @param {number} duration - 持续时间（毫秒），默认 3000ms
 */
function toast(type, msg, duration) {
  const fn = { success, error, info, warning }[type] || info
  fn(msg, duration)
}

export function useToast() {
  return {
    success,
    error,
    info,
    warning,
    loading,
    toast,
    // 别名，兼容旧代码
    toastSuccess: success,
    toastError: error,
    toastInfo: info,
    toastWarning: warning
  }
}
