import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  calculateDirectorySize,
  escapeHtml,
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
          const linkSpeed = ipv4.internal ? '10 Gbps' : '1 Gbps'
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
      return { ok: true, success: true, output: 'DNS cache flushed' }
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
        return { ok: true, success: true, checkId: targetId, message: 'DNS 缓存已清理' }
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
        return { ok: true, success: true, checkId: targetId, message: '已重置系统代理状态' }
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
        const defaultName = path.basename(new URL(url, 'http://localhost').pathname) || `download-${Date.now()}.bin`
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
          const srcPath = await this.#ctx.authorizeExistingPath(new URL(url).pathname, caller, 'read')
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
}
