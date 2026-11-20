import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { isDoubleModifier, SHELL_SHORTCUTS } from '../../contracts/hotkey-rules.js'
import { toElectronAccelerator } from '../platform/common/electron-global-shortcut.js'
import { getResolvedLocale, t } from '../i18n/index.js'

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
  wakeAccelerator: string
  platform: NodeJS.Platform
  onOpenLauncher(): void
  onShowMainWindow(): void
  onOpenSettings(): void
  onOpenAbout(): void
  onRelaunchApp?: (() => void) | undefined
  onRequestExit(): void
}

export function buildTrayMenuTemplate(
  context: BuildTrayMenuContext
): MenuItemConstructorOptions[] {
  const settingsAccelerator = context.platform === 'darwin'
    ? SHELL_SHORTCUTS.OPEN_SETTINGS.replace(/^Ctrl\+/i, 'Command+')
    : SHELL_SHORTCUTS.OPEN_SETTINGS
  // 双击修饰键不是合法 Electron Menu Accelerator，不能传给 Menu.buildFromTemplate 以免报错
  const wakeAccelerator = context.wakeAccelerator && !isDoubleModifier(context.wakeAccelerator)
    ? toElectronAccelerator(context.wakeAccelerator)
    : undefined
  const items: MenuItemConstructorOptions[] = [
    {
      id: 'open-launcher',
      label: t('tray.openLauncher'),
      // 与全局快捷键注册同一套转换：设置里的 Ctrl 在 macOS 上实际是 ⌘，菜单按实际按键显示
      ...(wakeAccelerator ? { accelerator: wakeAccelerator } : {}),
      click: () => context.onOpenLauncher()
    },
    {
      id: 'open-dashboard',
      label: t('tray.openDashboard'),
      click: () => context.onShowMainWindow()
    },
    { type: 'separator' },
    {
      id: 'open-settings',
      label: t('tray.preferences'),
      accelerator: settingsAccelerator,
      click: () => context.onOpenSettings()
    },
    {
      id: 'open-about',
      label: t('tray.checkUpdatesAbout'),
      click: () => context.onOpenAbout()
    },
    { type: 'separator' }
  ]

  if (typeof context.onRelaunchApp === 'function') {
    items.push({
      id: 'relaunch',
      label: t('tray.relaunch'),
      click: () => context.onRelaunchApp?.()
    })
  }

  items.push({
    id: 'quit',
    label: t('tray.quit'),
    click: () => context.onRequestExit()
  })

  return items
}

export class TrayController {
  #tray: TrayAdapter | null = null
  #wakeAccelerator: string
  #locale: string = getResolvedLocale()
  #stopped = false

  constructor(private readonly options: TrayControllerOptions) {
    this.#wakeAccelerator = normalizeTrayAccelerator(options.wakeAccelerator)
  }

  get state(): Required<TrayControllerState> {
    return {
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
    if (patch.wakeAccelerator !== undefined) {
      const normalized = normalizeTrayAccelerator(patch.wakeAccelerator)
      if (normalized !== this.#wakeAccelerator) {
        this.#wakeAccelerator = normalized
        changed = true
      }
    }
    const currentLocale = getResolvedLocale()
    if (currentLocale !== this.#locale) {
      this.#locale = currentLocale
      changed = true
    }
    if (changed && this.#tray) {
      this.#rebuildContextMenu()
    }
  }

  #rebuildContextMenu(): void {
    if (!this.#tray || this.#stopped) return
    const buildMenu = this.options.deps?.buildMenu ?? ((tpl) => Menu.buildFromTemplate(tpl))
    const template = buildTrayMenuTemplate({
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
