import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { MacPasteSession } from '../../src/main/platform/macos/paste-session.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  ClipboardService,
  decodeBmp,
  type ClipboardAdapter,
  type ClipboardImage,
  type ClipboardImageFactory,
  type ClipboardMacPasteAdapter,
  type FileClipboardAdapter
} from '../../src/main/services/clipboard-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import { EventService } from '../../src/main/services/event-service.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { ReferenceClipboardFilesService } from '../../src/main/services/reference-clipboard-files-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { DatabaseService } from '../../src/main/services/database-service.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 1 }

class FakeImage implements ClipboardImage {
  constructor(
    private readonly png: Buffer,
    private readonly width = 1,
    private readonly height = 1
  ) {}

  isEmpty(): boolean { return this.png.byteLength === 0 }
  getSize(): { width: number; height: number } { return { width: this.width, height: this.height } }
  toPNG(): Buffer { return this.png }
  toBitmap(): Buffer { return Buffer.alloc(this.width * this.height * 4, createHash('sha256').update(this.png).digest()) }
}

class FakeClipboard implements ClipboardAdapter {
  text = ''
  image: ClipboardImage = new FakeImage(Buffer.alloc(0))
  formats: string[] = []
  fileDrop = false
  fileUrlData = Buffer.alloc(0)

  availableFormats(): string[] { return this.formats }
  clear(): void { this.text = ''; this.image = new FakeImage(Buffer.alloc(0)); this.formats = []; this.fileDrop = false }
  has(format: string): boolean { return this.fileDrop && (format === 'FileNameW' || format === 'FileDrop') }
  readBuffer(): Buffer { return this.fileUrlData }
  readImage(): ClipboardImage { return this.image }
  readText(): string { return this.text }
  writeImage(image: ClipboardImage): void { this.image = image; this.text = ''; this.formats = ['image/png']; this.fileDrop = false }
  writeText(text: string): void { this.text = text; this.image = new FakeImage(Buffer.alloc(0)); this.formats = ['text/plain']; this.fileDrop = false }
}

class FakeFileClipboard implements FileClipboardAdapter {
  paths: string[] = []
  async readFiles(): Promise<string[]> { return this.paths }
  async writeFiles(paths: string[]): Promise<void> { this.paths = paths }
}

class FakeRegistry {
  readonly sent: Array<{ webContentsId: number; value: unknown }> = []
  readonly listeners = new Set<(webContentsId: number) => void>()

  send(webContentsId: number, _channel: string, value: unknown): boolean {
    this.sent.push({ webContentsId, value })
    return true
  }

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function createFiles(authorized = new Set<string>()): { files: FileSystemService; generated: Buffer[]; grants: string[] } {
  const generated: Buffer[] = []
  const grants: string[] = []
  const files = {
    async readFile(params: { path: string }) {
      if (!authorized.has(params.path)) throw new ZToolsError(errorCodes.permissionDenied, 'denied')
      return { success: true, content: await fs.readFile(params.path, 'utf8'), size: 0 }
    },
    async resolveAuthorizedPath(value: string) {
      if (!authorized.has(value)) throw new ZToolsError(errorCodes.permissionDenied, 'denied')
      return fs.realpath(value)
    },
    async grantOpenPath(value: string) {
      await fs.stat(value)
      grants.push(value)
      authorized.add(value)
      return undefined
    },
    async writeGeneratedCacheFile(_relativePath: string, data: Buffer) {
      generated.push(Buffer.from(data))
      return { path: 'C:\\cache\\clipboard.png', size: data.byteLength }
    }
  } as unknown as FileSystemService
  return { files, generated, grants }
}

function createImages(): ClipboardImageFactory {
  return {
    createFromBuffer: (buffer) => new FakeImage(buffer),
    createFromDataURL: (value) => new FakeImage(Buffer.from(value.slice(value.indexOf(',') + 1), 'base64')),
    createFromBitmap: (buffer, options) => new FakeImage(buffer, options.width, options.height)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('历史恢复写入图片原始字节和完整文件列表，缺失文件不执行粘贴，且不会向调用方授予文件读权限', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-restore-'))
  const first = path.join(directory, 'first.txt'), second = path.join(directory, '第二 份.txt')
  await fs.writeFile(first, 'one'); await fs.writeFile(second, 'two')
  const registry = new FakeRegistry(), events = new EventService(registry)
  const clipboard = new FakeClipboard(), fileClipboard = new FakeFileClipboard()
  const { files, grants } = createFiles()
  const service = new ClipboardService(files, events, clipboard, createImages(), fileClipboard)
  const signal = new AbortController().signal
  try {
    const image = 'data:image/png;base64,aGVsbG8='
    await service.restoreHistoryEntry({ type: 'image', image }, caller, signal)
    assert.equal(clipboard.readImage().toPNG().toString(), 'hello')
    assert.equal(clipboard.text, '')
    await service.restoreHistoryEntry({ type: 'files', files: [first, second] }, caller, signal)
    assert.deepEqual(fileClipboard.paths, await Promise.all([fs.realpath(first), fs.realpath(second)]))
    assert.deepEqual(grants, [])
    assert.deepEqual((await service.readFiles(caller, signal)).files, [])
    assert.deepEqual(grants, [])
    await assert.rejects(service.restoreHistoryEntry({ type: 'files', files: [path.join(directory, 'missing')] }, caller, signal, true), /不存在或无法访问/)
    assert.deepEqual(fileClipboard.paths, await Promise.all([fs.realpath(first), fs.realpath(second)]))
  } finally { await service.stop(); events.stop(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('filtered legacy clipboard events neither grant nor deliver raw paths to reference-lane subscribers', async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
  const { files } = createFiles(), fileClipboard = new FakeFileClipboard(), owners: number[] = []
  files.grantOpenPath = async (_selected, owner) => { owners.push(owner.webContentsId); return undefined }
  const service = Reflect.construct(ClipboardService, [files, events, clipboard, createImages(), fileClipboard,
    10, undefined, undefined, (owner: CallerIdentity) => owner.webContentsId === 1]) as ClipboardService
  const referenceCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'example', pluginInstanceId: 'two' }
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    events.subscribe({ key: 'clipboard_change' }, referenceCaller)
    fileClipboard.paths = [path.resolve('out-test/private-selection.txt')]
    clipboard.fileDrop = true; clipboard.formats = ['text/uri-list']; clipboard.fileUrlData = Buffer.from('changed')
    await wait(60)
    assert.deepEqual(registry.sent.map(item => item.webContentsId), [1])
    assert.deepEqual(owners, [1])
  } finally { service.stop(); events.stop() }
})

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'clipboard condition timed out')
    await wait(10)
  }
}

