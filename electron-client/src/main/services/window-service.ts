import { app, BrowserWindow, dialog, nativeTheme, screen, webContents } from 'electron'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  PopoutHandoffParams,
  WindowCloseConfirmParams,
  WindowDialogParams,
  WindowOpenParams,
  WindowPopoutHandoffTakeParams,
  WindowSetAlwaysOnTopParams,
  WindowSetHeightParams,
  WindowSetOpacityParams,
  WindowSetSizeParams,
  WindowUrlParams
} from '../../contracts/method-params.js'
import type { FileSystemService } from './file-system-service.js'
import type { PathGrantService } from './path-grant-service.js'
import { PathReferenceDialogs } from './path-reference-dialogs.js'
import { createElectronReferenceDialogProvider } from '../platform/electron-reference-dialog.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { clampBoundsToWorkArea } from '../windows/display-bounds.js'
import {
  getTitleBarOverlayOptions,
  getTrafficLightPosition,
  getWindowBackgroundColor,
  isWindows11OrLater,
  POPOUT_TITLE_BAR_HEIGHT,
  secureWebPreferences
} from '../windows/main-window.js'

const localWebOrigin = 'ztools://web'
const MAX_POPOUT_WINDOWS = 8
/** 新窗口必须在此时间内取走交接的状态，否则丢弃 */
export const POPOUT_HANDOFF_TTL_MS = 60_000

/** 等待新窗口取走的插件状态（一个窗口只保留最新一份） */
interface PendingPopoutHandoff {
  readonly id: string
  readonly pluginId: string
  readonly featureCode: string
  readonly state: string
  readonly expiresAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export type PopoutHandoffTakeResult =
  | { success: true; status: 'none' }
  | { success: true; status: 'ok'; pluginId: string; featureCode: string; state: string }

/** 从 #/popout/<id>?... 或 #/declarative/<id>?... 里取出插件 ID（原样，不改大小写）与 hash 查询参数 */
export function parsePopoutRoute(localUrl: string): { pluginId: string; query: URLSearchParams } | undefined {
  const hash = new URL(requireLocalUrl(localUrl)).hash || ''
  const match = /^#\/(?:popout|declarative)\/([A-Za-z0-9._-]+)(?:\?(.*))?$/s.exec(hash)
  if (!match?.[1]) return undefined
  return { pluginId: match[1], query: new URLSearchParams(match[2] ?? '') }
}

function callerWindow(caller: CallerIdentity): BrowserWindow {
  const contents = webContents.fromId(caller.webContentsId)
  const window = contents ? BrowserWindow.fromWebContents(contents) : null
  if (!window || window.isDestroyed()) {
    throw new ZToolsError(errorCodes.callerDestroyed, '调用者窗口已销毁')
  }
  return window
}

export function requireLocalUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value, `${localWebOrigin}/`)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'url 无效')
  }
  if (url.protocol !== 'ztools:' || url.hostname !== 'web' || url.username || url.password) {
    throw new ZToolsError(errorCodes.permissionDenied, '只允许访问 ztools://web 本地页面')
  }
  return url.toString()
}

export function extractPopoutKey(localUrl: string): string {
  const normalized = requireLocalUrl(localUrl)
  const parsed = new URL(normalized)
  const hash = parsed.hash || ''
  const pluginMatch = /^#\/(?:popout|declarative)\/([A-Za-z0-9._-]+)/.exec(hash)
  if (pluginMatch?.[1]) {
    return `plugin:${pluginMatch[1].toLowerCase()}`
  }
  const hashPath = (hash.split('?')[0] || '#').trim()
  return `route:${parsed.pathname}${hashPath}`
}

