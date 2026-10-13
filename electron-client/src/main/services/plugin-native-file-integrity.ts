import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export interface PluginNativeIntegrityFile {
  readonly entry: string
  readonly format?: 'pe' | 'data'
  readonly arch?: string
  readonly sha256?: string
}

function invalid(message: string): never {
  throw new ZToolsError(errorCodes.pluginPackageInvalid, message)
}

function unchanged(left: Stats, right: Stats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function samePath(left: string, right: string): boolean {
  // This checker is exclusively for Windows declarations, including Windows test fixtures.
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function inspectPath(root: string, segments: string[]): Promise<{ target: string; stat: Stats }> {
  let current = path.resolve(root)
  for (const segment of ['', ...segments.slice(0, -1)]) {
    if (segment) current = path.join(current, segment)
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(current, await fs.realpath(current))) {
      invalid('Windows 原生文件目录必须是无链接普通目录')
    }
  }
  const target = path.join(current, segments.at(-1)!)
  const stat = await fs.lstat(target)
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(target, await fs.realpath(target))) {
    invalid('Windows 原生文件必须是无链接普通文件')
  }
  return { target, stat }
}

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, offset + total)
    if (bytesRead === 0) invalid('PE 文件头被截断')
    total += bytesRead
  }
  return buffer
}

async function verifyFormat(handle: FileHandle, file: PluginNativeIntegrityFile, size: number): Promise<void> {
  if (!file.format) return
  const magic = await readAt(handle, 0, Math.min(size, 2))
  if (file.format === 'data') {
    if (magic.toString('ascii') === 'MZ') invalid(`data 文件不能包含 PE magic：${file.entry}`)
    return
  }
  if (size < 64 || magic.toString('ascii') !== 'MZ') invalid(`PE DOS 文件头无效：${file.entry}`)
  const dos = await readAt(handle, 0, 64)
  const peOffset = dos.readUInt32LE(0x3c)
  if (peOffset < 64 || peOffset > 16 * 1024 * 1024 || peOffset > size - 24) invalid(`PE 文件头偏移越界：${file.entry}`)
  const coff = await readAt(handle, peOffset, 24)
  const machine = coff.readUInt16LE(4)
  const expectedMachine = file.arch === 'ia32' ? 0x14c : file.arch === 'x64' ? 0x8664 : undefined
  if (coff.readUInt32LE(0) !== 0x4550 || expectedMachine === undefined || machine !== expectedMachine) {
    invalid(`PE machine 与声明架构不一致：${file.entry}`)
  }
  const flags = coff.readUInt16LE(22)
  const isDll = (flags & 0x2000) !== 0
  if (!(flags & 2) || isDll !== file.entry.toLowerCase().endsWith('.dll')) invalid(`PE DLL/EXE 分类无效：${file.entry}`)
  const sections = coff.readUInt16LE(6), optionalBytes = coff.readUInt16LE(20)
  const minimumOptionalBytes = machine === 0x14c ? 96 : 112
  if (sections < 1 || sections > 96 || optionalBytes < minimumOptionalBytes ||
      peOffset + 24 + optionalBytes + sections * 40 > size) invalid(`PE 可选头或节表越界：${file.entry}`)
  const optional = await readAt(handle, peOffset + 24, 2)
  if (optional.readUInt16LE(0) !== (machine === 0x14c ? 0x10b : 0x20b)) invalid(`PE 可选头架构无效：${file.entry}`)
  const sectionTable = await readAt(handle, peOffset + 24 + optionalBytes, sections * 40)
  for (let index = 0; index < sections; index++) {
    const bytes = sectionTable.readUInt32LE(index * 40 + 16), offset = sectionTable.readUInt32LE(index * 40 + 20)
    if (bytes > 0 && (offset < peOffset + 24 + optionalBytes + sections * 40 || offset + bytes > size)) {
      invalid(`PE 节数据越界：${file.entry}`)
    }
  }
}

