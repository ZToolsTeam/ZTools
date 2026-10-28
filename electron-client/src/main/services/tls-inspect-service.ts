import tls from 'node:tls'
import { isIP } from 'node:net'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { validateTlsInspectRequest, type TlsInspectRequest, type TlsInspection, type TlsCertificateSummary } from '../../contracts/tls-inspect.js'

type Inspect = Extract<TlsInspectRequest, { action: 'inspect' }>
export type TlsConnect = (options: tls.ConnectionOptions) => tls.TLSSocket
const text = (value: unknown, max = 8192): string => {
  const result = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : ''
  if (result.length > max) throw new Error('证书字段超过可显示的大小限制')
  return result
}
function summary(cert: tls.PeerCertificate): TlsCertificateSummary {
  if (!cert.raw?.length || cert.raw.length > 512 * 1024 || !Number.isFinite(Date.parse(cert.valid_from)) || !Number.isFinite(Date.parse(cert.valid_to))) throw new Error('对端证书内容或有效期无效')
  const issuerName = Object.entries(cert.issuer ?? {}).map(([key, value]) => `${key}=${text(value)}`).join(', ')
  return { subjectCN: text(cert.subject?.CN), issuerName: text(issuerName), validFrom: cert.valid_from, validTo: cert.valid_to, serialNumber: text(cert.serialNumber, 256), fingerprint256: text(cert.fingerprint256, 256) }
}
/** 只完成握手并读取公开证书，不发送 HTTP、认证信息或应用数据。 */
export function inspectTls(request: Inspect, signal: AbortSignal, connect: TlsConnect = tls.connect): Promise<TlsInspection> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let socket: tls.TLSSocket | undefined, settled = false
    const finish = (error?: Error, result?: TlsInspection) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket?.destroy()
      if (error) reject(error); else if (result) resolve(result); else reject(new Error('证书探测没有返回结果'))
    }
    const abort = () => finish(new Error('证书探测已取消'))
    const timer = setTimeout(() => finish(new Error('TLS 握手超时，请检查域名、端口或网络连接')), request.timeoutMs ?? 6000)
    signal.addEventListener('abort', abort, { once: true })
    try {
      // 诊断需显示过期/自签名证书；是否可信单独返回，不把握手成功当成验证成功。
      socket = connect({ host: request.domain, port: request.port ?? 443, servername: isIP(request.domain) ? undefined : request.domain, rejectUnauthorized: false })
      socket.once('error', error => finish(new Error(`TLS 连接失败：${error.message.slice(0, 1000)}`)))
      socket.once('close', () => { if (!settled) finish(new Error('TLS 连接在证书读取前关闭')) })
      socket.once('secureConnect', () => {
        try {
          if (!socket) throw new Error('TLS 连接已不可用')
          const cert = socket.getPeerCertificate(true), leaf = summary(cert), protocol = socket.getProtocol()
          if (!protocol || !leaf.fingerprint256) throw new Error('TLS 协议或证书指纹未返回')
          const chain: TlsCertificateSummary[] = [], seen = new Set<string>()
          let current: tls.DetailedPeerCertificate | undefined = cert, chainTruncated = false
          while (current?.raw?.length && !seen.has(current.fingerprint256)) {
            if (chain.length === 8) { chainTruncated = true; break }
            const entry = summary(current); seen.add(entry.fingerprint256); chain.push(entry); current = current.issuerCertificate
          }
          finish(undefined, { ...leaf, domain: request.domain, port: request.port ?? 443, protocol,
            subjectAltName: text(cert.subjectaltname, 32768), authorized: socket.authorized === true,
            authorizationError: socket.authorized ? '' : text(String(socket.authorizationError || '证书信任验证未通过')),
            hostnameMatches: !tls.checkServerIdentity(request.domain, cert), chain, chainTruncated })
        } catch (error) { finish(error instanceof Error ? error : new Error('证书解析失败')) }
      })
      if (signal.aborted) abort()
    } catch (error) { finish(error instanceof Error ? error : new Error('TLS 连接无法启动')) }
  })
}

type Operation = { window: number; controller: AbortController; task: Promise<TlsInspection> }
export class TlsInspectService {
  #active = new Map<string, Operation>(); #stopped = false
  constructor(private readonly connect: TlsConnect = tls.connect) {}
  closeOwner(window: number) { for (const operation of this.#active.values()) if (operation.window === window) operation.controller.abort() }
  async stop() {
    this.#stopped = true
    const operations = [...this.#active.values()]
    for (const operation of operations) operation.controller.abort()
    await Promise.allSettled(operations.map(operation => operation.task))
  }
  async handle(request: unknown, caller: CallerIdentity, signal: AbortSignal) {
    try {
      validateTlsInspectRequest(request); signal.throwIfAborted()
      if (this.#stopped) throw new Error('证书探测服务已停止')
      const key = JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId, request.operationId])
      if (request.action === 'cancel') {
        const operation = this.#active.get(key)
        if (operation) { operation.controller.abort(); await Promise.allSettled([operation.task]) }
        return { success: true, cancelled: !!operation }
      }
      if (this.#active.has(key) || this.#active.size >= 8) throw new Error('证书探测请求过多，请稍候再试')
      const controller = new AbortController(), combined = AbortSignal.any([controller.signal, signal])
      const task = inspectTls(request, combined, this.connect)
      this.#active.set(key, { window: caller.webContentsId, controller, task })
      try { const cert = await task; combined.throwIfAborted(); return { success: true, cert } }
      finally { this.#active.delete(key) }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostError, (error instanceof Error ? error.message : '证书探测失败').slice(0, 2000))
    }
  }
}