test('图片轮询只为新内容编码一次，完整像素、尺寸及格式变化均触发采集', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const events = new EventService(new FakeRegistry()), clipboard = new FakeClipboard()
  let encoded = 0, inspected = 0, recorded = 0
  const bitmap = Buffer.alloc(128 * 128 * 4, 127)
  let width = 128, height = 128
  clipboard.writeImage({
    isEmpty: () => false,
    getSize: scale => { assert.equal(scale, 1); return { width, height } },
    toBitmap: options => { assert.equal(options?.scaleFactor, 1); inspected++; return Buffer.from(bitmap) },
    toPNG: () => { encoded++; return Buffer.from('encoded image') }
  })
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    10, undefined, undefined, undefined, async () => { recorded++ })
  try {
    await until(() => recorded === 1)
    const firstInspections = inspected
    await until(() => inspected >= firstInspections + 5)
    assert.equal(encoded, 1)
    assert.equal(recorded, 1)
    // 改最后一个像素，防止以后改成只哈希前缀或采样。
    bitmap[bitmap.length - 1] = bitmap[bitmap.length - 1]! ^ 1
    await until(() => recorded === 2)
    width = 256; height = 64
    await until(() => recorded === 3)
    clipboard.formats.push('image/tiff')
    await until(() => recorded === 4)
    assert.equal(encoded, 4)
    await service.stop()
    const stoppedInspections = inspected
    await wait(30)
    assert.equal(inspected, stoppedInspections)
  } finally { await service.stop(); events.stop() }
})

test('图片非法尺寸在转换前拒绝，像素读取失败不录历史，恢复可读后重试', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const events = new EventService(new FakeRegistry()), clipboard = new FakeClipboard()
  let reads = 0, converted = 0, encoded = 0, recorded = 0
  let width = NaN, height = 1, failRead = false, emptyBitmap = false
  clipboard.writeImage({
    isEmpty: () => false,
    getSize: () => { reads++; return { width, height } },
    toBitmap: () => {
      converted++
      if (failRead) throw new Error('像素暂不可读')
      return emptyBitmap ? Buffer.alloc(0) : Buffer.alloc(width * height * 4)
    },
    toPNG: () => { encoded++; return Buffer.from('encoded image') }
  })
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    10, undefined, undefined, undefined, async () => { recorded++ })
  try {
    for (const [nextWidth, nextHeight] of [[NaN, 1], [0, 1], [-1, 1], [1.5, 1], [8192, 4097]] as const) {
      width = nextWidth; height = nextHeight
      const before = reads
      await until(() => reads >= before + 2)
      assert.equal(converted, 0)
    }
    width = 2; height = 2; failRead = true
    await until(() => converted >= 2)
    failRead = false; emptyBitmap = true
    const before = converted
    await until(() => converted >= before + 2)
    assert.equal(encoded, 0)
    assert.equal(recorded, 0)
    emptyBitmap = false
    await until(() => recorded === 1)
    assert.equal(encoded, 1)
  } finally { await service.stop(); events.stop() }
})

test('persistent clipboard collects without a plugin, stores attachments and detects successive file lists', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-clipboard-history-'))
  const database = new DatabaseService(root)
  const events = new EventService(new FakeRegistry())
  const clipboard = new FakeClipboard()
  const fileClipboard = new FakeFileClipboard()
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), fileClipboard,
    10, undefined, undefined, undefined, (entry) => database.recordClipboard(entry))
  const query = async () => (await database.query({ plugin_id: 'clipboard-manager', prefix: 'clip:v2:!', limit: 0 }, caller,
    new AbortController().signal)).data.map((row) => JSON.parse(row.value))
  try {
    await service.copyText({ text: 'host copy' }, caller)
    await until(async () => (await query()).length === 1)
    events.subscribe({ key: 'clipboard_change' }, caller)
    events.unsubscribe({ key: 'clipboard_change' }, caller)
    clipboard.writeImage(new FakeImage(Buffer.alloc(600 * 1024, 7)))
    await until(async () => (await query()).length === 2)
    const image = (await query()).find((doc) => doc.type === 'image')
    assert.equal(image.data, `ztools-clip-image:${image.id}`)
    const attachment = await database.get({ plugin_id: 'clipboard-manager', key: `attachment:clip-image:${image.id}` }, caller,
      new AbortController().signal)
    assert.equal(Buffer.from(JSON.parse(attachment.data).data, 'base64').length, 600 * 1024)
    clipboard.clear()
    clipboard.fileDrop = true
    clipboard.formats = ['FileNameW']
    fileClipboard.paths = ['C:\\first.txt']
    clipboard.fileUrlData = Buffer.from('first file list')
    await until(async () => (await query()).length === 3)
    fileClipboard.paths = ['C:\\second.txt']
    clipboard.fileUrlData = Buffer.from('second file list')
    await until(async () => (await query()).length === 4)
    assert.deepEqual(JSON.parse((await query())[0].data), [{ name: 'second.txt', path: 'C:\\second.txt' }])
    await service.stop()
    clipboard.writeText('after stop')
    await wait(30)
    assert.equal((await query()).length, 4)
    await database.stop()
    const reopened = new DatabaseService(root)
    try {
      assert.equal((await reopened.query({ plugin_id: 'clipboard-manager', prefix: 'clip:v2:!', limit: 0 }, caller,
        new AbortController().signal)).data.length, 4)
    } finally { await reopened.stop() }
  } finally {
    await service.stop()
    events.stop()
    await database.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('history retries failed writes and shutdown drains an in-flight save without publishing after stop', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  let attempts = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    10, undefined, undefined, undefined, async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary write failure')
      await blocked
    })
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.writeText('retry me')
    await until(() => attempts === 2)
    assert.equal(registry.sent.length, 0)
    let stopped = false
    const stopping = service.stop().then(() => { stopped = true })
    await wait(20)
    assert.equal(stopped, false)
    release()
    await stopping
    assert.equal(registry.sent.length, 0)
  } finally { release(); await service.stop(); events.stop() }
})

test('clipboard text and image methods enforce direct and generated-file response paths', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  const { files, generated } = createFiles()
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    assert.deepEqual(await service.copyText({ text: 'hello' }, caller), { success: true })
    assert.deepEqual(service.readText(), { success: true, text: 'hello' })
    assert.deepEqual(service.copyImage({ image: Buffer.from('png').toString('base64') }), { success: true })
    assert.match((await service.readImage(caller) as { image: string }).image, /^data:image\/png;base64,/)

    clipboard.image = new FakeImage(Buffer.alloc(600 * 1024, 7), 800, 600)
    clipboard.formats = ['image/png']
    assert.deepEqual(await service.readImage(caller), {
      success: true,
      useTempFile: true,
      tempFile: 'C:\\cache\\clipboard.png',
      size: 600 * 1024,
      width: 800,
      height: 600
    })
    assert.equal(generated[0]?.byteLength, 600 * 1024)
    assert.throws(
      () => service.unsupported('clipboard.hideAndType'),
      (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    )
  } finally {
    service.stop()
    events.stop()
  }
})

test('clipboard failures keep stable codes without exposing native error details', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  clipboard.readText = () => { throw new Error('clipboard backend failed at C:\\Users\\alice\\secret.txt') }
  const { files } = createFiles()
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    assert.throws(
      () => service.readText(),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.clipboardError &&
        error.message === '剪贴板操作失败' &&
        !error.message.includes('secret.txt')
    )
  } finally {
    service.stop()
    events.stop()
  }
})

