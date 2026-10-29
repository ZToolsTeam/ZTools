import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

export interface SshDirective { key: string; args: string[]; source: string; line: number; includes?: SshDocument[]; unresolved?: boolean }
export interface SshDocument { path: string; directives: SshDirective[] }
export interface SshDocuments { documents: SshDocument[]; revision: string; userConfigExists: boolean; warnings: string[] }
export interface SshReadOptions { home: string; systemDirectory?: string; environment?: NodeJS.ProcessEnv; username?: string }

/** 只拆词，不展开 shell、执行 Match 或读取密钥内容。 */
export function sshConfigTokens(line: string): string[] {
  if (line.length > 32768 || line.includes('\0')) throw new Error('SSH 配置行过长或含空字符')
  const directive = /^\s*([^\s=#]+)(?:\s*=\s*|\s+|$)/.exec(line)
  if (!directive) { if (!line.trim() || line.trimStart().startsWith('#')) return []; throw new Error('SSH 配置指令无效') }
  const words: string[] = [directive[1]!], args = line.slice(directive[0].length)
  let value = '', quote = '', present = false
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!, next = args[i + 1]
    if (c === '\\' && next && (next === '\\' || next === '"' || next === "'" || (!quote && /\s/.test(next)))) {
      value += next; present = true; i++; continue
    }
    if (quote) { if (c === quote) quote = ''; else value += c; present = true; continue }
    if (c === '"' || c === "'") { quote = c; present = true; continue }
    if (c === '#' && !present) break
    if (/\s/.test(c)) {
      if (present) { words.push(value); value = ''; present = false }
      continue
    }
    value += c; present = true
  }
  if (quote) throw new Error('SSH 配置引号未闭合')
  if (present) words.push(value)
  return words
}

/** 有界普通文件读取；缺失与读取失败分开。符号链接解析后仍按打开的实际对象验证。 */
export async function readSshConfigurationFile(file: string, signal: AbortSignal): Promise<Buffer | undefined> {
  signal.throwIfAborted()
  let target: string
  try { await fs.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('SSH 配置路径无法读取') }
  try { target = await fs.realpath(file) } catch { throw new Error('SSH 配置链接或路径无法读取') }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EISDIR') throw new Error('SSH 配置必须是可读取的普通文件且不超过 256 KiB')
    throw error
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 256 * 1024 || (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)) throw new Error('SSH 配置必须是可读取的普通文件且不超过 256 KiB')
    const bytes = Buffer.alloc(256 * 1024 + 1); let size = 0
    while (size < bytes.length) { signal.throwIfAborted(); const next = await handle.read(bytes, size, Math.min(16384, bytes.length - size), size); if (!next.bytesRead) break; size += next.bytesRead }
    if (size > 256 * 1024) throw new Error('SSH 配置读取超过 256 KiB')
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}

export async function readSshDocuments(options: SshReadOptions, signal: AbortSignal): Promise<SshDocuments> {
  const systemDirectory = options.systemDirectory ?? '/etc/ssh', environment = options.environment ?? process.env
  if (!path.isAbsolute(options.home) || !path.isAbsolute(systemDirectory)) throw new Error('SSH 配置目录必须为绝对路径')
  const warnings = new Set<string>(), fingerprint = createHash('sha256'), visiting = new Set<string>()
  let files = 0, totalBytes = 0, directoryEntries = 0
  const userDirectory = path.join(options.home, '.ssh')
  async function expand(pattern: string, base: string): Promise<{ paths: string[]; unresolved: boolean }> {
    let unresolved = false
    const expanded = pattern.replace(/%(.)/g, (_all, token: string) => {
      if (token === '%') return '%'
      if (token === 'd') return options.home
      if (token === 'u') return options.username ?? os.userInfo().username
      unresolved = true; return ''
    }).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, key: string) => {
      if (environment[key] === undefined || environment[key] === '') unresolved = true
      return environment[key] ?? ''
    })
    // 与具体目标有关的路径须由实际 ssh 解释，扫描不能猜测或执行表达式。
    if (unresolved || /\$\{|^~[^/]|\*\*|[{}()]/.test(expanded) || (base === systemDirectory && expanded.startsWith('~'))) {
      warnings.add('部分 Include 使用动态或未设置的路径，主机预览可能不完整；连接时由系统 SSH 解释原配置'); return { paths: [], unresolved: true }
    }
    const absolute = expanded.startsWith('~/') ? path.join(options.home, expanded.slice(2)) : path.resolve(base, expanded)
    const root = path.parse(absolute).root
    const pieces = absolute.slice(root.length).split(path.sep).filter(Boolean)
    if (pieces.length > 32) throw new Error('SSH Include 路径层级超过限制')
    let parents = [root]
    for (const piece of pieces) {
      signal.throwIfAborted(); const next: string[] = []
      if (!/[*?[]/.test(piece)) { parents = parents.map(parent => path.join(parent, piece)); continue }
      for (const parent of parents) {
        let directory
        try { directory = await fs.opendir(parent) }
        catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) continue; throw new Error('SSH Include 目录无法扫描') }
        for await (const entry of directory) {
          signal.throwIfAborted()
          if (++directoryEntries > 8192) throw new Error('SSH Include 扫描条目超过限制，停止读取')
          if ((!entry.name.startsWith('.') || piece.startsWith('.')) && path.matchesGlob(entry.name, piece)) next.push(path.join(parent, entry.name))
          if (next.length > 128) throw new Error('SSH Include 匹配文件过多')
        }
      }
      parents = next.sort()
    }
    return { paths: parents, unresolved: false }
  }
  async function load(file: string, base: string, depth: number): Promise<SshDocument | undefined> {
    signal.throwIfAborted()
    if (depth > 16 || ++files > 128) throw new Error('SSH Include 递归或文件数量超过限制')
    const bytes = await readSshConfigurationFile(file, signal)
    fingerprint.update(JSON.stringify([file, bytes?.length ?? null])); fingerprint.update(bytes ?? '')
    if (!bytes) return undefined
    const real = await fs.realpath(file)
    if (visiting.has(real)) throw new Error('SSH Include 出现循环引用')
    if ((totalBytes += bytes.length) > 2 * 1024 * 1024) throw new Error('SSH 配置总大小超过 2 MiB')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('SSH 配置不是有效 UTF-8 文本') }
    const directives: SshDirective[] = []; visiting.add(real)
    try {
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        signal.throwIfAborted(); const words = sshConfigTokens(line); if (!words.length) continue
        const key = words.shift()!.toLowerCase(); if (!words.length) throw new Error(`SSH 配置第 ${index + 1} 行缺少参数`)
        const item: SshDirective = { key, args: words, source: file, line: index + 1 }
        if (key === 'include') {
          item.includes = []
          for (const pattern of words) {
            const expanded = await expand(pattern, base)
            if (expanded.unresolved) item.unresolved = true
            for (const included of expanded.paths) { const document = await load(included, base, depth + 1); if (document) item.includes.push(document) }
          }
        }
        directives.push(item)
      }
    } finally { visiting.delete(real) }
    return { path: file, directives }
  }
  const user = await load(path.join(userDirectory, 'config'), userDirectory, 0), system = await load(path.join(systemDirectory, 'ssh_config'), systemDirectory, 0)
  return { documents: [user, system].filter((d): d is SshDocument => !!d), revision: fingerprint.digest('hex'), userConfigExists: !!user, warnings: [...warnings] }
}
