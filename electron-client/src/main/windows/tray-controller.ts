import { Menu, Tray, type MenuItem, type MenuItemConstructorOptions } from 'electron'
import { toElectronAccelerator } from '../platform/common/electron-global-shortcut.js'

export const DEFAULT_TRAY_WAKE_ACCELERATOR = 'Alt+Space'
const MAX_ACCELERATOR_LENGTH = 64

export interface TrayAdapter {
  setToolTip(toolTip: string): void
  setContextMenu(menu: Electron.Menu | null): void
  on(event: 'click' | 'double-click', listener: () => void): unknown
  destroy(): void
}

export interface TrayControllerDependencies {
  createTray?(icon: Electron.NativeImage): TrayAdapter
  buildMenu?(template: MenuItemConstructorOptions[]): Electron.Menu
}

export interface TrayControllerState {
  /** 超级面板当前是否启用 */
  isSuperPanelEnabled?: boolean
  /** 全局唤醒快捷键显示文案（默认 Alt+Space） */
  wakeAccelerator?: string
}

export interface TrayControllerOptions extends TrayControllerState {
  icon: Electron.NativeImage
  /** 打开主工作台窗口 (Dashboard) */
  showMainWindow(): void
  /** 左键单击托盘时的切换动作（未传则回退到 showMainWindow） */
  togglePrimaryWindow?(): void
  /** 打开极客搜索框 (Launcher) */
  openLauncher?(): void
  /** 打开偏好设置页 (/advanced-settings) */
  openSettings?(): void
  /** 打开检查更新与关于页 (/about) */
  openAbout?(): void
  /** 切换超级面板启用/暂停状态 */
  onToggleSuperPanel?(enabled: boolean): void | Promise<void>
  /** 重启应用 */
  relaunchApp?(): void
  /** 退出应用 */
  requestExit(): void
  /** 运行平台（默认 process.platform） */
  platform?: NodeJS.Platform
  /** 可选依赖注入（用于单元测试与无头集成测试） */
  deps?: TrayControllerDependencies
}

export function normalizeTrayAccelerator(
  value: unknown,
  fallback = DEFAULT_TRAY_WAKE_ACCELERATOR
): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  // 空串表示用户已关闭全局唤醒，菜单项不显示快捷键，不能退回默认值
  if (trimmed.length === 0) return ''
  if (
    trimmed.length > MAX_ACCELERATOR_LENGTH ||
    /[\r\n\0\t]/.test(trimmed)
  ) {
    return fallback
  }
  return trimmed
}

function invokeSafely(label: string, action: () => void | Promise<void>): void {
  try {
    const result = action()
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error: unknown) => {
        console.error(`托盘菜单动作执行失败 [${label}]`, error)
      })
    }
  } catch (error) {
    console.error(`托盘菜单动作执行失败 [${label}]`, error)
  }
}

export interface BuildTrayMenuContext {
  isSuperPanelEnabled: boolean
  wakeAccelerator: string
  platform: NodeJS.Platform
  onOpenLauncher(): void
  onShowMainWindow(): void
  onToggleSuperPanel(menuItem?: Pick<MenuItem, 'checked'>): void
  onOpenSettings(): void
  onOpenAbout(): void
  onRelaunchApp?: (() => void) | undefined
  onRequestExit(): void
}

export function buildTrayMenuTemplate(
  context: BuildTrayMenuContext
): MenuItemConstructorOptions[] {
  const settingsAccelerator = context.platform === 'darwin' ? 'Command+,' : 'Ctrl+,'
  const items: MenuItemConstructorOptions[] = [
    {
      id: 'open-launcher',
      label: '打开极客搜索',
      // 与全局快捷键注册同一套转换：设置里的 Ctrl 在 macOS 上实际是 ⌘，菜单按实际按键显示
      ...(context.wakeAccelerator ? { accelerator: toElectronAccelerator(context.wakeAccelerator) } : {}),
      click: () => context.onOpenLauncher()
    },
    {
      id: 'open-dashboard',
      label: '打开主工作台',
      click: () => context.onShowMainWindow()
    },
    { type: 'separator' },
    {
      id: 'toggle-super-panel',
      label: '启用超级面板',
      type: 'checkbox',
      checked: context.isSuperPanelEnabled,
      click: (menuItem) => context.onToggleSuperPanel(menuItem)
    },
    {
      id: 'open-settings',
      label: '偏好设置...',
      accelerator: settingsAccelerator,
      click: () => context.onOpenSettings()
    },
    {
      id: 'open-about',
      label: '检查更新 / 关于',
      click: () => context.onOpenAbout()
    },
    { type: 'separator' }
  ]

  if (typeof context.onRelaunchApp === 'function') {
    items.push({
      id: 'relaunch',
      label: '重启 ZTools',
      click: () => context.onRelaunchApp?.()
    })
  }

  items.push({
    id: 'quit',
    label: '退出 ZTools',
    click: () => context.onRequestExit()
  })

  return items
}

