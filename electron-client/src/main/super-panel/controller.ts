import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import path from 'node:path'
import {
  SUPER_PANEL_CALL_CHANNEL,
  isSuperPanelMethod,
  type SuperPanelMethod
} from '../../contracts/super-panel.js'
import type { ConfigService } from '../services/config-service.js'
import type { PluginStateProvider } from '../services/plugin-state-service.js'
import type { SystemToolsProvider } from '../services/system-tools-service.js'
import { decodeSuperPanelConfig, panelDimensions } from './config.js'
import { SuperPanelDataService } from './data-service.js'
import { calculateCursorRelativeBounds, clampBoundsToWorkArea } from '../windows/display-bounds.js'

const MAX_CALL_BYTES = 16 * 1024
const MIN_DISPLAY_TIME_MS = 200
const ITEM_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64}))$/i
const SYSTEM_TOOL_ITEM_ID_PATTERN = /^system-tool:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error('超级面板调用包含未知字段')
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`${label} 无效`)
  }
  return value
}

export interface SuperPanelControllerOptions {
  dataRoot: string
  config: Pick<ConfigService, 'get' | 'set'>
  getInstalledPlugins(): Promise<{ success: true; data: Record<string, unknown>[] }>
  openPlugin(pluginId: string): Promise<unknown>
  systemTools?: SystemToolsProvider
  getMainWindow(): BrowserWindow | null
  pluginState?: PluginStateProvider
}

export class SuperPanelController {
  readonly #data: SuperPanelDataService
  #window: BrowserWindow | null = null
  #loadPromise: Promise<void> | null = null
  #toggleQueue: Promise<void> = Promise.resolve()
  #openedAt = 0
  #ignoreBlur = false
  #registered = false
  #stopping = false
  #screenListenerAttached = false

  #onDisplayMetricsChanged = (): void => {
    const panel = this.#window
    if (!panel || panel.isDestroyed() || !panel.isVisible()) return
    const currentBounds = panel.getBounds()
    const display = typeof screen?.getDisplayMatching === 'function'
      ? (screen.getDisplayMatching(currentBounds) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    if (display) {
      const clamped = clampBoundsToWorkArea(currentBounds, display.workArea)
      panel.setBounds(clamped, false)
    }
  }

