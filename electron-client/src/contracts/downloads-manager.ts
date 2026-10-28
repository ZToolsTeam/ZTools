import { errorCodes, ZToolsError } from './errors.js'

export type DownloadsManagerRequest =
  | { action: 'discover'; customDirs: string[] }
  | { action: 'validate'; dirPath: string }

function validDirectory(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
    !value.includes('\0') && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) &&
    (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value))
}

/** 目录发现与校验只读；不接收任意原生函数名或文件清理动作。 */
export function validateDownloadsManagerRequest(value: unknown): asserts value is DownloadsManagerRequest {
  const input = value as Record<string, unknown> | null
  const discover = input?.action === 'discover'
  const keys = discover ? ['action', 'customDirs'] : ['action', 'dirPath']
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !keys.includes(key)) ||
      (discover
        ? !Array.isArray(input.customDirs) || input.customDirs.length > 256 || !input.customDirs.every(validDirectory)
        : input.action !== 'validate' || !validDirectory(input.dirPath))) {
    throw new ZToolsError(errorCodes.invalidRequest, '下载目录请求无效：请选择有效的绝对目录路径')
  }
}
