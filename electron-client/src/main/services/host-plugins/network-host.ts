import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import { errorCodes } from '../../../contracts/errors.js'
import { DEFAULT_LOCALE, getResolvedLocale, t, type SupportedLocale } from '../../i18n/index.js'
import {
  calculateDirectorySize,
  escapeHtml,
  fileUrlToLocalPath,
  formatBytes,
  guessMimeType,
  hostPluginError,
  isAccessDeniedCommandResult,
  resolveHostErrorMessage,
  resolveHostSystemCommands,
  type HostPluginContext,
  type HostSystemCommands,
  type LanShareServerState
} from './shared-utils.js'

/** TCP 连通探测结果：ok 为能否建立连接，latencyMs 为建立连接（或放弃）所用毫秒数 */
type TcpProbe = (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; latencyMs: number }>

/**
 * 按 HTTP Accept-Language 协商局域网共享页面语言；
 * 请求头缺失、为空或仅包含通配符 `*` 时回退到主进程当前已解析的 locale。
 */
export function resolveLanShareLocale(acceptLanguage?: string | readonly string[]): SupportedLocale {
  const raw = typeof acceptLanguage === 'string'
    ? acceptLanguage
    : Array.isArray(acceptLanguage)
      ? acceptLanguage.join(',')
      : ''
  const trimmed = raw.trim()
  if (!trimmed) return getResolvedLocale()

  const candidates: Array<{ tag: string; q: number; order: number }> = []
  const parts = trimmed.split(',')
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]?.trim()
    if (!segment) continue
    const [rawTag, ...params] = segment.split(';')
    const tag = rawTag?.trim().toLowerCase().replaceAll('_', '-') ?? ''
    if (!tag || tag === '*') continue
    let q = 1
    let invalidWeight = false
    for (const param of params) {
      const [key, val] = param.split('=').map((item: string) => item.trim().toLowerCase())
      if (key === 'q') {
        const parsed = Number(val)
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
          invalidWeight = true
          break
        }
        q = parsed
      }
    }
    if (invalidWeight) continue
    candidates.push({ tag, q, order: index })
  }

  if (candidates.length === 0) return getResolvedLocale()
  candidates.sort((a, b) => (b.q - a.q) || (a.order - b.order))

  for (const candidate of candidates) {
    if (candidate.tag === 'zh' || candidate.tag.startsWith('zh-')) {
      return 'zh-CN'
    }
    if (candidate.tag === 'en' || candidate.tag.startsWith('en-')) {
      return 'en-US'
    }
  }
  return DEFAULT_LOCALE
}

export function renderLanShareHtml(
  files: ReadonlyArray<{ id: string; name: string; size: number; shared?: boolean }>,
  locale: SupportedLocale
): string {
  const visibleFiles = files.filter((file) => file.shared !== false)
  const pageTitle = escapeHtml(t('lanShare.pageTitle', undefined, locale))
  const heading = escapeHtml(t('lanShare.heading', undefined, locale))
  const colName = escapeHtml(t('lanShare.colName', undefined, locale))
  const colSize = escapeHtml(t('lanShare.colSize', undefined, locale))
  const colAction = escapeHtml(t('lanShare.colAction', undefined, locale))
  const downloadLabel = escapeHtml(t('lanShare.download', undefined, locale))
  const emptyText = escapeHtml(t('lanShare.empty', undefined, locale))

  const rows = visibleFiles
    .map((file) => {
      const href = `/download/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`
      return `<tr><td><a href="${href}">${escapeHtml(file.name)}</a></td><td>${escapeHtml(formatBytes(file.size))}</td><td><a class="dl" href="${href}">${downloadLabel}</a></td></tr>`
    })
    .join('')

  const bodyContent = rows
    ? `<table><thead><tr><th>${colName}</th><th>${colSize}</th><th>${colAction}</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="empty">${emptyText}</p>`

  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle}</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:24px;max-width:760px;margin:0 auto}a{color:#60a5fa;text-decoration:none}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #27272a}th{font-weight:600;opacity:.75}.dl{font-weight:500}.empty{padding:24px 0;opacity:.7}</style></head><body><h2>${heading}</h2>${bodyContent}</body></html>`
}

/** 网络处理器的系统依赖：生产用真实实现，测试经构造参数注入替身（插件调用参数无法切换） */
export interface NetworkHostDeps extends HostSystemCommands {
  probeTcp: TcpProbe
  lookupDns: (hostname: string) => Promise<{ address: string }>
  /** 系统 hosts 文件路径（旧接口只读取）；未注入时按当前平台取系统路径 */
  hostsPath: string | undefined
}

