import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export type MediaTags = Record<string, unknown>
const locationTag = /(?:gps|latitude|longitude|location|geotag|^(?:City|Country|Province|State|SubLocation)$)/i
export const isLocationTag = (key: string) => locationTag.test(key.split(':').pop()!)
export const tagValue = (tags: MediaTags, name: string) => Object.entries(tags).find(([key]) => key.endsWith(':' + name))?.[1]
export const cleanableTypes = new Set(['JPEG', 'PNG', 'HEIC', 'HEIF'])
const displayTag = /:(?:Gamma|SRGBRendering|WhitePoint[XY]|(?:Red|Green|Blue)[XY]|ColorPrimaries|TransferCharacteristics|MatrixCoefficients|VideoFullRangeFlag|BackgroundColor|SignificantBits|PixelAspectRatio|PixelUnits|PixelsPerUnit[XY])$/
const exifDisplayTags = ['ColorSpace', 'InteropIndex', 'Gamma', 'WhitePoint', 'PrimaryChromaticities', 'YCbCrCoefficients', 'ReferenceBlackWhite', 'TransferFunction', 'YCbCrPositioning']
const displayMetadata = (tags: MediaTags) => Object.fromEntries(Object.entries(tags).filter(([key]) => key.startsWith('ICC') || displayTag.test(key) || exifDisplayTags.includes(key.split(':').pop()!)).sort(([a], [b]) => a.localeCompare(b)))

/** 只启动随应用分发的 ExifTool；关闭用户配置加载，不执行 shell 或插件传来的命令。 */
export function exifToolCommand(platform = process.platform): { file: string; prefix: string[] } {
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('当前系统不支持媒体元数据处理')
  let vendor: unknown
  try { vendor = platform === 'win32' ? require('exiftool-vendored.exe') : require('exiftool-vendored.pl') }
  catch { throw new Error('媒体处理组件缺失，请重新安装客户端') }
  if (typeof vendor !== 'string') throw new Error('媒体处理组件缺失，请重新安装客户端')
  const executable = vendor.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  return platform === 'win32' ? { file: executable, prefix: [] } : { file: '/usr/bin/perl', prefix: [executable] }
}

export async function runExifTool(args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const command = exifToolCommand(), env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(?:PERL|EXIFTOOL)/i.test(key)) delete env[key]
  return new Promise((resolve, reject) => {
    let output = '', failure: unknown
    // 回调可能在 abort 后早于 close；等进程真正退出后才允许调用方清理临时目录。
    const child = execFile(command.file, [...command.prefix, '-config', '', ...args], {
      shell: false, windowsHide: true, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env, signal
    }, (error, stdout, stderr) => { output = stdout; failure = error || (stderr.trim() ? new Error(stderr.trim()) : undefined) })
    child.once('close', () => {
      if (signal.aborted) reject(signal.reason ?? new Error('媒体处理已取消'))
      else if (failure) reject(failure)
      else resolve(output)
    })
  })
}

export async function readMediaTags(file: string, signal: AbortSignal): Promise<MediaTags> {
  const text = await runExifTool(['-j', '-G1:4', '-s', '-n', '-a', '-struct', '-all', '-ImageDataHash', '-api', 'ImageHashType=SHA256', file], signal)
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== 'object') throw new Error('无法解析媒体元数据')
  const tags = parsed[0] as MediaTags
  const errors = Object.entries(tags).filter(([key]) => /:(?:Warning|Error)$/.test(key))
  if (errors.length) throw new Error('媒体解析未通过：' + errors.map(([, value]) => String(value)).join('；'))
  if (typeof tagValue(tags, 'FileType') !== 'string') throw new Error('无法识别文件格式')
  return tags
}

export function summarizeMedia(tags: MediaTags) {
  const type = String(tagValue(tags, 'FileType'))
  const entries = Object.entries(tags).filter(([key]) => !/^(?:SourceFile$|System:|ExifTool:)/.test(key) && !key.endsWith(':ImageDataHash'))
  return {
    type, canClean: cleanableTypes.has(type), hasLocation: entries.some(([key]) => isLocationTag(key)),
    fields: entries.slice(0, 400).map(([key, value]) => ({ key, value: (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 2000) }))
  }
}

/** 定位模式同时丢弃可包含位置副本的 XMP/IPTC/厂商注记，保留标准 EXIF 拍摄参数。 */
export async function cleanMediaCopy(file: string, mode: 'location' | 'metadata', before: MediaTags, signal: AbortSignal): Promise<Buffer> {
  const type = String(tagValue(before, 'FileType'))
  if (!cleanableTypes.has(type)) throw new Error('目前只支持 JPEG、PNG、HEIC 照片的清理；音视频仅查看参数')
  const hash = tagValue(before, 'ImageDataHash')
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('无法验证图像数据，已停止处理')
  const copyDisplay = exifDisplayTags.map(tag => {
    const present = Object.keys(before).some(key => /^(?:IFD\d|ExifIFD|InteropIFD):/.test(key) && key.endsWith(':' + tag))
    // 新建 EXIF 目录会自动补 YCbCrPositioning 等默认值；原图没有的声明也不新增。
    return '-EXIF:' + tag + (present ? '' : '=')
  })
  const remove = mode === 'location'
    ? ['-GPS:all=', '-GPS*=', '-XMP:all=', '-IPTC:all=', '-MakerNotes:all=', '-Photoshop:all=', '-Location*=', '-Trailer:all=']
    // 按组移除拍摄信息，不能用 -all=：PNG 的 gAMA/sRGB 等也会被它删除。
    : ['-EXIF:all=', '-XMP:all=', '-IPTC:all=', '-MakerNotes:all=', '-Photoshop:all=', '-Comment=', '-Trailer:all=', '-tagsFromFile', '@', '-Orientation', ...copyDisplay]
  await runExifTool(['-overwrite_original', ...remove, file], signal)
  const after = await readMediaTags(file, signal)
  for (const key of ['FileType', 'ImageDataHash', 'ImageWidth', 'ImageHeight', 'Orientation', 'ProfileID']) {
    if (JSON.stringify(tagValue(before, key)) !== JSON.stringify(tagValue(after, key))) throw new Error('图像内容或显示参数发生变化，已停止保存')
  }
  if (JSON.stringify(displayMetadata(before)) !== JSON.stringify(displayMetadata(after))) throw new Error('色彩解释参数发生变化，已停止保存')
  if (Object.keys(after).some(isLocationTag)) throw new Error('仍检测到定位标签，已停止保存')
  if (mode === 'metadata' && Object.keys(after).some(key => /^(?:XMP|IPTC|GPS|MakerNotes|Photoshop)(?:[-:]|$)/i.test(key))) throw new Error('仍检测到待清理元数据，已停止保存')
  if (mode === 'metadata' && Object.keys(after).some(key => !key.startsWith('System:') && /:(?:Make|Model|.*SerialNumber|OwnerName|Artist|Creator|Author|Copyright|DateTimeOriginal|CreateDate|ModifyDate|LensMake|LensModel|UserComment|Comment|Description)$/.test(key))) throw new Error('仍检测到拍摄或作者信息，已停止保存')
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size < 1 || stat.size > 16 * 1024 * 1024) throw new Error('处理结果大小无效')
  return fs.readFile(file)
}

export function outputMatchesType(output: string, type: string) {
  const ext = path.extname(output).toLowerCase()
  return type === 'JPEG' ? ['.jpg', '.jpeg'].includes(ext) : type === 'PNG' ? ext === '.png' : ['.heic', '.heif'].includes(ext)
}