test('clipboard domain errors from platform adapters cannot leak their message', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const fileClipboard = new FakeFileClipboard()
  fileClipboard.writeFiles = async () => {
    throw new ZToolsError(errorCodes.clipboardError, 'PowerShell failed for C:\\Users\\alice\\private.txt')
  }
  const { files } = createFiles()
  const service = new ClipboardService(files, events, new FakeClipboard(), createImages(), fileClipboard)
  try {
    await assert.rejects(
      service.copyFiles({ filePaths: [] }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.clipboardError &&
        error.message === '剪贴板操作失败' &&
        !error.message.includes('private.txt')
    )
  } finally {
    service.stop()
    events.stop()
  }
})

test('file clipboard copy requires caller authorization and reads grant returned paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-clipboard-'))
  const selected = path.join(root, 'selected.txt')
  const denied = path.join(root, 'denied.txt')
  await fs.writeFile(selected, 'selected')
  await fs.writeFile(denied, 'denied')
  const authorized = new Set([selected])
  const { files, grants } = createFiles(authorized)
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const fileClipboard = new FakeFileClipboard()
  const service = new ClipboardService(files, events, new FakeClipboard(), createImages(), fileClipboard)
  try {
    assert.deepEqual(
      await service.copyFile({ filePath: selected }, caller, new AbortController().signal),
      { success: true, count: 1 }
    )
    await assert.rejects(
      service.copyFile({ filePath: denied }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    fileClipboard.paths = [selected, denied]
    assert.deepEqual(
      await service.readFiles(caller, new AbortController().signal),
      { success: true, files: [selected, denied] }
    )
    assert.deepEqual(grants, [selected, denied])
  } finally {
    service.stop()
    events.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('clipboard monitoring starts on subscription, emits host events and suppresses own writes', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  clipboard.writeText('initial')
  const { files } = createFiles()
  const fileClipboard = new FakeFileClipboard()
  const service = new ClipboardService(files, events, clipboard, createImages(), fileClipboard, 10)
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.writeText('external')
    await wait(40)
    assert.equal(registry.sent.length, 1)
    const envelope = (registry.sent[0]?.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
    assert.deepEqual(envelope.source, { kind: 'host' })
    assert.deepEqual(envelope.payload, {
      type: 'text',
      text: 'external',
      size: 8,
      hasData: true
    })

    await service.copyText({ text: 'self' }, caller)
    await wait(40)
    assert.equal(registry.sent.length, 1)
    clipboard.text = ''
    clipboard.formats = ['custom/files']
    clipboard.fileDrop = true
    await wait(40)
    assert.equal(registry.sent.length, 2)
    const fileEnvelope = (registry.sent[1]?.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
    assert.deepEqual(fileEnvelope.payload, { type: 'files', files: [], hasData: false })
    events.unsubscribe({ key: 'clipboard_change' }, caller)
  } finally {
    service.stop()
    events.stop()
  }
})

test('BMP decoding accepts the plugin 32-bit layout and rejects truncated pixel data', () => {
  const bmp = Buffer.alloc(62)
  bmp.write('BM', 0, 'ascii')
  bmp.writeUInt32LE(62, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(2, 18)
  bmp.writeInt32LE(1, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(32, 28)
  bmp.writeUInt32LE(8, 34)
  bmp.set([1, 2, 3, 0, 4, 5, 6, 0], 54)
  assert.deepEqual(decodeBmp(bmp), {
    bitmap: Buffer.from([1, 2, 3, 255, 4, 5, 6, 255]),
    width: 2,
    height: 1
  })
  assert.throws(
    () => decodeBmp(bmp.subarray(0, 60)),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})


test('Mac file URL monitoring recognizes AppKit formats and detects same-format file changes', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  const { files } = createFiles()
  const native = new FakeFileClipboard()
  let reads = 0
  native.readFiles = async () => { reads++; return [] }
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 10)
  const until = async (count: number): Promise<void> => {
    const deadline = Date.now() + 2000
    while (registry.sent.length < count && Date.now() < deadline) await wait(10)
    assert.equal(registry.sent.length, count)
  }
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.formats = ['public.file-url']
    clipboard.fileUrlData = Buffer.from('file:///tmp/first%20file')
    await until(1)
    clipboard.fileUrlData = Buffer.from('file:///tmp/second%20file')
    await until(2)
    clipboard.formats = ['NSFilenamesPboardType']
    await until(3)
    assert.equal(reads, 3)
    for (const sent of registry.sent) {
      const envelope = (sent.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
      assert.deepEqual(envelope.payload, { type: 'files', files: [], hasData: false })
    }
  } finally { service.stop(); events.stop() }
})


test('monitor stop aborts its pending native read and never publishes a late file event', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  const { files } = createFiles()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let signalSeen: AbortSignal | undefined
  const native: FileClipboardAdapter = {
    readFiles: async signal => new Promise<string[]>((_resolve, reject) => {
      signalSeen = signal
      signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      entered()
    }),
    writeFiles: async () => {}
  }
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 10)
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.formats = ['public.file-url']
    clipboard.fileUrlData = Buffer.from('file:///tmp/pending')
    await Promise.race([started, wait(2000).then(() => { throw new Error('native read did not start') })])
    service.stop()
    assert.equal(signalSeen?.aborted, true)
    await wait(30)
    assert.equal(registry.sent.length, 0)
  } finally { service.stop(); events.stop() }
})

test('failed native file snapshot retries the same clipboard instead of remembering a failed fingerprint', async () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry)
  const clipboard = new FakeClipboard()
  const { files } = createFiles()
  let reads = 0
  const native: FileClipboardAdapter = {
    readFiles: async () => { if (++reads === 1) throw new Error('temporary clipboard contention'); return [] },
    writeFiles: async () => {}
  }
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 10)
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.formats = ['public.file-url']
    clipboard.fileUrlData = Buffer.from('file:///tmp/retry')
    const deadline = Date.now() + 2000
    while (registry.sent.length === 0 && Date.now() < deadline) await wait(10)
    assert.equal(registry.sent.length, 1)
    assert.equal(reads, 2)
  } finally { service.stop(); events.stop() }
})

test('Windows and URI file formats detect data changes even when available format names are unchanged', async () => {
  for (const format of ['FileDrop', 'CF_HDROP', 'FileNameW', 'Shell IDList Array', 'text/uri-list']) {
    const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
    const { files } = createFiles(), native = new FakeFileClipboard()
    native.readFiles = async () => []
    const service = new ClipboardService(files, events, clipboard, createImages(), native, 10)
    const until = async (count: number) => {
      const deadline = Date.now() + 2000
      while (registry.sent.length < count && Date.now() < deadline) await wait(10)
      assert.equal(registry.sent.length, count, format)
    }
    try {
      events.subscribe({ key: 'clipboard_change' }, caller)
      clipboard.formats = [format]; clipboard.fileUrlData = Buffer.from('first')
      await until(1)
      clipboard.fileUrlData = Buffer.from('second')
      await until(2)
      clipboard.fileUrlData = Buffer.alloc(128 * 1024 + 1)
      await wait(35)
      assert.equal(registry.sent.length, 2, 'oversized data must not become a successful fingerprint')
      clipboard.fileUrlData = Buffer.from('third')
      await until(3)
    } finally { service.stop(); events.stop() }
  }
})