export class NetworkHostPluginHandler {
  readonly #ctx: HostPluginContext
  readonly #sys: HostSystemCommands
  readonly #probeTcp: TcpProbe
  readonly #lookupDns: NetworkHostDeps['lookupDns']
  readonly #hostsPathOverride: string | undefined
  #lanShareStarting: Promise<void> | null = null
  readonly #lanShare: LanShareServerState = {
    server: null,
    port: 0,
    pin: String(crypto.randomInt(1000, 10000)),
    requirePin: false,
    sharedFiles: new Map(),
    activeTransfers: 0,
    totalClientRequests: 0,
    uploadDir: path.join(os.homedir(), 'Downloads')
  }
  readonly #downloadTasks = new Map<
    string,
    {
      id: string
      url: string
      fileName: string
      savePath: string
      status: 'completed' | 'downloading' | 'paused' | 'failed'
      totalBytes: number
      downloadedBytes: number
      createdAt: string
      error?: string
    }
  >()

  constructor(ctx: HostPluginContext, deps: Partial<NetworkHostDeps> = {}) {
    this.#ctx = ctx
    this.#sys = resolveHostSystemCommands(deps)
    this.#probeTcp = deps.probeTcp ?? ((host, port, timeoutMs) => this.#probeTcpEndpoint(host, port, timeoutMs))
    this.#lookupDns = deps.lookupDns ?? (hostname => dns.lookup(hostname))
    this.#hostsPathOverride = deps.hostsPath
  }

  async stop(): Promise<void> {
    if (this.#lanShare.server) {
      await new Promise<void>((resolve) => {
        this.#lanShare.server?.close(() => resolve())
      })
      this.#lanShare.server = null
      this.#lanShare.port = 0
    }
  }

  #buildLanShareStatus(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const nets = os.networkInterfaces()
    const interfaces: Array<{ name: string; address: string; family: string; internal: boolean }> = []
    for (const [name, addrs] of Object.entries(nets)) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          interfaces.push({ name, address: addr.address, family: 'IPv4', internal: false })
        }
      }
    }
    if (interfaces.length === 0) {
      interfaces.push({ name: 'Loopback', address: '127.0.0.1', family: 'IPv4', internal: true })
    }
    const primaryIp = interfaces[0]?.address ?? '127.0.0.1'
    const port = this.#lanShare.port || 8765
    const running = Boolean(this.#lanShare.server)
    const sharedFiles = Array.from(this.#lanShare.sharedFiles.values())
    const totalClientRequests = this.#lanShare.totalClientRequests ?? 0
    return {
      ok: true,
      success: true,
      interfaces,
      lanIp: primaryIp,
      primaryIp,
      port,
      running,
      pin: this.#lanShare.pin,
      requirePin: this.#lanShare.requirePin,
      url: `http://${primaryIp}:${port}`,
      files: sharedFiles,
      sharedFiles,
      totalClientRequests,
      ...extra
    }
  }

  async handleLanShare(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'getnetworkinterfaces' ||
      lowerFn === 'getlocalips' ||
      lowerFn === 'getlansharestatus' ||
      lowerFn === 'getstatus' ||
      lowerFn === 'status'
    ) {
      return this.#buildLanShareStatus()
    }

    if (lowerFn === 'startshareserver' || lowerFn === 'startserver' || lowerFn === 'start') {
      if (typeof params.requirePin === 'boolean') {
        this.#lanShare.requirePin = params.requirePin
      }
      if (typeof params.pin === 'string' && params.pin.trim()) {
        this.#lanShare.pin = params.pin.trim()
      }
      if (typeof params.uploadDir === 'string' && params.uploadDir.trim()) {
        const resolvedUploadDir = await this.#ctx.authorizeOutputPath(params.uploadDir, caller)
        await fs.mkdir(resolvedUploadDir, { recursive: true })
        this.#lanShare.uploadDir = resolvedUploadDir
      }
      if (Array.isArray(params.files) || Array.isArray(params.paths) || typeof params.path === 'string') {
        await this.#ingestSharedFiles(params, caller, false)
      }
      const preferredPort = Number(params.port) || this.#lanShare.port || 8765
      if (!this.#lanShare.server) {
        await this.#startLanHttpServer(preferredPort)
      }
      return this.#buildLanShareStatus()
    }

    if (lowerFn === 'stopshareserver' || lowerFn === 'stopserver' || lowerFn === 'stop') {
      await this.stop()
      return this.#buildLanShareStatus({ running: false })
    }

    if (
      lowerFn === 'syncsharefiles' ||
      lowerFn === 'addsharedfile' ||
      lowerFn === 'addfiles' ||
      lowerFn === 'sharefiles'
    ) {
      const replaceExisting = lowerFn === 'syncsharefiles' && Array.isArray(params.files)
      const added = await this.#ingestSharedFiles(params, caller, replaceExisting)
      if (!this.#lanShare.server && lowerFn !== 'syncsharefiles') {
        await this.#startLanHttpServer(Number(params.port) || this.#lanShare.port || 8765)
      }
      return this.#buildLanShareStatus({ added })
    }

    if (lowerFn === 'togglefileshare') {
      const targetId = typeof params.id === 'string' ? params.id.trim() : ''
      const targetPath = typeof params.path === 'string' ? params.path.trim() : ''
      let matchedKey: string | null = null
      if (targetId && this.#lanShare.sharedFiles.has(targetId)) {
        matchedKey = targetId
      } else {
        for (const [k, entry] of this.#lanShare.sharedFiles.entries()) {
          if (
            (targetId && entry.id === targetId) ||
            (targetPath && (entry.path === targetPath || path.resolve(entry.path) === path.resolve(targetPath)))
          ) {
            matchedKey = k
            break
          }
        }
      }
      if (!matchedKey) {
        return {
          ok: false,
          success: false,
          errorCode: 'FILE_NOT_FOUND', error: t('hostPlugin.network.shareFileNotFound', { target: targetId || targetPath || 'unknown' })
        }
      }
      const existing = this.#lanShare.sharedFiles.get(matchedKey)!
      const nextShared = params.shared !== undefined ? Boolean(params.shared) : existing.shared === false
      const updated = { ...existing, shared: nextShared }
      this.#lanShare.sharedFiles.set(matchedKey, updated)
      return this.#buildLanShareStatus({ updatedFile: updated })
    }

    if (lowerFn === 'removesharedfile' || lowerFn === 'removefile' || lowerFn === 'clearfiles') {
      if (lowerFn === 'clearfiles') {
        this.#lanShare.sharedFiles.clear()
      } else {
        const id = String(params.id ?? params.fileId ?? '')
        this.#lanShare.sharedFiles.delete(id)
      }
      return this.#buildLanShareStatus()
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported LanSharePlugin function: ${fn}`
    }
  }

  async #ingestSharedFiles(
    params: Record<string, unknown>,
    caller: CallerIdentity | undefined,
    replaceExisting: boolean
  ): Promise<Array<Record<string, unknown>>> {
    if (replaceExisting) {
      this.#lanShare.sharedFiles.clear()
    }
    const added: Array<Record<string, unknown>> = []

    if (Array.isArray(params.files)) {
      for (const rawItem of params.files) {
        if (!rawItem || typeof rawItem !== 'object') continue
        const obj = rawItem as Record<string, unknown>
        const rawPath = String(obj.path ?? '').trim()
        if (!rawPath) continue
        try {
          const resolved = await this.#ctx.authorizeExistingPath(rawPath, caller, 'read')
          if (!fsSync.existsSync(resolved)) continue
          const stat = await fs.stat(resolved)
          const id =
            typeof obj.id === 'string' && obj.id.trim()
              ? obj.id.trim()
              : crypto.createHash('md5').update(resolved).digest('hex').slice(0, 10)
          const computedSize = stat.isDirectory()
            ? (await calculateDirectorySize(resolved, 2)).totalBytes
            : stat.size
          const item = {
            id,
            name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : path.basename(resolved),
            path: resolved,
            size: computedSize,
            sizeBytes: computedSize,
            shared: obj.shared !== undefined ? Boolean(obj.shared) : true,
            isDirectory: stat.isDirectory(),
            addedAt: new Date().toISOString()
          }
          this.#lanShare.sharedFiles.set(id, item)
          added.push(item)
        } catch {
          // ignore inaccessible or unauthorized path
        }
      }
    }

    const rawPaths = Array.isArray(params.paths)
      ? params.paths.map(String)
      : typeof params.path === 'string'
        ? [params.path]
        : []
    for (const p of rawPaths) {
      try {
        const resolved = await this.#ctx.authorizeExistingPath(p, caller, 'read')
        if (!fsSync.existsSync(resolved)) continue
        const stat = await fs.stat(resolved)
        const id = crypto.createHash('md5').update(resolved).digest('hex').slice(0, 10)
        const computedSize = stat.isDirectory()
          ? (await calculateDirectorySize(resolved, 2)).totalBytes
          : stat.size
        const item = {
          id,
          name: path.basename(resolved),
          path: resolved,
          size: computedSize,
          sizeBytes: computedSize,
          shared: true,
          isDirectory: stat.isDirectory(),
          addedAt: new Date().toISOString()
        }
        this.#lanShare.sharedFiles.set(id, item)
        added.push(item)
      } catch {
        // ignore inaccessible or unauthorized path
      }
    }

    return added
  }

  async #startLanHttpServer(preferredPort: number): Promise<void> {
    if (this.#lanShare.server) return
    if (this.#lanShareStarting) {
      await this.#lanShareStarting
      return
    }

    this.#lanShareStarting = (async () => {
      if (this.#lanShare.server) return

      const server = http.createServer(async (req, res) => {
        this.#lanShare.totalClientRequests = (this.#lanShare.totalClientRequests ?? 0) + 1
        try {
          const locale = resolveLanShareLocale(req.headers['accept-language'])
          const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
          if (this.#lanShare.requirePin) {
            const pinParam = reqUrl.searchParams.get('pin') ?? req.headers['x-ztools-pin']
            if (pinParam !== this.#lanShare.pin) {
              res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end(t('lanShare.pinRequired', undefined, locale))
              return
            }
          }

          if (reqUrl.pathname === '/api/files') {
            const files = Array.from(this.#lanShare.sharedFiles.values())
              .filter((f) => f.shared !== false)
              .map((f) => ({
                id: f.id,
                name: f.name,
                size: f.size,
                sizeBytes: f.size,
                sizeText: formatBytes(f.size),
                shared: f.shared !== false,
                isDirectory: f.isDirectory,
                downloadUrl: `/download/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`
              }))
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, files }))
            return
          }

          if (reqUrl.pathname.startsWith('/download/') || reqUrl.pathname.startsWith('/dl/')) {
            const parts = reqUrl.pathname.split('/').filter(Boolean)
            const fileIdOrIdx = decodeURIComponent(parts[1] ?? '')
            const fileNameParam = decodeURIComponent(parts[2] ?? '')
            let descriptor = this.#lanShare.sharedFiles.get(fileIdOrIdx)
            if (!descriptor) {
              const allEntries = Array.from(this.#lanShare.sharedFiles.values())
              if (/^\d+$/.test(fileIdOrIdx)) {
                const idx = Number(fileIdOrIdx)
                descriptor = allEntries[idx] ?? allEntries[idx - 1]
              }
              if (!descriptor && fileNameParam) {
                descriptor = allEntries.find((f) => f.id === fileIdOrIdx || f.name === fileNameParam)
              }
            }

            if (descriptor && descriptor.shared === false) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end(t('lanShare.fileDisabled', undefined, locale))
              return
            }

            if (!descriptor || descriptor.isDirectory || !fsSync.existsSync(descriptor.path)) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end(t('lanShare.fileNotFound', undefined, locale))
              return
            }
            const stat = await fs.stat(descriptor.path)
            const ext = path.extname(descriptor.name).toLowerCase()
            const mime = guessMimeType(ext)
            res.writeHead(200, {
              'Content-Type': mime,
              'Content-Length': String(stat.size),
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`
            })
            this.#lanShare.activeTransfers += 1
            let transferSettled = false
            const finalizeTransfer = () => {
              if (transferSettled) return
              transferSettled = true
              this.#lanShare.activeTransfers = Math.max(0, this.#lanShare.activeTransfers - 1)
            }
            const stream = fsSync.createReadStream(descriptor.path)
            stream.on('close', finalizeTransfer)
            stream.on('error', (streamErr) => {
              finalizeTransfer()
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end(streamErr.message || 'File read error')
              } else {
                res.destroy(streamErr)
              }
            })
            stream.pipe(res)
            return
          }

          const html = renderLanShareHtml(Array.from(this.#lanShare.sharedFiles.values()), locale)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(html)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(err instanceof Error ? err.message : 'Internal Server Error')
        }
      })

      await new Promise<void>((resolve, reject) => {
        const onPreferredError = () => {
          server.once('error', (fallbackErr) => reject(fallbackErr))
          server.listen(0, '0.0.0.0', () => resolve())
        }
        server.once('error', onPreferredError)
        server.listen(preferredPort, '0.0.0.0', () => {
          server.removeListener('error', onPreferredError)
          resolve()
        })
      })
      server.on('error', () => {
        // Prevent unhandled error event after server has started listening
      })
      const addr = server.address()
      this.#lanShare.server = server
      this.#lanShare.port = typeof addr === 'object' && addr ? addr.port : preferredPort
    })()

    try {
      await this.#lanShareStarting
    } finally {
      this.#lanShareStarting = null
    }
  }

  static #parseLinkSpeedMbps(linkSpeed: unknown): number {
    if (typeof linkSpeed === 'number' && Number.isFinite(linkSpeed)) {
      return linkSpeed
    }
    const raw = String(linkSpeed ?? '').trim()
    if (!raw) return 0
    const m = raw.match(/([\d.]+)\s*(gbps|mbps|kbps|bps)/i)
    if (m?.[1] && m[2]) {
      const val = parseFloat(m[1])
      const unit = m[2].toLowerCase()
      if (unit === 'gbps') return Math.round(val * 1000)
      if (unit === 'mbps') return Math.round(val)
      // 不足 1 Mbps 的正速率记为 1；已禁用、未连接的网卡报 “0 bps”，不能显示成 1 Mbps
      if (unit === 'kbps') return val > 0 ? Math.max(1, Math.round(val / 1000)) : 0
      if (unit === 'bps') return val > 0 ? Math.max(1, Math.round(val / 1_000_000)) : 0
    }
    const num = Number(raw)
    return Number.isFinite(num) ? num : 0
  }

  static #parseDnsServers(dnsVal: unknown): string[] {
    if (Array.isArray(dnsVal)) {
      return dnsVal.map((item) => String(item ?? '').trim()).filter(Boolean)
    }
    if (typeof dnsVal === 'string') {
      return dnsVal
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
    return []
  }

  async handleNetworkAdapter(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'getadapters' || lowerFn === 'listadapters' || lowerFn === 'getnetworkinterfaces') {
      const osNets = os.networkInterfaces()
      const adapters: Array<Record<string, unknown>> = []

      if (process.platform === 'win32') {
        // Get-NetAdapter 本身失败（CIM 损坏、被策略禁止）必须报错，不能退回填充数据；单块网卡读不到 IP 配置属正常，字段留空
        const psScript = `
          $netAdapters = @(Get-NetAdapter -ErrorAction Stop)
          $list = @($netAdapters | ForEach-Object {
            $ifIndex = $_.ifIndex
            $ipInfo = Get-NetIPConfiguration -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
            $ipv4 = ($ipInfo.IPv4Address | Select-Object -First 1).IPAddress
            $prefix = ($ipInfo.IPv4Address | Select-Object -First 1).PrefixLength
            $gw = ($ipInfo.IPv4DefaultGateway | Select-Object -First 1).NextHop
            $dnsList = @($ipInfo.DnsServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses } | Where-Object { $_ })
            $dns = $dnsList -join ', '
            [PSCustomObject]@{
              id = $_.Name
              name = $_.Name
              description = $_.InterfaceDescription
              status = $_.Status
              mac = $_.MacAddress
              linkSpeed = $_.LinkSpeed
              ipv4 = if ($ipv4) { $ipv4 } else { '' }
              prefixLength = if ($prefix) { $prefix } else { 24 }
              gateway = if ($gw) { $gw } else { '' }
              dns = if ($dns) { $dns } else { '' }
              dnsServers = $dnsList
            }
          })
          # Disabled adapters or adapters without IP config emit non-terminating errors in Get-NetIPConfiguration;
          # capture into $list and output separately so the exit code remains 0.
          ConvertTo-Json -InputObject $list -Compress -Depth 4
        `
        let raw: string
        try {
          raw = await this.#sys.runPowerShell(psScript, 10_000, signal)
        } catch (error) {
          return { ok: false, success: false, errorCode: 'ADAPTER_LIST_FAILED', error: t('hostPlugin.network.adapterListFailed', { detail: error instanceof Error ? error.message : String(error) }) }
        }
        {
          let parsed: unknown
          try { parsed = JSON.parse(raw.trim() || '[]') } catch {
            return { ok: false, success: false, errorCode: 'ADAPTER_LIST_FAILED', error: t('hostPlugin.network.adapterListParseFailed') }
          }
          {
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (item && typeof item === 'object') {
                const record = item as Record<string, unknown>
                const dnsServers = NetworkHostPluginHandler.#parseDnsServers(record.dnsServers ?? record.dns)
                const speedMbps = NetworkHostPluginHandler.#parseLinkSpeedMbps(record.linkSpeed)
                adapters.push({
                  ...record,
                  dns: typeof record.dns === 'string' ? record.dns : dnsServers.join(', '),
                  dnsServers,
                  speedMbps
                })
              }
            }
          }
        }
        // Windows 以 Get-NetAdapter 的结果为准：确实没有网卡就返回空列表，不用 os.networkInterfaces() 填充状态与 MAC
        return { ok: true, success: true, adapters }
      }

      if (adapters.length === 0) {
        for (const [name, addrs] of Object.entries(osNets)) {
          const ipv4 = (addrs ?? []).find((a) => a.family === 'IPv4')
          if (!ipv4) continue
          const linkSpeed = t('hostPlugin.network.linkSpeedUnknown')
          adapters.push({
            id: name,
            name,
            description: name,
            status: ipv4.internal ? 'Loopback' : 'Up',
            mac: ipv4.mac || '00:00:00:00:00:00',
            linkSpeed,
            speedMbps: NetworkHostPluginHandler.#parseLinkSpeedMbps(linkSpeed),
            ipv4: ipv4.address,
            netmask: ipv4.netmask,
            gateway: '',
            dns: '',
            dnsServers: []
          })
        }
      }

      return { ok: true, success: true, adapters }
    }

    if (lowerFn === 'flushdns') {
      if (process.platform === 'win32') {
        const res = await this.#sys.runCommand('ipconfig', ['/flushdns'], 10_000, signal)
        return { ok: res.exitCode === 0, success: res.exitCode === 0, output: res.stdout || res.stderr }
      }
      if (process.platform === 'darwin') {
        const res = await this.#sys.runCommand('dscacheutil', ['-flushcache'], 10_000, signal)
        return { ok: res.exitCode === 0, success: res.exitCode === 0, output: res.stdout || res.stderr || 'DNS cache flushed' }
      }
      return { ok: false, success: false, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.flushDnsUnsupported') }
    }

    if (lowerFn === 'setdns' || lowerFn === 'applypreset') {
      const adapterName = String(params.adapterName ?? params.name ?? '').replace(/["']/g, '')
      const primaryDns = String(params.primaryDns ?? params.dns1 ?? '').trim()
      if (!adapterName) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', error: t('hostPlugin.network.adapterNameMissing') }
      }
      if (process.platform === 'win32') {
        const args = primaryDns
          ? ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'static', primaryDns]
          : ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'dhcp']
        const res = await this.#sys.runCommand('netsh', args, 10_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          output: res.stdout || res.stderr,
          ...(res.exitCode !== 0 ? { error: res.stderr || res.stdout || t('hostPlugin.network.setDnsFailed') } : {})
        }
      }
      return { ok: false, success: false, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.netshDnsUnsupported') }
    }

    return this.handleNetworkAdapter('getAdapters', params, signal)
  }

  async #probeTcpEndpoint(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now()
    const ok = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolve(false)
      })
      socket.once('error', () => {
        socket.destroy()
        resolve(false)
      })
      socket.connect(port, host)
    })
    return { ok, latencyMs: Math.max(1, Date.now() - start) }
  }

  async #readWindowsNetworkStatus(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') return { error: t('hostPlugin.network.winNetConfigUnsupported') }
    try {
      const raw = await this.#sys.runPowerShell(String.raw`
        $result = @{}
        try { $result.nlaStatus = (Get-Service -Name NlaSvc -ErrorAction Stop).Status.ToString() }
        catch { $result.nlaError = $_.Exception.Message }
        try { $result.firewallProfiles = @(Get-NetFirewallProfile -ErrorAction Stop | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction) }
        catch { $result.firewallError = $_.Exception.Message }
        try {
          $proxy = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
          $result.proxyEnabled = ($proxy.ProxyEnable -eq 1)
          $result.proxyServer = [string]$proxy.ProxyServer
        } catch { $result.proxyError = $_.Exception.Message }
        ConvertTo-Json -InputObject $result -Compress -Depth 4
      `, 10000, signal)
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw hostPluginError(errorCodes.dataCorrupt, 'hostPlugin.network.winNetConfigInvalid', { hostCode: 'WIN_NET_CONFIG_INVALID' })
      return parsed as Record<string, unknown>
    } catch (err) {
      signal?.throwIfAborted()
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  async handleNetworkRescue(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'diagnose' || lowerFn === 'rundiagnostics' || lowerFn === 'checkall') {
      signal?.throwIfAborted()
      const checks: Array<Record<string, unknown>> = []
      const windowsStatus = await this.#readWindowsNetworkStatus(signal)

      const osNets = os.networkInterfaces()
      const activeIps: string[] = []
      for (const addrs of Object.values(osNets)) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) activeIps.push(a.address)
        }
      }

      // 1. renew-dhcp (网卡与内网 DHCP 分配)
      checks.push({
        id: 'renew-dhcp',
        nameKey: 'hostPlugin.network.diag.dhcp.name',
        categoryKey: 'hostPlugin.network.diag.dhcp.category',
        name: t('hostPlugin.network.diag.dhcp.name'),
        category: t('hostPlugin.network.diag.dhcp.category'),
        status: activeIps.length > 0 ? 'healthy' : 'error',
        detail: activeIps.length > 0 ? t('hostPlugin.network.diag.dhcp.active', { ips: activeIps.join(', ') }) : t('hostPlugin.network.diag.dhcp.none')
      })

      // 2. flush-dns (DNS 解析与缓存)
      const dnsStart = Date.now()
      try {
        const resolved = await this.#lookupDns('www.baidu.com')
        checks.push({
          id: 'flush-dns',
          nameKey: 'hostPlugin.network.diag.dns.name',
          categoryKey: 'hostPlugin.network.diag.dns.category',
          name: t('hostPlugin.network.diag.dns.name'),
          category: t('hostPlugin.network.diag.dns.category'),
          status: 'healthy',
          detail: `www.baidu.com -> ${resolved.address}`,
          latencyMs: Math.max(1, Date.now() - dnsStart)
        })
      } catch (err) {
        checks.push({
          id: 'flush-dns',
          nameKey: 'hostPlugin.network.diag.dns.name',
          categoryKey: 'hostPlugin.network.diag.dns.category',
          name: t('hostPlugin.network.diag.dns.name'),
          category: t('hostPlugin.network.diag.dns.category'),
          status: 'error',
          detail: resolveHostErrorMessage(err, 'hostPlugin.network.diag.dns.failed'),
          latencyMs: Math.max(1, Date.now() - dnsStart)
        })
      }

      // 3. ping-gateway-dns (公网骨干 TCP 连通性)
      const tcpProbe = await this.#probeTcp('223.5.5.5', 53, 3000)
      checks.push({
        id: 'ping-gateway-dns',
        nameKey: 'hostPlugin.network.diag.gateway.name',
        categoryKey: 'hostPlugin.network.diag.gateway.category',
        name: t('hostPlugin.network.diag.gateway.name'),
        category: t('hostPlugin.network.diag.gateway.category'),
        status: tcpProbe.ok ? 'healthy' : 'warning',
        detail: tcpProbe.ok ? t('hostPlugin.network.diag.gateway.ok') : t('hostPlugin.network.diag.gateway.timeout'),
        latencyMs: tcpProbe.latencyMs
      })

      // 4. clear-proxy (系统代理劫持检测)
      const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || ''
      checks.push({
        id: 'clear-proxy',
        nameKey: 'hostPlugin.network.diag.proxy.name',
        categoryKey: 'hostPlugin.network.diag.proxy.category',
        name: t('hostPlugin.network.diag.proxy.name'),
        category: t('hostPlugin.network.diag.proxy.category'),
        status: envProxy || windowsStatus.proxyEnabled === true ? 'warning' : windowsStatus.proxyEnabled === false ? 'healthy' : 'unknown',
        detail: envProxy ? t('hostPlugin.network.diag.proxy.envDetected')
          : windowsStatus.proxyEnabled === true ? t('hostPlugin.network.diag.proxy.enabled', { server: String(windowsStatus.proxyServer || t('hostPlugin.network.diag.proxy.addrMissing')) })
          : windowsStatus.proxyEnabled === false ? t('hostPlugin.network.diag.proxy.disabled')
          : t('hostPlugin.network.diag.proxy.unreadable', { detail: String(windowsStatus.proxyError || windowsStatus.error || t('hostPlugin.network.diag.noValidResult')) })
      })

      // 5. check-hosts (Hosts 规则文件审计)
      const hostsStart = Date.now()
      const hostsPath = this.#hostsPathOverride ?? (
        process.platform === 'win32'
          ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
          : '/etc/hosts')
      let hostsRuleCount = 0
      let hostsReadable = false
      try {
        const rawHosts = await fs.readFile(hostsPath, 'utf8')
        hostsReadable = true
        hostsRuleCount = rawHosts
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#')).length
      } catch {
        hostsReadable = false
      }
      checks.push({
        id: 'check-hosts',
        nameKey: 'hostPlugin.network.diag.hosts.name',
        categoryKey: 'hostPlugin.network.diag.dns.category',
        name: t('hostPlugin.network.diag.hosts.name'),
        category: t('hostPlugin.network.diag.dns.category'),
        status: hostsReadable ? (hostsRuleCount > 50 ? 'warning' : 'healthy') : 'warning',
        detail: hostsReadable ? t('hostPlugin.network.diag.hosts.readable', { count: hostsRuleCount }) : t('hostPlugin.network.diag.hosts.unreadable'),
        latencyMs: Math.max(1, Date.now() - hostsStart)
      })

      // 6. reset-winsock (Winsock 传输层目录状态)
      checks.push({
        id: 'reset-winsock',
        nameKey: 'hostPlugin.network.diag.winsock.name',
        categoryKey: 'hostPlugin.network.diag.winsock.category',
        name: t('hostPlugin.network.diag.winsock.name'),
        category: t('hostPlugin.network.diag.winsock.category'),
        status: 'unknown',
        detail: t('hostPlugin.network.diag.winsock.detail')
      })

      // 7. reset-firewall (系统防火墙策略状态)
      checks.push({
        id: 'reset-firewall',
        nameKey: 'hostPlugin.network.diag.firewall.name',
        categoryKey: 'hostPlugin.network.diag.firewall.category',
        name: t('hostPlugin.network.diag.firewall.name'),
        category: t('hostPlugin.network.diag.firewall.category'),
        status: 'unknown',
        detail: Array.isArray(windowsStatus.firewallProfiles) && windowsStatus.firewallProfiles.length > 0
          ? t('hostPlugin.network.diag.firewall.profilesRead', { count: windowsStatus.firewallProfiles.length })
          : t('hostPlugin.network.diag.firewall.unreadable', { detail: String(windowsStatus.firewallError || windowsStatus.error || t('hostPlugin.network.diag.noValidResult')) })
      })

      // 8. restart-nla (NLA 网络位置感知服务)
      checks.push({
        id: 'restart-nla',
        nameKey: 'hostPlugin.network.diag.nla.name',
        categoryKey: 'hostPlugin.network.diag.nla.category',
        name: t('hostPlugin.network.diag.nla.name'),
        category: t('hostPlugin.network.diag.nla.category'),
        status: windowsStatus.nlaStatus === 'Running' ? 'healthy' : typeof windowsStatus.nlaStatus === 'string' && windowsStatus.nlaStatus ? 'warning' : 'unknown',
        detail: typeof windowsStatus.nlaStatus === 'string' && windowsStatus.nlaStatus
          ? t('hostPlugin.network.diag.nla.status', { status: windowsStatus.nlaStatus })
          : t('hostPlugin.network.diag.nla.unreadable', { detail: String(windowsStatus.nlaError || windowsStatus.error || t('hostPlugin.network.diag.noValidResult')) })
      })

      signal?.throwIfAborted()
      return { ok: true, success: true, checks }
    }

    if (lowerFn === 'repair' || lowerFn === 'executerepair') {
      const targetId = String(params.checkId ?? params.itemId ?? params.id ?? '').toLowerCase().trim()
      if (!targetId) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', error: t('hostPlugin.network.repair.missingCheckId') }
      }

      if (targetId === 'flush-dns') {
        if (process.platform === 'win32') {
          const res = await this.#sys.runCommand('ipconfig', ['/flushdns'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || t('hostPlugin.network.repair.dnsFlushed') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.flushDnsWinFailed') })
          }
        }
        if (process.platform === 'darwin') {
          const res = await this.#sys.runCommand('dscacheutil', ['-flushcache'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? t('hostPlugin.network.repair.dnsFlushedMac') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.flushDnsMacFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.flushDnsUnsupported') }
      }

      if (targetId === 'clear-proxy') {
        if (process.platform === 'win32') {
          const regRes = await this.#sys.runCommand(
            'reg',
            [
              'add',
              'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
              '/v',
              'ProxyEnable',
              '/t',
              'REG_DWORD',
              '/d',
              '0',
              '/f'
            ],
            8_000,
            signal
          )
          const ok = regRes.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: regRes.stdout || regRes.stderr,
            message: ok ? t('hostPlugin.network.repair.proxyDisabledWin') : undefined,
            ...(ok ? {} : { error: regRes.stderr || regRes.stdout || t('hostPlugin.network.repair.proxyClearWinFailed') })
          }
        }
        if (process.platform === 'darwin') {
          const webRes = await this.#sys.runCommand('networksetup', ['-setwebproxystate', 'Wi-Fi', 'off'], 8_000, signal)
          const secRes = await this.#sys.runCommand('networksetup', ['-setsecurewebproxystate', 'Wi-Fi', 'off'], 8_000, signal)
          const ok = webRes.exitCode === 0 && secRes.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: `${webRes.stdout || webRes.stderr}\n${secRes.stdout || secRes.stderr}`.trim(),
            message: ok ? t('hostPlugin.network.repair.proxyDisabledMac') : undefined,
            ...(ok ? {} : { error: webRes.stderr || secRes.stderr || t('hostPlugin.network.repair.proxyClearMacFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.proxyUnsupported') }
      }

      if (targetId === 'reset-winsock') {
        if (process.platform === 'win32') {
          const res = await this.#sys.runCommand('netsh', ['winsock', 'reset'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || t('hostPlugin.network.repair.winsockReset') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.winsockFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.winsockWinOnly') }
      }

      if (targetId === 'check-hosts') {
        const hostsPath =
          process.platform === 'win32'
            ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
            : '/etc/hosts'
        try {
          const content = await fs.readFile(hostsPath, 'utf8')
          const activeLines = content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('#'))
          return {
            ok: true,
            success: true,
            checkId: targetId,
            hostsPath,
            activeRulesCount: activeLines.length,
            output: t('hostPlugin.network.repair.hostsChecked', { count: activeLines.length }),
            message: t('hostPlugin.network.repair.hostsChecked', { count: activeLines.length })
          }
        } catch (err) {
          return {
            ok: false,
            success: false,
            checkId: targetId,
            error: resolveHostErrorMessage(err, 'hostPlugin.network.repair.hostsReadFailed')
          }
        }
      }

      if (targetId === 'renew-dhcp') {
        if (process.platform === 'win32') {
          const res = await this.#sys.runCommand('ipconfig', ['/renew'], 15_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || t('hostPlugin.network.repair.dhcpRenewed') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.dhcpFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.dhcpUnsupported') }
      }

      if (targetId === 'ping-gateway-dns') {
        const probe = await this.#probeTcp('223.5.5.5', 53, 3500)
        if (probe.ok) {
          return {
            ok: true,
            success: true,
            checkId: targetId,
            latencyMs: probe.latencyMs,
            output: t('hostPlugin.network.repair.gatewayOk', { latencyMs: probe.latencyMs }),
            message: t('hostPlugin.network.repair.gatewayOk', { latencyMs: probe.latencyMs })
          }
        }
        try {
          const start = Date.now()
          const resolved = await dns.lookup('www.baidu.com')
          const latencyMs = Math.max(1, Date.now() - start)
          return {
            ok: true,
            success: true,
            checkId: targetId,
            latencyMs,
            output: t('hostPlugin.network.repair.dnsConnectivityOk', { address: resolved.address, latencyMs }),
            message: t('hostPlugin.network.repair.dnsConnectivityOk', { address: resolved.address, latencyMs })
          }
        } catch (err) {
          return {
            ok: false,
            success: false,
            checkId: targetId,
            error: resolveHostErrorMessage(err, 'hostPlugin.network.repair.gatewayProbeFailed')
          }
        }
      }

      if (targetId === 'reset-firewall') {
        if (process.platform === 'win32') {
          const res = await this.#sys.runCommand('netsh', ['advfirewall', 'reset'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? t('hostPlugin.network.repair.firewallReset') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.firewallFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.firewallWinOnly') }
      }

      if (targetId === 'restart-nla') {
        if (process.platform === 'win32') {
          const res = await this.#sys.runCommand(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Restart-Service -Name NlaSvc -Force -ErrorAction Stop'],
            15_000,
            signal
          )
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? t('hostPlugin.network.repair.nlaRestarted') : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || t('hostPlugin.network.repair.nlaFailed') })
          }
        }
        return { ok: false, success: false, checkId: targetId, errorCode: 'PLATFORM_NOT_SUPPORTED', error: t('hostPlugin.network.repair.nlaWinOnly') }
      }

      return {
        ok: false,
        success: false,
        checkId: targetId,
        errorCode: 'INVALID_REQUEST', error: t('hostPlugin.network.repair.unknownCheckId', { checkId: targetId })
      }
    }

    if (lowerFn === 'flushdns' || lowerFn === 'repairdns') {
      return this.handleNetworkRescue('repair', { ...params, checkId: 'flush-dns' }, signal)
    }

    if (lowerFn === 'clearproxy' || lowerFn === 'resetproxy') {
      return this.handleNetworkRescue('repair', { ...params, checkId: 'clear-proxy' }, signal)
    }

    if (lowerFn === 'resetwinsock') {
      return this.handleNetworkRescue('repair', { ...params, checkId: 'reset-winsock' }, signal)
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported NetworkRescuePlugin function: ${fn}`
    }
  }

  async handleMultiDownload(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'addtask' ||
      lowerFn === 'startdownload' ||
      lowerFn === 'download' ||
      lowerFn === 'createtask'
    ) {
      const url = String(params.url ?? '').trim()
      if (!url) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', error: t('hostPlugin.network.download.invalidUrl') }
      }
      try {
        const rawOutputDir = String(params.outputDir ?? params.saveDir ?? path.join(os.homedir(), 'Downloads'))
        const outputDir = await this.#ctx.authorizeOutputPath(rawOutputDir, caller)
        await fs.mkdir(outputDir, { recursive: true })
        // 地址格式不合法时这里不抛错，留给下面按协议校验时给出明确的中文原因
        let urlBaseName = ''
        try {
          urlBaseName = path.basename(new URL(url, 'http://localhost').pathname)
        } catch {
          urlBaseName = ''
        }
        const defaultName = urlBaseName || `download-${Date.now()}.bin`
        const rawFileName = String(params.fileName ?? params.name ?? defaultName).trim()
        const fileName =
          path.basename(rawFileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || `download-${Date.now()}.bin`
        const candidateSavePath = path.resolve(outputDir, fileName)
        const relCheck = path.relative(outputDir, candidateSavePath)
        if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
          return { ok: false, success: false, errorCode: 'PERMISSION_DENIED', error: t('hostPlugin.network.download.invalidFileName') }
        }
        const savePath = await this.#ctx.authorizeOutputPath(candidateSavePath, caller)
        const id = String(params.id ?? params.taskId ?? `dl-${Date.now()}`)
        if (url.startsWith('file://')) {
          // fileURLToPath 按平台解码：Windows 盘符与 UNC、%20 等转义都能得到正确的本地路径
          const srcPath = await this.#ctx.authorizeExistingPath(fileUrlToLocalPath(url), caller, 'read')
          await fs.copyFile(srcPath, savePath)
        } else if (url.startsWith('http://') || url.startsWith('https://')) {
          const resp = await fetch(url, signal ? { signal } : undefined)
          if (!resp.ok) {
            return { ok: false, success: false, errorCode: 'NETWORK_ERROR', error: t('hostPlugin.network.download.httpFailed', { status: resp.status }) }
          }
          const arrayBuf = await resp.arrayBuffer()
          await fs.writeFile(savePath, Buffer.from(arrayBuf))
        } else {
          return { ok: false, success: false, errorCode: 'NOT_SUPPORTED', error: t('hostPlugin.network.download.unsupportedProtocol', { url }) }
        }
        const stat = await fs.stat(savePath)
        const task = {
          id,
          url,
          fileName,
          savePath,
          status: 'completed' as const,
          totalBytes: stat.size,
          downloadedBytes: stat.size,
          createdAt: new Date().toISOString()
        }
        this.#downloadTasks.set(id, task)
        return { ok: true, success: true, task, outputPath: savePath, sizeBytes: stat.size }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, success: false, error: message }
      }
    }

    if (lowerFn === 'removetask' || lowerFn === 'deletetask') {
      const id = String(params.id ?? params.taskId ?? '')
      this.#downloadTasks.delete(id)
      return { ok: true, success: true, id }
    }

    return {
      ok: true,
      success: true,
      tasks: Array.from(this.#downloadTasks.values())
    }
  }

  async handleVideoDownloader(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'parseurl' || lowerFn === 'extractinfo' || lowerFn === 'getvideoinfo') {
      const url = String(params.url ?? '').trim()
      if (!url) {
        return { ok: false, success: false, errorCode: 'INVALID_REQUEST', error: t('hostPlugin.network.video.invalidUrl') }
      }
      const parsed = new URL(url, 'https://localhost')
      return {
        ok: true,
        success: true,
        url,
        title: parsed.pathname.split('/').filter(Boolean).pop() || 'Online Video Stream',
        site: parsed.hostname,
        formats: [
          { id: 'best', labelKey: 'hostPlugin.network.video.formatBest', label: t('hostPlugin.network.video.formatBest'), ext: 'mp4' },
          { id: 'audio', labelKey: 'hostPlugin.network.video.formatAudio', label: t('hostPlugin.network.video.formatAudio'), ext: 'mp3' }
        ]
      }
    }

    if (lowerFn === 'download' || lowerFn === 'startdownload') {
      return this.handleMultiDownload('startDownload', params, caller, signal)
    }

    return {
      ok: true,
      success: true,
      tasks: Array.from(this.#downloadTasks.values())
    }
  }

  // ==================== 07. Wi-Fi 密码与二维码提取 (WifiPasswordPlugin) ====================
  static #hasUnsafeSsidToken(ssid: string): boolean {
    return /[\r\n\0]/.test(ssid)
  }

  async handleWifiPassword(
    fn: string,
    params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    // 旧接口一次性批量返回全部明文密码、编造频段/信号/加密方式且不检查 netsh 退出码；
    // 真实读取改由 wifi_get_profiles（只列配置）与 wifi_get_password（按名称单独读取）完成。
    const wifiPluginOutdated = () => ({
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: t('hostPlugin.network.wifi.upgradeRequired')
    })

    if (
      lowerFn === 'listsavednetworks' ||
      lowerFn === 'listprofiles' ||
      lowerFn === 'getprofiles' ||
      lowerFn === 'list'
    ) {
      return wifiPluginOutdated()
    }

    if (lowerFn === 'getpassword' || lowerFn === 'revealpassword') {
      const ssid = String(params.ssid ?? params.name ?? '').trim()
      if (!ssid || NetworkHostPluginHandler.#hasUnsafeSsidToken(ssid)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_SSID',
          error: t('hostPlugin.network.wifi.invalidSsid')
        }
      }

      return wifiPluginOutdated()
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported WifiPasswordPlugin function: ${fn}`
    }
  }

  // ==================== 09. DNS 测速与一键切换 (DnsBenchmarkPlugin) ====================
  /** netsh / ipconfig 失败：区分需要管理员权限、超时与其他失败，并带上命令输出 */
  static #netshFailure(action: string, res: { stdout: string; stderr: string; exitCode: number }) {
    const output = `${res.stderr} ${res.stdout}`.trim()
    const errorCode = res.exitCode === 124
      ? 'TIMEOUT'
      : isAccessDeniedCommandResult(res)
        ? 'ADMIN_PRIVILEGE_REQUIRED'
        : 'NETSH_FAILED'
    return {
      ok: false as const,
      success: false as const,
      errorCode,
      error: output
        ? t('hostPlugin.network.netsh.failedWithOutput', { errorCode, action, output: output.slice(0, 300) })
        : t('hostPlugin.network.netsh.failedWithExitCode', { errorCode, action, exitCode: res.exitCode })
    }
  }

  /** 读取 Windows 每块已连接网卡的 IPv4、DNS 与是否由 DHCP 下发 */
  async #readWindowsDnsAdapters(signal?: AbortSignal): Promise<Array<{ name: string; description: string; ipv4: string; isDhcp: boolean; currentDns: string[] }>> {
    const ps = `
      $ErrorActionPreference = 'Stop'
      $list = @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
        $alias = $_.InterfaceAlias
        $dnsInfo = Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4
        $iface = Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4
        $dhcpDns = $false
        try {
          $guid = $_.NetAdapter.InterfaceGuid
          $reg = Get-ItemProperty -Path ("HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\" + $guid)
          $dhcpDns = [string]::IsNullOrWhiteSpace([string]$reg.NameServer)
        } catch { $dhcpDns = ($iface.Dhcp -eq 'Enabled') }
        [PSCustomObject]@{
          name = $alias
          description = [string]$_.InterfaceDescription
          ipv4 = [string]($_.IPv4Address | Select-Object -First 1).IPAddress
          isDhcp = [bool]$dhcpDns
          currentDns = @($dnsInfo.ServerAddresses)
        }
      })
      @{ adapters = $list } | ConvertTo-Json -Compress -Depth 5
    `
    const parsed = JSON.parse(await this.#sys.runPowerShell(ps, 15_000, signal)) as { adapters?: unknown }
    if (!parsed || !Array.isArray(parsed.adapters)) throw hostPluginError(errorCodes.dataCorrupt, 'hostPlugin.network.dns.adapterFormatInvalid', { hostCode: 'ADAPTER_FORMAT_INVALID' })
    return (parsed.adapters as Array<Record<string, unknown>>).map(item => ({
      name: String(item.name ?? ''),
      description: String(item.description ?? item.name ?? ''),
      ipv4: String(item.ipv4 ?? ''),
      isDhcp: item.isDhcp === true,
      currentDns: Array.isArray(item.currentDns) ? (item.currentDns as unknown[]).map(String).filter(ip => NetworkHostPluginHandler.#isValidIpv4(ip)) : []
    })).filter(item => item.name)
  }

  /** 修改后重新读取系统里的实际 DNS 作为结果，并单独报告刷新缓存是否成功 */
  async #dnsChangeResult(adapterName: string, signal?: AbortSignal) {
    const flush = await this.#sys.runCommand('ipconfig', ['/flushdns'], 10_000, signal)
    let adapter: { isDhcp: boolean; currentDns: string[] } | undefined
    try { adapter = (await this.#readWindowsDnsAdapters(signal)).find(item => item.name === adapterName) } catch { adapter = undefined }
    return {
      ok: true,
      success: true,
      adapterName,
      ...(adapter ? { currentDns: adapter.currentDns, isDhcp: adapter.isDhcp } : { currentDnsUnknown: true }),
      flushed: flush.exitCode === 0,
      ...(flush.exitCode === 0 ? {} : { flushError: NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionFlushDns'), flush).error })
    }
  }

  static #isValidIpv4(ip: string): boolean {
    if (typeof ip !== 'string') return false
    const trimmed = ip.trim()
    const m = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (!m) return false
    for (let i = 1; i <= 4; i++) {
      const part = Number(m[i])
      if (!Number.isInteger(part) || part < 0 || part > 255) return false
    }
    return true
  }

  static #isSafeAdapterName(name: string): boolean {
    if (typeof name !== 'string') return false
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > 120) return false
    return !/[;&|`$<>\\"\r\n\0]/.test(trimmed)
  }

  async handleDnsBenchmark(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (
      lowerFn === 'getactiveadapters' ||
      lowerFn === 'listadapters' ||
      lowerFn === 'getadapters'
    ) {
      const adapters: Array<{
        name: string
        description: string
        ipv4: string
        isDhcp: boolean
        currentDns: string[]
      }> = []
      if (process.platform === 'win32') {
        // 每块网卡自己的 DNS 与是否由 DHCP 下发；读取失败如实报错，不编造网卡
        try {
          for (const item of await this.#readWindowsDnsAdapters(signal)) adapters.push(item)
        } catch (err) {
          return { ok: false, success: false, errorCode: 'ADAPTER_READ_FAILED', error: t('hostPlugin.network.dns.adapterReadFailed', { detail: err instanceof Error ? err.message : String(err) }) }
        }
      } else {
        const sysDns = dns
          .getServers()
          .map((s: string) => s.replace(/^\[|\]:\d+$/g, ''))
          .filter((s: string) => NetworkHostPluginHandler.#isValidIpv4(s))
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
          if (/vmware|vbox|loopback/i.test(name)) continue
          const ipv4 = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal)
          if (!ipv4) continue
          adapters.push({ name, description: name, ipv4: ipv4.address, isDhcp: false, currentDns: sysDns.slice(0, 2) })
        }
      }

      return {
        ok: true,
        success: true,
        adapters,
        ...(adapters.length === 0 ? { message: t('hostPlugin.network.dns.noEditableAdapters') } : {})
      }
    }

    if (lowerFn === 'benchmarkdns' || lowerFn === 'probedns' || lowerFn === 'testdns') {
      const rawServers = Array.isArray(params.servers) ? params.servers : []
      const timeoutMs = Math.max(200, Math.min(3000, Number(params.timeoutMs) || 1200))

      const results = await Promise.all(
        rawServers
          .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
          .map(async (s) => {
            const id = String(s.id ?? s.primary ?? '')
            const primary = String(s.primary ?? '').trim()
            const secondary = String(s.secondary ?? '').trim()
            if (!NetworkHostPluginHandler.#isValidIpv4(primary)) {
              return {
                id,
                primary,
                secondary,
                avgMs: timeoutMs,
                primaryMs: null,
                secondaryMs: null,
                timeout: true,
                errorCode: 'INVALID_DNS_IP'
              }
            }
            const [probePrimary, probeSecondary] = await Promise.all([
              this.#probeTcp(primary, 53, timeoutMs),
              NetworkHostPluginHandler.#isValidIpv4(secondary)
                ? this.#probeTcp(secondary, 53, timeoutMs)
                : Promise.resolve({ ok: false, latencyMs: timeoutMs })
            ])
            const primaryMs = probePrimary.ok ? probePrimary.latencyMs : null
            const secondaryMs = probeSecondary.ok ? probeSecondary.latencyMs : null
            const anyOk = probePrimary.ok || probeSecondary.ok
            const avgMs =
              primaryMs !== null && secondaryMs !== null
                ? Math.round((primaryMs + secondaryMs) / 2)
                : (primaryMs ?? secondaryMs ?? timeoutMs)
            return {
              id,
              primary,
              secondary,
              avgMs,
              primaryMs,
              secondaryMs,
              timeout: !anyOk
            }
          })
      )

      return {
        ok: true,
        success: true,
        results
      }
    }

    if (lowerFn === 'applydns' || lowerFn === 'setdns') {
      const adapterName = String(params.adapterName ?? params.adapter ?? '').trim()
      const primary = String(params.primary ?? params.primaryDns ?? '').trim()
      const secondary = String(params.secondary ?? params.secondaryDns ?? '').trim()

      if (!NetworkHostPluginHandler.#isSafeAdapterName(adapterName)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_ADAPTER_NAME',
          error: t('hostPlugin.network.dns.invalidAdapterNameChars')
        }
      }

      if (
        !NetworkHostPluginHandler.#isValidIpv4(primary) ||
        (secondary && !NetworkHostPluginHandler.#isValidIpv4(secondary))
      ) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_DNS_IP',
          error: t('hostPlugin.network.dns.invalidDnsIp', { addresses: `${primary}${secondary ? `, ${secondary}` : ''}` })
        }
      }

      if (params.executeSystemModify !== true) {
        return { ok: false, success: false, errorCode: 'NOT_EXECUTED', error: t('hostPlugin.network.dns.notExecuted') }
      }
      if (process.platform !== 'win32') {
        return { ok: false, success: false, errorCode: 'UNSUPPORTED_PLATFORM', error: t('hostPlugin.network.dns.windowsOnlyLegacy') }
      }
      const setPrimary = await this.#sys.runCommand('netsh', ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'static', primary, 'validate=no'], 10_000, signal)
      if (setPrimary.exitCode !== 0) return NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionSetPrimaryDns'), setPrimary)
      if (secondary) {
        const addSecondary = await this.#sys.runCommand('netsh', ['interface', 'ip', 'add', 'dns', `name=${adapterName}`, secondary, 'index=2', 'validate=no'], 10_000, signal)
        if (addSecondary.exitCode !== 0) {
          const failure = NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionAddSecondaryDns'), addSecondary)
          return { ...failure, errorCode: 'SECONDARY_DNS_FAILED', error: t('hostPlugin.network.dns.secondaryFailed', { primary, detail: failure.error }) }
        }
      }
      return this.#dnsChangeResult(adapterName, signal)
    }

    if (lowerFn === 'resetdhcp' || lowerFn === 'resetdns') {
      const adapterName = String(params.adapterName ?? params.adapter ?? '').trim()
      if (!NetworkHostPluginHandler.#isSafeAdapterName(adapterName)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_ADAPTER_NAME',
          error: t('hostPlugin.network.dns.invalidAdapterName')
        }
      }
      if (params.executeSystemModify !== true) {
        return { ok: false, success: false, errorCode: 'NOT_EXECUTED', error: t('hostPlugin.network.dns.notExecuted') }
      }
      if (process.platform !== 'win32') {
        return { ok: false, success: false, errorCode: 'UNSUPPORTED_PLATFORM', error: t('hostPlugin.network.dns.windowsOnlyLegacy') }
      }
      const reset = await this.#sys.runCommand('netsh', ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'dhcp'], 10_000, signal)
      if (reset.exitCode !== 0) return NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionResetAutoDns'), reset)
      return this.#dnsChangeResult(adapterName, signal)
    }

    if (lowerFn === 'flushcache' || lowerFn === 'flushdns') {
      if (params.skipSystemExec === true) {
        return { ok: false, success: false, errorCode: 'NOT_EXECUTED', error: t('hostPlugin.network.dns.flushNotExecuted') }
      }
      const res = process.platform === 'win32'
        ? await this.#sys.runCommand('ipconfig', ['/flushdns'], 10_000, signal)
        : process.platform === 'darwin'
          ? await this.#sys.runCommand('dscacheutil', ['-flushcache'], 10_000, signal)
          : null
      if (!res) return { ok: false, success: false, errorCode: 'UNSUPPORTED_PLATFORM', error: t('hostPlugin.network.flushDnsUnsupported') }
      if (res.exitCode !== 0) return NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionFlushDns'), res)
      return {
        ok: true,
        success: true,
        flushed: true,
        message: t('hostPlugin.network.dns.flushCompleted')
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported DnsBenchmarkPlugin function: ${fn}`
    }
  }

  // ==================== 13. 网络测速与多节点诊断 (SpeedtestPlugin) ====================
  /**
   * 旧接口不再测速：原实现下载测不到时按延迟推算带宽、上传取下载的 30%、只有一个探测时抖动填固定值、
   * 本机 IP 缺省写死、网关按 x.x.x.1 猜测，节点不可达时把超时时间当延迟、连通即报 200，都属于编造数据。
   * 测速与节点检测统一走新版 network_speedtest 接口；这里不再执行任何探测或网络请求。
   */
  async handleSpeedtest(
    fn: string,
    _params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    const legacyFns = ['probenodes', 'pingnodes', 'probe', 'runbandwidthtest', 'speedtest', 'measurebandwidth']
    if (legacyFns.includes(lowerFn)) {
      return {
        ok: false,
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: t('hostPlugin.network.speedtest.upgradeRequired')
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported SpeedtestPlugin function: ${fn}`
    }
  }

  // ==================== 27. Hosts 方案切换 (HostsSwitcherPlugin) ====================
  async handleHostsSwitcher(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    if (process.platform === 'darwin' && (!['read', 'readsystemhosts'].includes(lowerFn) || Object.keys(params).length)) {
      return { ok: false, success: false, errorCode: 'UPGRADE_REQUIRED', error: t('hostPlugin.network.hosts.upgradeRequired') }
    }
    const defaultHostsPath =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
        : '/etc/hosts'
    // 只读取系统 hosts：调用方不能指定其他路径，否则会借主进程权限读取任意文件（测试只能经构造参数替换）
    const targetPath = this.#hostsPathOverride ?? defaultHostsPath

    if (lowerFn === 'read' || lowerFn === 'readsystemhosts') {
      try {
        const content = await fs.readFile(targetPath, 'utf8')
        return { ok: true, success: true, content, hostsPath: targetPath }
      } catch (err) {
        return {
          ok: false,
          success: false,
          errorCode: 'READ_FAILED',
          error: resolveHostErrorMessage(err, 'hostPlugin.network.hosts.readFailed')
        }
      }
    }

    if (lowerFn === 'apply' || lowerFn === 'applycombinedhosts') {
      // 旧接口用调用方给的完整内容整体覆盖系统 hosts，没有授权确认与可恢复的备份；Windows 版插件已下线重做，
      // 但已安装的旧版仍会调用这里，写入一律拒绝（macOS 在上面已要求更新插件）
      return {
        ok: false,
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: process.platform === 'win32' ? t('hostPlugin.network.hosts.writeWinReworking') : t('hostPlugin.network.hosts.writeUnsupported')
      }
    }

    if (lowerFn === 'flushdns') {
      if (params.dryRun === true) return { ok: true, success: true, dryRun: true, output: t('hostPlugin.network.hosts.flushDryRun') }
      if (process.platform !== 'win32') {
        return { ok: false, success: false, errorCode: 'UNSUPPORTED_PLATFORM', error: t('hostPlugin.network.hosts.flushWinOnly') }
      }
      // 超时（124）、取消（130）或其他非零退出都如实报错，不能报告“已刷新”
      const res = await this.#sys.runCommand('ipconfig', ['/flushdns'], 3000, signal)
      if (res.exitCode !== 0) return NetworkHostPluginHandler.#netshFailure(t('hostPlugin.network.netsh.actionFlushDns'), res)
      return { ok: true, success: true, output: res.stdout || t('hostPlugin.network.hosts.flushDone') }
    }

    return { ok: false, success: false, error: `Unsupported HostsSwitcherPlugin function: ${fn}` }
  }

  // ==================== 29. Docker 容器管控 (DockerManagerPlugin) ====================
  static #stripAnsiCodes(text: string): string {
    return (text ?? '')
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  }

  async handleDockerManager(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'ping' || lowerFn === 'pingdockerdaemon') {
      const res = await this.#sys.runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], 3000, signal)
      const online = res.exitCode === 0 && Boolean(res.stdout.trim())
      return {
        ok: online,
        success: online,
        online,
        version: res.stdout.trim(),
        ...(online ? {} : { errorCode: 'DAEMON_OFFLINE', error: t('hostPlugin.network.docker.daemonOffline') })
      }
    }

    if (lowerFn === 'list' || lowerFn === 'listcontainers') {
      const res = await this.#sys.runCommand('docker', ['ps', '-a', '--format', '{{json .}}'], 4000, signal)
      if (res.exitCode !== 0) {
        return {
          ok: false,
          success: false,
          errorCode: 'DAEMON_OFFLINE',
          error: t('hostPlugin.network.docker.daemonUnreachable')
        }
      }
      const containers = res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>
          } catch {
            return null
          }
        })
        .filter((x): x is Record<string, unknown> => x !== null)
      return { ok: true, success: true, containers }
    }

    if (lowerFn === 'control' || lowerFn === 'controlcontainer') {
      const id = String(params.id ?? '').trim()
      const action = String(params.action ?? '').trim().toLowerCase()
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) {
        return { ok: false, success: false, errorCode: 'INVALID_CONTAINER_ID', error: t('hostPlugin.network.docker.invalidContainerId') }
      }
      if (!['start', 'stop', 'restart', 'rm', 'remove'].includes(action)) {
        return { ok: false, success: false, errorCode: 'INVALID_ACTION', error: t('hostPlugin.network.docker.unsupportedAction', { action }) }
      }
      const dockerSub = action === 'remove' ? 'rm' : action
      if (params.dryRun === true) {
        return { ok: true, success: true, id, action: dockerSub, command: `docker ${dockerSub} ${id}` }
      }
      const res = await this.#sys.runCommand('docker', [dockerSub, id], 8000, signal)
      return {
        ok: res.exitCode === 0,
        success: res.exitCode === 0,
        id,
        action: dockerSub,
        output: res.stdout || res.stderr
      }
    }

    if (lowerFn === 'logs' || lowerFn === 'getcontainertaillogs') {
      const id = String(params.id ?? '').trim()
      const lines = Math.max(1, Math.min(500, Number(params.lines) || 100))
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) {
        return { ok: false, success: false, errorCode: 'INVALID_CONTAINER_ID', error: t('hostPlugin.network.docker.invalidContainerId') }
      }
      const res = await this.#sys.runCommand('docker', ['logs', '--tail', String(lines), id], 5000, signal)
      return {
        ok: res.exitCode === 0,
        success: res.exitCode === 0,
        logs: NetworkHostPluginHandler.#stripAnsiCodes(`${res.stdout}\n${res.stderr}`.trim())
      }
    }

    return { ok: false, success: false, error: `Unsupported DockerManagerPlugin function: ${fn}` }
  }

  // ==================== 30. 局域网扫描与 WOL 唤醒 (LanScannerPlugin) ====================
  static buildWolMagicPacket(mac: string): Buffer {
    const clean = (mac ?? '').trim().replace(/[:-]/g, '')
    if (!/^[0-9a-fA-F]{12}$/.test(clean)) {
      throw hostPluginError(errorCodes.invalidRequest, 'hostPlugin.network.lan.invalidMacFormat', { hostCode: 'INVALID_MAC_ADDRESS' })
    }
    const macBytes = Buffer.from(clean, 'hex')
    const packet = Buffer.alloc(102)
    packet.fill(0xff, 0, 6)
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6)
    }
    return packet
  }

  async handleLanScanner(
    fn: string,
    params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    if (process.platform === 'darwin') return { success: false, errorCode: 'UPGRADE_REQUIRED', error: t('hostPlugin.network.lan.macLegacyUnsupported') }
    const lowerFn = (fn ?? '').trim().toLowerCase()
    // 旧接口的真实分支把非 /24 网段一律当 /24、只回原始 arp 文本、唤醒不核对网卡；真实扫描与唤醒改由 lan_network 新接口完成
    const lanPluginOutdated = () => ({
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: t('hostPlugin.network.lan.upgradeRequired')
    })

    if (lowerFn === 'interfaces' || lowerFn === 'detectactiveinterfaces' || lowerFn === 'scan' || lowerFn === 'scansubnet') {
      return lanPluginOutdated()
    }

    if (lowerFn === 'wol' || lowerFn === 'sendwakeonlan') {
      const mac = String(params.mac ?? '').trim()
      let packet: Buffer
      try {
        packet = NetworkHostPluginHandler.buildWolMagicPacket(mac)
      } catch (err) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_MAC_ADDRESS',
          error: resolveHostErrorMessage(err, 'hostPlugin.network.lan.invalidMac')
        }
      }

      if (params.dryRun === true) {
        return {
          ok: true,
          success: true,
          byteLength: packet.byteLength,
          packetHex: packet.toString('hex')
        }
      }

      return lanPluginOutdated()
    }

    return { ok: false, success: false, error: `Unsupported LanScannerPlugin function: ${fn}` }
  }

  // ==================== 31. SSH 与开发代理管家 (SshProxyHelperPlugin) ====================
  async handleSshProxyHelper(
    fn: string,
    _params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    // 旧接口从不写 NPM、吞掉 Git 失败、不备份原代理、初始状态假装已启用，且可读任意路径；
    // 真实读取与修改改由 ssh_proxy 新接口完成（先预览、备份、写入后读回核验）。
    if (
      lowerFn === 'readconfig' || lowerFn === 'parsesshconfigfile' ||
      lowerFn === 'proxystatus' || lowerFn === 'getproxystatus' ||
      lowerFn === 'setproxy' || lowerFn === 'setdevtoolsproxy' ||
      lowerFn === 'unsetproxy' || lowerFn === 'unsetdevtoolsproxy'
    ) {
      return {
        ok: false,
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: t('hostPlugin.network.ssh.upgradeRequired')
      }
    }

    return { ok: false, success: false, error: `Unsupported SshProxyHelperPlugin function: ${fn}` }
  }

  // ==================== 39. SSL 证书与域名健康巡检 (SslDomainCheckPlugin) ====================
  async handleSslDomainCheck(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    if (
      lowerFn === 'inspectdomain' ||
      lowerFn === 'inspectcert' ||
      lowerFn === 'checkssl' ||
      lowerFn === 'inspect'
    ) {
      const rawDomain = String(params.domain ?? params.host ?? '').trim()
      if (!rawDomain) {
        return { ok: false, success: false, errorCode: 'EMPTY_DOMAIN', error: t('hostPlugin.network.tls.emptyDomain') }
      }
      const host = rawDomain
        .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
        .split('/')[0]!
        .split(':')[0]!
        .trim()
        .toLowerCase()
      const port = Number(params.port) || 443
      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 6000, 1000), 15000)

      return new Promise((resolve) => {
        let settled = false
        const finish = (res: Record<string, unknown>): void => {
          if (settled) return
          settled = true
          resolve(res)
        }

        const socket = tls.connect(
          {
            host,
            port,
            servername: host,
            rejectUnauthorized: false,
            timeout: timeoutMs
          },
          () => {
            try {
              const cert = socket.getPeerCertificate(false)
              const protocol = socket.getProtocol() || 'TLSv1.3'
              socket.end()
              socket.destroy()
              if (!cert || Object.keys(cert).length === 0) {
                finish({
                  ok: false,
                  success: false,
                  errorCode: 'NO_PEER_CERT',
                  error: t('hostPlugin.network.tls.noCertificate', { host, port })
                })
                return
              }
              const cnRaw = cert.subject?.CN
              const subjectCN = Array.isArray(cnRaw) ? cnRaw[0] || host : cnRaw || host
              const issuerOrg = Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O
              const issuerCn = Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN
              const issuerName = issuerOrg
                ? `${issuerOrg}${issuerCn ? ` (${issuerCn})` : ''}`
                : issuerCn || 'Unknown CA'
              const sanList = typeof cert.subjectaltname === 'string'
                ? cert.subjectaltname
                    .split(',')
                    .map((s) => s.trim().replace(/^DNS:/i, ''))
                    .filter(Boolean)
                : [host]

              finish({
                ok: true,
                success: true,
                cert: {
                  domain: host,
                  subjectCN,
                  issuerName,
                  validFrom: cert.valid_from,
                  validTo: cert.valid_to,
                  serialNumber: cert.serialNumber || '-',
                  fingerprint256: cert.fingerprint256 ? `SHA256:${cert.fingerprint256}` : '-',
                  subjectAltNames: sanList.length > 0 ? sanList : [host],
                  protocol
                }
              })
            } catch (err) {
              socket.destroy()
              finish({
                ok: false,
                success: false,
                errorCode: 'TLS_PARSE_ERROR',
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
        )

        const onAbort = (): void => {
          socket.destroy()
          finish({ ok: false, success: false, errorCode: 'ABORTED', error: t('hostPlugin.network.tls.aborted') })
        }
        if (signal) {
          if (signal.aborted) {
            onAbort()
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
        }

        socket.on('timeout', () => {
          socket.destroy()
          finish({
            ok: false,
            success: false,
            errorCode: 'TLS_TIMEOUT',
            error: t('hostPlugin.network.tls.timeout', { host, port, timeoutMs })
          })
        })

        socket.on('error', (err) => {
          socket.destroy()
          finish({
            ok: false,
            success: false,
            errorCode: 'TLS_CONNECT_ERROR',
            error: err instanceof Error ? err.message : String(err)
          })
        })
      })
    }

    return { ok: false, success: false, error: `Unsupported SslDomainCheckPlugin function: ${fn}` }
  }
}
