/**
 * Toast 通知 API
 * 轻量级、非阻塞的提示系统
 */

import { sendMessage } from '../core/message-sender.js'

/**
 * 显示 Toast 通知（前端实现，不经过后端）
 * @param {string} type - 类型：success | error | info | warning
 * @param {string} message - 提示内容
 * @param {number} duration - 持续时间（毫秒），默认 3000ms
 */
export function toast(type, message, duration = 3000) {
  // 直接触发前端 Toast，不经过后端
  if (window.__ztoolsToast) {
    window.__ztoolsToast(type, message, duration)
  } else {
    console.warn('[Toast] Toast system not initialized')
  }
}

/**
 * 成功提示
 * @param {string} message - 提示内容
 * @param {number} duration - 持续时间（毫秒）
 */
export function success(message, duration) {
  toast('success', message, duration)
}

/**
 * 错误提示
 * @param {string} message - 提示内容
 * @param {number} duration - 持续时间（毫秒）
 */
export function error(message, duration) {
  toast('error', message, duration)
}

/**
 * 信息提示
 * @param {string} message - 提示内容
 * @param {number} duration - 持续时间（毫秒）
 */
export function info(message, duration) {
  toast('info', message, duration)
}

/**
 * 警告提示
 * @param {string} message - 提示内容
 * @param {number} duration - 持续时间（毫秒）
 */
export function warning(message, duration) {
  toast('warning', message, duration)
}