test('injected reference monitoring publishes owner-scoped refs and never calls legacy path grants', async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
  const { files, grants: legacyGrants } = createFiles(), native = new FakeFileClipboard()
  native.paths = [path.resolve('out-test/synthetic-monitor-selection')]
  let id = 0
  const refs: Pick<PathGrantService, 'createSelected' | 'revoke' | 'resourceUrl'> = {
    createSelected: async () => ({ grantId: String(++id).padStart(43, 'a'), displayName: 'selection', kind: 'file', operations: ['read'] }),
    revoke: async () => {}, resourceUrl: (_, grantId) => 'ztools://file/' + grantId + '/selection'
  }
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 10,
    new ReferenceClipboardFilesService(native, refs))
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    events.subscribe({ key: 'clipboard_change' }, { type: 'plugin', webContentsId: 2, pluginId: 'test', pluginInstanceId: 'one' })
    clipboard.formats = ['FileDrop']; clipboard.fileUrlData = Buffer.from('first')
    const deadline = Date.now() + 2000
    while (registry.sent.length < 2 && Date.now() < deadline) await wait(10)
    assert.equal(registry.sent.length, 2); assert.equal(legacyGrants.length, 0)
    const payloads = registry.sent.map(item => (item.value as { msgData: { envelope: { payload: { contractVersion: number; files: { grantId: string }[] } } } }).msgData.envelope.payload)
    assert.equal(payloads[0]!.contractVersion, 2)
    assert.notEqual(payloads[0]!.files[0]!.grantId, payloads[1]!.files[0]!.grantId)
    assert.ok(!JSON.stringify(payloads).includes('synthetic-monitor-selection'))
  } finally { service.stop(); events.stop() }
})

test('reference clipboard content uses anchored UTF-8 files and generated image references without legacy paths', async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
  const { files, generated } = createFiles(), native = new FakeFileClipboard(), revoked: string[] = []
  const reference = { grantId: 'a'.repeat(43), displayName: 'image.png', kind: 'file' as const, operations: ['read' as const] }
  const stored: Buffer[] = []
  let bytes = Buffer.from('引用文本')
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 750, undefined, {
    grants: { read: async (owner, id, relative, maxBytes, signal) => {
      assert.equal(owner, 1); assert.equal(id, reference.grantId); assert.equal(relative, '')
      assert.equal(maxBytes, 8 * 1024 * 1024); assert.equal(signal!.aborted, false); return bytes
    } },
    cache: { writeGeneratedCacheFile: async (data, owner, extension) => {
      assert.equal(owner.webContentsId, 1); assert.equal(extension, 'png'); stored.push(data)
      return { success: true, reference, fileUrl: 'ztools://file/reference/image.png', size: data.length }
    }, revokeReference: async ref => { revoked.push(ref.grantId) } }
  })
  try {
    await service.copyTextReference({ fileGrantId: reference.grantId }, caller, new AbortController().signal)
    assert.equal(clipboard.text, '引用文本')
    bytes = Buffer.from([0xff]); await assert.rejects(service.copyTextReference({ fileGrantId: reference.grantId }, caller, new AbortController().signal), { code: 'FILE_ERROR' })
    assert.equal(clipboard.text, '引用文本')
    clipboard.image = new FakeImage(Buffer.alloc(600 * 1024, 7), 800, 600)
    const result = await service.readImageReference(caller, new AbortController().signal)
    assert.equal(result.useReference, true); assert.equal(result.reference!.grantId, reference.grantId)
    assert.ok(!Object.hasOwn(result, 'tempFile')); assert.equal(generated.length, 0); assert.equal(stored.length, 1)
    clipboard.image = new FakeImage(Buffer.from('small'), 1, 1)
    assert.equal((await service.readImageReference(caller, new AbortController().signal)).useReference, false)
    clipboard.image = new FakeImage(Buffer.from('invalid'), NaN, 1)
    await assert.rejects(service.readImageReference(caller, new AbortController().signal), { code: 'FILE_TOO_LARGE' })
    assert.deepEqual(revoked, [])
  } finally { service.stop(); events.stop() }
})

test('reference clipboard large image refuses absent cache and cancels undelivered references after storage', async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
  const { files } = createFiles(), native = new FakeFileClipboard(), controller = new AbortController()
  clipboard.image = new FakeImage(Buffer.alloc(600 * 1024), 800, 600)
  const missing = new ClipboardService(files, events, clipboard, createImages(), native)
  await assert.rejects(missing.readImageReference(caller, new AbortController().signal), { code: 'NATIVE_HOST_UNAVAILABLE' })
  missing.stop()
  const revoked: string[] = [], reference = { grantId: 'a'.repeat(43), displayName: 'image.png', kind: 'file' as const, operations: ['read' as const] }
  const service = new ClipboardService(files, events, clipboard, createImages(), native, 750, undefined, {
    grants: { read: async () => { throw new Error('unexpected') } },
    cache: { writeGeneratedCacheFile: async () => { controller.abort(); return { success: true, reference, fileUrl: '', size: 600 * 1024 } },
      revokeReference: async ref => { revoked.push(ref.grantId) } }
  })
  try {
    await assert.rejects(service.readImageReference(caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    assert.deepEqual(revoked, [reference.grantId])
    const oldText = clipboard.text
    await assert.rejects(service.copyTextReference({ text: 'cancelled' }, caller, controller.signal), { code: 'CALLER_DESTROYED' })
    assert.equal(clipboard.text, oldText)
  } finally { service.stop(); events.stop() }
})

test('reference image copy reads an owned PNG ref, rejects malformed data and never accepts raw paths', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles(), id = 'a'.repeat(43)
  let bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0fkAAAAASUVORK5CYII=', 'base64'), reads = 0
  const cache = { writeGeneratedCacheFile: async () => { throw new Error('unused') }, revokeReference: async () => {} }
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard(), 750, undefined, { cache, grants: { read: async (owner, grant, _relative, maximum) => { assert.equal(owner, 1); assert.equal(grant, id); assert.equal(maximum, 16 * 1024 * 1024); reads++; return bytes } } })
  try {
    assert.deepEqual(await service.copyImageReference({ fileGrantId: id }, caller, new AbortController().signal), { success: true }); assert.equal(clipboard.image.getSize().width, 1)
    await assert.rejects(service.copyImageReference({ path: '/raw' }, caller, new AbortController().signal), { code: 'INVALID_REQUEST' }); assert.equal(reads, 1)
    bytes = Buffer.from('invalid'); await assert.rejects(service.copyImageReference({ fileGrantId: id }, caller, new AbortController().signal), { code: 'FILE_ERROR' }); assert.equal(reads, 2)
  } finally { service.stop() }
})
test('reference image copy canceled during native read or stopped cannot write clipboard', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles(), controller = new AbortController(), id = 'a'.repeat(43)
  const cache = { writeGeneratedCacheFile: async () => { throw new Error('unused') }, revokeReference: async () => {} }
  let reads = 0
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard(), 750, undefined, { cache, grants: { read: async () => { reads++; controller.abort(); return Buffer.from('data') } } })
  await assert.rejects(service.copyImageReference({ fileGrantId: id }, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(clipboard.image.isEmpty(), true)
  service.stop(); await assert.rejects(service.copyImageReference({ fileGrantId: id }, caller, new AbortController().signal), { code: 'CALLER_DESTROYED' }); assert.equal(reads, 1)
})

