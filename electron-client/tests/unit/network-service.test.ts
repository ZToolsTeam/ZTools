import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type {
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  Session
} from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import {
  NetworkService,
  type NetworkServiceOptions
} from '../../src/main/services/network-service.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 1 }

function referenceTransferFixture(): NonNullable<NetworkServiceOptions['pathGrants']> {
  return {
    readReference: (owner, id) => {
      if (owner !== 1 || id !== 'file') throw new ZToolsError(errorCodes.permissionDenied, 'wrong owner/reference')
      return { grantId: id, displayName: '空 格.txt', kind: 'file', operations: ['read'] }
    },
    saveReference: (owner, id) => {
      if (owner !== 1 || id !== 'save') throw new ZToolsError(errorCodes.permissionDenied, 'wrong owner/reference')
      return { grantId: id, displayName: 'output.txt', kind: 'save', operations: ['write'] }
    },
    describe: async () => ({ isDirectory: false, size: 7, lastModifiedMs: 1000 }),
    read: async () => Buffer.from('fixture'),
    streamSave: async (owner, id, expected, chunks) => {
      assert.equal(owner, 1); assert.equal(id, 'save'); let size = 0
      for await (const chunk of chunks) size += chunk.length
      if (expected !== undefined) assert.equal(size, expected)
      return { status: 'committed', bytesWritten: size }
    }
  }
}

test('reference download retains caller session/redirect policy and returns only an opaque save reference', async () => {
  const session = fakeSession(), grants = referenceTransferFixture(); let fetched = 0
  const service = createService(session, () => { throw new Error('unexpected request API') }, undefined, { pathGrants: grants,
    transferFetch: async (actualSession, url, init) => {
      assert.equal(actualSession, session); assert.equal(init.redirect, 'manual'); fetched++
      if (fetched === 1) return new Response(null, { status: 302, headers: { location: '/output' } })
      assert.equal(url, 'https://example.test/output')
      return new Response('fixture', { headers: { 'content-length': '7' } })
    } })
  const result = await service.downloadRef({ url: 'https://example.test/start', saveGrantId: 'save' }, caller, new AbortController().signal)
  assert.equal(result.grantId, 'save'); assert.equal(result.size, 7); assert.equal('path' in result, false); assert.equal(fetched, 2)
  await assert.rejects(service.downloadRef({ url: 'https://example.test/start', saveGrantId: 'save' }, { type: 'main', webContentsId: 99 }, new AbortController().signal), { code: 'PERMISSION_DENIED' })
  assert.equal(fetched, 2)
})

test('reference upload uses pinned content and trusted display name and refuses changed sources before HTTP', async () => {
  const session = fakeSession(), grants = referenceTransferFixture(); let fetched = 0
  const service = createService(session, () => { throw new Error('unexpected request API') }, undefined, { pathGrants: grants,
    transferFetch: async (actualSession, _, init) => {
      assert.equal(actualSession, session); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST')
      const part = (init.body as FormData).get('file') as Blob & { name: string }
      assert.equal(part.name, '空 格.txt'); assert.equal(await part.text(), 'fixture'); fetched++
      return new Response('uploaded')
    } })
  assert.equal((await service.uploadRef({ url: 'https://example.test/upload', fileGrantId: 'file' }, caller, new AbortController().signal)).data.body, 'uploaded')
  await assert.rejects(service.uploadRef({ url: 'https://example.test/upload', fileGrantId: 'file' }, { type: 'main', webContentsId: 99 }, new AbortController().signal), { code: 'PERMISSION_DENIED' })
  assert.equal(fetched, 1)
  let described = 0; grants.describe = async () => ({ isDirectory: false, size: 7, lastModifiedMs: ++described === 1 ? 1000 : 1001 })
  await assert.rejects(service.uploadRef({ url: 'https://example.test/upload', fileGrantId: 'file' }, caller, new AbortController().signal), { code: 'FILE_ERROR' })
  assert.equal(fetched, 1)
})

