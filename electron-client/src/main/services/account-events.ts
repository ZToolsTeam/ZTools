import type { EventService } from './event-service.js'

export type AccountEventType = 'user.login' | 'user.logout'

/** 登录状态事件只能由宿主发出：界面层据此切换登录状态，插件或页面伪造会让界面与本地凭据不一致 */
export const ACCOUNT_EVENT_TYPES: ReadonlySet<string> = new Set<AccountEventType>(['user.login', 'user.logout'])

/**
 * 通知宿主主窗口登录状态变了（界面层的用户状态靠它同步，例如请求遇到 401 时宿主直接清掉了本地凭据）。
 * 只发给主窗口，插件窗口收不到；事件不带任何账号信息；发送失败不影响登录、退出本身。
 */
export function publishAccountChanged(
  events: Pick<EventService, 'publishHostToMain'>,
  type: AccountEventType,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error)
): void {
  try {
    events.publishHostToMain(type, {})
  } catch (error) {
    warn(`发布 ${type} 事件失败:`, error)
  }
}