test('text clipboard silent native write failure is rejected in both lanes without retry or text disclosure', async () => {
  for (const referenceLane of [false, true]) {
    const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
    clipboard.text = 'previous private content'
    let writes = 0
    clipboard.writeText = () => { writes += 1 }
    const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
    try {
      const operation = referenceLane
        ? service.copyTextReference({ text: 'requested private content' }, caller, new AbortController().signal)
        : service.copyText({ text: 'requested private content' }, caller)
      await assert.rejects(operation, error => error instanceof ZToolsError &&
        error.code === errorCodes.clipboardError && !error.message.includes('private'))
      assert.equal(writes, 1)
      assert.equal(clipboard.text, 'previous private content')
    } finally { service.stop(); events.stop() }
  }
})

test('text clipboard verification preserves another application change and never retries', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
  let writes = 0
  clipboard.writeText = () => { writes += 1; clipboard.text = 'external owner content' }
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    await assert.rejects(service.copyText({ text: 'request' }, caller), { code: errorCodes.clipboardError })
    assert.equal(writes, 1)
    assert.equal(clipboard.text, 'external owner content')
  } finally { service.stop(); events.stop() }
})

test('text clipboard verified writes allow empty and Unicode values while read-back failures reject', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    for (const text of ['中文\n🙂', '']) {
      assert.deepEqual(await service.copyText({ text }, caller), { success: true })
      assert.equal(clipboard.text, text)
    }
    clipboard.readText = () => { throw new Error('private OS error') }
    await assert.rejects(service.copyText({ text: 'request' }, caller), error => error instanceof ZToolsError &&
      error.code === errorCodes.clipboardError && !error.message.includes('private'))
  } finally { service.stop(); events.stop() }
})

test('text clipboard accepts exactly 8 MiB and rejects one byte more without touching the clipboard', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    const limit = 8 * 1024 * 1024
    const atLimit = 'a'.repeat(limit)
    assert.deepEqual(await service.copyText({ text: atLimit }, caller), { success: true })
    assert.equal(clipboard.text.length, limit)
    await assert.rejects(service.copyText({ text: 'sentinel-' + 'b'.repeat(limit) }, caller), { code: errorCodes.responseTooLarge })
    // 多字节字符按 UTF-8 字节计：字符数不到上限但字节超限同样拒绝
    await assert.rejects(service.copyText({ text: '汉'.repeat(Math.floor(limit / 3) + 1) }, caller), { code: errorCodes.responseTooLarge })
    assert.equal(clipboard.text, atLimit)
  } finally { service.stop(); events.stop() }
})

test('empty text must not turn an inaccessible empty clipboard into successful copy', async () => {
  for (const referenceLane of [false, true]) {
    const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
    let writes = 0
    clipboard.writeText = () => { writes += 1 }
    const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
    try {
      const operation = referenceLane
        ? service.copyTextReference({ text: '' }, caller, new AbortController().signal)
        : service.copyText({ text: '' }, caller)
      await assert.rejects(operation, { code: errorCodes.clipboardError })
      assert.equal(writes, 1)
      assert.deepEqual(clipboard.formats, [])
    } finally { service.stop(); events.stop() }
  }
})

test('pending legacy text file reads cannot write after caller cancellation or service stop', async () => {
  for (const stopService of [false, true]) {
    const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
    let releaseRead!: (value: { success: true; content: string; size: number }) => void
    files.readFile = () => new Promise(resolve => { releaseRead = resolve })
    let writes = 0
    clipboard.writeText = () => { writes += 1 }
    const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
    const controller = new AbortController()
    try {
      const pending = service.copyText({ tempFile: 'owned-test-file' }, caller, controller.signal)
      if (stopService) service.stop(); else controller.abort()
      releaseRead({ success: true, content: 'late text', size: 9 })
      await assert.rejects(pending, { code: errorCodes.callerDestroyed })
      assert.equal(writes, 0)
      assert.equal(clipboard.text, '')
    } finally { service.stop(); events.stop() }
  }
})

test('both text lanes reject new work after service stop before reading or writing', async () => {
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry()), { files } = createFiles()
  let writes = 0, reads = 0
  clipboard.writeText = () => { writes += 1 }
  files.readFile = async () => { reads += 1; return { success: true, content: 'text', size: 4 } }
  const service = new ClipboardService(files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    service.stop()
    await assert.rejects(service.copyText({ tempFile: 'owned-test-file' }, caller), { code: errorCodes.callerDestroyed })
    await assert.rejects(service.copyTextReference({ text: 'text' }, caller, new AbortController().signal), { code: errorCodes.callerDestroyed })
    assert.equal(reads, 0); assert.equal(writes, 0)
  } finally { service.stop(); events.stop() }
})

// ---------------------------------------------------------------------------
// macOS：常驻剪贴板历史采集与隐私标记过滤
// ---------------------------------------------------------------------------

class MarkedClipboard extends FakeClipboard {
  markers = new Set<string>()
  override has(format: string): boolean { return this.markers.has(format) || super.has(format) }
  override writeText(text: string): void { super.writeText(text); this.markers.clear() }
}

test('macOS persistent history records successive copies without any subscriber and skips concealed pasteboard content', { skip: process.platform !== 'darwin' }, async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new MarkedClipboard()
  const recorded: string[] = []
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    10, undefined, undefined, undefined, async (entry) => { if (entry.type === 'text') recorded.push(entry.text) })
  try {
    clipboard.writeText('ZTCM-alpha 第一条')
    await until(() => recorded.length === 1)
    clipboard.writeText('ZTCM-beta 第二条')
    await until(() => recorded.length === 2)
    // 密码管理器写入：带 ConcealedType 标记，既不录入也不广播
    events.subscribe({ key: 'clipboard_change' }, caller)
    clipboard.writeText('S3cr3t-password!')
    clipboard.markers.add('org.nspasteboard.ConcealedType')
    await wait(80)
    clipboard.text = 'transient value'
    clipboard.markers.add('org.nspasteboard.TransientType')
    await wait(80)
    assert.deepEqual(recorded, ['ZTCM-alpha 第一条', 'ZTCM-beta 第二条'])
    assert.equal(registry.sent.length, 0)
    // 宿主自身写入只被采集一次（同一指纹不重复录入）
    await service.copyText({ text: 'host copy once' }, caller)
    await until(() => recorded.length === 3)
    await wait(60)
    assert.deepEqual(recorded.slice(2), ['host copy once'])
    await service.stop()
    clipboard.writeText('after stop')
    await wait(40)
    assert.equal(recorded.length, 3)
  } finally { await service.stop(); events.stop() }
})

