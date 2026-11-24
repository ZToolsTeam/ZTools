import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { clipboard } from 'electron'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { t } from '../../i18n/index.js'

export { createMacPasteAdapter } from './paste-session.js'

const execFileAsync = promisify(execFile)

export interface MacosWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MacosWindowControllerResult {
  success: boolean
  ok: boolean
  action?: string | undefined
  appName?: string | undefined
  rect?: MacosWindowBounds | undefined
  errorCode?: string | undefined
  error?: string | undefined
  message?: string | undefined
}

export interface MacosPasteResult {
  success: boolean
  clipboardWritten: boolean
  cursorOffset: number
  errorCode?: string | undefined
  error?: string | undefined
}

export const MACOS_ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'

export function getMacosAccessibilityErrorMessage(): string {
  return t('macosWindow.error.accessibilityRequired')
}

function isTccAccessibilityDeniedError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : ''
  if (code === 'EACCES' || code === 'EPERM') return true
  const stderr = typeof err === 'object' && err !== null && 'stderr' in err ? String(err.stderr) : ''
  const text = err instanceof Error ? `${err.message} ${stderr}` : String(err)
  return /not allowed assistive access|-1719|-25211|-1743|not allowed to send keystrokes|accessibility|permission denied/i.test(
    text
  )
}

export function macAccessibilityDeniedError(): ZToolsError {
  const detail = getMacosAccessibilityErrorMessage()
  return new ZToolsError(
    errorCodes.permissionDenied,
    t('macosWindow.error.copiedAutoPasteFailed', { detail }),
    {
      hostCode: 'ACCESSIBILITY_PERMISSION_DENIED',
      i18nKey: 'macosWindow.error.copiedAutoPasteFailed',
      i18nParams: { detail }
    }
  )
}

/**
 * 读取 macOS 当前前台非 ZTools 应用窗口坐标
 */
export async function getFrontmostWindowBounds(): Promise<MacosWindowControllerResult> {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      ok: false,
      errorCode: 'PLATFORM_NOT_SUPPORTED',
      error: t('macosWindow.error.notMacos')
    }
  }

  const script = `
    const se = Application("System Events");
    const procs = se.applicationProcesses.whose({ visible: true })();
    let target = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      const name = String(p.name() || "");
      if (!/^(ztools|electron)$/i.test(name)) {
        if (p.frontmost()) { target = p; break; }
        if (!target && p.windows.length > 0) { target = p; }
      }
    }
    if (!target || target.windows.length === 0) {
      JSON.stringify({ ok: false, errorCode: "NO_ACTIVE_WINDOW" });
    } else {
      const win = target.windows[0];
      const pos = win.position();
      const sz = win.size();
      JSON.stringify({
        ok: true,
        appName: String(target.name()),
        rect: {
          x: Number(pos[0]) || 0,
          y: Number(pos[1]) || 0,
          width: Number(sz[0]) || 800,
          height: Number(sz[1]) || 600
        }
      });
    }
  `

  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const parsed = JSON.parse(String(stdout || '').trim())
    if (parsed && parsed.ok && parsed.rect) {
      return {
        success: true,
        ok: true,
        appName: parsed.appName,
        rect: parsed.rect
      }
    }
    return {
      success: false,
      ok: false,
      errorCode: parsed?.errorCode || 'NO_ACTIVE_WINDOW',
      error: t('macosWindow.error.noActiveWindow')
    }
  } catch (err) {
    if (isTccAccessibilityDeniedError(err)) {
      const accessibilityMessage = getMacosAccessibilityErrorMessage()
      return {
        success: false,
        ok: false,
        errorCode: 'ACCESSIBILITY_PERMISSION_DENIED',
        error: accessibilityMessage,
        message: accessibilityMessage
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      ok: false,
      errorCode: 'OSASCRIPT_ERROR',
      error: errMsg,
      message: errMsg
    }
  }
}

/**
 * 设置 macOS 当前前台窗口（排除 ZTools/Electron 自身）的坐标与尺寸或最小化状态
 */
