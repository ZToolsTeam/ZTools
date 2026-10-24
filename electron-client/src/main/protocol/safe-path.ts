import fs from 'node:fs/promises'
import path from 'node:path'

function isContained(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
  )
}

export async function resolveSafeFile(root: string, encodedPath: string): Promise<string> {
  let decoded: string
  try {
    decoded = decodeURIComponent(encodedPath)
  } catch {
    throw new Error('路径编码无效')
  }
  if (/\0|%[0-9a-f]{2}/i.test(decoded)) throw new Error('拒绝二次编码或空字符')
  decoded = decoded.replace(/^\/+/, '')
  if (/^(?:[a-z]:|[/\\]{2}|\\\?\\|\\\.\\)/i.test(decoded)) throw new Error('拒绝绝对或设备路径')
  const rootRealPath = await fs.realpath(root)
  const candidate = path.resolve(rootRealPath, decoded.replaceAll('/', path.sep))
  if (!isContained(rootRealPath, candidate)) throw new Error('路径越界')
  const candidateRealPath = await fs.realpath(candidate)
  if (!isContained(rootRealPath, candidateRealPath)) throw new Error('真实路径越界')
  const stat = await fs.stat(candidateRealPath)
  if (!stat.isFile()) throw new Error('目标不是文件')
  return candidateRealPath
}
