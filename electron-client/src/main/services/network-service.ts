import {
  net,
  type ClientRequest,
  type ClientRequestConstructorOptions,
  type CookiesSetDetails,
  type Session
} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  NetworkGetCookieParams,
  NetworkHttpRequestParams,
  NetworkSetCookieParams,
  NetworkSetProxyParams,
  NetworkTransferParams
} from '../../contracts/method-params.js'
import { replaceFile, type FileSystemService } from './file-system-service.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { PathGrantService } from './path-grant-service.js'
import { persistAnchoredDownload } from './anchored-download.js'
import type { DownloadReferenceParams, UploadReferenceParams } from '../../contracts/path-transfer.js'

export const MAX_NETWORK_RESPONSE_BYTES = 16 * 1024 * 1024
export const MAX_NETWORK_DOWNLOAD_BYTES = 1024 * 1024 * 1024
export const MAX_NETWORK_UPLOAD_BYTES = 16 * 1024 * 1024
const MAX_REDIRECTS = 5

type RequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest
type SessionResolver = (caller: CallerIdentity) => Session | undefined
type TransferFetch = (callerSession: Session, url: string, init: RequestInit) => Promise<Response>

export interface NetworkServiceOptions {
  requestFactory?: RequestFactory
  sessionResolver?: SessionResolver
  transferFetch?: TransferFetch
  fileService?: FileSystemService
  pathGrants?: Pick<PathGrantService, 'streamSave' | 'read' | 'describe' | 'readReference' | 'saveReference'>
  maxResponseBytes?: number
  maxDownloadBytes?: number
  maxUploadBytes?: number
}

interface ProxyCredentials {
  username: string
  password: string
}

function networkFailure(error: unknown): ZToolsError {
  if (error instanceof ZToolsError) return error
  return new ZToolsError(errorCodes.networkError, '网络请求失败')
}

function abortFailure(reason: unknown): ZToolsError {
  if (reason === errorCodes.requestTimeout) {
    return new ZToolsError(errorCodes.requestTimeout, '调用超时')
  }
  if (reason === errorCodes.appStopping) {
    return new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  return new ZToolsError(errorCodes.callerDestroyed, '调用者已销毁')
}

function requireRedirectUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ZToolsError(errorCodes.networkError, '服务器返回了无效重定向地址')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new ZToolsError(errorCodes.networkError, '服务器重定向到不允许的 URL')
  }
  return parsed
}

export class NetworkService {
  readonly #requestFactory: RequestFactory
  readonly #sessionResolver: SessionResolver
  readonly #transferFetch: TransferFetch
  readonly #fileService: FileSystemService | undefined
  readonly #pathGrants: NetworkServiceOptions['pathGrants']
  readonly #maxResponseBytes: number
  readonly #maxDownloadBytes: number
  readonly #maxUploadBytes: number
  readonly #proxyCredentials = new WeakMap<Session, ProxyCredentials>()

  constructor(registry: WindowRegistry, options: NetworkServiceOptions = {}) {
    this.#requestFactory = options.requestFactory ?? ((requestOptions) => net.request(requestOptions))
    this.#sessionResolver = options.sessionResolver ?? ((caller) => registry.getSession(caller.webContentsId))
    this.#transferFetch = options.transferFetch ?? ((callerSession, url, init) => callerSession.fetch(url, init))
    this.#fileService = options.fileService
    this.#pathGrants = options.pathGrants
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_NETWORK_RESPONSE_BYTES
    this.#maxDownloadBytes = options.maxDownloadBytes ?? MAX_NETWORK_DOWNLOAD_BYTES
    this.#maxUploadBytes = options.maxUploadBytes ?? MAX_NETWORK_UPLOAD_BYTES
  }

