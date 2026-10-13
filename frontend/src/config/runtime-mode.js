/**
 * 运行模式
 *
 * 未配置 VITE_API_BASE_URL 时为单机模式：不访问任何远程后台，
 * 商城、登录、同步、反馈、统计等在线能力整体关闭。
 * 官方构建通过环境变量注入后台地址进入在线模式。
 */

const apiBase = String(import.meta.env.VITE_API_BASE_URL || '').trim()

export const isOnline = apiBase !== ''

export const OFFLINE_ERROR_CODE = 'OFFLINE_MODE'

export function createOfflineError() {
  const err = new Error('单机模式未启用在线服务')
  err.code = OFFLINE_ERROR_CODE
  err.status = 0
  return err
}

export function isOfflineError(err) {
  return err?.code === OFFLINE_ERROR_CODE
}
