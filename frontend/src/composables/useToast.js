import { message } from 'ant-design-vue'

const DEFAULT_DURATION = 3 // antd 使用秒为单位

/**
 * 成功提示（绿色）
 * @param {string} msg - 提示内容
 * @param {number} d - 持续时间（毫秒），默认 3000ms
 */
function success(msg, d) {
  message.success({
    content: msg,
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
