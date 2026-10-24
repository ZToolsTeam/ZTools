import { errorCodes, ZToolsError } from '../../../contracts/errors.js'

export type MacosLoginItemStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found'

export interface MacosLoginItemState {
  readonly openAtLogin: boolean
  readonly wasOpenedAtLogin: boolean
  readonly status: MacosLoginItemStatus
}

export interface ElectronMacosLoginItemApp {
  getLoginItemSettings(): {
    openAtLogin: boolean
    wasOpenedAtLogin: boolean
    status: string
  }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

export interface MacosLoginItemAdapter {
  get(): MacosLoginItemState
  setEnabled(enabled: boolean): MacosLoginItemState
}

export interface MacosLoginItemAdapterOptions {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  readonly app: ElectronMacosLoginItemApp
}

const validStatuses = new Set<MacosLoginItemStatus>([
  'not-registered',
  'enabled',
  'requires-approval',
  'not-found'
])

function requireMacosPackaged(options: MacosLoginItemAdapterOptions): void {
  if (options.platform !== 'darwin') {
    throw new ZToolsError(errorCodes.notSupported, '登录启动设置仅支持 macOS')
  }
  if (!options.isPackaged) {
    throw new ZToolsError(errorCodes.notSupported, '开发态不修改 macOS 登录启动设置')
  }
}

function normalizeState(value: ReturnType<ElectronMacosLoginItemApp['getLoginItemSettings']>): MacosLoginItemState {
  if (
    typeof value !== 'object' || value === null ||
    typeof value.openAtLogin !== 'boolean' ||
    typeof value.wasOpenedAtLogin !== 'boolean' ||
    !validStatuses.has(value.status as MacosLoginItemStatus)
  ) {
    throw new ZToolsError(errorCodes.notSupported, 'macOS 登录启动状态无效')
  }
  return Object.freeze({
    openAtLogin: value.openAtLogin,
    wasOpenedAtLogin: value.wasOpenedAtLogin,
    status: value.status as MacosLoginItemStatus
  })
}

/** Electron login-item access for a packaged Darwin app; creating it never changes OS state. */
export function createMacosLoginItemAdapter(options: MacosLoginItemAdapterOptions): MacosLoginItemAdapter {
  const read = (): MacosLoginItemState => {
    requireMacosPackaged(options)
    try {
      return normalizeState(options.app.getLoginItemSettings())
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.notSupported, '读取 macOS 登录启动设置失败')
    }
  }

  return {
    get: read,
    setEnabled(enabled) {
      if (typeof enabled !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, '登录启动状态必须是布尔值')
      }
      requireMacosPackaged(options)
      try {
        options.app.setLoginItemSettings({ openAtLogin: enabled })
      } catch {
        throw new ZToolsError(errorCodes.notSupported, '设置 macOS 登录启动状态失败')
      }
      const state = read()
      if (state.openAtLogin !== enabled) {
        throw new ZToolsError(errorCodes.notSupported, 'macOS 未确认登录启动设置已生效')
      }
      return state
    }
  }
}