export async function setFrontmostWindowBounds(
  bounds: MacosWindowBounds,
  action?: string
): Promise<MacosWindowControllerResult> {
  const safeBounds: MacosWindowBounds = {
    x: Math.round(Number(bounds?.x) || 0),
    y: Math.round(Number(bounds?.y) || 0),
    width: Math.max(100, Math.round(Number(bounds?.width) || 800)),
    height: Math.max(100, Math.round(Number(bounds?.height) || 600))
  }
  const safeAction = String(action || '').trim().toLowerCase()

  if (process.platform !== 'darwin') {
    return {
      success: false,
      ok: false,
      action: safeAction,
      rect: safeBounds,
      errorCode: 'PLATFORM_NOT_SUPPORTED',
      error: t('macosWindow.error.notMacos')
    }
  }

  const jxaScript = `
    const se = Application("System Events");
    const procs = se.applicationProcesses.whose({ visible: true })();
    let target = null;
    for (let i = 0; i < procs.length; i++) {
      const p = procs[i];
      const name = String(p.name() || "");
      if (!/^(ztools|electron)$/i.test(name)) {
        if (p.frontmost()) { target = p; break; }
        if (!target && p.windows.length > 0) { target = p; }
      }
    }
    if (!target || target.windows.length === 0) {
      JSON.stringify({ ok: false, errorCode: "NO_ACTIVE_WINDOW" });
    } else {
      const win = target.windows[0];
      const act = ${JSON.stringify(safeAction)};
      if (act === "minimize") {
        win.minimized = true;
      } else {
        win.position = [${safeBounds.x}, ${safeBounds.y}];
        win.size = [${safeBounds.width}, ${safeBounds.height}];
      }
      JSON.stringify({
        ok: true,
        appName: String(target.name()),
        rect: { x: ${safeBounds.x}, y: ${safeBounds.y}, width: ${safeBounds.width}, height: ${safeBounds.height} }
      });
    }
  `

  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxaScript], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const parsed = JSON.parse(String(stdout || '').trim())
    if (parsed && parsed.ok) {
      return {
        success: true,
        ok: true,
        action: safeAction,
        appName: parsed.appName,
        rect: parsed.rect || safeBounds
      }
    }
    const noWindowMessage = t('macosWindow.error.noForegroundWindow')
    return {
      success: false,
      ok: false,
      action: safeAction,
      rect: safeBounds,
      errorCode: parsed?.errorCode || 'NO_ACTIVE_WINDOW',
      error: noWindowMessage,
      message: noWindowMessage
    }
  } catch (err) {
    if (isTccAccessibilityDeniedError(err)) {
      const accessibilityMessage = getMacosAccessibilityErrorMessage()
      return {
        success: false,
        ok: false,
        action: safeAction,
        rect: safeBounds,
        errorCode: 'ACCESSIBILITY_PERMISSION_DENIED',
        error: accessibilityMessage,
        message: accessibilityMessage
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      ok: false,
      action: safeAction,
      rect: safeBounds,
      errorCode: 'OSASCRIPT_ERROR',
      error: errMsg,
      message: errMsg
    }
  }
}

async function writeTextToMacClipboard(
  text: string,
  customWriter?: ((val: string) => void) | undefined
): Promise<boolean> {
  if (customWriter) {
    customWriter(text)
    return true
  }
  try {
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text)
      return true
    }
  } catch {
    // Electron clipboard 在纯 Node 测试环境可能不可用，回退到 pbcopy
  }

  if (process.platform === 'darwin') {
    return await new Promise<boolean>((resolve) => {
      try {
        const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('error', () => resolve(false))
        child.on('close', (code) => resolve(code === 0))
        child.stdin?.end(text, 'utf8')
      } catch {
        resolve(false)
      }
    })
  }
  return false
}

/**
 * macOS 活动窗口自动回贴 (写入剪贴板 -> Cmd+V 模拟按键 -> 按 {cursor} 偏移回退左方向键)
 */
export async function pasteToActiveWindowOnMac(
  text: string,
  cursorOffsetFromEnd = 0,
  options?: { writeClipboard?: ((val: string) => void) | undefined }
): Promise<MacosPasteResult> {
  const safeText = String(text ?? '')
  const safeOffset = Math.max(0, Math.min(5000, Math.floor(Number(cursorOffsetFromEnd) || 0)))
  const clipboardWritten = await writeTextToMacClipboard(safeText, options?.writeClipboard)

  if (process.platform !== 'darwin') {
    return {
      success: clipboardWritten,
      clipboardWritten,
      cursorOffset: safeOffset
    }
  }

  const lines = [
    'tell application "System Events"',
    '  keystroke "v" using command down'
  ]
  if (safeOffset > 0) {
    lines.push('  delay 0.02')
    lines.push(`  repeat ${safeOffset} times`)
    lines.push('    key code 123')
    lines.push('  end repeat')
  }
  lines.push('end tell')

  try {
    await execFileAsync('/usr/bin/osascript', ['-e', lines.join('\n')], {
      timeout: 3000,
      encoding: 'utf8'
    })
    return {
      success: true,
      clipboardWritten: true,
      cursorOffset: safeOffset
    }
  } catch (err) {
    if (isTccAccessibilityDeniedError(err)) {
      return {
        success: false,
        clipboardWritten,
        cursorOffset: safeOffset,
        errorCode: 'ACCESSIBILITY_PERMISSION_DENIED',
        error: t('macosWindow.error.copiedEnableAccessibility')
      }
    }
    return {
      success: false,
      clipboardWritten,
      cursorOffset: safeOffset,
      errorCode: 'OSASCRIPT_ERROR',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
