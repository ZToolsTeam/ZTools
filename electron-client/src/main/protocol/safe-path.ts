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
    throw new Error('Invalid path encoding')
  }
  if (/\0|%[0-9a-f]{2}/i.test(decoded)) throw new Error('Rejected double-encoded path or null byte')
  decoded = decoded.replace(/^\/+/, '')
  if (/^(?:[a-z]:|[/\\]{2}|\\\?\\|\\\.\\)/i.test(decoded)) throw new Error('Rejected absolute or device path')
  const rootRealPath = await fs.realpath(root)
  const candidate = path.resolve(rootRealPath, decoded.replaceAll('/', path.sep))
  if (!isContained(rootRealPath, candidate)) throw new Error('Path escapes root directory')
  const candidateRealPath = await fs.realpath(candidate)
  if (!isContained(rootRealPath, candidateRealPath)) throw new Error('Resolved real path escapes root directory')
  const stat = await fs.stat(candidateRealPath)
  if (!stat.isFile()) throw new Error('Target is not a regular file')
  return candidateRealPath
}