test('macOS history failure from the recorder never stops monitoring and is retried on the next poll', { skip: process.platform !== 'darwin' }, async () => {
  const events = new EventService(new FakeRegistry()), clipboard = new MarkedClipboard()
  let attempts = 0
  const recorded: string[] = []
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    10, undefined, undefined, undefined, async (entry) => {
      attempts += 1
      if (attempts === 1) throw new Error('disk busy')
      if (entry.type === 'text') recorded.push(entry.text)
    })
  try {
    clipboard.writeText('retry me')
    await until(() => recorded.length === 1)
    assert.equal(recorded[0], 'retry me')
  } finally { await service.stop(); events.stop() }
})

// ---------------------------------------------------------------------------
// macOS：粘贴到前台应用（hideAndPaste*）
// ---------------------------------------------------------------------------

class FakeHostWindow {
  readonly log: string[]
  destroyed = false
  constructor(log: string[]) { this.log = log }
  isDestroyed(): boolean { return this.destroyed }
  hide(): void { this.log.push('window.hide') }
  show(): void { this.log.push('window.show') }
  focus(): void { this.log.push('window.focus') }
}

function createMacPasteHarness(options: { trusted?: boolean; sendPaste?: (signal: AbortSignal, token: number) => Promise<void>; delayMs?: number; preparePaste?: (signal: AbortSignal) => Promise<number> } = {}) {
  const log: string[] = []
  const window = new FakeHostWindow(log)
  const mac: ClipboardMacPasteAdapter = {
    isTrusted: () => options.trusted ?? true,
    preparePaste: options.preparePaste ?? (async () => 42),
    stop: async () => {},
    hideApplication: () => { log.push('app.hide') },
    showApplication: () => { log.push('app.show') },
    sendPaste: options.sendPaste ?? (async () => { log.push('paste') }),
    activationDelayMs: options.delayMs ?? 1,
    resolveWindow: () => window
  }
  const registry = { getWebContents: (id: number) => (id === caller.webContentsId ? {} : undefined) } as unknown as WindowRegistry
  const clipboard = new FakeClipboard(), events = new EventService(new FakeRegistry())
  const { files } = createFiles(), fileClipboard = new FakeFileClipboard()
  const service = new ClipboardService(files, events, clipboard, createImages(), fileClipboard,
    750, undefined, undefined, undefined, undefined, registry, undefined, mac)
  return { log, window, clipboard, events, service, files, fileClipboard }
}

test('macOS hideAndPasteText writes the clipboard, hides ZTools, then sends the paste keystroke', async () => {
  const { log, clipboard, events, service } = createMacPasteHarness()
  try {
    assert.deepEqual(await service.hideAndPasteText({ text: '84' }, caller, new AbortController().signal), { success: true })
    assert.equal(clipboard.text, '84')
    assert.deepEqual(log, ['window.hide', 'app.hide', 'paste'])
    clipboard.image = new FakeImage(Buffer.alloc(0))
    assert.deepEqual(await service.hideAndPasteImage({ image: Buffer.from('png').toString('base64') }, caller, new AbortController().signal), { success: true })
    assert.deepEqual(log.slice(3), ['window.hide', 'app.hide', 'paste'])
  } finally { service.stop(); events.stop() }
})

test('等待粘贴时图片像素变化即停止，不复用轮询或上次读取的指纹', async () => {
  const harness = createMacPasteHarness({ preparePaste: async () => {
    const original = harness.clipboard.image.toBitmap()
    original[original.length - 1] = original[original.length - 1]! ^ 1
    harness.clipboard.image.toBitmap = () => original
    return 42
  } })
  try {
    await assert.rejects(harness.service.hideAndPasteImage({ image: Buffer.from('original').toString('base64') }, caller,
      new AbortController().signal), error => error instanceof ZToolsError && error.details?.hostCode === 'CLIPBOARD_CHANGED')
    assert.ok(!harness.log.includes('paste'))
    assert.deepEqual(harness.log, ['window.hide', 'app.hide', 'app.show', 'window.show', 'window.focus'])
  } finally { await harness.service.stop(); harness.events.stop() }
})

test('macOS paste without Accessibility permission fails with PERMISSION_DENIED, keeps the copy and never hides the window', async () => {
  let pasted = 0
  const { log, clipboard, events, service } = createMacPasteHarness({ trusted: false, sendPaste: async () => { pasted += 1 } })
  try {
    await assert.rejects(service.hideAndPasteText({ text: '#123456' }, caller, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof ZToolsError)
      assert.equal(error.code, errorCodes.permissionDenied)
      assert.match(error.message, /已复制.*辅助功能/)
      assert.equal(error.details?.hostCode, 'ACCESSIBILITY_PERMISSION_DENIED')
      return true
    })
    assert.equal(clipboard.text, '#123456')
    assert.equal(pasted, 0)
    assert.deepEqual(log, [])
  } finally { service.stop(); events.stop() }
})

test('macOS paste keystroke timeout or osascript permission error restores the window and reports a stable code', async () => {
  for (const [thrown, code] of [
    [new ZToolsError(errorCodes.requestTimeout, '已复制，但发送粘贴按键超时，请手动粘贴'), errorCodes.requestTimeout],
    [new ZToolsError(errorCodes.permissionDenied, '已复制，但无法自动粘贴'), errorCodes.permissionDenied],
    [new Error('raw native failure'), errorCodes.clipboardError]
  ] as const) {
    const { log, events, service } = createMacPasteHarness({ sendPaste: async () => { throw thrown } })
    try {
      await assert.rejects(service.hideAndPasteText({ text: 'x' }, caller, new AbortController().signal), { code })
      assert.deepEqual(log, ['window.hide', 'app.hide', 'app.show', 'window.show', 'window.focus'])
    } finally { service.stop(); events.stop() }
  }
})

test('macOS paste canceled during foreground activation never sends the keystroke and restores the window', async () => {
  let pasted = 0
  const { log, events, service } = createMacPasteHarness({ delayMs: 200, sendPaste: async () => { pasted += 1 } })
  const controller = new AbortController()
  try {
    const pending = service.hideAndPasteText({ text: 'late' }, caller, controller.signal)
    await wait(20)
    controller.abort()
    await assert.rejects(pending, { code: errorCodes.callerDestroyed })
    assert.equal(pasted, 0)
    assert.deepEqual(log, ['window.hide', 'app.hide', 'app.show', 'window.show', 'window.focus'])
  } finally { service.stop(); events.stop() }
})

test('macOS paste from a destroyed or unknown caller window is rejected as unsupported without touching focus', async () => {
  const { log, window, events, service } = createMacPasteHarness()
  try {
    window.destroyed = true
    await assert.rejects(service.hideAndPasteText({ text: 'x' }, caller, new AbortController().signal), { code: errorCodes.notSupported })
    await assert.rejects(service.hideAndPasteText({ text: 'x' }, { type: 'main', webContentsId: 99 }, new AbortController().signal), { code: errorCodes.notSupported })
    assert.deepEqual(log, [])
  } finally { service.stop(); events.stop() }
})