export function parseDialogFilters(value?: string): Electron.FileFilter[] | undefined {
  if (!value) return undefined
  const parts = value.split('|').map((item) => item.trim())
  if (parts.length % 2 !== 0) {
    throw new ZToolsError(errorCodes.invalidRequest, 'filters 必须为名称和扩展名成对结构')
  }
  const filters: Electron.FileFilter[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const name = parts[index]
    const patterns = parts[index + 1]
    if (!name || !patterns) throw new ZToolsError(errorCodes.invalidRequest, 'filters 包含空项')
    const extensions = patterns.split(';').map((pattern) => {
      const normalized = pattern.trim()
      if (normalized === '*' || normalized === '*.*') return '*'
      const match = /^(?:\*\.)?([A-Za-z0-9][A-Za-z0-9+_-]{0,31})$/.exec(normalized)
      if (!match?.[1]) throw new ZToolsError(errorCodes.invalidRequest, '文件筛选扩展名无效')
      return match[1]
    })
    filters.push({ name, extensions: [...new Set(extensions)] })
  }
  return filters
}

export function normalizeOpenDialogProperties(
  value?: string[]
): NonNullable<Electron.OpenDialogOptions['properties']> {
  const properties = [...new Set(value ?? ['openFile'])] as NonNullable<Electron.OpenDialogOptions['properties']>
  if (!properties.includes('openFile') && !properties.includes('openDirectory')) {
    properties.unshift('openFile')
  }
  return properties
}

function saveDefaultPath(options: WindowDialogParams): string | undefined {
  if (options.defaultPath && options.defaultName) return path.join(options.defaultPath, options.defaultName)
  return options.defaultPath ?? options.defaultName
}

function tooltipHtml(text: string): string {
  const escaped = text.replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;overflow:hidden}
    body{display:flex;box-sizing:border-box;padding:7px 10px;color:#f7f9fc;
      background:#20252b;border:1px solid #56606b;border-radius:4px;
      font:13px "Segoe UI",sans-serif;line-height:18px;white-space:pre-wrap}
  </style></head><body>${escaped}</body></html>`
}

function recordBarHtml(initialDuration = 0): string {
  const safeSeconds = Math.max(0, Math.floor(initialDuration))
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>录屏控制条</title>
<style>
  * { box-sizing: border-box; user-select: none; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%; overflow: hidden; background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .capsule-bar {
    width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 10px 0 12px;
    background: rgba(22, 26, 33, 0.95);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 25px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.3);
    color: #fff;
    -webkit-app-region: drag;
  }
  .drag-handle {
    display: flex; align-items: center; justify-content: center;
    color: rgba(255, 255, 255, 0.35);
    font-size: 15px; margin-right: 6px;
    cursor: grab;
    line-height: 1;
  }
  .indicator-group {
    display: flex; align-items: center; gap: 8px;
    -webkit-app-region: no-drag;
  }
  .rec-dot {
    width: 10px; height: 10px; border-radius: 50%; background: #ff4d4f;
    box-shadow: 0 0 10px #ff4d4f;
    animation: recPulse 1.4s infinite ease-in-out;
  }
  @keyframes recPulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.3; transform: scale(0.8); }
  }
  .timer {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 14px; font-weight: 600; color: #ffffff; letter-spacing: 0.8px;
  }
  .divider {
    width: 1px; height: 18px; background: rgba(255, 255, 255, 0.15); margin: 0 4px;
    -webkit-app-region: no-drag;
  }
  .actions {
    display: flex; align-items: center; gap: 6px;
    -webkit-app-region: no-drag;
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 30px; border-radius: 6px; border: none;
    cursor: pointer; transition: all 0.15s ease; outline: none;
    font-size: 12px; font-weight: 500;
  }
  .btn-stop {
    padding: 0 10px;
    background: #ff4d4f; color: #fff;
    box-shadow: 0 2px 6px rgba(255, 77, 79, 0.4);
    gap: 5px;
  }
  .btn-stop:hover {
    background: #ff7875;
    box-shadow: 0 3px 10px rgba(255, 77, 79, 0.6);
  }
  .btn-stop .stop-icon {
    width: 10px; height: 10px; background: #fff; border-radius: 2px;
  }
  .btn-icon {
    width: 30px; padding: 0;
    color: rgba(255, 255, 255, 0.65);
    background: rgba(255, 255, 255, 0.08);
  }
  .btn-icon:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.18);
  }
</style>
</head>
<body>
<div class="capsule-bar">
  <div class="drag-handle" title="按住拖拽">⋮⋮</div>
  <div class="indicator-group">
    <div class="rec-dot" id="dot"></div>
    <div class="timer" id="timer">00:00:00</div>
  </div>
  <div class="divider"></div>
  <div class="actions">
    <button class="btn btn-stop" id="btn-stop" title="结束录制并保存">
      <span class="stop-icon"></span>
      <span>结束</span>
    </button>
    <button class="btn btn-icon" id="btn-restore" title="还原主窗口">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
    </button>
    <button class="btn btn-icon" id="btn-cancel" title="放弃本次录制">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  </div>
</div>
<script>
  let seconds = ${safeSeconds};
  const timerEl = document.getElementById('timer');
  function formatTime(s) {
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const p = n => String(n).padStart(2, '0');
    return hrs > 0 ? (p(hrs) + ':' + p(mins) + ':' + p(secs)) : (p(mins) + ':' + p(secs));
  }
  timerEl.textContent = formatTime(seconds);
  setInterval(() => {
    seconds++;
    timerEl.textContent = formatTime(seconds);
  }, 1000);

  function sendAction(action) {
    document.title = 'action:' + action;
    try { location.href = 'action:' + action; } catch (e) {}
  }
  document.getElementById('btn-stop').onclick = () => { sendAction('stop'); };
  document.getElementById('btn-restore').onclick = () => { sendAction('restore'); };
  document.getElementById('btn-cancel').onclick = () => { sendAction('cancel'); };

  window.updateDuration = (newSeconds) => {
    seconds = newSeconds;
    timerEl.textContent = formatTime(seconds);
  };
</script>
</body>
</html>`
}