async function verifyExactLibrary(root: string, files: readonly PluginNativeIntegrityFile[], checkActive: () => void): Promise<void> {
  const expected = new Set(files.map(file => file.entry.replaceAll('\\', '/').toLowerCase()).filter(entry => entry.startsWith('lib/')))
  const found = new Set<string>()
  let entries = 0
  const visit = async (relative: string): Promise<void> => {
    checkActive()
    const directory = path.join(root, relative), stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(directory, await fs.realpath(directory))) invalid('原生 lib 目录包含链接')
    const children = await fs.opendir(directory)
    for await (const child of children) {
      checkActive()
      if (++entries > 20_000) invalid('原生 lib 文件集合超过安装条目上限')
      const childRelative = `${relative}/${child.name}`, target = path.join(root, childRelative)
      const childStat = await fs.lstat(target)
      if (childStat.isSymbolicLink()) invalid('原生 lib 文件集合包含链接')
      if (childStat.isDirectory()) await visit(childRelative)
      else if (childStat.isFile()) {
        const key = childRelative.toLowerCase()
        if (!expected.has(key) || found.has(key)) invalid(`原生 lib 文件未声明或大小写重复：${childRelative}`)
        found.add(key)
      } else invalid('原生 lib 文件集合包含非普通文件')
    }
  }
  try {
    await visit('lib')
    if (found.size !== expected.size) invalid('原生 lib 文件集合与所选 target 声明不一致')
  } catch (error) {
    checkActive()
    if (error instanceof ZToolsError) throw error
    invalid('原生 lib 文件集合无法安全读取')
  }
}

/** Verify an explicit manifest file table; does not execute files or grant native trust. */
export async function verifyWindowsPluginNativeFiles(
  root: string,
  files: readonly PluginNativeIntegrityFile[],
  options: { readonly maxBytes: number; readonly checkActive: () => void; readonly verifyContents?: boolean; readonly exactLibrary?: boolean }
): Promise<void> {
  let aggregateBytes = 0
  for (const file of files) {
    options.checkActive()
    const normalized = file.entry.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (path.isAbsolute(normalized) || segments.some(segment => !segment || segment === '.' || segment === '..' || /[:\u0000-\u001f\u007f]/.test(segment))) {
      invalid('Windows 原生文件路径无效')
    }
    try {
      const before = await inspectPath(root, segments)
      if (options.verifyContents === false) {
        aggregateBytes += before.stat.size
        if (before.stat.size < 1 || aggregateBytes > options.maxBytes) invalid('Windows 原生文件为空或超过安装上限')
        continue
      }
      const handle = await fs.open(before.target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        aggregateBytes += opened.size
        if (!unchanged(before.stat, opened) || !Number.isSafeInteger(opened.size) || opened.size < 1 ||
            aggregateBytes > options.maxBytes) invalid('Windows 原生文件对象变化、为空或超过安装上限')
        options.checkActive()
        await verifyFormat(handle, file, opened.size)
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
        let total = 0
        while (true) {
          options.checkActive()
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
          if (bytesRead === 0) break
          total += bytesRead
          if (total > opened.size) throw new ZToolsError(errorCodes.pluginIntegrity, '原生文件读取期间大小发生变化')
          hash.update(buffer.subarray(0, bytesRead))
        }
        options.checkActive()
        const after = await handle.stat(), namedAfter = await inspectPath(root, segments)
        if (total !== opened.size || !unchanged(opened, after) || !unchanged(opened, namedAfter.stat) ||
            (file.sha256 !== undefined && hash.digest('hex') !== file.sha256)) {
          throw new ZToolsError(errorCodes.pluginIntegrity, `原生文件对象或 SHA-256 与声明不一致：${file.entry}`)
        }
      } finally { await handle.close() }
    } catch (error) {
      options.checkActive()
      if (error instanceof ZToolsError) throw error
      invalid(`native component 文件不存在或无法安全读取：${file.entry}`)
    }
  }
  if (options.verifyContents !== false && options.exactLibrary === true) await verifyExactLibrary(root, files, options.checkActive)
}