export class TrayController {
  #tray: TrayAdapter | null = null
  #isSuperPanelEnabled: boolean
  #wakeAccelerator: string
  #toggleQueue: Promise<void> = Promise.resolve()
  #stopped = false

  constructor(private readonly options: TrayControllerOptions) {
    this.#isSuperPanelEnabled = options.isSuperPanelEnabled !== false
    this.#wakeAccelerator = normalizeTrayAccelerator(options.wakeAccelerator)
  }

  get state(): Required<TrayControllerState> {
    return {
      isSuperPanelEnabled: this.#isSuperPanelEnabled,
      wakeAccelerator: this.#wakeAccelerator
    }
  }

  async start(): Promise<void> {
    if (this.#tray) return
    const icon = this.options.icon
    if (!icon || typeof icon.isEmpty !== 'function' || icon.isEmpty()) {
      throw new Error('无法加载 ZTools 托盘图标')
    }

    this.#stopped = false
    const createTray = this.options.deps?.createTray ?? ((img) => new Tray(img))
    const tray = createTray(icon)
    tray.setToolTip('ZTools')
    this.#tray = tray
    this.#rebuildContextMenu()

    tray.on('click', () => {
      invokeSafely('tray-click', () => {
        if (typeof this.options.togglePrimaryWindow === 'function') {
          this.options.togglePrimaryWindow()
        } else {
          this.options.showMainWindow()
        }
      })
    })
    tray.on('double-click', () => {
      invokeSafely('tray-double-click', () => this.options.showMainWindow())
    })
  }

  updateState(patch: TrayControllerState): void {
    if (this.#stopped) return
    let changed = false
    if (typeof patch.isSuperPanelEnabled === 'boolean' && patch.isSuperPanelEnabled !== this.#isSuperPanelEnabled) {
      this.#isSuperPanelEnabled = patch.isSuperPanelEnabled
      changed = true
    }
    if (patch.wakeAccelerator !== undefined) {
      const normalized = normalizeTrayAccelerator(patch.wakeAccelerator)
      if (normalized !== this.#wakeAccelerator) {
        this.#wakeAccelerator = normalized
        changed = true
      }
    }
    if (changed && this.#tray) {
      this.#rebuildContextMenu()
    }
  }

  #handleToggleSuperPanel(menuItem?: Pick<MenuItem, 'checked'>): void {
    const operation = this.#toggleQueue.catch(() => undefined).then(async () => {
      if (this.#stopped) return
      const previous = this.#isSuperPanelEnabled
      const next = typeof menuItem?.checked === 'boolean' ? menuItem.checked : !previous
      this.#isSuperPanelEnabled = next
      this.#rebuildContextMenu()

      if (typeof this.options.onToggleSuperPanel !== 'function') return
      try {
        await this.options.onToggleSuperPanel(next)
      } catch (error) {
        console.error('托盘切换超级面板状态失败，已回滚菜单勾选状态', error)
        if (!this.#stopped) {
          this.#isSuperPanelEnabled = previous
          this.#rebuildContextMenu()
        }
      }
    })
    this.#toggleQueue = operation
  }

  #rebuildContextMenu(): void {
    if (!this.#tray || this.#stopped) return
    const buildMenu = this.options.deps?.buildMenu ?? ((tpl) => Menu.buildFromTemplate(tpl))
    const template = buildTrayMenuTemplate({
      isSuperPanelEnabled: this.#isSuperPanelEnabled,
      wakeAccelerator: this.#wakeAccelerator,
      platform: this.options.platform ?? process.platform,
      onOpenLauncher: () => invokeSafely('open-launcher', () => {
        if (typeof this.options.openLauncher === 'function') {
          this.options.openLauncher()
        } else {
          this.options.showMainWindow()
        }
      }),
      onShowMainWindow: () => invokeSafely('open-dashboard', () => this.options.showMainWindow()),
      onToggleSuperPanel: (menuItem) => this.#handleToggleSuperPanel(menuItem),
      onOpenSettings: () => invokeSafely('open-settings', () => {
        if (typeof this.options.openSettings === 'function') {
          this.options.openSettings()
        } else {
          this.options.showMainWindow()
        }
      }),
      onOpenAbout: () => invokeSafely('open-about', () => {
        if (typeof this.options.openAbout === 'function') {
          this.options.openAbout()
        } else {
          this.options.showMainWindow()
        }
      }),
      ...(typeof this.options.relaunchApp === 'function' ? {
        onRelaunchApp: () => invokeSafely('relaunch', () => this.options.relaunchApp?.())
      } : {}),
      onRequestExit: () => invokeSafely('quit', () => this.options.requestExit())
    })
    this.#tray.setContextMenu(buildMenu(template))
  }

  stop(): void {
    this.#stopped = true
    this.#tray?.destroy()
    this.#tray = null
  }
}