export class WindowService {
  #tooltip: BrowserWindow | null = null
  #tooltipOwner: number | null = null
  #tooltipGeneration = 0
  #recordBar: BrowserWindow | null = null
  #recordBarOwnerId: number | null = null
  readonly #registry: WindowRegistry | undefined
  readonly #createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow
  readonly #popoutWindows = new Map<string, BrowserWindow>()
  readonly #popoutBounds = new Map<string, Electron.Rectangle>()
  /** 按新窗口 webContentsId 登记的交接状态 */
  readonly #popoutHandoffs = new Map<number, PendingPopoutHandoff>()
  /** 每个 popoutKey 的打开序号：加载失败时据此判断是否已被更新的弹出请求取代 */
  readonly #popoutGenerations = new Map<string, number>()
  readonly #removeRegistryListener: (() => void) | null

  constructor(
    private readonly files: FileSystemService,
    grantsOrRegistry?: PathGrantService | WindowRegistry,
    explicitRegistry?: WindowRegistry,
    createWindow: (options: Electron.BrowserWindowConstructorOptions) => BrowserWindow = (opts) => new BrowserWindow(opts)
  ) {
    const registry = grantsOrRegistry && 'onRemoved' in grantsOrRegistry ? grantsOrRegistry : explicitRegistry
    const pathGrants = grantsOrRegistry && !('onRemoved' in grantsOrRegistry) ? grantsOrRegistry : undefined
    this.#registry = registry
    this.#createWindow = createWindow
    this.#referenceDialogs = pathGrants ? new PathReferenceDialogs(
      createElectronReferenceDialogProvider(callerWindow, parseDialogFilters, normalizeOpenDialogProperties), pathGrants) : undefined
    this.#removeRegistryListener = registry?.onRemoved((webContentsId) => {
      if (this.#tooltipOwner === webContentsId) this.#hideTooltip()
      this.#dropHandoff(webContentsId)
    }) ?? null
  }

  readonly #referenceDialogs: PathReferenceDialogs | undefined
  showReferenceDialog(mode: 'open' | 'save' | 'folder', params: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    if (!this.#referenceDialogs) throw new ZToolsError(errorCodes.notSupported, '文件引用对话框尚未初始化')
    return this.#referenceDialogs.show(mode, params, caller, signal)
  }

  unsupported(feature: string): never {
    throw new ZToolsError(errorCodes.notSupported, `${feature} 在当前 Electron 架构中不受支持`)
  }

  async open(
    params: WindowOpenParams,
    caller: CallerIdentity
  ): Promise<{ success: true; windowInstanceStatus: 'created' | 'reused'; popoutKey: string }> {
    if (caller.type !== 'main') {
      throw new ZToolsError(errorCodes.permissionDenied, '仅主宿主界面允许弹出独立窗口')
    }
    const targetUrl = requireLocalUrl(params.url)
    const popoutKey = extractPopoutKey(targetUrl)
    const handoff = params.handoff ? this.#checkHandoff(params.handoff, targetUrl, caller) : undefined
    const generation = (this.#popoutGenerations.get(popoutKey) ?? 0) + 1
    this.#popoutGenerations.set(popoutKey, generation)
    const superseded = (): boolean => this.#popoutGenerations.get(popoutKey) !== generation

    for (const [key, win] of this.#popoutWindows.entries()) {
      if (win.isDestroyed()) {
        this.#popoutWindows.delete(key)
      }
    }

    const existing = this.#popoutWindows.get(popoutKey)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      const staged = handoff ? await this.#stageHandoff(existing.webContents.id, handoff, caller) : undefined
      try {
        // 复用窗口时 URL 只有 hash 不同（同文档导航，页面不重载）：页面按 URL 里新的 handoff 编号重新取状态
        await existing.loadURL(targetUrl)
      } catch (error) {
        staged?.rollback()
        if (superseded()) throw new ZToolsError(errorCodes.cancelled, '已被更新的弹出请求取代')
        throw error
      }
      return { success: true, windowInstanceStatus: 'reused', popoutKey }
    }

    if (this.#popoutWindows.size >= MAX_POPOUT_WINDOWS) {
      throw new ZToolsError(errorCodes.pluginBusy, `独立窗口数量已达上限 (${MAX_POPOUT_WINDOWS})`)
    }
    const primaryDisplay = typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined
    const workArea = primaryDisplay?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
    const saved = this.#popoutBounds.get(popoutKey)
    const defaultWidth = Math.min(1140, Math.max(820, workArea.width - 120))
    const defaultHeight = Math.min(760, Math.max(540, workArea.height - 100))
    const initialBounds = clampBoundsToWorkArea(
      saved ?? {
        x: Math.round(workArea.x + (workArea.width - defaultWidth) / 2),
        y: Math.round(workArea.y + (workArea.height - defaultHeight) / 2),
        width: defaultWidth,
        height: defaultHeight
      },
      workArea
    )

    const isDark = nativeTheme?.shouldUseDarkColors ?? true
    const isWin = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const hasMica = isWindows11OrLater()

    const popout = this.#createWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: Math.min(820, workArea.width),
      minHeight: Math.min(540, workArea.height),
      show: false,
      backgroundColor: getWindowBackgroundColor(isDark),
      autoHideMenuBar: true,
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac ? { trafficLightPosition: getTrafficLightPosition(POPOUT_TITLE_BAR_HEIGHT) } : {}),
      ...(isWin ? { titleBarOverlay: getTitleBarOverlayOptions(isDark, POPOUT_TITLE_BAR_HEIGHT) } : {}),
      ...(hasMica ? { backgroundMaterial: 'mica' } : {}),
      ...(isMac ? { vibrancy: 'sidebar' } : {}),
      webPreferences: secureWebPreferences()
    })

    if (this.#registry && popout.webContents && typeof popout.webContents.id === 'number') {
      try {
        this.#registry.registerMain(popout.webContents)
      } catch {
        // Ignore if already registered in mock test environment
      }
    }

    const savePopoutBounds = (): void => {
      if (popout.isDestroyed() || popout.isMinimized() || popout.isMaximized() || popout.isFullScreen()) return
      const b = typeof popout.getNormalBounds === 'function' ? popout.getNormalBounds() : popout.getBounds()
      this.#popoutBounds.set(popoutKey, b)
    }

    popout.on('resize', savePopoutBounds)
    popout.on('move', savePopoutBounds)
    const popoutContentsId = popout.webContents?.id
    popout.once('closed', () => {
      if (this.#popoutWindows.get(popoutKey) === popout) {
        this.#popoutWindows.delete(popoutKey)
      }
      if (typeof popoutContentsId === 'number') this.#dropHandoff(popoutContentsId)
    })

    if (popout.webContents?.on) {
      popout.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('ztools://web/')) event.preventDefault()
      })
      popout.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
      popout.webContents.on('will-attach-webview', (event) => event.preventDefault())
    }

    this.#popoutWindows.set(popoutKey, popout)

    let staged: { rollback(): void } | undefined
    try {
      // 先登记交接状态与授权、再加载：页面一加载就可能来取
      staged = handoff ? await this.#stageHandoff(popout.webContents.id, handoff, caller) : undefined
      await popout.loadURL(targetUrl)
      if (!popout.isDestroyed()) {
        popout.show()
        popout.focus()
      }
    } catch (error) {
      staged?.rollback()
      // 加载被同一插件更新的弹出请求打断（复用了这个窗口）：窗口留给新请求，本次按取消处理
      if (superseded() && !popout.isDestroyed() && this.#popoutWindows.get(popoutKey) === popout) {
        throw new ZToolsError(errorCodes.cancelled, '已被更新的弹出请求取代')
      }
      if (this.#popoutWindows.get(popoutKey) === popout) this.#popoutWindows.delete(popoutKey)
      if (!popout.isDestroyed()) popout.destroy()
      throw error
    }

    return { success: true, windowInstanceStatus: 'created', popoutKey }
  }

  /**
   * 新窗口取走弹出前交接的插件状态：只交给登记时的那个窗口、只交付 URL 里编号对应的最新一份，读取即删除。
   * 插件代码（带会话归属的调用）不能代取。
   */
  takePopoutHandoff(params: WindowPopoutHandoffTakeParams, caller: CallerIdentity): PopoutHandoffTakeResult {
    if (caller.type !== 'main' || caller.attributedPlugin) {
      throw new ZToolsError(errorCodes.permissionDenied, '只有宿主界面可以取走独立窗口交接的状态')
    }
    const entry = this.#popoutHandoffs.get(caller.webContentsId)
    if (!entry || entry.id !== params.handoffId) return { success: true, status: 'none' }
    this.#dropHandoff(caller.webContentsId)
    if (entry.expiresAt <= Date.now()) return { success: true, status: 'none' }
    return { success: true, status: 'ok', pluginId: entry.pluginId, featureCode: entry.featureCode, state: entry.state }
  }

  /** 交接参数与 URL 交叉校验：插件 ID、功能码、交接编号必须与 URL 一致；state 必须是 JSON 对象 */
  #checkHandoff(handoff: PopoutHandoffParams, targetUrl: string, caller: CallerIdentity): PopoutHandoffParams & { featureCode: string } {
    if (caller.attributedPlugin) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件不能代替宿主交接独立窗口状态')
    }
    const route = parsePopoutRoute(targetUrl)
    if (!route || route.pluginId !== handoff.pluginId) {
      throw new ZToolsError(errorCodes.invalidRequest, 'handoff.pluginId 与独立窗口地址不一致', { path: 'handoff.pluginId' })
    }
    if (route.query.get('handoff') !== handoff.id) {
      throw new ZToolsError(errorCodes.invalidRequest, 'handoff.id 与独立窗口地址不一致', { path: 'handoff.id' })
    }
    const featureCode = handoff.featureCode ?? ''
    if ((route.query.get('feature') ?? '') !== featureCode) {
      throw new ZToolsError(errorCodes.invalidRequest, 'handoff.featureCode 与独立窗口地址不一致', { path: 'handoff.featureCode' })
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(handoff.state)
    } catch {
      parsed = undefined
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'handoff.state 必须是 JSON 对象', { path: 'handoff.state' })
    }
    return { ...handoff, featureCode }
  }

  /** 以新窗口身份登记交接状态（替换旧的一份）并转交路径授权；返回撤销本次登记的函数 */
  async #stageHandoff(
    webContentsId: number,
    handoff: PopoutHandoffParams & { featureCode: string },
    caller: CallerIdentity
  ): Promise<{ rollback(): void }> {
    this.#dropHandoff(webContentsId)
    const entry: PendingPopoutHandoff = {
      id: handoff.id,
      pluginId: handoff.pluginId,
      featureCode: handoff.featureCode,
      state: handoff.state,
      expiresAt: Date.now() + POPOUT_HANDOFF_TTL_MS,
      timer: undefined
    }
    entry.timer = setTimeout(() => {
      if (this.#popoutHandoffs.get(webContentsId) === entry) this.#dropHandoff(webContentsId)
    }, POPOUT_HANDOFF_TTL_MS)
    entry.timer.unref?.()
    this.#popoutHandoffs.set(webContentsId, entry)

    let revokeGrants: (() => void) | undefined
    if (handoff.paths && handoff.paths.length > 0) {
      try {
        const transfer = await this.files.transferGrants(caller, webContentsId, handoff.paths, handoff.pluginId)
        revokeGrants = transfer.revoke
        console.info('[popout] 交接路径授权', {
          pluginId: handoff.pluginId, transferred: transfer.transferred, dropped: transfer.dropped
        })
      } catch (error) {
        // 授权转交失败不阻止弹出：状态照常交接，新窗口里这些路径需要用户重新选择
        console.warn('[popout] 路径授权转交失败', {
          pluginId: handoff.pluginId, code: error instanceof ZToolsError ? error.code : 'UNKNOWN'
        })
      }
    }
    return {
      rollback: () => {
        if (this.#popoutHandoffs.get(webContentsId) === entry) this.#dropHandoff(webContentsId)
        revokeGrants?.()
      }
    }
  }

  #dropHandoff(webContentsId: number): void {
    const entry = this.#popoutHandoffs.get(webContentsId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.#popoutHandoffs.delete(webContentsId)
  }

  close(caller: CallerIdentity): { success: true } {
    const window = callerWindow(caller)
    setImmediate(() => {
      if (!window.isDestroyed()) window.close()
    })
    return { success: true }
  }

  minimize(caller: CallerIdentity): { success: true } {
    callerWindow(caller).minimize()
    return { success: true }
  }

  maximize(caller: CallerIdentity): { success: true; maximized: boolean } {
    const window = callerWindow(caller)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return { success: true, maximized: window.isMaximized() }
  }

  toggleFullscreen(caller: CallerIdentity): { success: true; fullscreen: boolean } {
    const window = callerWindow(caller)
    const fullscreen = !window.isFullScreen()
    window.setFullScreen(fullscreen)
    return { success: true, fullscreen }
  }

  hide(caller: CallerIdentity): { success: true } {
    callerWindow(caller).hide()
    return { success: true }
  }

  show(caller: CallerIdentity): { success: true } {
    const window = callerWindow(caller)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return { success: true }
  }

  setHeight(params: WindowSetHeightParams, caller: CallerIdentity): { success: true } {
    const window = callerWindow(caller)
    const width = window.getSize()[0] ?? 1
    window.setSize(width, params.height)
    return { success: true }
  }

  async redirect(params: WindowUrlParams, caller: CallerIdentity): Promise<{ success: true }> {
    const window = callerWindow(caller)
    await window.loadURL(requireLocalUrl(params.url))
    return { success: true }
  }

  async showOpenDialog(params: WindowDialogParams, caller: CallerIdentity): Promise<unknown> {
    const properties = normalizeOpenDialogProperties(params.properties)
    const filters = parseDialogFilters(params.filters)
    const result = await dialog.showOpenDialog(callerWindow(caller), {
      ...(params.title ? { title: params.title } : {}),
      ...(params.defaultPath ? { defaultPath: params.defaultPath } : {}),
      ...(filters ? { filters } : {}),
      properties
    })
    if (result.canceled) return { canceled: true }
    const fileUrls = await Promise.all(result.filePaths.map((item) => this.files.grantOpenPath(item, caller)))
    if (result.filePaths.length === 1) {
      return {
        canceled: false,
        filePath: result.filePaths[0],
        ...(fileUrls[0] ? { fileUrl: fileUrls[0] } : {})
      }
    }
    return {
      canceled: false,
      filePaths: result.filePaths.map((item, index) => ({
        path: item,
        ...(fileUrls[index] ? { fileUrl: fileUrls[index] } : {})
      }))
    }
  }

  async showSaveDialog(params: WindowDialogParams, caller: CallerIdentity): Promise<unknown> {
    const filters = parseDialogFilters(params.filters)
    const defaultPath = saveDefaultPath(params)
    const result = await dialog.showSaveDialog(callerWindow(caller), {
      ...(params.title ? { title: params.title } : {}),
      ...(defaultPath ? { defaultPath } : {}),
      ...(filters ? { filters } : {})
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    const fileUrl = await this.files.grantSavePath(result.filePath, caller)
    return { canceled: false, filePath: result.filePath, fileUrl }
  }

  async showSelectFolderDialog(params: WindowDialogParams, caller: CallerIdentity): Promise<unknown> {
    const result = await dialog.showOpenDialog(callerWindow(caller), {
      ...(params.title ? { title: params.title } : {}),
      ...(params.defaultPath ? { defaultPath: params.defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return { canceled: true }
    const folderPath = result.filePaths[0]
    if (!folderPath) throw new ZToolsError(errorCodes.internalError, '文件夹对话框未返回路径')
    await this.files.grantFolder(folderPath, caller)
    return { canceled: false, folderPath }
  }

  async showTooltip(text: string, caller: CallerIdentity): Promise<{ success: true }> {
    const owner = callerWindow(caller)
    const point = typeof screen?.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 }
    const display = typeof screen?.getDisplayNearestPoint === 'function'
      ? (screen.getDisplayNearestPoint(point) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    const workArea = display?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
    const characterCount = [...text].length
    const width = Math.min(640, Math.max(96, 20 + Math.min(72, characterCount) * 8))
    const lineCount = Math.max(1, Math.ceil(characterCount / Math.max(1, Math.floor((width - 20) / 8))))
    const height = Math.min(240, 14 + lineCount * 18)
    const bounds = clampBoundsToWorkArea({
      x: point.x + 12,
      y: point.y + 18,
      width,
      height
    }, workArea)
    const generation = ++this.#tooltipGeneration
    let tooltip = this.#tooltip
    if (!tooltip || tooltip.isDestroyed()) {
      tooltip = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      tooltip.setAlwaysOnTop(true, 'floating')
      tooltip.once('closed', () => {
        if (this.#tooltip === tooltip) {
          this.#tooltip = null
          this.#tooltipOwner = null
        }
      })
      this.#tooltip = tooltip
    }
    this.#tooltipOwner = owner.webContents.id
    tooltip.setBounds(bounds)
    await tooltip.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tooltipHtml(text))}`)
    if (generation === this.#tooltipGeneration && !tooltip.isDestroyed()) tooltip.showInactive()
    return { success: true }
  }

  hideTooltip(caller: CallerIdentity): { success: true } {
    if (this.#tooltipOwner === caller.webContentsId) this.#hideTooltip()
    return { success: true }
  }

  async showRecordBar(
    params: { duration?: number; taskId?: string },
    caller: CallerIdentity
  ): Promise<{ success: true }> {
    const owner = callerWindow(caller)
    this.hideRecordBar()

    const point = typeof screen?.getCursorScreenPoint === 'function'
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 }
    const display = typeof screen?.getDisplayNearestPoint === 'function'
      ? (screen.getDisplayNearestPoint(point) || (typeof screen?.getPrimaryDisplay === 'function' ? screen.getPrimaryDisplay() : undefined))
      : undefined
    const workArea = display?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
    const width = 320
    const height = 50
    const bounds = clampBoundsToWorkArea({
      x: workArea.x + workArea.width - width - 24,
      y: workArea.y + workArea.height - height - 36,
      width,
      height
    }, workArea)

    const recordBar = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    recordBar.setAlwaysOnTop(true, 'screen-saver')

    recordBar.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url.startsWith('action:')) {
        const action = url.slice('action:'.length)
        this.#handleRecordBarAction(action, owner)
      }
    })

    recordBar.on('page-title-updated', (event, title) => {
      event.preventDefault()
      if (title.startsWith('action:')) {
        const action = title.slice('action:'.length)
        this.#handleRecordBarAction(action, owner)
      }
    })

    recordBar.once('closed', () => {
      if (this.#recordBar === recordBar) {
        this.#recordBar = null
        this.#recordBarOwnerId = null
      }
    })

    owner.once('closed', () => {
      this.hideRecordBar()
    })

    this.#recordBar = recordBar
    this.#recordBarOwnerId = owner.webContents.id

    const html = recordBarHtml(params.duration ?? 0)
    await recordBar.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    if (!recordBar.isDestroyed()) {
      recordBar.showInactive()
    }
    return { success: true }
  }

  updateRecordBar(
    params: { duration?: number; status?: string },
    caller: CallerIdentity
  ): { success: true } {
    if (this.#recordBar && !this.#recordBar.isDestroyed() && this.#recordBarOwnerId === caller.webContentsId) {
      if (params.duration !== undefined) {
        this.#recordBar.webContents
          .executeJavaScript(`typeof window.updateDuration === 'function' && window.updateDuration(${Math.floor(params.duration)})`)
          .catch(() => undefined)
      }
    }
    return { success: true }
  }

  hideRecordBar(caller?: CallerIdentity): { success: true } {
    if (this.#recordBar && !this.#recordBar.isDestroyed()) {
      if (!caller || this.#recordBarOwnerId === caller.webContentsId) {
        this.#recordBar.destroy()
        this.#recordBar = null
        this.#recordBarOwnerId = null
      }
    }
    return { success: true }
  }

  #handleRecordBarAction(action: string, owner: BrowserWindow): void {
    if (!owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
      owner.webContents
        .executeJavaScript(
          `window.dispatchEvent(new CustomEvent('ztools-record-bar:action', { detail: { action: ${JSON.stringify(action)} } }))`
        )
        .catch(() => undefined)
    }
    if (action === 'stop' || action === 'cancel') {
      this.hideRecordBar()
    }
  }

  stop(): void {
    this.#removeRegistryListener?.()
    this.#hideTooltip()
    this.hideRecordBar()
    this.#tooltip?.destroy()
    this.#tooltip = null
    this.#tooltipOwner = null
    for (const popout of this.#popoutWindows.values()) {
      try {
        if (!popout.isDestroyed()) popout.destroy()
      } catch {
        // Ignore destruction errors on shutdown
      }
    }
    this.#popoutWindows.clear()
    for (const webContentsId of [...this.#popoutHandoffs.keys()]) this.#dropHandoff(webContentsId)
    this.#popoutGenerations.clear()
  }

  setSize(params: WindowSetSizeParams, caller: CallerIdentity): { success: true } {
    callerWindow(caller).setSize(params.width, params.height, params.animate)
    return { success: true }
  }

  getBounds(caller: CallerIdentity): { success: true; x: number; y: number; width: number; height: number } {
    return { success: true, ...callerWindow(caller).getBounds() }
  }

  setOpacity(params: WindowSetOpacityParams, caller: CallerIdentity): { success: true } {
    callerWindow(caller).setOpacity(params.opacity)
    return { success: true }
  }

  setAlwaysOnTop(params: WindowSetAlwaysOnTopParams, caller: CallerIdentity): { success: true } {
    callerWindow(caller).setAlwaysOnTop(params.alwaysOnTop)
    return { success: true }
  }

  toggleDevTools(caller: CallerIdentity): { success: true } {
    const contents = callerWindow(caller).webContents
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach' })
    return { success: true }
  }

  async handleCloseConfirm(
    params: WindowCloseConfirmParams,
    caller: CallerIdentity,
    disableFutureConfirmation: () => Promise<void>
  ): Promise<WindowCloseConfirmParams & { success: true }> {
    const window = callerWindow(caller)
    if (params.doNotAskAgain) await disableFutureConfirmation()
    if (params.action === 'exit') setImmediate(() => app.quit())
    else if (params.action === 'minimize') setImmediate(() => !window.isDestroyed() && window.hide())
    return { success: true, ...params }
  }

  #hideTooltip(): void {
    this.#tooltipGeneration += 1
    if (this.#tooltip && !this.#tooltip.isDestroyed()) this.#tooltip.hide()
    this.#tooltipOwner = null
  }
}
