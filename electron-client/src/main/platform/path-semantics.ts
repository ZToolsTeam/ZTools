import { errorCodes, ZToolsError } from '../../contracts/errors.js'

const MAX_PATH_INPUT_LENGTH = 32 * 1024
const WINDOWS_DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i

export interface PathSemanticsAdapter {
  validatePathInput(value: string): void
}

function invalidPath(): never {
  throw new ZToolsError(errorCodes.invalidRequest, 'path 包含不允许的路径形式')
}

function validateCommonInput(value: string): void {
  if (value.length > MAX_PATH_INPUT_LENGTH || value.includes('\0')) invalidPath()
}

export class PosixPathSemanticsAdapter implements PathSemanticsAdapter {
  validatePathInput(value: string): void {
    validateCommonInput(value)
  }
}

export class WindowsPathSemanticsAdapter implements PathSemanticsAdapter {
  validatePathInput(value: string): void {
    validateCommonInput(value)

    const normalized = value.replaceAll('/', '\\')
    const lower = normalized.toLowerCase()
    if (
      lower.startsWith('\\\\?\\') ||
      lower.startsWith('\\\\.\\') ||
      lower.startsWith('\\??\\') ||
      lower.startsWith('\\\\??\\')
    ) invalidPath()

    if (/^[a-z]:(?![\\/])/i.test(value)) invalidPath()

    const segments = normalized.split('\\')
    for (const [index, segment] of segments.entries()) {
      if (segment === '' || segment === '.' || segment === '..') continue
      const isAbsoluteDrive = index === 0 && /^[a-z]:$/i.test(segment) && /^[a-z]:[\\/]/i.test(value)
      if (isAbsoluteDrive) continue
      if (segment.includes(':') || /[ .]$/.test(segment)) invalidPath()

      const deviceBaseName = segment.split('.')[0]?.replace(/[ .]+$/g, '') ?? ''
      if (WINDOWS_DEVICE_NAMES.test(deviceBaseName)) invalidPath()
    }
  }
}

export function createPathSemanticsAdapter(platform: NodeJS.Platform): PathSemanticsAdapter {
  switch (platform) {
    case 'win32':
      return new WindowsPathSemanticsAdapter()
    case 'darwin':
    case 'linux':
      return new PosixPathSemanticsAdapter()
    default:
      throw new ZToolsError(errorCodes.notSupported, `当前平台未配置路径语义适配器: ${platform}`)
  }
}