test('敏感文本由宿主定时清除，调用窗口退出不撤销；后来的普通复制不受影响', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = new EventService(new FakeRegistry()), clipboard = new FakeClipboard()
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    assert.deepEqual(await service.copyText({ text: 'fixture-secret', sensitive: true }, caller), { success: true, clearAfterMs: 30000 })
    t.mock.timers.tick(29999); assert.equal(clipboard.text, 'fixture-secret')
    t.mock.timers.tick(1); assert.equal(clipboard.text, '')
    await service.copyText({ text: 'fixture-secret-2', sensitive: true }, caller)
    clipboard.writeText('用户后来复制的普通内容')
    t.mock.timers.tick(30000); assert.equal(clipboard.text, '用户后来复制的普通内容')
    await service.copyText({ text: 'repeat', sensitive: true }, caller)
    await service.copyText({ text: 'repeat' }, caller)
    t.mock.timers.tick(30000); assert.equal(clipboard.text, 'repeat')
    await service.copyText({ text: 'stop-secret', sensitive: true }, caller)
    await service.stop(); assert.equal(clipboard.text, '')
  } finally { await service.stop(); events.stop() }
})

test('敏感写入后读回失败仍保留到期清理，公开清除静默失败不能撤销保护', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class IntermittentClipboard extends FakeClipboard {
    readFails = false
    ignoreClear = false
    override readImage() { if (this.readFails) throw new Error('暂时不可读'); return super.readImage() }
    override clear() { if (!this.ignoreClear) super.clear() }
  }
  const events = new EventService(new FakeRegistry()), clipboard = new IntermittentClipboard()
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    clipboard.readFails = true
    await assert.rejects(service.copyText({ text: 'uncertain-secret', sensitive: true }, caller))
    clipboard.readFails = false; t.mock.timers.tick(30000); assert.equal(clipboard.text, '')
    await service.copyText({ text: 'retry-secret', sensitive: true }, caller)
    clipboard.ignoreClear = true; assert.throws(() => service.clear())
    t.mock.timers.tick(30000); assert.equal(clipboard.text, 'retry-secret')
    clipboard.ignoreClear = false; t.mock.timers.tick(1000); assert.equal(clipboard.text, '')
  } finally { clipboard.readFails = false; clipboard.ignoreClear = false; await service.stop(); events.stop() }
})

test('敏感清理耗尽重试后新请求重新登记，停止及取消状态不产生新任务', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class FailingClipboard extends FakeClipboard {
    fail = false
    override clear() { if (this.fail) throw new Error('busy'); super.clear() }
    override readImage() { if (this.fail) throw new Error('busy'); return super.readImage() }
  }
  const events = new EventService(new FakeRegistry()), clipboard = new FailingClipboard()
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard())
  try {
    await service.copyText({ text: 'first-sensitive', sensitive: true }, caller)
    clipboard.fail = true; t.mock.timers.tick(30000); t.mock.timers.tick(1000); t.mock.timers.tick(1000)
    await assert.rejects(service.copyText({ text: 'second-sensitive', sensitive: true }, caller))
    clipboard.fail = false; t.mock.timers.tick(30000); assert.equal(clipboard.text, '')
    const abort = new AbortController(); abort.abort()
    await assert.rejects(service.copyText({ text: 'cancelled', sensitive: true }, caller, abort.signal))
    await service.stop(); await assert.rejects(service.copyText({ text: 'stopped', sensitive: true }, caller))
    clipboard.writeText('ordinary'); t.mock.timers.tick(60000); assert.equal(clipboard.text, 'ordinary')
  } finally { clipboard.fail = false; await service.stop(); events.stop() }
})

test('历史写入的异步间隙出现敏感复制，不得把密码录入历史或广播', { skip: !['darwin', 'win32'].includes(process.platform) }, async () => {
  const registry = new FakeRegistry(), events = new EventService(registry), clipboard = new FakeClipboard()
  let release: () => void = () => {}; let started = false
  const pending = new Promise<void>(resolve => { release = resolve }), records: string[] = []
  const service = new ClipboardService(createFiles().files, events, clipboard, createImages(), new FakeFileClipboard(),
    5, undefined, undefined, undefined, async entry => {
      if (entry.type !== 'text') return
      records.push(entry.text)
      if (entry.text === 'old-ordinary') { started = true; await pending }
    })
  events.subscribe({ key: 'clipboard_change' }, caller)
  try {
    clipboard.writeText('old-ordinary'); await until(() => started)
    await service.copyText({ text: 'private-fixture', sensitive: true }, caller)
    release(); await wait(60)
    assert.deepEqual(records, ['old-ordinary'])
    assert.ok(!JSON.stringify(registry.sent).includes('private-fixture'))
    await service.stop(); assert.equal(clipboard.text, '')
  } finally { release(); await service.stop(); events.stop() }
})


test('粘贴在途时所有宿主写入口拒绝抢占，原文本只粘贴一次，完成后可继续', async () => {
  let entered = false, release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve }), pasted: string[] = []
  const harness = createMacPasteHarness({ sendPaste: async () => { entered = true; await pending; pasted.push(harness.clipboard.text) } })
  const { service, clipboard, events } = harness, signal = new AbortController().signal
  const first = service.hideAndPasteText({ text: '第一份文本' }, caller, signal)
  try {
    await until(() => entered)
    const operations: Array<() => unknown> = [
      () => service.copyText({ text: '覆盖' }, caller),
      () => service.copyImage({ image: Buffer.from('png').toString('base64') }),
      () => service.copyFile({ filePath: '/not-read' }, caller, signal),
      () => service.copyFiles({ filePaths: ['/not-read'] }, caller, signal),
      () => service.copyTextReference({ text: '覆盖' }, caller, signal),
      () => service.copyImageReference({ image: 'ignored' }, caller, signal),
      () => service.clear(),
      () => service.restoreHistoryEntry({ type: 'text', text: '覆盖' }, caller, signal),
      () => service.restoreHistoryEntry({ type: 'text', text: '覆盖' }, caller, signal, true),
      () => service.hideAndPasteText({ text: '第二份文本' }, caller, signal),
      () => service.hideAndPasteImage({ image: 'ignored' }, caller, signal),
      () => service.hideAndPasteFile({ filePath: '/not-read' }, caller, signal),
      () => service.hideAndType('覆盖', caller, signal)
    ]
    for (const operation of operations) {
      await assert.rejects(Promise.resolve().then(operation), { code: errorCodes.clipboardError, message: '剪贴板操作正在进行，请完成后重试' })
      assert.equal(clipboard.text, '第一份文本')
    }
    release(); await first
    assert.deepEqual(pasted, ['第一份文本'])
    await service.hideAndPasteText({ text: '第二份文本' }, caller, signal)
    assert.deepEqual(pasted, ['第一份文本', '第二份文本'])
  } finally { release(); await first; await service.stop(); events.stop() }
})

test('异步文件写入准备阶段已持有互斥，拒绝粘贴抢先执行，失败后释放', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipboard-write-lock-'))
  const file = path.join(directory, 'fixture.txt'); await fs.writeFile(file, 'fixture')
  const { service, clipboard, files, fileClipboard, events, log } = createMacPasteHarness()
  let entered = false, release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve }), signal = new AbortController().signal
  files.resolveAuthorizedPath = async () => { entered = true; await pending; return file }
  const writing = service.copyFiles({ filePaths: [file] }, caller, signal)
  try {
    await until(() => entered)
    await assert.rejects(service.hideAndPasteText({ text: '不能抢先' }, caller, signal), { code: errorCodes.clipboardError })
    assert.equal(clipboard.text, ''); assert.deepEqual(log, [])
    release(); await writing; assert.deepEqual(fileClipboard.paths, [file])
    files.resolveAuthorizedPath = async () => { throw new Error('文件拒绝访问') }
    await assert.rejects(service.copyFiles({ filePaths: [file] }, caller, signal))
    await service.hideAndPasteText({ text: '失败后可恢复' }, caller, signal)
    assert.equal(clipboard.text, '失败后可恢复')
  } finally { release(); await writing; await service.stop(); events.stop(); await fs.rm(directory, { recursive: true, force: true }) }
})