test('reference download preserves commit uncertainty after cancellation and refuses unsafe redirects', async () => {
  const session = fakeSession(), grants = referenceTransferFixture(), controller = new AbortController()
  grants.streamSave = async () => { controller.abort(); throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'unknown') }
  const service = createService(session, () => { throw new Error('unexpected request API') }, undefined, { pathGrants: grants,
    transferFetch: async () => new Response('fixture') })
  await assert.rejects(service.downloadRef({ url: 'https://example.test/start', saveGrantId: 'save' }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const unsafe = createService(session, () => { throw new Error('unexpected request API') }, undefined, { pathGrants: referenceTransferFixture(),
    transferFetch: async () => new Response(null, { status: 302, headers: { location: 'http://example.test/downgrade' } }) })
  await assert.rejects(unsafe.downloadRef({ url: 'https://example.test/start', saveGrantId: 'save' }, caller, new AbortController().signal), { code: 'NETWORK_ERROR' })
})

class FakeRequest extends EventEmitter {
  body: string | Buffer | undefined
  aborted = false
  followedRedirects = 0
  endCalls = 0

  constructor(private readonly onEnd: (request: FakeRequest) => void) {
    super()
  }

  abort(): void {
    this.aborted = true
    this.emit('abort')
  }

  end(body?: string | Buffer): this {
    this.endCalls += 1
    this.body = body
    this.onEnd(this)
    return this
  }

  followRedirect(): void {
    this.followedRedirects += 1
  }
}

function respond(request: FakeRequest, body: string, statusCode = 200, statusMessage = 'OK'): void {
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    statusMessage
  }) as IncomingMessage
  request.emit('response', response)
  response.emit('data', Buffer.from(body))
  response.emit('end')
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    cookies: {
      set: async () => undefined,
      get: async () => []
    },
    clearStorageData: async () => undefined,
    setProxy: async () => undefined,
    closeAllConnections: async () => undefined,
    ...overrides
  } as unknown as Session
}

function createService(
  session: Session,
  requestFactory: NonNullable<NetworkServiceOptions['requestFactory']>,
  maxResponseBytes?: number,
  extra: Partial<NetworkServiceOptions> = {}
): NetworkService {
  return new NetworkService({} as WindowRegistry, {
    requestFactory,
    sessionResolver: () => session,
    ...extra,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes })
  })
}

test('network request uses the caller session and preserves the Delphi response shape', async () => {
  const session = fakeSession()
  let capturedOptions: ClientRequestConstructorOptions | undefined
  let createdRequest: FakeRequest | undefined
  const service = createService(session, (options) => {
    capturedOptions = options
    createdRequest = new FakeRequest((request) => respond(request, '{"ok":true}', 201, 'Created'))
    return createdRequest as unknown as ClientRequest
  })

  const result = await service.request({
    method: 'POST',
    url: 'https://example.com/api',
    headers: { 'Content-Type': 'application/json' },
    body: '{"input":1}',
    timeout: 30_000
  }, caller, new AbortController().signal)

  assert.deepEqual(result, {
    success: true,
    data: { statusCode: 201, statusText: 'Created', body: '{"ok":true}' }
  })
  assert.equal(capturedOptions?.session, session)
  assert.equal(capturedOptions?.redirect, 'manual')
  assert.equal(createdRequest?.body, '{"input":1}')
})

test('network request aborts oversized responses and unsafe redirects', async () => {
  let oversizedRequest: FakeRequest | undefined
  const oversized = createService(fakeSession(), () => {
    oversizedRequest = new FakeRequest((request) => respond(request, '12345'))
    return oversizedRequest as unknown as ClientRequest
  }, 4)
  await assert.rejects(
    oversized.request({ method: 'GET', url: 'http://localhost:6800/jsonrpc', timeout: 1000 }, caller, new AbortController().signal),
    (error) => error instanceof ZToolsError && error.code === errorCodes.responseTooLarge
  )
  assert.equal(oversizedRequest?.aborted, true)

  let redirectRequest: FakeRequest | undefined
  const redirected = createService(fakeSession(), () => {
    redirectRequest = new FakeRequest((request) => request.emit('redirect', 302, 'GET', 'file:///etc/passwd', {}))
    return redirectRequest as unknown as ClientRequest
  })
  await assert.rejects(
    redirected.request({ method: 'GET', url: 'https://example.com', timeout: 1000 }, caller, new AbortController().signal),
    (error) => error instanceof ZToolsError && error.code === errorCodes.networkError
  )
  assert.equal(redirectRequest?.aborted, true)
  assert.equal(redirectRequest?.followedRedirects, 0)
})

