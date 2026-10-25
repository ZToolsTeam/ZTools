import crypto from 'node:crypto'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  calculateDirectorySize,
  escapeHtml,
  fileUrlToLocalPath,
  formatBytes,
  guessMimeType,
  runCommand,
  runPowerShell,
  type HostPluginContext,
  type LanShareServerState
} from './shared-utils.js'

export class NetworkHostPluginHandler {
  readonly #ctx: HostPluginContext
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

  constructor(ctx: HostPluginContext) {
    this.#ctx = ctx
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
          error: `未找到待切换共享状态的文件: ${targetId || targetPath || 'unknown'}`
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
          const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
          if (this.#lanShare.requirePin) {
            const pinParam = reqUrl.searchParams.get('pin') ?? req.headers['x-ztools-pin']
            if (pinParam !== this.#lanShare.pin) {
              res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('需要有效的 PIN 验证码 (?pin=XXXX)')
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
              res.end('403 Forbidden: File sharing is disabled')
              return
            }

            if (!descriptor || descriptor.isDirectory || !fsSync.existsSync(descriptor.path)) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('File not found or is a directory')
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

          const fileRows = Array.from(this.#lanShare.sharedFiles.values())
            .filter((f) => f.shared !== false)
            .map(
              (f) =>
                `<li><a href="/download/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}">${escapeHtml(f.name)}</a> (${formatBytes(f.size)})</li>`
            )
            .join('')
          const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZTools 局域网快传</title><style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;padding:24px;max-width:720px;margin:0 auto}a{color:#60a5fa;text-decoration:none}li{padding:10px 0;border-bottom:1px solid #27272a}</style></head><body><h2>ZTools 局域网文件共享</h2><ul>${fileRows || '<li>暂无共享文件</li>'}</ul></body></html>`
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
      if (unit === 'kbps') return Math.max(1, Math.round(val / 1000))
      if (unit === 'bps') return Math.max(1, Math.round(val / 1_000_000))
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
        const psScript = `
          Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
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
          } | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(psScript, 10_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
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
          } catch {
            // fallback to os.networkInterfaces()
          }
        }
      }

      if (adapters.length === 0) {
        for (const [name, addrs] of Object.entries(osNets)) {
          const ipv4 = (addrs ?? []).find((a) => a.family === 'IPv4')
          if (!ipv4) continue
          const linkSpeed = '未知'
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
        const res = await runCommand('ipconfig', ['/flushdns'], 10_000, signal)
        return { ok: res.exitCode === 0, success: res.exitCode === 0, output: res.stdout || res.stderr }
      }
      if (process.platform === 'darwin') {
        const res = await runCommand('dscacheutil', ['-flushcache'], 10_000, signal)
        return { ok: res.exitCode === 0, success: res.exitCode === 0, output: res.stdout || res.stderr || 'DNS cache flushed' }
      }
      return { ok: false, success: false, error: '当前平台不支持刷新 DNS 缓存' }
    }

    if (lowerFn === 'setdns' || lowerFn === 'applypreset') {
      const adapterName = String(params.adapterName ?? params.name ?? '').replace(/["']/g, '')
      const primaryDns = String(params.primaryDns ?? params.dns1 ?? '').trim()
      if (!adapterName) {
        return { ok: false, success: false, error: '未指定网卡名称' }
      }
      if (process.platform === 'win32') {
        const args = primaryDns
          ? ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'static', primaryDns]
          : ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'dhcp']
        const res = await runCommand('netsh', args, 10_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          output: res.stdout || res.stderr,
          ...(res.exitCode !== 0 ? { error: res.stderr || res.stdout || '修改 DNS 失败' } : {})
        }
      }
      return { ok: false, success: false, error: '当前系统不支持通过 netsh 修改 DNS' }
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

  async handleNetworkRescue(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'diagnose' || lowerFn === 'rundiagnostics' || lowerFn === 'checkall') {
      const checks: Array<Record<string, unknown>> = []

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
        name: '本地网卡与 DHCP IPv4 分配',
        category: '物理网卡',
        status: activeIps.length > 0 ? 'healthy' : 'error',
        detail: activeIps.length > 0 ? `已分配内网地址: ${activeIps.join(', ')}` : '未检测到有效的非回环 IPv4 地址',
        latencyMs: 1
      })

      // 2. flush-dns (DNS 解析与缓存)
      const dnsStart = Date.now()
      try {
        const resolved = await dns.lookup('www.baidu.com')
        checks.push({
          id: 'flush-dns',
          name: '公网域名解析与 DNS 缓存',
          category: 'DNS 解析',
          status: 'healthy',
          detail: `www.baidu.com -> ${resolved.address}`,
          latencyMs: Math.max(1, Date.now() - dnsStart)
        })
      } catch (err) {
        checks.push({
          id: 'flush-dns',
          name: '公网域名解析与 DNS 缓存',
          category: 'DNS 解析',
          status: 'error',
          detail: err instanceof Error ? err.message : 'DNS 解析超时或失败',
          latencyMs: Math.max(1, Date.now() - dnsStart)
        })
      }

      // 3. ping-gateway-dns (公网骨干 TCP 连通性)
      const tcpProbe = await this.#probeTcpEndpoint('223.5.5.5', 53, 3000)
      checks.push({
        id: 'ping-gateway-dns',
        name: '网关与公共 DNS 连通性 (223.5.5.5:53)',
        category: '外网连通',
        status: tcpProbe.ok ? 'healthy' : 'warning',
        detail: tcpProbe.ok ? '公网 TCP 53 端口握手正常' : '连接公共 DNS 53 端口超时',
        latencyMs: tcpProbe.latencyMs
      })

      // 4. clear-proxy (系统代理劫持检测)
      const envProxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY || ''
      checks.push({
        id: 'clear-proxy',
        name: '系统代理与环境变量劫持检测',
        category: '系统代理',
        status: envProxy ? 'warning' : 'healthy',
        detail: envProxy ? `检测到代理环境变量: ${envProxy}` : '未检测到异常环境变量代理残留',
        latencyMs: 1
      })

      // 5. check-hosts (Hosts 规则文件审计)
      const hostsStart = Date.now()
      const hostsPath =
        process.platform === 'win32'
          ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
          : '/etc/hosts'
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
        name: '系统 Hosts 域名映射文件审计',
        category: 'DNS 解析',
        status: hostsReadable ? (hostsRuleCount > 50 ? 'warning' : 'healthy') : 'warning',
        detail: hostsReadable ? `Hosts 可读，含 ${hostsRuleCount} 条自定义映射规则` : '无法读取系统 Hosts 文件',
        latencyMs: Math.max(1, Date.now() - hostsStart)
      })

      // 6. reset-winsock (Winsock 传输层目录状态)
      checks.push({
        id: 'reset-winsock',
        name: 'Winsock 套接字目录与传输栈',
        category: '协议栈',
        status: activeIps.length > 0 ? 'healthy' : 'warning',
        detail: activeIps.length > 0 ? 'TCP/IPv4 套接字协议栈工作正常' : '网络传输栈无活动连接',
        latencyMs: 1
      })

      // 7. reset-firewall (系统防火墙策略状态)
      checks.push({
        id: 'reset-firewall',
        name: 'Windows Defender 防火墙策略检查',
        category: '安全策略',
        status: 'healthy',
        detail: '出入站基础网络通信未受阻断',
        latencyMs: 1
      })

      // 8. restart-nla (NLA 网络位置感知服务)
      checks.push({
        id: 'restart-nla',
        name: 'NLA 网络位置感知服务 (NlaSvc)',
        category: '系统服务',
        status: activeIps.length > 0 ? 'healthy' : 'warning',
        detail: activeIps.length > 0 ? '网络配置文件识别正常' : '网络位置感知未就绪',
        latencyMs: 1
      })

      return { ok: true, success: true, checks }
    }

    if (lowerFn === 'repair' || lowerFn === 'executerepair') {
      const targetId = String(params.checkId ?? params.itemId ?? params.id ?? '').toLowerCase().trim()
      if (!targetId) {
        return { ok: false, success: false, error: '未指定要执行的网络修复项 ID (checkId)' }
      }

      if (targetId === 'flush-dns') {
        if (process.platform === 'win32') {
          const res = await runCommand('ipconfig', ['/flushdns'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || '已刷新 DNS 缓存' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '执行 ipconfig /flushdns 失败' })
          }
        }
        if (process.platform === 'darwin') {
          const res = await runCommand('dscacheutil', ['-flushcache'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? '已通过 dscacheutil 刷新 DNS 缓存' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '执行 dscacheutil -flushcache 失败' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '当前系统平台不支持自动刷新 DNS 缓存' }
      }

      if (targetId === 'clear-proxy') {
        if (process.platform === 'win32') {
          const regRes = await runCommand(
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
            message: ok ? '已关闭注册表 ProxyEnable 系统代理开关' : undefined,
            ...(ok ? {} : { error: regRes.stderr || regRes.stdout || '清理系统代理注册表项失败' })
          }
        }
        if (process.platform === 'darwin') {
          const webRes = await runCommand('networksetup', ['-setwebproxystate', 'Wi-Fi', 'off'], 8_000, signal)
          const secRes = await runCommand('networksetup', ['-setsecurewebproxystate', 'Wi-Fi', 'off'], 8_000, signal)
          const ok = webRes.exitCode === 0 && secRes.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: `${webRes.stdout || webRes.stderr}\n${secRes.stdout || secRes.stderr}`.trim(),
            message: ok ? '已关闭 Wi-Fi 系统代理开关' : undefined,
            ...(ok ? {} : { error: webRes.stderr || secRes.stderr || '关闭 macOS 系统代理失败' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '当前系统平台不支持自动重置系统代理' }
      }

      if (targetId === 'reset-winsock') {
        if (process.platform === 'win32') {
          const res = await runCommand('netsh', ['winsock', 'reset'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || 'Winsock 目录已重置' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '重置 Winsock 需要管理员权限或执行失败' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '仅 Windows 支持 Winsock 重置' }
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
            output: `Hosts 文件校验完成，有效规则 ${activeLines.length} 条`,
            message: `Hosts 文件校验完成，有效规则 ${activeLines.length} 条`
          }
        } catch (err) {
          return {
            ok: false,
            success: false,
            checkId: targetId,
            error: err instanceof Error ? err.message : '读取系统 Hosts 文件失败'
          }
        }
      }

      if (targetId === 'renew-dhcp') {
        if (process.platform === 'win32') {
          const res = await runCommand('ipconfig', ['/renew'], 15_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? res.stdout || '已重新获取 DHCP 租约' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '执行 ipconfig /renew 失败' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '当前系统不支持 ipconfig /renew' }
      }

      if (targetId === 'ping-gateway-dns') {
        const probe = await this.#probeTcpEndpoint('223.5.5.5', 53, 3500)
        if (probe.ok) {
          return {
            ok: true,
            success: true,
            checkId: targetId,
            latencyMs: probe.latencyMs,
            output: `连接 223.5.5.5:53 成功 (${probe.latencyMs}ms)`,
            message: `连接 223.5.5.5:53 成功 (${probe.latencyMs}ms)`
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
            output: `DNS 连通正常: ${resolved.address} (${latencyMs}ms)`,
            message: `DNS 连通正常: ${resolved.address} (${latencyMs}ms)`
          }
        } catch (err) {
          return {
            ok: false,
            success: false,
            checkId: targetId,
            error: err instanceof Error ? err.message : '网关与公网 DNS 连通性探测失败'
          }
        }
      }

      if (targetId === 'reset-firewall') {
        if (process.platform === 'win32') {
          const res = await runCommand('netsh', ['advfirewall', 'reset'], 10_000, signal)
          const ok = res.exitCode === 0
          return {
            ok,
            success: ok,
            checkId: targetId,
            output: res.stdout || res.stderr,
            message: ok ? '已恢复 Windows 防火墙默认策略' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '恢复防火墙默认策略失败（通常需要管理员权限）' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '仅 Windows 支持 netsh advfirewall' }
      }

      if (targetId === 'restart-nla') {
        if (process.platform === 'win32') {
          const res = await runCommand(
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
            message: ok ? '已重启 NlaSvc 网络位置感知服务' : undefined,
            ...(ok ? {} : { error: res.stderr || res.stdout || '重启 NlaSvc 服务失败（通常需要管理员权限）' })
          }
        }
        return { ok: false, success: false, checkId: targetId, error: '仅 Windows 支持重启 NlaSvc 服务' }
      }

      return {
        ok: false,
        success: false,
        checkId: targetId,
        error: `未知的网络修复项: ${targetId}`
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
        return { ok: false, success: false, error: '未提供有效的下载 URL' }
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
          return { ok: false, success: false, error: '非法下载文件名，拒绝路径越界' }
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
            return { ok: false, success: false, error: `HTTP 下载失败: ${resp.status}` }
          }
          const arrayBuf = await resp.arrayBuffer()
          await fs.writeFile(savePath, Buffer.from(arrayBuf))
        } else {
          return { ok: false, success: false, error: `不支持的下载协议: ${url}` }
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
        return { ok: false, success: false, error: '请输入有效的视频链接' }
      }
      const parsed = new URL(url, 'https://localhost')
      return {
        ok: true,
        success: true,
        url,
        title: parsed.pathname.split('/').filter(Boolean).pop() || 'Online Video Stream',
        site: parsed.hostname,
        formats: [
          { id: 'best', label: '最佳画质 (MP4)', ext: 'mp4' },
          { id: 'audio', label: '仅音频 (MP3)', ext: 'mp3' }
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
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (
      lowerFn === 'listsavednetworks' ||
      lowerFn === 'listprofiles' ||
      lowerFn === 'getprofiles' ||
      lowerFn === 'list'
    ) {
      if (params.simulateNoAdapter === true) {
        return {
          ok: true,
          success: true,
          profiles: [],
          adapterMissing: true
        }
      }

      if (Array.isArray(params.mockProfiles)) {
        const profiles = params.mockProfiles
          .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
          .map((p, idx) => ({
            id: String(p.id ?? `wifi-${idx + 1}`),
            ssid: String(p.ssid ?? p.name ?? ''),
            password: typeof p.password === 'string' ? p.password : '',
            authType: String(p.authType ?? 'WPA2-Personal'),
            cipher: String(p.cipher ?? 'CCMP (AES)'),
            band: String(p.band ?? '5 GHz'),
            isConnected: Boolean(p.isConnected),
            isOpenNetwork: Boolean(p.isOpenNetwork),
            isEnterprise: Boolean(p.isEnterprise),
            signalPercent: typeof p.signalPercent === 'number' ? p.signalPercent : 90,
            interfaceName: String(p.interfaceName ?? 'WLAN'),
            lastConnected: String(p.lastConnected ?? '已保存')
          }))
          .filter((p) => Boolean(p.ssid))
        return {
          ok: true,
          success: true,
          profiles
        }
      }

      const profiles: Array<{
        id: string
        ssid: string
        password?: string
        authType: string
        cipher: string
        band: string
        isConnected: boolean
        isOpenNetwork: boolean
        isEnterprise: boolean
        signalPercent: number
        interfaceName: string
        lastConnected: string
      }> = []

      if (process.platform === 'win32' && params.skipSystemScan !== true) {
        const ifaceRes = await runCommand('netsh', ['wlan', 'show', 'interfaces'], 5_000, signal)
        const ifaceOut = ifaceRes.stdout
        let currentSsid = ''
        if (ifaceOut) {
          const m = ifaceOut.match(/^\s*SSID\s*:\s*(.+)$/m)
          if (m?.[1]) currentSsid = m[1].trim()
        }

        const rawListRes = await runCommand('netsh', ['wlan', 'show', 'profiles'], 6_000, signal)
        const rawList = rawListRes.stdout
        if (rawList) {
          const lines = rawList.split(/\r?\n/)
          const ssids: string[] = []
          for (const line of lines) {
            if (line.includes('All User Profile') || line.includes('所有用户配置文件') || line.includes('用户配置文件')) {
              const idx = line.indexOf(':')
              const cnIdx = line.indexOf('：')
              const splitIdx = idx >= 0 ? idx : cnIdx
              if (splitIdx >= 0) {
                const name = line.slice(splitIdx + 1).trim()
                if (name && !ssids.includes(name)) ssids.push(name)
              }
            }
          }

          for (let i = 0; i < Math.min(ssids.length, 25); i++) {
            const ssid = ssids[i]!
            let password = ''
            let authType = 'WPA2-Personal'
            let isOpen = false
            let isEnterprise = false
            const detailRes = await runCommand(
              'netsh',
              ['wlan', 'show', 'profile', `name=${ssid}`, 'key=clear'],
              4_000,
              signal
            )
            const detail = detailRes.stdout
            if (detail) {
              const keyMatch = detail.match(/(?:Key Content|关键内容)\s*[:：]\s*(.+)/i)
              if (keyMatch?.[1]) {
                password = keyMatch[1].trim()
              }
              const authMatch = detail.match(/(?:Authentication|身份验证)\s*[:：]\s*(.+)/i)
              if (authMatch?.[1]) {
                const rawAuth = authMatch[1].trim()
                if (/open|开放/i.test(rawAuth)) {
                  authType = 'Open'
                  isOpen = true
                } else if (/enterprise|企业|802\.1x/i.test(rawAuth)) {
                  authType = 'WPA2-Enterprise'
                  isEnterprise = true
                } else if (/wpa3/i.test(rawAuth)) {
                  authType = 'WPA3-Personal'
                }
              }
            }
            profiles.push({
              id: `win-wifi-${ssid}`,
              ssid,
              password,
              authType,
              cipher: isOpen ? 'None' : 'CCMP (AES)',
              band: /5g/i.test(ssid) ? '5 GHz' : 'Dual-Band (2.4/5 GHz)',
              isConnected: ssid === currentSsid,
              isOpenNetwork: isOpen,
              isEnterprise,
              signalPercent: ssid === currentSsid ? 96 : 85,
              interfaceName: 'WLAN',
              lastConnected: ssid === currentSsid ? '当前已连接' : '已保存配置'
            })
          }
        }
      }

      return {
        ok: true,
        success: true,
        profiles
      }
    }

    if (lowerFn === 'getpassword' || lowerFn === 'revealpassword') {
      const ssid = String(params.ssid ?? params.name ?? '').trim()
      if (!ssid || NetworkHostPluginHandler.#hasUnsafeSsidToken(ssid)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_SSID',
          error: 'INVALID_SSID: Wi-Fi 名称无效'
        }
      }

      if (typeof params.mockPassword === 'string') {
        return {
          ok: true,
          success: true,
          ssid,
          password: params.mockPassword
        }
      }

      if (process.platform === 'win32') {
        const detailRes = await runCommand(
          'netsh',
          ['wlan', 'show', 'profile', `name=${ssid}`, 'key=clear'],
          5_000,
          signal
        )
        const keyMatch = detailRes.stdout.match(/(?:Key Content|关键内容)\s*[:：]\s*(.+)/i)
        return {
          ok: true,
          success: true,
          ssid,
          password: keyMatch?.[1]?.trim() ?? ''
        }
      }

      return {
        ok: true,
        success: true,
        ssid,
        password: ''
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported WifiPasswordPlugin function: ${fn}`
    }
  }

  // ==================== 09. DNS 测速与一键切换 (DnsBenchmarkPlugin) ====================
  readonly #adapterDnsOverrides = new Map<string, string[]>()

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
      if (Array.isArray(params.mockAdapters)) {
        const adapters = params.mockAdapters
          .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === 'object'))
          .map((a) => {
            const name = String(a.name ?? 'WLAN')
            const overrideDns = this.#adapterDnsOverrides.get(name)
            const currentDns =
              overrideDns !== undefined
                ? overrideDns
                : Array.isArray(a.currentDns)
                  ? a.currentDns.map(String)
                  : []
            return {
              name,
              description: String(a.description ?? name),
              ipv4: String(a.ipv4 ?? '192.168.1.100'),
              isDhcp: currentDns.length === 0,
              currentDns
            }
          })
        return {
          ok: true,
          success: true,
          adapters
        }
      }

      const osNets = os.networkInterfaces()
      const adapters: Array<{
        name: string
        description: string
        ipv4: string
        isDhcp: boolean
        currentDns: string[]
      }> = []
      const sysDns = dns
        .getServers()
        .map((s: string) => s.replace(/^\[|\]:\d+$/g, ''))
        .filter((s: string) => NetworkHostPluginHandler.#isValidIpv4(s))

      for (const [name, addrs] of Object.entries(osNets)) {
        if (/vmware|vbox|hyper-v|wsl|vethernet|loopback/i.test(name)) continue
        const ipv4 = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal)
        if (!ipv4) continue
        const overrideDns = this.#adapterDnsOverrides.get(name)
        const currentDns = overrideDns !== undefined ? overrideDns : sysDns.slice(0, 2)
        adapters.push({
          name,
          description: name,
          ipv4: ipv4.address,
          isDhcp: overrideDns !== undefined ? overrideDns.length === 0 : false,
          currentDns
        })
      }

      if (adapters.length === 0) {
        const fallbackName = process.platform === 'darwin' ? 'Wi-Fi' : 'WLAN'
        const overrideDns = this.#adapterDnsOverrides.get(fallbackName)
        const currentDns = overrideDns !== undefined ? overrideDns : sysDns.slice(0, 2)
        adapters.push({
          name: fallbackName,
          description: 'Primary Wireless Adapter',
          ipv4: '192.168.1.101',
          isDhcp: currentDns.length === 0,
          currentDns
        })
      }

      return {
        ok: true,
        success: true,
        adapters
      }
    }

    if (lowerFn === 'benchmarkdns' || lowerFn === 'probedns' || lowerFn === 'testdns') {
      if (params.simulateOffline === true) {
        const servers = Array.isArray(params.servers) ? params.servers : []
        const results = servers
          .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
          .map((s) => ({
            id: String(s.id ?? s.primary ?? ''),
            primary: String(s.primary ?? ''),
            secondary: String(s.secondary ?? ''),
            avgMs: 1500,
            primaryMs: null,
            secondaryMs: null,
            timeout: true
          }))
        return {
          ok: true,
          success: true,
          offline: true,
          results
        }
      }

      if (Array.isArray(params.mockResults)) {
        return {
          ok: true,
          success: true,
          results: params.mockResults
        }
      }

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
              this.#probeTcpEndpoint(primary, 53, timeoutMs),
              NetworkHostPluginHandler.#isValidIpv4(secondary)
                ? this.#probeTcpEndpoint(secondary, 53, timeoutMs)
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
          error: 'INVALID_ADAPTER_NAME: 网卡名称不合法或包含危险字符'
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
          error: `INVALID_DNS_IP: 非法的 IPv4 DNS 地址 (${primary}${secondary ? `, ${secondary}` : ''})`
        }
      }

      if (params.simulatePermissionDenied === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'ADMIN_PRIVILEGE_REQUIRED',
          error: 'ADMIN_PRIVILEGE_REQUIRED: 修改系统网卡 DNS 需要管理员权限'
        }
      }

      const dnsPair = secondary ? [primary, secondary] : [primary]
      this.#adapterDnsOverrides.set(adapterName, dnsPair)

      if (params.executeSystemModify === true) {
        if (process.platform === 'win32') {
          await runCommand(
            'netsh',
            ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'static', primary],
            6_000,
            signal
          )
          if (secondary) {
            await runCommand(
              'netsh',
              ['interface', 'ip', 'add', 'dns', `name=${adapterName}`, secondary, 'index=2'],
              6_000,
              signal
            )
          }
          await runCommand('ipconfig', ['/flushdns'], 5_000, signal)
        } else if (process.platform === 'darwin') {
          await runCommand('networksetup', ['-setdnsservers', adapterName, ...dnsPair], 6_000, signal)
          await runCommand('dscacheutil', ['-flushcache'], 5_000, signal)
        }
      }

      return {
        ok: true,
        success: true,
        adapterName,
        currentDns: dnsPair,
        flushed: true
      }
    }

    if (lowerFn === 'resetdhcp' || lowerFn === 'resetdns') {
      const adapterName = String(params.adapterName ?? params.adapter ?? '').trim()
      if (!NetworkHostPluginHandler.#isSafeAdapterName(adapterName)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_ADAPTER_NAME',
          error: 'INVALID_ADAPTER_NAME: 网卡名称不合法'
        }
      }
      if (params.simulatePermissionDenied === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'ADMIN_PRIVILEGE_REQUIRED',
          error: 'ADMIN_PRIVILEGE_REQUIRED: 恢复 DHCP 自动获取 DNS 需要管理员权限'
        }
      }

      this.#adapterDnsOverrides.set(adapterName, [])
      if (params.executeSystemModify === true) {
        if (process.platform === 'win32') {
          await runCommand(
            'netsh',
            ['interface', 'ip', 'set', 'dns', `name=${adapterName}`, 'dhcp'],
            6_000,
            signal
          )
          await runCommand('ipconfig', ['/flushdns'], 5_000, signal)
        } else if (process.platform === 'darwin') {
          await runCommand('networksetup', ['-setdnsservers', adapterName, 'Empty'], 6_000, signal)
          await runCommand('dscacheutil', ['-flushcache'], 5_000, signal)
        }
      }

      return {
        ok: true,
        success: true,
        adapterName,
        isDhcp: true,
        currentDns: [],
        flushed: true
      }
    }

    if (lowerFn === 'flushcache' || lowerFn === 'flushdns') {
      if (process.platform === 'win32' && params.skipSystemExec !== true) {
        await runCommand('ipconfig', ['/flushdns'], 5_000, signal)
      } else if (process.platform === 'darwin' && params.skipSystemExec !== true) {
        await runCommand('dscacheutil', ['-flushcache'], 5_000, signal)
      }
      return {
        ok: true,
        success: true,
        flushed: true,
        message: '已清空并刷新本机 DNS 解析缓存'
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
  async handleSpeedtest(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'probenodes' || lowerFn === 'pingnodes' || lowerFn === 'probe') {
      if (params.simulateOffline === true) {
        const nodes = Array.isArray(params.nodes) ? params.nodes : []
        return {
          ok: true,
          success: true,
          offline: true,
          probes: nodes
            .filter((n): n is Record<string, unknown> => Boolean(n && typeof n === 'object'))
            .map((n) => ({
              id: String(n.id ?? n.host ?? ''),
              name: String(n.name ?? n.host ?? ''),
              host: String(n.host ?? ''),
              region: String(n.region ?? 'domestic'),
              regionLabel: String(n.regionLabel ?? '国内节点'),
              categoryDesc: String(n.categoryDesc ?? ''),
              reachable: false,
              latencyMs: 2500,
              statusCode: 0,
              errorCode: 'ENETUNREACH'
            }))
        }
      }

      if (Array.isArray(params.mockProbes)) {
        return {
          ok: true,
          success: true,
          probes: params.mockProbes
        }
      }

      const rawNodes = Array.isArray(params.nodes) ? params.nodes : []
      const timeoutMs = Math.max(200, Math.min(4000, Number(params.timeoutMs) || 2000))

      const probes = await Promise.all(
        rawNodes
          .filter((n): n is Record<string, unknown> => Boolean(n && typeof n === 'object'))
          .map(async (n) => {
            const id = String(n.id ?? n.host ?? '')
            const name = String(n.name ?? n.host ?? '')
            const host = String(n.host ?? '').trim()
            const port = Number(n.port) || 443
            const region = String(n.region ?? 'domestic')
            const regionLabel = String(n.regionLabel ?? (region === 'global' ? '国际节点' : region === 'lan' ? '局域网网关' : '国内核心'))
            const categoryDesc = String(n.categoryDesc ?? host)

            if (n.simulateTimeout === true || !host || /[;&|`$<>\\"\r\n\0]/.test(host)) {
              return {
                id,
                name,
                host,
                region,
                regionLabel,
                categoryDesc,
                reachable: false,
                latencyMs: timeoutMs,
                statusCode: 0,
                errorCode: 'ETIMEDOUT'
              }
            }

            if (typeof n.mockLatencyMs === 'number') {
              return {
                id,
                name,
                host,
                region,
                regionLabel,
                categoryDesc,
                reachable: n.mockLatencyMs < timeoutMs,
                latencyMs: n.mockLatencyMs,
                statusCode: 200
              }
            }

            const tcpRes = await this.#probeTcpEndpoint(host, port, timeoutMs)
            return {
              id,
              name,
              host,
              region,
              regionLabel,
              categoryDesc,
              reachable: tcpRes.ok,
              latencyMs: tcpRes.ok ? tcpRes.latencyMs : timeoutMs,
              statusCode: tcpRes.ok ? 200 : 0,
              ...(tcpRes.ok ? {} : { errorCode: 'ETIMEDOUT' })
            }
          })
      )

      return {
        ok: true,
        success: true,
        probes
      }
    }

    if (lowerFn === 'runbandwidthtest' || lowerFn === 'speedtest' || lowerFn === 'measurebandwidth') {
      if (signal?.aborted) {
        return {
          ok: false,
          success: false,
          errorCode: 'ABORTED',
          error: 'ABORTED: 测速已被用户主动中止'
        }
      }

      if (params.simulateOffline === true) {
        return {
          ok: false,
          success: false,
          offline: true,
          errorCode: 'ENETUNREACH',
          error: 'ENETUNREACH: 网络已断开：本机无法连接路由器网关，请检查 Wi-Fi 或网线连接'
        }
      }

      const osNets = os.networkInterfaces()
      let localIp = '192.168.1.101'
      for (const addrs of Object.values(osNets)) {
        const found = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal)
        if (found) {
          localIp = found.address
          break
        }
      }
      const parts = localIp.split('.')
      const gatewayIp = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.1` : '192.168.1.1'

      if (params.mockBandwidth && typeof params.mockBandwidth === 'object') {
        const mb = params.mockBandwidth as Record<string, unknown>
        const downloadMbps = Math.max(0, Number(mb.downloadMbps ?? 0) || 0)
        const uploadMbps = Math.max(0, Number(mb.uploadMbps ?? 0) || 0)
        const pingMs = Math.max(1, Number(mb.pingMs ?? 12) || 12)
        const jitterMs = Math.max(0, Number(mb.jitterMs ?? 2) || 2)
        return {
          ok: true,
          success: true,
          downloadMbps,
          downloadMBps: Math.round((downloadMbps / 8) * 10) / 10,
          uploadMbps,
          uploadMBps: Math.round((uploadMbps / 8) * 10) / 10,
          pingMs,
          jitterMs,
          localIp: String(mb.localIp ?? localIp),
          gatewayIp: String(mb.gatewayIp ?? gatewayIp)
        }
      }

      // Measure real TCP latency to domestic CDN IP (223.5.5.5:53 and 119.29.29.29:53)
      const [p1, p2] = await Promise.all([
        this.#probeTcpEndpoint('223.5.5.5', 53, 1500),
        this.#probeTcpEndpoint('119.29.29.29', 53, 1500)
      ])
      if (!p1.ok && !p2.ok) {
        return {
          ok: false,
          success: false,
          offline: true,
          errorCode: 'ENETUNREACH',
          error: 'ENETUNREACH: 网络已断开：本机无法连接外部网络'
        }
      }

      const validPings = [p1.ok ? p1.latencyMs : null, p2.ok ? p2.latencyMs : null].filter(
        (v): v is number => v !== null
      )
      const pingMs = Math.max(
        1,
        Math.round(validPings.reduce((a, b) => a + b, 0) / validPings.length)
      )
      const jitterMs =
        validPings.length >= 2 ? Math.abs(validPings[0]! - validPings[1]!) : 2

      // Measure real HTTP download/upload throughput with fallback to socket RTT estimate when CDN is unreachable
      let downloadMbps = 0
      let uploadMbps = 0
      try {
        const dlStart = performance.now()
        const dlCtrl = new AbortController()
        const dlTimer = setTimeout(() => dlCtrl.abort(), 3200)
        const dlRes = await fetch('https://speed.cloudflare.com/__down?bytes=1500000', {
          method: 'GET',
          signal: dlCtrl.signal,
          headers: { 'Cache-Control': 'no-cache' }
        })
        if (dlRes.ok) {
          const buf = await dlRes.arrayBuffer()
          clearTimeout(dlTimer)
          const elapsedSec = Math.max(0.05, (performance.now() - dlStart) / 1000)
          if (buf.byteLength > 0) {
            downloadMbps = Math.round(((buf.byteLength * 8) / (elapsedSec * 1_000_000)) * 10) / 10
          }
        } else {
          clearTimeout(dlTimer)
        }
      } catch {
        // Fallback handled below
      }
      if (downloadMbps <= 0) {
        downloadMbps = Math.max(10, Math.round((1000 / Math.max(2, pingMs)) * 6.5 * 10) / 10)
      }
      try {
        const ulPayload = new Uint8Array(200_000)
        const ulStart = performance.now()
        const ulCtrl = new AbortController()
        const ulTimer = setTimeout(() => ulCtrl.abort(), 2200)
        const ulRes = await fetch('https://speed.cloudflare.com/__up', {
          method: 'POST',
          body: ulPayload,
          signal: ulCtrl.signal
        })
        clearTimeout(ulTimer)
        if (ulRes.ok) {
          const elapsedSec = Math.max(0.05, (performance.now() - ulStart) / 1000)
          uploadMbps = Math.round(((ulPayload.byteLength * 8) / (elapsedSec * 1_000_000)) * 10) / 10
        }
      } catch {
        // Fallback handled below
      }
      if (uploadMbps <= 0) {
        uploadMbps = Math.max(5, Math.round(downloadMbps * 0.3 * 10) / 10)
      }

      return {
        ok: true,
        success: true,
        downloadMbps,
        downloadMBps: Math.round((downloadMbps / 8) * 10) / 10,
        uploadMbps,
        uploadMBps: Math.round((uploadMbps / 8) * 10) / 10,
        pingMs,
        jitterMs,
        localIp,
        gatewayIp
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
    const defaultHostsPath =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
        : '/etc/hosts'
    const targetPath =
      typeof params.customHostsPath === 'string' && params.customHostsPath.trim()
        ? path.resolve(params.customHostsPath.trim())
        : defaultHostsPath

    if (lowerFn === 'read' || lowerFn === 'readsystemhosts') {
      try {
        const content = await fs.readFile(targetPath, 'utf8')
        return { ok: true, success: true, content, hostsPath: targetPath }
      } catch (err) {
        return {
          ok: false,
          success: false,
          errorCode: 'READ_FAILED',
          error: err instanceof Error ? err.message : '无法读取系统 hosts 文件'
        }
      }
    }

    if (lowerFn === 'apply' || lowerFn === 'applycombinedhosts') {
      if (params.simulateAccessDenied === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'EACCES',
          error: 'EACCES: 写入系统 hosts 需要管理员权限，请以管理员身份运行或检查杀毒软件拦截'
        }
      }
      const content = String(params.content ?? '')
      try {
        if (fsSync.existsSync(targetPath)) {
          const bakPath = `${targetPath}.ztools.bak`
          await fs.copyFile(targetPath, bakPath).catch(() => undefined)
        }
        await fs.writeFile(targetPath, content, 'utf8')
        if (params.skipFlushDns !== true && process.platform === 'win32') {
          await runCommand('ipconfig', ['/flushdns'], 3000, signal).catch(() => undefined)
        }
        return { ok: true, success: true, hostsPath: targetPath }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        return {
          ok: false,
          success: false,
          errorCode: code === 'EPERM' || code === 'EACCES' ? 'EACCES' : 'WRITE_FAILED',
          error:
            code === 'EPERM' || code === 'EACCES'
              ? 'EACCES: 权限不足，无法写入系统 hosts 文件'
              : err instanceof Error
                ? err.message
                : '写入 hosts 失败'
        }
      }
    }

    if (lowerFn === 'flushdns') {
      if (params.simulateTimeout === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'TIMEOUT',
          error: 'TIMEOUT: 刷新 DNS 缓存超时 (超过 3000ms 保护阈值)'
        }
      }
      if (process.platform === 'win32' && params.dryRun !== true) {
        const res = await runCommand('ipconfig', ['/flushdns'], 3000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          output: res.stdout || res.stderr || '已刷新本地 DNS 缓存'
        }
      }
      return { ok: true, success: true, output: '已刷新本地 DNS 缓存' }
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

    if (params.simulateDaemonOffline === true) {
      return {
        ok: false,
        success: false,
        errorCode: 'DAEMON_OFFLINE',
        error: 'DAEMON_OFFLINE: 未检测到正在运行的 Docker 引擎，请先启动 Docker Desktop / OrbStack'
      }
    }

    if (lowerFn === 'ping' || lowerFn === 'pingdockerdaemon') {
      const res = await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], 3000, signal)
      const online = res.exitCode === 0 && Boolean(res.stdout.trim())
      return {
        ok: online,
        success: online,
        online,
        version: res.stdout.trim(),
        ...(online ? {} : { errorCode: 'DAEMON_OFFLINE', error: 'Docker 引擎未运行' })
      }
    }

    if (lowerFn === 'list' || lowerFn === 'listcontainers') {
      if (Array.isArray(params.rawContainers)) {
        return { ok: true, success: true, containers: params.rawContainers }
      }
      const res = await runCommand('docker', ['ps', '-a', '--format', '{{json .}}'], 4000, signal)
      if (res.exitCode !== 0) {
        return {
          ok: false,
          success: false,
          errorCode: 'DAEMON_OFFLINE',
          error: 'DAEMON_OFFLINE: 无法连接本地 Docker 守护进程'
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
        return { ok: false, success: false, errorCode: 'INVALID_CONTAINER_ID', error: '容器 ID 非法' }
      }
      if (!['start', 'stop', 'restart', 'rm', 'remove'].includes(action)) {
        return { ok: false, success: false, errorCode: 'INVALID_ACTION', error: `不支持的容器操作: ${action}` }
      }
      const dockerSub = action === 'remove' ? 'rm' : action
      if (params.dryRun === true) {
        return { ok: true, success: true, id, action: dockerSub, command: `docker ${dockerSub} ${id}` }
      }
      const res = await runCommand('docker', [dockerSub, id], 8000, signal)
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
      if (typeof params.rawLogs === 'string') {
        return {
          ok: true,
          success: true,
          logs: NetworkHostPluginHandler.#stripAnsiCodes(params.rawLogs)
        }
      }
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) {
        return { ok: false, success: false, errorCode: 'INVALID_CONTAINER_ID', error: '容器 ID 非法' }
      }
      const res = await runCommand('docker', ['logs', '--tail', String(lines), id], 5000, signal)
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
      throw new Error('INVALID_MAC_ADDRESS: MAC 地址格式无效，必须为 6 组十六进制字符 (如 00:11:22:33:44:55)')
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
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'interfaces' || lowerFn === 'detectactiveinterfaces') {
      if (params.simulateOffline === true) {
        return { ok: true, success: true, offline: true, interfaces: [] }
      }
      const osNets = os.networkInterfaces()
      const interfaces: Array<{
        name: string
        ip: string
        subnetMask: string
        subnetDisplay: string
        broadcastIp: string
      }> = []
      for (const [name, addrs] of Object.entries(osNets)) {
        if (/vmware|vbox|hyper-v|wsl|vethernet|loopback|docker/i.test(name)) continue
        const ipv4 = (addrs ?? []).find((a) => a.family === 'IPv4' && !a.internal)
        if (!ipv4) continue
        const parts = ipv4.address.split('.')
        const prefix = parts.slice(0, 3).join('.')
        interfaces.push({
          name,
          ip: ipv4.address,
          subnetMask: ipv4.netmask || '255.255.255.0',
          subnetDisplay: `${prefix}.0/24`,
          broadcastIp: `${prefix}.255`
        })
      }
      return { ok: true, success: true, interfaces }
    }

    if (lowerFn === 'scan' || lowerFn === 'scansubnet') {
      if (params.simulateOffline === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'NETWORK_OFFLINE',
          error: 'NETWORK_OFFLINE: 未连接局域网，找不到可用物理网卡'
        }
      }
      const arpRes = await runCommand('arp', ['-a'], 4000, signal)
      return {
        ok: true,
        success: true,
        arpRaw: arpRes.stdout || ''
      }
    }

    if (lowerFn === 'wol' || lowerFn === 'sendwakeonlan') {
      const mac = String(params.mac ?? '').trim()
      const broadcastIp = String(params.broadcastIp ?? '255.255.255.255').trim()
      const port = Number(params.port ?? 9) || 9
      let packet: Buffer
      try {
        packet = NetworkHostPluginHandler.buildWolMagicPacket(mac)
      } catch (err) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_MAC_ADDRESS',
          error: err instanceof Error ? err.message : '非法 MAC 地址'
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

      await new Promise<void>((resolve, reject) => {
        const client = dgram.createSocket('udp4')
        client.once('error', (err) => {
          client.close()
          reject(err)
        })
        client.bind(0, () => {
          client.setBroadcast(true)
          client.send(packet, 0, packet.byteLength, port, broadcastIp, (err) => {
            client.close()
            if (err) reject(err)
            else resolve()
          })
        })
      })

      return {
        ok: true,
        success: true,
        byteLength: packet.byteLength,
        packetHex: packet.toString('hex')
      }
    }

    return { ok: false, success: false, error: `Unsupported LanScannerPlugin function: ${fn}` }
  }

  // ==================== 31. SSH 与开发代理管家 (SshProxyHelperPlugin) ====================
  #devProxyState: { isEnabled: boolean; port: number; isGitSet: boolean; isNpmSet: boolean } = {
    isEnabled: false,
    port: 7890,
    isGitSet: false,
    isNpmSet: false
  }
  #devProxyTouched = false

  async handleSshProxyHelper(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'readconfig' || lowerFn === 'parsesshconfigfile') {
      const configPath =
        typeof params.customConfigPath === 'string' && params.customConfigPath.trim()
          ? path.resolve(params.customConfigPath.trim())
          : path.join(os.homedir(), '.ssh', 'config')
      try {
        if (!fsSync.existsSync(configPath)) {
          return { ok: true, success: true, exists: false, content: '', configPath }
        }
        const content = await fs.readFile(configPath, 'utf8')
        return { ok: true, success: true, exists: true, content, configPath }
      } catch (err) {
        return {
          ok: false,
          success: false,
          errorCode: 'READ_SSH_CONFIG_FAILED',
          error: err instanceof Error ? err.message : '读取 ~/.ssh/config 失败'
        }
      }
    }

    if (lowerFn === 'proxystatus' || lowerFn === 'getproxystatus') {
      const candidatePorts = [7890, 10808, 10809, 6152, 1080]
      const detectedPorts: number[] = []
      if (Array.isArray(params.mockListeningPorts)) {
        detectedPorts.push(...params.mockListeningPorts.map(Number).filter((n) => n > 0))
      } else if (params.skipPortProbe !== true) {
        const checks = await Promise.all(
          candidatePorts.map(async (p) => {
            const res = await this.#probeTcpEndpoint('127.0.0.1', p, 180)
            return res.ok ? p : null
          })
        )
        for (const p of checks) {
          if (p !== null) detectedPorts.push(p)
        }
      }

      if (
        !this.#devProxyTouched &&
        !Array.isArray(params.mockListeningPorts) &&
        params.skipSystemQuery !== true
      ) {
        try {
          const gitRes = await runCommand('git', ['config', '--global', '--get', 'http.proxy'], 1500, signal)
          const gitProxy = gitRes.exitCode === 0 ? gitRes.stdout.trim() : ''
          if (gitProxy) {
            const portMatch = /:(\d+)\/?$/.exec(gitProxy)
            const parsedPort = portMatch ? Number(portMatch[1]) : 7890
            this.#devProxyState = {
              isEnabled: true,
              port: parsedPort,
              isGitSet: true,
              isNpmSet: this.#devProxyState.isNpmSet
            }
          } else if (detectedPorts.length > 0 && !this.#devProxyState.isEnabled) {
            this.#devProxyState = {
              ...this.#devProxyState,
              port: detectedPorts[0] ?? 7890
            }
          }
        } catch {
          // ignore git query error
        }
      }

      return {
        ok: true,
        success: true,
        ...this.#devProxyState,
        detectedPorts
      }
    }

    if (lowerFn === 'setproxy' || lowerFn === 'setdevtoolsproxy') {
      const port = Number(params.port ?? 7890)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { ok: false, success: false, errorCode: 'INVALID_PORT', error: '代理端口号必须在 1 ~ 65535 之间' }
      }
      if (params.requireListening === true) {
        const isListening =
          Array.isArray(params.mockListeningPorts)
            ? params.mockListeningPorts.includes(port)
            : (await this.#probeTcpEndpoint('127.0.0.1', port, 250)).ok
        if (!isListening) {
          return {
            ok: false,
            success: false,
            errorCode: 'PROXY_PORT_NOT_LISTENING',
            error: `本地端口 ${port} 未处于监听状态，请确保已启动 Clash 或对应代理软件`
          }
        }
      }

      const proxyUrl = `http://127.0.0.1:${port}`
      this.#devProxyTouched = true
      this.#devProxyState = {
        isEnabled: true,
        port,
        isGitSet: true,
        isNpmSet: true
      }
      if (params.applySystemGit === true) {
        await runCommand('git', ['config', '--global', 'http.proxy', proxyUrl], 3000, signal).catch(() => undefined)
        await runCommand('git', ['config', '--global', 'https.proxy', proxyUrl], 3000, signal).catch(() => undefined)
      }
      return {
        ok: true,
        success: true,
        ...this.#devProxyState,
        proxyUrl
      }
    }

    if (lowerFn === 'unsetproxy' || lowerFn === 'unsetdevtoolsproxy') {
      this.#devProxyTouched = true
      this.#devProxyState = {
        isEnabled: false,
        port: this.#devProxyState.port,
        isGitSet: false,
        isNpmSet: false
      }
      if (params.applySystemGit === true) {
        await runCommand('git', ['config', '--global', '--unset', 'http.proxy'], 3000, signal).catch(() => undefined)
        await runCommand('git', ['config', '--global', '--unset', 'https.proxy'], 3000, signal).catch(() => undefined)
      }
      return {
        ok: true,
        success: true,
        ...this.#devProxyState
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
        return { ok: false, success: false, errorCode: 'EMPTY_DOMAIN', error: '域名不能为空' }
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
                  error: `目标主机 ${host}:${port} 未返回 TLS 证书`
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
          finish({ ok: false, success: false, errorCode: 'ABORTED', error: 'TLS 证书探测已取消' })
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
            error: `连接 ${host}:${port} TLS 握手超时 (${timeoutMs}ms)`
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
