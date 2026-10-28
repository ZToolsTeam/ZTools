import { Notification } from 'electron'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

interface DesktopNotification {
  show(): void
  close(): void
  once(event: 'show' | 'failed' | 'close' | 'click', listener: () => void): unknown
  removeAllListeners(): unknown
}

export interface DesktopNotificationApi {
  isSupported(): boolean
  create(options: { title: string; body: string; closeButtonText: string }): DesktopNotification
}

const electronNotifications: DesktopNotificationApi = {
  isSupported: () => Notification.isSupported(),
  create: options => new Notification(options)
}

// Electron 会在对象被回收时移除原生通知。保留到关闭/点击，兼顾未发送关闭事件的系统：最多持有最近 64 条。
const activeNotifications = new Map<DesktopNotification, (error: ZToolsError) => void>()
const MAX_ACTIVE_NOTIFICATIONS = 64

export function closeDesktopNotifications(): void {
  for (const close of [...activeNotifications.values()]) {
    close(new ZToolsError(errorCodes.appStopping, '应用正在退出，通知已关闭'))
  }
}

/** 等待系统接收回执；回执不保证用户看到横幅，显示仍受系统通知设置约束。 */
export async function showDesktopNotification(title: string, body: string, api = electronNotifications): Promise<void> {
  if (!api.isSupported()) throw new ZToolsError(errorCodes.notSupported, '当前系统不支持桌面通知')
  // macOS 只有注册了关闭动作的通知类别才会报告用户主动移除通知。
  const notification = api.create({ title, body, closeButtonText: '关闭' })
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let released = false
    const finish = (error?: ZToolsError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve()
    }
    const release = (error?: ZToolsError, closeNative = true) => {
      if (released) return
      released = true
      finish(error ?? new ZToolsError(errorCodes.cancelled, '通知已关闭'))
      notification.removeAllListeners()
      activeNotifications.delete(notification)
      if (closeNative) {
        try { notification.close() }
        catch (closeError) { console.warn('关闭系统通知失败', closeError) }
      }
    }
    const timer = setTimeout(() => release(new ZToolsError(errorCodes.requestTimeout, '系统未确认接收通知，请检查通知权限')), 5000)
    timer.unref()
    try {
      if (activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
        activeNotifications.values().next().value?.(new ZToolsError(errorCodes.cancelled, '通知数量达到上限，旧通知已关闭'))
      }
      activeNotifications.set(notification, error => release(error))
      notification.once('show', () => finish())
      notification.once('close', () => release(undefined, false))
      notification.once('click', () => release())
      notification.once('failed', () => release(new ZToolsError(errorCodes.nativeHostError, '系统未能接收通知，请检查通知权限')))
      notification.show()
    } catch {
      release(new ZToolsError(errorCodes.nativeHostError, '系统未能接收通知，请检查通知权限'))
    }
  })
}
