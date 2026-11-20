import { Notification } from 'electron'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { t } from '../i18n/index.js'

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
    close(new ZToolsError(errorCodes.appStopping, t('notification.appStopping')))
  }
}

/** 等待系统接收回执；回执不保证用户看到横幅，显示仍受系统通知设置约束。 */
export async function showDesktopNotification(title: string, body: string, api = electronNotifications): Promise<void> {
  if (!api.isSupported()) throw new ZToolsError(errorCodes.notSupported, t('notification.notSupported'))
  // macOS 只有注册了关闭动作的通知类别才会报告用户主动移除通知。
  const notification = api.create({ title, body, closeButtonText: t('notification.closeButton') })
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
      finish(error ?? new ZToolsError(errorCodes.cancelled, t('notification.closed')))
      notification.removeAllListeners()
      activeNotifications.delete(notification)
      if (closeNative) {
        try { notification.close() }
        catch (closeError) { console.warn('关闭系统通知失败', closeError) }
      }
    }
    const timer = setTimeout(() => release(new ZToolsError(errorCodes.requestTimeout, t('notification.timeout'))), 5000)
    timer.unref()
    try {
      if (activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
        activeNotifications.values().next().value?.(new ZToolsError(errorCodes.cancelled, t('notification.limitReached')))
      }
      activeNotifications.set(notification, error => release(error))
      notification.once('show', () => finish())
      notification.once('close', () => release(undefined, false))
      notification.once('click', () => release())
      notification.once('failed', () => release(new ZToolsError(errorCodes.nativeHostError, t('notification.failed'))))
      notification.show()
    } catch {
      release(new ZToolsError(errorCodes.nativeHostError, t('notification.failed')))
    }
  })
}
