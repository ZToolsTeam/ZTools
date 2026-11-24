import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { InstalledFont, FontPreview } from '../../contracts/font-manager.js'
import { getResolvedLocale, t } from '../i18n/index.js'
import { WINDOWS_FONT_SCRIPT } from './windows-font-script.js'

export type FontNativeRequest = { version: 1; operation: 'fonts-list' } | { version: 1; operation: 'fonts-preview'; id: string; text: string }
export interface FontProvider { list(signal: AbortSignal): Promise<InstalledFont[]>; preview(id: string, text: string, signal: AbortSignal): Promise<FontPreview> }
export function macFontHelperPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacVision') : path.resolve(__dirname, '../../mac-vision-native/native/ZToolsMacVision')
}
export function runFontProcess(executable: string, args: string[], request: FontNativeRequest, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      signal.removeEventListener('abort', cancel)
      try {
        signal.throwIfAborted()
        if (error) throw new Error('System font helper failed to read or render; rescan and retry')
        resolve(JSON.parse(stdout))
      } catch (failure) { reject(failure) }
    })
    const cancel = () => { child.kill('SIGKILL') }
    signal.addEventListener('abort', cancel, { once: true })
    child.stdin?.on('error', () => { /* 组件提前退出时，execFile 回调负责报告失败。 */ })
    child.stdin?.end(JSON.stringify(request))
    if (signal.aborted) cancel()
  })
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid font helper payload')
  return value as Record<string, unknown>
}
function stringField(item: Record<string, unknown>, key: string, max = 32768) {
  if (typeof item[key] !== 'string' || item[key].length > max || item[key].includes('\0')) throw new Error('Invalid font helper field')
  return item[key]
}
export function parseFontList(value: unknown): InstalledFont[] {
  const reply = record(value)
  if (reply.success !== true || reply.version !== 1 || !Array.isArray(reply.fonts) || reply.fonts.length > 10000) throw new Error('Failed to read system font list')
  const seen = new Set<string>()
  return reply.fonts.map((value: unknown) => {
    const font = record(value), id = stringField(font, 'id', 1024), family = stringField(font, 'family', 1024)
    if (!id || !family || seen.has(id) || typeof font.system !== 'boolean' || typeof font.hasLicense !== 'boolean') throw new Error('Invalid system font entry')
    seen.add(id)
    return { id, family, style: stringField(font, 'style', 1024), filePath: stringField(font, 'filePath', 4096), system: font.system, hasLicense: font.hasLicense }
  })
}
function formatCoverageWarningFromCode(code: string, fallbackFonts: readonly string[]): string | undefined {
  if (code === 'MISSING_GLYPHS_LAST_RESORT') {
    if (fallbackFonts.length === 0) {
      return t('font.coverageWarning.missingGlyphs')
    }
    const shown = fallbackFonts.slice(0, 8)
    const separator = getResolvedLocale() === 'zh-CN' ? '、' : ', '
    let names = shown.join(separator)
    if (names.length > 600) {
      names = `${names.slice(0, 600)}…`
    }
    const localized = fallbackFonts.length > shown.length
      ? t('font.coverageWarning.missingGlyphsWithMoreFallbacks', { names, total: fallbackFonts.length })
      : t('font.coverageWarning.missingGlyphsWithFallbacks', { names })
    return localized.length > 1024 ? `${localized.slice(0, 1023)}…` : localized
  }
  if (code === 'MISSING_GLYPHS_GENERIC') {
    return t('font.coverageWarning.missingGlyphsGeneric')
  }
  return undefined
}

export function parseFontPreview(value: unknown, id: string): FontPreview {
  const reply = record(value)
  if (reply.version !== 1 || reply.success !== true || reply.id !== id || !Array.isArray(reply.fallbacks) || reply.fallbacks.length > 320 || reply.fallbacks.some(v => typeof v !== 'string' || v.length > 1024)) throw new Error('Font preview returned mismatched font or invalid result')
  const png = stringField(reply, 'png', 3 * 1024 * 1024), bytes = Buffer.from(png, 'base64')
  if (bytes.length < 33 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== png || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== 1000 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 1580) throw new Error('Invalid font preview image')
  const rawCoverageWarning = reply.coverageWarning === undefined ? '' : stringField(reply, 'coverageWarning', 1024)
  const warningCode = reply.coverageWarningCode === undefined ? undefined : stringField(reply, 'coverageWarningCode', 128)
  let coverageFallbackFonts: string[] = []
  if (reply.coverageFallbackFonts !== undefined) {
    if (!Array.isArray(reply.coverageFallbackFonts) || reply.coverageFallbackFonts.length > 320 || reply.coverageFallbackFonts.some(v => typeof v !== 'string' || v.length > 1024 || v.includes('\0'))) {
      throw new Error('Invalid font helper field')
    }
    coverageFallbackFonts = reply.coverageFallbackFonts as string[]
  }
  const coverageWarning = (warningCode ? formatCoverageWarningFromCode(warningCode, coverageFallbackFonts) : undefined) ?? rawCoverageWarning
  return { id, png, coverageWarning, fallbacks: reply.fallbacks as string[], license: stringField(reply, 'license'), licenseUrl: stringField(reply, 'licenseUrl'), copyright: stringField(reply, 'copyright'), manufacturer: stringField(reply, 'manufacturer') }
}
export class SystemFontProvider implements FontProvider {
  constructor(private readonly macHelper: string, private readonly platform: NodeJS.Platform = process.platform) {}
  async #request(request: FontNativeRequest, signal: AbortSignal) {
    if (this.platform === 'darwin') {
      let stat: fs.Stats
      try { stat = fs.lstatSync(this.macHelper) } catch { throw new Error('Native font helper is not built; update the client or build the macOS native helper') }
      if (!path.isAbsolute(this.macHelper) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid native font helper')
      return runFontProcess(this.macHelper, [], request, signal)
    }
    if (this.platform !== 'win32') throw new Error('System font enumeration is not supported on this platform')
    const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return runFontProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_FONT_SCRIPT, 'utf16le').toString('base64')], request, signal)
  }
  async list(signal: AbortSignal) { return parseFontList(await this.#request({ version: 1, operation: 'fonts-list' }, signal)) }
  async preview(id: string, text: string, signal: AbortSignal) { return parseFontPreview(await this.#request({ version: 1, operation: 'fonts-preview', id, text }, signal), id) }
}