test('等待目标应用激活时外部复制变化就停止粘贴，保留新内容并恢复窗口', async () => {
  const { service, clipboard, events, log } = createMacPasteHarness({ delayMs: 30 })
  try {
    const request = service.hideAndPasteText({ text: '原文本' }, caller, new AbortController().signal)
    const rejected = assert.rejects(request, { code: errorCodes.clipboardError, message: '剪贴板已变化，已停止自动粘贴，请重新选择内容' })
    await until(() => log.includes('app.hide')); clipboard.writeText('用户后来复制的内容')
    await rejected
    assert.equal(clipboard.text, '用户后来复制的内容'); assert.ok(!log.includes('paste'))
    assert.deepEqual(log.slice(-3), ['app.show', 'window.show', 'window.focus'])
    await service.hideAndPasteText({ text: '重试' }, caller, new AbortController().signal)
    assert.equal(log.filter(value => value === 'paste').length, 1)
  } finally { await service.stop(); events.stop() }
})

test('已取消和已停止的粘贴在复制前拒绝，原剪贴板保持不变', async () => {
  const { service, clipboard, events, log } = createMacPasteHarness()
  clipboard.writeText('保留')
  const controller = new AbortController(); controller.abort()
  try {
    await assert.rejects(service.hideAndPasteText({ text: '不写入' }, caller, controller.signal), { code: errorCodes.callerDestroyed })
    await service.stop()
    await assert.rejects(service.hideAndPasteText({ text: '不写入' }, caller, new AbortController().signal), { code: errorCodes.callerDestroyed })
    assert.equal(clipboard.text, '保留'); assert.deepEqual(log, [])
  } finally { await service.stop(); events.stop() }
})

test('敏感清理遇到在途写入先延后，停止等待取消后的释放再清理，不能提前返回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { service, clipboard, files, events } = createMacPasteHarness()
  let entered = false, release: () => void = () => {}, stopped = false
  const pending = new Promise<void>(resolve => { release = resolve })
  files.readFile = async (_params, _caller, signal) => {
    entered = true
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new ZToolsError(errorCodes.callerDestroyed, '读取已取消'))
      signal?.addEventListener('abort', abort, { once: true })
      void pending.then(() => { signal?.removeEventListener('abort', abort); resolve() })
    })
    return { success: true, content: '停机后不能落地', size: 24 }
  }
  try {
    await service.copyText({ text: '等待清除的假密码', sensitive: true }, caller)
    const writing = service.copyText({ tempFile: '/isolated-fixture' }, caller)
    assert.equal(entered, true)
    const rejected = assert.rejects(writing, { code: errorCodes.callerDestroyed })
    t.mock.timers.tick(30000); t.mock.timers.tick(3000)
    assert.equal(clipboard.text, '等待清除的假密码')
    const stopping = service.stop().then(() => { stopped = true })
    await rejected; await stopping
    assert.equal(clipboard.text, ''); assert.equal(stopped, true)
    release(); await Promise.resolve(); assert.equal(clipboard.text, '', '读取迟到完成也不得重新写入')
    clipboard.writeText('后来的正常复制'); t.mock.timers.tick(60000)
    assert.equal(clipboard.text, '后来的正常复制')
  } finally { release(); await service.stop(); events.stop() }
})


test('Mac目标无法确认时不隐藏窗口也不发送粘贴键', async () => {
  const { log, events, service, clipboard } = createMacPasteHarness({
    preparePaste: async () => { throw new ZToolsError(errorCodes.clipboardError, '无法确认粘贴目标', { hostCode: 'PASTE_TARGET_UNAVAILABLE' }) }
  })
  try {
    await assert.rejects(service.hideAndPasteText({ text: '仅复制的测试内容' }, caller, new AbortController().signal), error =>
      error instanceof ZToolsError && error.details?.hostCode === 'PASTE_TARGET_UNAVAILABLE')
    assert.equal(clipboard.text, '仅复制的测试内容')
    assert.deepEqual(log, [])
  } finally { await service.stop(); events.stop() }
})

test('原生目标或发键权限拒绝经完整服务保留原因，准备失败不隐藏，发送前撤权恢复窗口', async () => {
  const scenarios = ['PASTE_TARGET_UNAVAILABLE', 'PASTE_HOST_NOT_ACTIVE', 'PASTE_TARGET_APP_UNAVAILABLE',
    'PASTE_TARGET_WINDOW_UNAVAILABLE', 'PASTE_TARGET_ELEMENT_UNAVAILABLE', 'PASTE_FOCUS_OBSERVER_UNAVAILABLE', 'PASTE_EVENT_PERMISSION_DENIED']
    .map(reason => ({ reason, phase: 'prepare' }))
  scenarios.push({ reason: 'PASTE_EVENT_PERMISSION_DENIED', phase: 'paste' })
  for (const { reason, phase } of scenarios) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const peer = Object.assign(new EventEmitter(), { stdin, stdout, stderr,
      kill: () => { queueMicrotask(() => peer.emit('close')); return true } })
    const requests: string[] = []
    stdin.on('data', data => {
      const request = JSON.parse(String(data)) as { id: number; mode: string }
      requests.push(request.mode)
      stdout.write(JSON.stringify(request.mode === phase
        ? { version: 1, id: request.id, success: false, error: reason }
        : { version: 1, id: request.id, success: true, state: 'prepared' }) + '\n')
    })
    const session = new MacPasteSession('/fixture/not-executed', () => peer as unknown as ChildProcessWithoutNullStreams)
    stdout.write('{"version":1,"ready":true}\n')
    const harness = createMacPasteHarness({ preparePaste: signal => session.prepare(signal), sendPaste: (signal, token) => session.paste(token, signal) })
    try {
      await assert.rejects(harness.service.hideAndPasteText({ text: '内存中的测试文字' }, caller, new AbortController().signal), error =>
        error instanceof ZToolsError && error.code === (reason === 'PASTE_EVENT_PERMISSION_DENIED' ? errorCodes.permissionDenied : errorCodes.clipboardError)
          && error.details?.hostCode === reason && /手动粘贴/.test(error.message))
      assert.deepEqual(requests, phase === 'prepare' ? ['prepare'] : ['prepare', 'paste'])
      assert.deepEqual(harness.log, phase === 'prepare' ? [] : ['window.hide', 'app.hide', 'app.show', 'window.show', 'window.focus'])
      assert.equal(harness.clipboard.text, '内存中的测试文字')
    } finally { await harness.service.stop(); harness.events.stop(); await session.stop() }
  }
})