  #attachScreenListeners(): void {
    if (this.#screenListenerAttached || typeof screen?.on !== 'function') return
    screen.on('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.on('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = true
  }

  #detachScreenListeners(): void {
    if (!this.#screenListenerAttached || typeof screen?.removeListener !== 'function') return
    screen.removeListener('display-metrics-changed', this.#onDisplayMetricsChanged)
    screen.removeListener('display-removed', this.#onDisplayMetricsChanged)
    this.#screenListenerAttached = false
  }

  constructor(private readonly options: SuperPanelControllerOptions) {
    this.#data = new SuperPanelDataService(
      options.dataRoot,
      options.config,
      options.getInstalledPlugins,
      (target) => shell.openPath(target),
      options.pluginState,
      undefined,
      async (target) => (await app.getFileIcon(target, { size: 'large' })).toDataURL(),
      options.systemTools
    )
  }

  register(): void {
    if (this.#registered) return
    ipcMain.handle(SUPER_PANEL_CALL_CHANNEL, (event, value) => this.#handleCall(event, value))
    this.#registered = true
  }

  toggle(trigger: 'keyboard_hotkey' | 'mouse_hotkey'): void {
    const operation = this.#toggleQueue.catch(() => undefined).then(async () => {
      if (this.#stopping) return
      const panel = this.#window
      if (panel?.isVisible()) {
        this.hide('toggle')
        return
      }
      await this.show(trigger)
    })
    this.#toggleQueue = operation
    void operation.catch((error: unknown) => console.error('超级面板切换失败', error))
  }

  async show(trigger: 'keyboard_hotkey' | 'mouse_hotkey'): Promise<void> {
    const raw = await this.options.config.get('user_settings.json', 'super_panel', {})
    const config = decodeSuperPanelConfig(raw)
    if (!config.enabled || this.#stopping) return
    const panel = this.#ensureWindow()
    await this.#loadPromise
    if (panel.isDestroyed() || this.#stopping) return

    const dimensions = panelDimensions(config.size)
    const cursor = typeof screen?.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 }
    const display = typeof screen?.getDisplayNearestPoint === 'function'
      ? (screen.getDisplayNearestPoint(cursor) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    if (display) {
      const bounds = calculateCursorRelativeBounds(
        dimensions,
        cursor,
        display,
        config.position === 'cursor' ? 'cursor' : 'center'
      )
      panel.setBounds(bounds, false)
    }
    const currentBounds = panel.getBounds()
    panel.setAlwaysOnTop(true, 'pop-up-menu')
    this.#openedAt = Date.now()
    panel.show()
    panel.focus()
    const dark = nativeTheme.shouldUseDarkColors
    await panel.webContents.executeJavaScript(
      `window.__superPanelSetDarkMode?.(${dark ? 'true' : 'false'});window.__superPanelReset?.();`
    ).catch(() => undefined)
    console.info(`超级面板已显示: trigger=${trigger}, bounds=${currentBounds.x},${currentBounds.y},${currentBounds.width},${currentBounds.height}`)
  }

  hide(reason: string): void {
    const panel = this.#window
    if (!panel || panel.isDestroyed() || !panel.isVisible()) return
    panel.hide()
    panel.setAlwaysOnTop(false)
    console.info(`超级面板已隐藏: reason=${reason}`)
  }

  launchLocalApp(appId: string): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error('应用正在退出'))
    if (!/^localapp:(?:[A-F0-9]{8}|mac:[A-F0-9]{64})$/i.test(appId)) {
      return Promise.reject(new Error('本地应用快捷键目标不受支持'))
    }
    return this.#data.launchLocalApp(appId)
  }

  setDarkMode(enabled: boolean): void {
    const panel = this.#window
    if (!panel || panel.isDestroyed()) return
    panel.setBackgroundColor(enabled ? '#141414' : '#ffffff')
    void panel.webContents.executeJavaScript(
      `window.__superPanelSetDarkMode?.(${enabled ? 'true' : 'false'})`
    ).catch(() => undefined)
  }

  getPanelLocalApps(): Promise<Array<{ id: string; name: string }>> {
    return this.#data.getPanelLocalApps()
  }


  async stop(): Promise<void> {
    this.#detachScreenListeners()
    if (this.#stopping) return this.#toggleQueue.catch(() => undefined)
    this.#stopping = true
    this.#data.stop()
    if (this.#registered) {
      ipcMain.removeHandler(SUPER_PANEL_CALL_CHANNEL)
      this.#registered = false
    }
    await this.#toggleQueue.catch(() => undefined)
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy()
    this.#window = null
    this.#loadPromise = null
  }

  #ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window
    this.#attachScreenListeners()
    const panel = new BrowserWindow({
      width: 400,
      height: 300,
      minWidth: 320,
      minHeight: 240,
      show: false,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#ffffff',
      webPreferences: {
        preload: path.resolve(__dirname, '../../preload/super-panel.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    this.#window = panel
    panel.webContents.on('will-navigate', (event, url) => {
      if (url !== 'ztools://web/super-panel/index.html') event.preventDefault()
    })
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    panel.webContents.on('will-attach-webview', (event) => event.preventDefault())
    panel.webContents.on('render-process-gone', () => {
      if (!panel.isDestroyed()) panel.destroy()
    })
    panel.on('blur', () => {
      if (this.#ignoreBlur || !panel.isVisible()) return
      const remaining = MIN_DISPLAY_TIME_MS - (Date.now() - this.#openedAt)
      if (remaining <= 0) {
        this.hide('focus_lost')
        return
      }
      setTimeout(() => {
        if (!this.#ignoreBlur && panel.isVisible() && !panel.isFocused()) this.hide('focus_lost')
      }, remaining)
    })
    panel.once('closed', () => {
      if (this.#window === panel) {
        this.#window = null
        this.#loadPromise = null
      }
      this.#detachScreenListeners()
    })
    this.#loadPromise = panel.loadURL('ztools://web/super-panel/index.html').then(() => undefined)
    return panel
  }

  async #handleCall(event: IpcMainInvokeEvent, value: unknown): Promise<unknown> {
    const panel = this.#window
    if (!panel || panel.isDestroyed() || event.sender.id !== panel.webContents.id) {
      throw new Error('超级面板调用者未授权')
    }
    if (!isRecord(value)) throw new Error('超级面板调用必须是对象')
    requireKeys(value, ['method', 'params'])
    if (!isSuperPanelMethod(value.method) || !isRecord(value.params)) throw new Error('超级面板调用无效')
    if (Buffer.byteLength(JSON.stringify(value.params), 'utf8') > MAX_CALL_BYTES) {
      throw new Error('超级面板调用参数过大')
    }
    return this.#dispatch(value.method, value.params)
  }

  async #dispatch(method: SuperPanelMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'super_panel_get_data':
        requireKeys(params, [])
        return this.#data.getData()
      case 'super_panel_open_item': {
        requireKeys(params, ['id', 'itemType', 'query'])
        const id = requireText(params.id, '项目 ID', 128)
        const itemType = requireText(params.itemType, '项目类型', 32)
        const validId = itemType === 'system_tool'
          ? SYSTEM_TOOL_ITEM_ID_PATTERN.test(id)
          : ITEM_ID_PATTERN.test(id)
        if (!validId || !['plugin', 'local', 'system_tool'].includes(itemType)) {
          throw new Error('超级面板项目无效')
        }
        if (params.query !== undefined && (typeof params.query !== 'string' || params.query.length > 512)) {
          throw new Error('搜索文本无效')
        }
        if (itemType === 'local') await this.#data.launchLocalApp(id)
        else if (itemType === 'system_tool') {
          if (!this.options.systemTools) throw new Error('系统工具不可用')
          await this.options.systemTools.openTarget(id.slice('system-tool:'.length))
        } else {
          await this.#data.markPluginUsed(id)
          await this.options.openPlugin(id)
        }
        this.hide('item_select')
        return { success: true }
      }
      case 'super_panel_toggle_pin': {
        requireKeys(params, ['id', 'itemType'])
        const id = requireText(params.id, '项目 ID', 128)
        const itemType = requireText(params.itemType, '项目类型', 32)
        return { success: true, pinned: await this.#data.togglePin(id, itemType) }
      }
      case 'super_panel_add_local_app': {
        requireKeys(params, [])
        const panel = this.#window
        if (!panel || panel.isDestroyed()) throw new Error('超级面板窗口不可用')
        this.#ignoreBlur = true
        try {
          const result = await dialog.showOpenDialog(panel, {
            title: '添加本地软件',
            properties: ['openFile', 'multiSelections'],
            filters: process.platform === 'darwin'
              ? [{ name: 'macOS 应用程序', extensions: ['app'] }]
              : [{ name: 'Windows 程序', extensions: ['exe'] }]
          })
          const added = result.canceled ? 0 : await this.#data.addLocalApps(result.filePaths)
          if (!result.canceled && panel.isVisible()) panel.focus()
          return { success: true, added }
        } finally {
          this.#ignoreBlur = false
          this.#openedAt = Date.now()
        }
      }
      case 'super_panel_open_settings':
        requireKeys(params, [])
        this.hide('settings')
        await this.#navigateMain("window.__navigateTo?.('/advanced-settings',{scrollToSuperPanelSettings:true})")
        return { success: true }
      case 'super_panel_open_shortcut_settings':
        requireKeys(params, [])
        this.hide('settings')
        await this.#navigateMain("window.__navigateTo?.('/advanced-settings',{openShortcutSettings:true})")
        return { success: true }
      case 'super_panel_hide':
        requireKeys(params, [])
        this.hide('frontend')
        return { success: true }
      case 'super_panel_drag':
      case 'window_hide_tooltip':
        requireKeys(params, [])
        return { success: true }
      case 'window_show_tooltip':
        requireKeys(params, ['text'])
        requireText(params.text, 'Tooltip 文本', 512)
        return { success: true }
      default:
        throw new Error('未知超级面板方法')
    }
  }

  async #navigateMain(script: string): Promise<void> {
    const main = this.options.getMainWindow()
    if (!main || main.isDestroyed()) throw new Error('主窗口不可用')
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    await main.webContents.executeJavaScript(script)
  }
}
