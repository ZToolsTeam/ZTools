import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { InstalledFont, FontPreview } from '../../contracts/font-manager.js'
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
        if (error) throw new Error('系统字体组件未能完成读取或绘制，请重新扫描后重试')
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('字体组件数据无效')
  return value as Record<string, unknown>
}
function stringField(item: Record<string, unknown>, key: string, max = 32768) {
  if (typeof item[key] !== 'string' || item[key].length > max || item[key].includes('\0')) throw new Error('字体组件字段无效')
  return item[key]
}
export function parseFontList(value: unknown): InstalledFont[] {
  const reply = record(value)
  if (reply.success !== true || reply.version !== 1 || !Array.isArray(reply.fonts) || reply.fonts.length > 10000) throw new Error('系统字体列表读取失败')
  const seen = new Set<string>()
  return reply.fonts.map((value: unknown) => {
    const font = record(value), id = stringField(font, 'id', 1024), family = stringField(font, 'family', 1024)
    if (!id || !family || seen.has(id) || typeof font.system !== 'boolean' || typeof font.hasLicense !== 'boolean') throw new Error('系统字体条目无效')
    seen.add(id)
    return { id, family, style: stringField(font, 'style', 1024), filePath: stringField(font, 'filePath', 4096), system: font.system, hasLicense: font.hasLicense }
  })
}
export function parseFontPreview(value: unknown, id: string): FontPreview {
  const reply = record(value)
  if (reply.version !== 1 || reply.success !== true || reply.id !== id || !Array.isArray(reply.fallbacks) || reply.fallbacks.length > 320 || reply.fallbacks.some(v => typeof v !== 'string' || v.length > 1024)) throw new Error('字体预览返回了错误字体或无效结果')
  const png = stringField(reply, 'png', 3 * 1024 * 1024), bytes = Buffer.from(png, 'base64')
  if (bytes.length < 33 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== png || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== 1000 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(20) > 1580) throw new Error('字体预览图像无效')
  return { id, png, coverageWarning: reply.coverageWarning === undefined ? '' : stringField(reply, 'coverageWarning', 1024), fallbacks: reply.fallbacks as string[], license: stringField(reply, 'license'), licenseUrl: stringField(reply, 'licenseUrl'), copyright: stringField(reply, 'copyright'), manufacturer: stringField(reply, 'manufacturer') }
}
export class SystemFontProvider implements FontProvider {
  constructor(private readonly macHelper: string, private readonly platform: NodeJS.Platform = process.platform) {}
  async #request(request: FontNativeRequest, signal: AbortSignal) {
    if (this.platform === 'darwin') {
      let stat: fs.Stats
      try { stat = fs.lstatSync(this.macHelper) } catch { throw new Error('字体原生组件未构建，请更新客户端或构建 Mac 原生组件') }
      if (!path.isAbsolute(this.macHelper) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('字体原生组件无效')
      return runFontProcess(this.macHelper, [], request, signal)
    }
    if (this.platform !== 'win32') throw new Error('此平台尚未支持系统字体读取')
    const executable = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return runFontProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_FONT_SCRIPT, 'utf16le').toString('base64')], request, signal)
  }
  async list(signal: AbortSignal) { return parseFontList(await this.#request({ version: 1, operation: 'fonts-list' }, signal)) }
  async preview(id: string, text: string, signal: AbortSignal) { return parseFontPreview(await this.#request({ version: 1, operation: 'fonts-preview', id, text }, signal), id) }
}