  async request(
    params: NetworkHttpRequestParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{
    success: true
    data: { statusCode: number; statusText: string; body: string }
  }> {
    const callerSession = this.#requireSession(caller)
    if (signal.aborted) throw abortFailure(signal.reason)

    return new Promise((resolve, reject) => {
      let settled = false
      let redirects = 0
      let currentUrl = new URL(params.url)
      let responseBytes = 0
      const chunks: Buffer[] = []
      let deadline: NodeJS.Timeout | undefined
      let request: ClientRequest | undefined

      const cleanup = (): void => {
        if (deadline) clearTimeout(deadline)
        signal.removeEventListener('abort', onAbort)
      }
      const succeed = (value: {
        success: true
        data: { statusCode: number; statusText: string; body: string }
      }): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(networkFailure(error))
      }
      const abortRequest = (): void => {
        try {
          request?.abort()
        } catch {
          // The request may already have closed.
        }
      }
      const onAbort = (): void => {
        fail(abortFailure(signal.reason))
        abortRequest()
      }

      try {
        request = this.#requestFactory({
          method: params.method,
          url: params.url,
          session: callerSession,
          credentials: 'include',
          redirect: 'manual',
          ...(params.headers === undefined ? {} : { headers: params.headers })
        })
      } catch (error) {
        fail(error)
        return
      }
      deadline = setTimeout(() => {
        fail(new ZToolsError(errorCodes.requestTimeout, '网络请求超时'))
        abortRequest()
      }, params.timeout)
      signal.addEventListener('abort', onAbort, { once: true })
      request.on('error', fail)
      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        try {
          if (params.method !== 'GET' && params.method !== 'HEAD') {
            throw new ZToolsError(errorCodes.networkError, '拒绝自动重定向非 GET/HEAD 请求')
          }
          redirects += 1
          if (redirects > MAX_REDIRECTS) {
            throw new ZToolsError(errorCodes.networkError, 'HTTP 重定向次数超过上限')
          }
          const nextUrl = requireRedirectUrl(redirectUrl)
          if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
            throw new ZToolsError(errorCodes.networkError, '拒绝 HTTPS 降级重定向')
          }
          const hasSensitiveHeaders = Object.keys(params.headers ?? {}).some((name) =>
            name.toLowerCase() === 'authorization' || name.toLowerCase() === 'cookie'
          )
          if (currentUrl.origin !== nextUrl.origin && hasSensitiveHeaders) {
            throw new ZToolsError(errorCodes.networkError, '拒绝携带敏感请求头的跨源重定向')
          }
          currentUrl = nextUrl
          request.followRedirect()
        } catch (error) {
          fail(error)
          abortRequest()
        }
      })

      const credentials = this.#proxyCredentials.get(callerSession)
      if (credentials) {
        request.on('login', (authInfo, callback) => {
          if (authInfo.isProxy) callback(credentials.username, credentials.password)
          else callback()
        })
      }

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          if (settled) return
          responseBytes += chunk.byteLength
          if (responseBytes > this.#maxResponseBytes) {
            fail(new ZToolsError(errorCodes.responseTooLarge, 'HTTP 响应体超过 16 MiB 上限'))
            abortRequest()
            return
          }
          chunks.push(chunk)
        })
        response.on('aborted', () => fail(new Error('响应流已中断')))
        response.on('error', fail)
        response.on('end', () => {
          succeed({
            success: true,
            data: {
              statusCode: response.statusCode,
              statusText: response.statusMessage,
              body: Buffer.concat(chunks, responseBytes).toString('utf8')
            }
          })
        })
      })

      const body = params.method === 'POST' || params.method === 'PUT' ? params.body : undefined
      request.end(body)
    })
  }

  async setCookie(params: NetworkSetCookieParams, caller: CallerIdentity): Promise<{ success: true }> {
    const details: CookiesSetDetails = {
      url: this.#cookieUrl(params),
      name: params.name,
      value: params.value
    }
    if (params.domain !== undefined) details.domain = params.domain
    if (params.path !== undefined) details.path = params.path
    if (params.secure !== undefined) details.secure = params.secure
    if (params.httpOnly !== undefined) details.httpOnly = params.httpOnly
    if (params.expirationDate !== undefined) details.expirationDate = params.expirationDate
    if (params.sameSite !== undefined) details.sameSite = params.sameSite
    try {
      await this.#requireSession(caller).cookies.set(details)
      return { success: true }
    } catch (error) {
      throw networkFailure(error)
    }
  }

  async getCookie(params: NetworkGetCookieParams, caller: CallerIdentity): Promise<Electron.Cookie[]> {
    try {
      return await this.#requireSession(caller).cookies.get({ url: params.url })
    } catch (error) {
      throw networkFailure(error)
    }
  }

  async clearCookies(caller: CallerIdentity): Promise<{ success: true }> {
    try {
      await this.#requireSession(caller).clearStorageData({ storages: ['cookies'] })
      return { success: true }
    } catch (error) {
      throw networkFailure(error)
    }
  }

  async setProxy(params: NetworkSetProxyParams, caller: CallerIdentity): Promise<{ success: true }> {
    const callerSession = this.#requireSession(caller)
    try {
      await callerSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `${params.host}:${params.port}`
      })
      if ((params.username ?? '') !== '' || (params.password ?? '') !== '') {
        this.#proxyCredentials.set(callerSession, {
          username: params.username ?? '',
          password: params.password ?? ''
        })
      } else {
        this.#proxyCredentials.delete(callerSession)
      }
      await callerSession.closeAllConnections()
      return { success: true }
    } catch (error) {
      throw networkFailure(error)
    }
  }

  async downloadRef(params: DownloadReferenceParams, caller: CallerIdentity, signal: AbortSignal): Promise<{
    success: true; grantId: string; size: number; statusCode: number; statusText: string
  }> {
    const grants = this.#requirePathGrants()
    try {
      this.#throwIfAborted(signal)
      requireRedirectUrl(params.url)
      grants.saveReference(caller.webContentsId, params.saveGrantId)
      const response = await this.#fetchDownload(params, caller, signal)
      return await persistAnchoredDownload({ response, owner: caller.webContentsId, saveGrantId: params.saveGrantId,
        grants, signal, maxBytes: this.#maxDownloadBytes, ...(params.replace === undefined ? {} : { replace: params.replace }) })
    } catch (error) {
      if (error instanceof ZToolsError && (error.code === errorCodes.fileWriteOutcomeUnknown || error.code === errorCodes.fileStagingRetained)) throw error
      if (signal.aborted) throw abortFailure(signal.reason)
      throw networkFailure(error)
    }
  }

  async uploadRef(params: UploadReferenceParams, caller: CallerIdentity, signal: AbortSignal): Promise<{
    success: true; data: { statusCode: number; statusText: string; body: string }
  }> {
    const grants = this.#requirePathGrants()
    try {
      this.#throwIfAborted(signal)
      requireRedirectUrl(params.url)
      const reference = grants.readReference(caller.webContentsId, params.fileGrantId)
      const metadata = await grants.describe(caller.webContentsId, params.fileGrantId, signal)
      if (metadata.isDirectory || metadata.size > this.#maxUploadBytes) throw new ZToolsError(errorCodes.fileTooLarge, '上传文件超过大小上限')
      const data = await grants.read(caller.webContentsId, params.fileGrantId, '', this.#maxUploadBytes, signal)
      const after = await grants.describe(caller.webContentsId, params.fileGrantId, signal)
      if (data.length !== metadata.size || after.size !== metadata.size || after.lastModifiedMs !== metadata.lastModifiedMs) {
        throw new ZToolsError(errorCodes.fileError, '上传源文件在读取期间发生变化')
      }
      this.#throwIfAborted(signal)
      const form = new FormData()
      form.append(params.fieldName ?? 'file', new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }), reference.displayName)
      const response = await this.#transferFetch(this.#requireSession(caller), params.url, {
        method: 'POST', redirect: 'error', credentials: 'include', signal, body: form,
        ...(params.headers === undefined ? {} : { headers: params.headers })
      })
      const body = await this.#readResponseBody(response, signal)
      if (response.status < 200 || response.status >= 300) throw new ZToolsError(errorCodes.networkError, '上传请求返回非成功HTTP状态')
      return { success: true, data: { statusCode: response.status, statusText: response.statusText, body } }
    } catch (error) {
      if (signal.aborted) throw abortFailure(signal.reason)
      throw networkFailure(error)
    }
  }

  async download(
    params: NetworkTransferParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; path: string; size: number; statusCode: number; statusText: string }> {
    const files = this.#requireFileService()
    const target = await files.resolveAuthorizedPath(params.savePath ?? '', caller, 'write', true)
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.download`)
    let handle: fs.FileHandle | undefined
    try {
      this.#throwIfAborted(signal)
      const response = await this.#fetchDownload(params, caller, signal)
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel()
        throw new ZToolsError(errorCodes.networkError, `下载请求返回 HTTP ${response.status}`)
      }
      const declaredSize = this.#contentLength(response)
      if (declaredSize !== undefined && declaredSize > this.#maxDownloadBytes) {
        await response.body?.cancel()
        throw new ZToolsError(errorCodes.responseTooLarge, '下载文件超过 1 GiB 上限')
      }
      if (!response.body) throw new ZToolsError(errorCodes.networkError, '下载响应没有正文')

      await fs.mkdir(path.dirname(target), { recursive: true })
      handle = await fs.open(temporary, 'wx')
      let size = 0
      for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
        this.#throwIfAborted(signal)
        const chunk = Buffer.from(value)
        size += chunk.byteLength
        if (size > this.#maxDownloadBytes) {
          throw new ZToolsError(errorCodes.responseTooLarge, '下载文件超过 1 GiB 上限')
        }
        await handle.write(chunk)
      }
      this.#throwIfAborted(signal)
      await handle.close()
      handle = undefined
      await replaceFile(temporary, target)
      return {
        success: true,
        path: target,
        size,
        statusCode: response.status,
        statusText: response.statusText
      }
    } catch (error) {
      if (signal.aborted) throw abortFailure(signal.reason)
      throw networkFailure(error)
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async upload(
    params: NetworkTransferParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: { statusCode: number; statusText: string; body: string } }> {
    const files = this.#requireFileService()
    const source = await files.resolveAuthorizedPath(params.filePath ?? '', caller, 'read', false)
    let handle: fs.FileHandle | undefined
    try {
      this.#throwIfAborted(signal)
      handle = await fs.open(source, 'r')
      const stats = await handle.stat()
      if (!stats.isFile()) throw new ZToolsError(errorCodes.fileError, '上传目标不是文件')
      if (stats.size > this.#maxUploadBytes) {
        throw new ZToolsError(errorCodes.fileTooLarge, '上传文件超过 16 MiB 上限')
      }
      const data = await handle.readFile()
      await handle.close()
      handle = undefined
      this.#throwIfAborted(signal)

      const form = new FormData()
      form.append(
        params.fieldName ?? 'file',
        new Blob([new Uint8Array(data)], { type: 'application/octet-stream' }),
        path.basename(source)
      )
      const response = await this.#transferFetch(this.#requireSession(caller), params.url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'include',
        signal,
        body: form,
        ...(params.headers === undefined ? {} : { headers: params.headers })
      })
      const body = await this.#readResponseBody(response, signal)
      if (response.status < 200 || response.status >= 300) {
        throw new ZToolsError(errorCodes.networkError, `上传请求返回 HTTP ${response.status}`)
      }
      return {
        success: true,
        data: { statusCode: response.status, statusText: response.statusText, body }
      }
    } catch (error) {
      if (signal.aborted) throw abortFailure(signal.reason)
      throw networkFailure(error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async #fetchDownload(
    params: NetworkTransferParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<Response> {
    const callerSession = this.#requireSession(caller)
    let currentUrl = new URL(params.url)
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      this.#throwIfAborted(signal)
      const response = await this.#transferFetch(callerSession, currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
        signal,
        ...(params.headers === undefined ? {} : { headers: params.headers })
      })
      if (response.status < 300 || response.status >= 400) return response
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new ZToolsError(errorCodes.networkError, '重定向响应缺少 Location')
      if (redirects === MAX_REDIRECTS) {
        throw new ZToolsError(errorCodes.networkError, 'HTTP 重定向次数超过上限')
      }
      const nextUrl = requireRedirectUrl(new URL(location, currentUrl).href)
      if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
        throw new ZToolsError(errorCodes.networkError, '拒绝 HTTPS 降级重定向')
      }
      const hasSensitiveHeaders = Object.keys(params.headers ?? {}).some((name) =>
        name.toLowerCase() === 'authorization' || name.toLowerCase() === 'cookie'
      )
      if (currentUrl.origin !== nextUrl.origin && hasSensitiveHeaders) {
        throw new ZToolsError(errorCodes.networkError, '拒绝携带敏感请求头的跨源重定向')
      }
      currentUrl = nextUrl
    }
    throw new ZToolsError(errorCodes.networkError, 'HTTP 重定向状态异常')
  }

  async #readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) return ''
    const chunks: Buffer[] = []
    let size = 0
    for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
      this.#throwIfAborted(signal)
      const chunk = Buffer.from(value)
      size += chunk.byteLength
      if (size > this.#maxResponseBytes) {
        throw new ZToolsError(errorCodes.responseTooLarge, 'HTTP 响应体超过 16 MiB 上限')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  }

  #contentLength(response: Response): number | undefined {
    const value = response.headers.get('content-length')
    if (value === null || !/^\d+$/.test(value)) return undefined
    const size = Number(value)
    return Number.isSafeInteger(size) ? size : undefined
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortFailure(signal.reason)
  }

  #requirePathGrants(): NonNullable<NetworkServiceOptions['pathGrants']> {
    if (!this.#pathGrants) throw new ZToolsError(errorCodes.notSupported, '原生文件引用传输尚未初始化')
    return this.#pathGrants
  }

  #requireFileService(): FileSystemService {
    if (!this.#fileService) throw new ZToolsError(errorCodes.internalError, '文件服务未初始化')
    return this.#fileService
  }

  #requireSession(caller: CallerIdentity): Session {
    const callerSession = this.#sessionResolver(caller)
    if (!callerSession) {
      throw new ZToolsError(errorCodes.callerDestroyed, '调用者窗口已销毁')
    }
    return callerSession
  }

  #cookieUrl(params: NetworkSetCookieParams): string {
    if (params.url !== undefined) return params.url
    const hostname = (params.domain ?? '').replace(/^\./, '')
    return `https://${hostname}${params.path ?? '/'}`
  }
}
