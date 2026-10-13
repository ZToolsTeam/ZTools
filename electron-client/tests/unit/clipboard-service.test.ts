import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  ClipboardService,
  decodeBmp,
  type ClipboardAdapter,
  type ClipboardImage,
  type ClipboardImageFactory,
  type FileClipboardAdapter
} from '../../src/main/services/clipboard-service.js'
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

test('history retries failed writes and shutdown drains an in-flight save without publishing after stop', { skip: process.platform !== 'win32' }, async () => {
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
