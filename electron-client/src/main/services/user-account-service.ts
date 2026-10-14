import type { UserSetTokenParams } from '../../contracts/method-params.js'
import { JsonFileStore } from './json-file-store.js'

const USER_ACCOUNT_FILE = 'user_account.json'

interface StoredUserAccount {
  user_id: string
  username: string
  email: string
  current_token: string
  refresh_token: string
  token_expires_at: string
  last_login_at: string
}

function stringField(document: Record<string, unknown>, key: keyof StoredUserAccount): string {
  const value = document[key]
  return typeof value === 'string' ? value : ''
}

function formatLocalDateTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(value)
}

export class UserAccountService {
  constructor(private readonly store: JsonFileStore) {}

  async getInfo(): Promise<Record<string, unknown>> {
    const account = await this.store.read(USER_ACCOUNT_FILE)
    const userId = stringField(account, 'user_id')
    if (userId === '') return { success: true, logged_in: false }
    return {
      success: true,
      logged_in: true,
      user: {
        user_id: userId,
        username: stringField(account, 'username'),
        email: stringField(account, 'email'),
        last_login_at: stringField(account, 'last_login_at')
      },
      token: stringField(account, 'current_token'),
      refresh_token: stringField(account, 'refresh_token')
    }
  }

  async getAccessToken(): Promise<string> {
    const account = await this.store.read(USER_ACCOUNT_FILE)
    return stringField(account, 'current_token')
  }

  async setToken(params: UserSetTokenParams): Promise<void> {
    const now = new Date()
    const expiresAt = params.expires_at === '' || params.expires_at === undefined
      ? new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
      : new Date(params.expires_at)
    await this.store.replace(USER_ACCOUNT_FILE, {
      user_id: params.user_id,
      username: params.username ?? '',
      email: params.email ?? '',
      current_token: params.token,
      refresh_token: params.refresh_token,
      token_expires_at: formatLocalDateTime(expiresAt),
      last_login_at: formatLocalDateTime(now)
    })
  }

  logout(): Promise<void> {
    return this.store.replace(USER_ACCOUNT_FILE, {})
  }
}