test('network request only follows redirects for GET and HEAD, never resends unsafe request bodies', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const statusCode of [301, 302, 303, 307, 308]) {
      let requestFactoryCalls = 0
      let request: FakeRequest | undefined
      const service = createService(fakeSession(), () => {
        requestFactoryCalls += 1
        request = new FakeRequest((current) => current.emit('redirect', statusCode, 'GET', 'https://example.com/next', {}))
        return request as unknown as ClientRequest
      })
      await assert.rejects(
        service.request({ method, url: 'https://example.com/start', body: 'private request body', timeout: 1000 } as Parameters<NetworkService['request']>[0], caller, new AbortController().signal),
        (error) => error instanceof ZToolsError && error.code === errorCodes.networkError && error.message === '拒绝自动重定向非 GET/HEAD 请求'
      )
      assert.equal(requestFactoryCalls, 1, `${method} ${statusCode} must not create a follow-up request`)
      assert.equal(request?.body, method === 'POST' || method === 'PUT' ? 'private request body' : undefined,
        'the original supported body is sent only on the initial request')
      assert.equal(request?.endCalls, 1, `${method} ${statusCode} must not resend the body`)
      assert.equal(request?.followedRedirects, 0, `${method} ${statusCode} must not call followRedirect`)
      assert.equal(request?.aborted, true)
    }
  }
})

test('GET and HEAD keep safe redirect following behavior', async () => {
  for (const method of ['GET', 'HEAD'] as const) {
    assert.doesNotThrow(() => validateMethodParams('network_http_request', {
      method, url: 'https://example.com/start', timeout: 1000
    }))
    let requestFactoryCalls = 0
    let request: FakeRequest | undefined
    const service = createService(fakeSession(), () => {
      requestFactoryCalls += 1
      request = new FakeRequest((current) => {
        current.emit('redirect', 302, method, 'https://example.com/next', {})
        if (current.followedRedirects === 1) respond(current, 'safe response', 200)
      })
      return request as unknown as ClientRequest
    })
    const result = await service.request({ method, url: 'https://example.com/start', timeout: 1000 }, caller, new AbortController().signal)
    assert.deepEqual(result.data, { statusCode: 200, statusText: 'OK', body: 'safe response' })
    assert.equal(requestFactoryCalls, 1, 'Electron follows on the existing request object')
    assert.equal(request?.endCalls, 1)
    assert.equal(request?.followedRedirects, 1)
    assert.equal(request?.aborted, false)
  }
})

test('network request cancellation preserves the router error category', async () => {
  let request: FakeRequest | undefined
  const service = createService(fakeSession(), () => {
    request = new FakeRequest(() => undefined)
    return request as unknown as ClientRequest
  })
  const controller = new AbortController()
  const pending = service.request(
    { method: 'GET', url: 'https://example.com', timeout: 1000 },
    caller,
    controller.signal
  )
  controller.abort(errorCodes.requestTimeout)
  await assert.rejects(
    pending,
    (error) => error instanceof ZToolsError && error.code === errorCodes.requestTimeout
  )
  assert.equal(request?.aborted, true)
})

test('network request failures keep stable codes without exposing native error details', async () => {
  const request = new FakeRequest(() => undefined)
  const service = createService(fakeSession(), () => {
    queueMicrotask(() => request.emit('error', new Error('getaddrinfo failed for https://user:secret@example.com/private')))
    return request as unknown as ClientRequest
  })
  await assert.rejects(
    service.request({ method: 'GET', url: 'https://example.com', timeout: 1000 }, caller, new AbortController().signal),
    (error) => error instanceof ZToolsError &&
      error.code === errorCodes.networkError &&
      error.message === '网络请求失败' &&
      !error.message.includes('secret@example.com')
  )
})

