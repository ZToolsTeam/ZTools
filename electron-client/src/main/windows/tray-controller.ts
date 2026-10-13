import { Menu, Tray } from 'electron'

export interface TrayControllerOptions {
  icon: Electron.NativeImage
  showMainWindow(): void
  requestExit(): void
}

export class TrayController {
  #tray: Tray | null = null

  constructor(private readonly options: TrayControllerOptions) {}

  async start(): Promise<void> {
    if (this.#tray) return
    const icon = this.options.icon
    if (icon.isEmpty()) throw new Error('无法加载 ZTools 托盘图标')

    const tray = new Tray(icon)
    tray.setToolTip('ZTools')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => this.options.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.options.requestExit() }
    ]))
    tray.on('click', () => this.options.showMainWindow())
    tray.on('double-click', () => this.options.showMainWindow())
    this.#tray = tray
  }

  stop(): void {
    this.#tray?.destroy()
    this.#tray = null
  }
}
