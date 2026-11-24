import fs from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { ConfigService } from './config-service.js'

/** 只为尚无用户配置的首次运行开启自启动，升级和用户后续关闭时保持原选择。 */
export async function initializeDefaultAutostart(
  dataRoot: string,
  config: Pick<ConfigService, 'set'>,
  loginItem: { getEnabled(): boolean; setEnabled(enabled: boolean): void }
): Promise<void> {
  try {
    await fs.stat(path.join(dataRoot, 'user_settings.json'))
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  // Windows 可能把非目录路径报为 ENOENT，开启登录项前先确认配置目录确实可用。
  if (!(await fs.stat(dataRoot)).isDirectory()) {
    throw Object.assign(new Error('Config root path is not a directory'), { code: 'ENOTDIR' })
  }

  const previous = loginItem.getEnabled()
  try {
    if (!previous) loginItem.setEnabled(true)
    if (!loginItem.getEnabled()) {
      throw new ZToolsError(errorCodes.notSupported, 'System did not confirm launch-at-login is enabled')
    }
    await config.set('user_settings.json', 'system.autostart', 'true', true)
  } catch (error) {
    if (!previous) {
      try {
        loginItem.setEnabled(false)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Failed to initialize launch-at-login and rollback failed')
      }
    }
    throw error
  }
}

export interface LoginItemSettings {
  openAtLogin?: boolean
  executableWillLaunchAtLogin?: boolean
}

export interface LoginItemAdapter {
  getLoginItemSettings(options: { path: string; args: readonly string[] }): LoginItemSettings
  setLoginItemSettings(options: {
    openAtLogin: boolean
    openAsHidden: boolean
    path: string
    args: readonly string[]
  }): void
}

export interface AutostartServiceOptions {
  executablePath: string
  adapter: LoginItemAdapter
  platform?: NodeJS.Platform
  arguments?: readonly string[]
}

export class AutostartService {
  readonly #platform: NodeJS.Platform
  readonly #arguments: readonly string[]

  constructor(private readonly options: AutostartServiceOptions) {
    this.#platform = options.platform ?? process.platform
    this.#arguments = options.arguments ?? ['--autostart', '--source=autostart']
  }

  get(): { success: true; enabled: boolean } {
    this.#requireWindows()
    const settings = this.options.adapter.getLoginItemSettings({
      path: this.options.executablePath,
      args: this.#arguments
    })
    return {
      success: true,
      enabled: settings.openAtLogin === true || settings.executableWillLaunchAtLogin === true
    }
  }

  set(enabled: boolean): { success: true; enabled: boolean } {
    this.#requireWindows()
    this.options.adapter.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      path: this.options.executablePath,
      args: this.#arguments
    })
    return { success: true, enabled }
  }

  #requireWindows(): void {
    if (this.#platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, 'Windows autostart is not supported on this platform')
    }
  }
}