test('network request enforces its handler timeout even when the router deadline is longer', async () => {
  let request: FakeRequest | undefined
  const service = createService(fakeSession(), () => {
    request = new FakeRequest(() => undefined)
    return request as unknown as ClientRequest
  })
  await assert.rejects(
    service.request(
      { method: 'GET', url: 'https://example.com', timeout: 5 },
      caller,
      new AbortController().signal
    ),
    (error) => error instanceof ZToolsError && error.code === errorCodes.requestTimeout
  )
  assert.equal(request?.aborted, true)
})

test('cookies and proxy are scoped to the caller session', async () => {
  const calls: Record<string, unknown> = {}
  const session = fakeSession({
    cookies: {
      set: async (details) => { calls.cookie = details },
      get: async (filter) => {
        calls.filter = filter
        return [{ name: 'session', value: 'value', domain: '.example.com', path: '/', secure: true, httpOnly: false, session: true }]
      }
    } as Session['cookies'],
    clearStorageData: async (options) => { calls.clear = options },
    setProxy: async (options) => { calls.proxy = options },
    closeAllConnections: async () => { calls.closed = true }
  })
  const service = createService(session, (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest)

  await service.setCookie({ name: 'session', value: 'value', domain: '.example.com', path: '/' }, caller)
  assert.deepEqual(calls.cookie, {
    url: 'https://example.com/',
    name: 'session',
    value: 'value',
    domain: '.example.com',
    path: '/'
  })
  assert.equal((await service.getCookie({ url: 'https://example.com' }, caller))[0]?.name, 'session')
  assert.deepEqual(calls.filter, { url: 'https://example.com' })
  await service.clearCookies(caller)
  assert.deepEqual(calls.clear, { storages: ['cookies'] })
  await service.setProxy({ host: '127.0.0.1', port: 7890, username: 'user', password: 'pass' }, caller)
  assert.deepEqual(calls.proxy, { mode: 'fixed_servers', proxyRules: '127.0.0.1:7890' })
  assert.equal(calls.closed, true)
})

test('download rejects an ungranted destination and writes atomically after Main authorizes it', async () => {
  // macOS 的临时目录在 /var 下，而 /var 是指向 /private/var 的系统链接；服务返回规范化后的真实路径，测试也按真实路径断言
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-')))
  let removed: ((webContentsId: number) => void) | undefined
  const registry = {
    onRemoved(listener: (webContentsId: number) => void) {
      removed = listener
      return () => { removed = undefined }
    }
  } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const target = path.join(root, 'download.txt')
  let fetched = 0
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      transferFetch: async () => { fetched++; return new Response('downloaded', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-length': '10' }
      }) }
    }
  )
  try {
    await assert.rejects(
      service.download({ url: 'https://example.com/file', savePath: target }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.equal(fetched, 0)
    await files.grantSavePath(target, caller)
    assert.deepEqual(
      await service.download({ url: 'https://example.com/file', savePath: target }, caller, new AbortController().signal),
      { success: true, path: target, size: 10, statusCode: 200, statusText: 'OK' }
    )
    assert.equal(fetched, 1)
    assert.equal(await fs.readFile(target, 'utf8'), 'downloaded')
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.download')), false)
  } finally {
    files.stop()
    removed = undefined
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('upload rejects an ungranted source and reads a bounded file after Main authorizes it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-upload-'))
  const registry = {
    onRemoved() { return () => undefined }
  } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const source = path.join(root, 'upload.txt')
  await fs.writeFile(source, 'payload')
  let uploaded = ''
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      transferFetch: async (_session, _url, init) => {
        const form = init.body as FormData
        const file = form.get('document') as File
        uploaded = await file.text()
        return new Response('{"accepted":true}', { status: 201, statusText: 'Created' })
      }
    }
  )
  try {
    await assert.rejects(
      service.upload({ url: 'https://example.com/upload', filePath: source, fieldName: 'document' }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    await files.grantOpenPath(source, caller)
    const result = await service.upload({
      url: 'https://example.com/upload',
      filePath: source,
      fieldName: 'document'
    }, caller, new AbortController().signal)
    assert.equal(uploaded, 'payload')
    assert.deepEqual(result, {
      success: true,
      data: { statusCode: 201, statusText: 'Created', body: '{"accepted":true}' }
    })
  } finally {
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('download rejects a declared oversized body before creating the target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-limit-'))
  const registry = { onRemoved() { return () => undefined } } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const target = path.join(root, 'large.bin')
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      maxDownloadBytes: 4,
      transferFetch: async () => new Response('12345', {
        status: 200,
        headers: { 'content-length': '5' }
      })
    }
  )
  try {
    await files.grantSavePath(target, caller)
    await assert.rejects(
      service.download({ url: 'https://example.com/large', savePath: target }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.responseTooLarge
    )
    await assert.rejects(fs.stat(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  } finally {
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('download enforces the streamed size and removes partial files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-stream-limit-'))
  const registry = { onRemoved() { return () => undefined } } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const target = path.join(root, 'large.bin')
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      maxDownloadBytes: 4,
      transferFetch: async () => new Response('12345', { status: 200 })
    }
  )
  try {
    await files.grantSavePath(target, caller)
    await assert.rejects(
      service.download({ url: 'https://example.com/large', savePath: target }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.responseTooLarge
    )
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.download')), false)
  } finally {
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('download cancellation preserves the timeout category and removes its temporary file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-cancel-'))
  const registry = { onRemoved() { return () => undefined } } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const target = path.join(root, 'cancel.bin')
  const controller = new AbortController()
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      transferFetch: async (_session, _url, init) => new Response(new ReadableStream({
        start(stream) {
          init.signal?.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true })
        }
      }), { status: 200 })
    }
  )
  try {
    await files.grantSavePath(target, caller)
    const pending = service.download({ url: 'https://example.com/cancel', savePath: target }, caller, controller.signal)
    setImmediate(() => controller.abort(errorCodes.requestTimeout))
    await assert.rejects(
      pending,
      (error) => error instanceof ZToolsError && error.code === errorCodes.requestTimeout
    )
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.download')), false)
  } finally {
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('download rejects HTTPS downgrade redirects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-redirect-'))
  const registry = { onRemoved() { return () => undefined } } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'cache'))
  const target = path.join(root, 'redirect.bin')
  const service = createService(
    fakeSession(),
    (_options) => new FakeRequest(() => undefined) as unknown as ClientRequest,
    undefined,
    {
      fileService: files,
      transferFetch: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/insecure' }
      })
    }
  )
  try {
    await files.grantSavePath(target, caller)
    await assert.rejects(
      service.download({ url: 'https://example.com/file', savePath: target }, caller, new AbortController().signal),
      (error) => error instanceof ZToolsError && error.code === errorCodes.networkError
    )
  } finally {
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('reference download preserves retained staging during cancellation and upload metadata receives the same abort signal', async () => {
  const grants = referenceTransferFixture(), controller = new AbortController()
  grants.streamSave = async () => { controller.abort(); throw new ZToolsError(errorCodes.fileStagingRetained, 'staging remains') }
  const service = createService(fakeSession(), () => { throw new Error('unused') }, undefined, { pathGrants: grants,
    transferFetch: async () => new Response('fixture') })
  await assert.rejects(service.downloadRef({ url: 'https://example.test/file', saveGrantId: 'save' }, caller, controller.signal), { code: 'FILE_STAGING_RETAINED' })
  const uploading = referenceTransferFixture(), signal = new AbortController().signal
  let metadataCalls = 0
  uploading.describe = async (_owner, _id, actualSignal) => {
    assert.equal(actualSignal, signal); metadataCalls++
    return { isDirectory: false, size: 7, lastModifiedMs: 1000 }
  }
  const upload = createService(fakeSession(), () => { throw new Error('unused') }, undefined, { pathGrants: uploading,
    transferFetch: async () => new Response('uploaded') })
  await upload.uploadRef({ url: 'https://example.test/upload', fileGrantId: 'file' }, caller, signal)
  assert.equal(metadataCalls, 2)
})
