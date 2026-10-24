import { errorCodes, ZToolsError } from '../../contracts/errors.js'

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
      throw new ZToolsError(errorCodes.notSupported, '当前平台不支持 Windows 自启动')
    }
  }
}
