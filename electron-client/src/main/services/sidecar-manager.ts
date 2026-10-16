import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

export type SidecarState = 'stopped' | 'starting' | 'running' | 'restarting' | 'degraded'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface ActiveWindowInfo {
  active: boolean
  hwnd: number
  title: string
  pid: number
  process_name: string
  process_path: string
}

export interface SelectedTextInfo {
  text: string
  source: string
}

export interface BrowserUrlInfo {
  found: boolean
  url: string
  browser: string
}

export interface FileRecord {
  name: string
  path: string
  is_dir: boolean
  size: number
  mtime: number
  acronym: string
  pinyin: string
}

export interface SearchFilesResult {
  files: FileRecord[]
  count: number
  total_matches: number
  elapsed_us: number
  elapsed_ms: number
  total_indexed: number
  degraded?: boolean
}

export interface IndexPathResult {
  total_indexed: number
  scanner_used: string
  elapsed_ms: number
}

export interface MockDatasetResult {
  total_indexed: number
  elapsed_ms: number
}

export interface IndexerStatsResult {
  total_indexed: number
  index_type: string
}

export interface SidecarProcessOptions {
  name: string
  binaryName: string
  fallbackBinaryName?: string
  args?: string[]
  cwd?: string
  heartbeatIntervalMs?: number
  maxRestartsWithinWindow?: number
  restartWindowMs?: number
}

export class ManagedSidecarProcess {
  public state: SidecarState = 'stopped'
  public child: ChildProcess | null = null
  public pid: number | null = null
  public lastError: string | null = null
  public restartCount = 0

  private nextRequestId = 1
  private pendingRequests = new Map<number | string, {
    resolve: (res: any) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()

  private heartbeatTimer: NodeJS.Timeout | null = null
  private restartTimestamps: number[] = []
  private intentionallyStopped = false
  private rl: readline.Interface | null = null

  constructor(public readonly options: SidecarProcessOptions) {}

  public async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return
    this.intentionallyStopped = false
    this.state = 'starting'

    const binaryPath = this.resolveBinaryPath(this.options.binaryName)
    if (!binaryPath) {
      // Check fallback binary if available
      if (this.options.fallbackBinaryName) {
        const fallbackPath = this.resolveBinaryPath(this.options.fallbackBinaryName)
        if (fallbackPath) {
          await this.spawnProcess(fallbackPath)
          return
        }
      }
      this.state = 'degraded'
      this.lastError = `Binary not found: ${this.options.binaryName}`
      return
    }

    try {
      await this.spawnProcess(binaryPath)
    } catch (err) {
      // If primary binary fails (e.g. EACCES on uiAccess manifest), try fallback binary
      if (this.options.fallbackBinaryName) {
        const fallbackPath = this.resolveBinaryPath(this.options.fallbackBinaryName)
        if (fallbackPath && fallbackPath !== binaryPath) {
          try {
            await this.spawnProcess(fallbackPath)
            return
          } catch (fallbackErr) {
            this.lastError = String(fallbackErr)
          }
        }
      }
      this.state = 'degraded'
      this.lastError = String(err)
    }
  }

  private resolveBinaryPath(name: string): string | null {
    const envKey = `ZTOOLS_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`
    if (process.env[envKey] && fs.existsSync(process.env[envKey])) {
      return process.env[envKey]!
    }

    const appRoot = path.resolve(__dirname, '..', '..', '..')
    const candidates = [
      path.join(appRoot, 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(appRoot, 'resources', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(process.cwd(), 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(process.cwd(), 'electron-client', 'out', 'native', 'win32-x64', 'bin', `${name}.exe`)
    ]

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c
      }
    }
    return null
  }

  private spawnProcess(executablePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false

      try {
        const sessionToken = crypto.randomBytes(24).toString('hex')
        const child = spawn(executablePath, this.options.args || [], {
          cwd: this.options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            ZTOOLS_SIDECAR_TOKEN: sessionToken
          }
        })

        this.child = child
        this.pid = child.pid ?? null

        child.on('error', (err) => {
          this.lastError = err.message
          if (!settled) {
            settled = true
            reject(err)
          } else {
            this.handleUnexpectedExit()
          }
        })

        child.on('exit', (code, signal) => {
          this.handleExit(code, signal)
          if (!settled) {
            settled = true
            reject(new Error(`Sidecar exited prematurely with code ${code}, signal ${signal}`))
          }
        })

        if (!child.stdout || !child.stdin) {
          throw new Error('Failed to attach stdio pipes')
        }

        this.rl = readline.createInterface({ input: child.stdout })
        this.rl.on('line', (line) => {
          this.handleRpcLine(line)
        })

        // Verify with initial handshake & ping
        setTimeout(async () => {
          try {
            await this.sendRequest('handshake', { token: sessionToken }, 3000)
            await this.sendRequest('ping', {}, 3000)
            this.state = 'running'
            this.startHeartbeat()
            if (!settled) {
              settled = true
              resolve()
            }
          } catch (handshakeErr) {
            if (!settled) {
              settled = true
              reject(handshakeErr)
            }
          }
        }, 100)
      } catch (err) {
        if (!settled) {
          settled = true
          reject(err)
        }
      }
    })
  }

  public async stop(): Promise<void> {
    this.intentionallyStopped = true
    this.stopHeartbeat()
    this.clearPendingRequests(new Error('Sidecar stopped'))

    if (this.child && !this.child.killed) {
      try {
        await this.sendRequest('shutdown', {}, 1000).catch(() => {})
      } catch {
        // Ignore shutdown error
      }
      this.child.kill('SIGTERM')
      this.child = null
    }

    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    this.state = 'stopped'
    this.pid = null
  }

  public async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  public sendRequest<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    if (this.state !== 'running' && this.state !== 'starting') {
      return Promise.reject(new Error(`Cannot send request, sidecar is in ${this.state} state`))
    }

    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Sidecar stdin is not writable'))
    }

    const id = this.nextRequestId++
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      try {
        const payload = JSON.stringify(req) + '\n'
        this.child!.stdin!.write(payload)
      } catch (writeErr) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(writeErr as Error)
      }
    })
  }

  private handleRpcLine(line: string) {
    if (!line || !line.trim()) return
    try {
      const msg: JsonRpcResponse = JSON.parse(line)
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const req = this.pendingRequests.get(msg.id)!
        this.pendingRequests.delete(msg.id)
        clearTimeout(req.timer)

        if (msg.error) {
          req.reject(new Error(`RPC Error [${msg.error.code}]: ${msg.error.message}`))
        } else {
          req.resolve(msg.result)
        }
      }
    } catch {
      // Ignore unparseable non-JSON-RPC lines
    }
  }

  private handleExit(_code: number | null, _signal: NodeJS.Signals | null) {
    this.stopHeartbeat()
    this.pid = null
    this.child = null

    if (this.intentionallyStopped) {
      this.state = 'stopped'
      return
    }

    this.handleUnexpectedExit()
  }

  private handleUnexpectedExit() {
    this.clearPendingRequests(new Error('Sidecar process exited unexpectedly'))

    const now = Date.now()
    const windowMs = this.options.restartWindowMs || 60000
    const maxRestarts = this.options.maxRestartsWithinWindow || 5

    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < windowMs)
    this.restartTimestamps.push(now)
    this.restartCount++

    if (this.restartTimestamps.length > maxRestarts) {
      console.warn(`[Sidecar:${this.options.name}] Max restarts exceeded (${maxRestarts} within ${windowMs}ms). Degrading.`)
      this.state = 'degraded'
      return
    }

    const backoffMs = Math.min(500 * Math.pow(2, this.restartTimestamps.length - 1), 5000)
    console.info(`[Sidecar:${this.options.name}] Process crashed. Restarting in ${backoffMs}ms (attempt ${this.restartTimestamps.length}/${maxRestarts})...`)
    this.state = 'restarting'

    setTimeout(() => {
      if (!this.intentionallyStopped) {
        this.start().catch(err => {
          console.error(`[Sidecar:${this.options.name}] Failed to auto-restart:`, err)
        })
      }
    }, backoffMs)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    const interval = this.options.heartbeatIntervalMs || 15000
    this.heartbeatTimer = setInterval(async () => {
      if (this.state === 'running') {
        try {
          await this.sendRequest('ping', {}, 3000)
        } catch (err) {
          console.warn(`[Sidecar:${this.options.name}] Heartbeat failed:`, err)
          this.handleUnexpectedExit()
        }
      }
    }, interval)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPendingRequests(err: Error) {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer)
      req.reject(err)
    }
    this.pendingRequests.clear()
  }
}

export class SidecarManager {
  private uiaccessProcess: ManagedSidecarProcess
  private indexerProcess: ManagedSidecarProcess

  // In-memory fallback dataset for degraded indexer mode
  private fallbackFiles: FileRecord[] = []

  constructor() {
    this.uiaccessProcess = new ManagedSidecarProcess({
      name: 'ztools-uiaccess',
      binaryName: 'ztools-uiaccess',
      fallbackBinaryName: 'ztools-uiaccess-standard',
      heartbeatIntervalMs: 15000
    })

    this.indexerProcess = new ManagedSidecarProcess({
      name: 'ztools-indexer',
      binaryName: 'ztools-indexer',
      heartbeatIntervalMs: 15000
    })
  }

  public async startAll(): Promise<void> {
    await Promise.allSettled([
      this.uiaccessProcess.start(),
      this.indexerProcess.start()
    ])
  }

  public async stop(): Promise<void> {
    await Promise.allSettled([
      this.uiaccessProcess.stop(),
      this.indexerProcess.stop()
    ])
  }

  public getStatus() {
    return {
      uiaccess: {
        state: this.uiaccessProcess.state,
        pid: this.uiaccessProcess.pid,
        restarts: this.uiaccessProcess.restartCount,
        lastError: this.uiaccessProcess.lastError
      },
      indexer: {
        state: this.indexerProcess.state,
        pid: this.indexerProcess.pid,
        restarts: this.indexerProcess.restartCount,
        lastError: this.indexerProcess.lastError
      }
    }
  }

  // --- UIAccess Methods with Graceful Degradation ---

  public async getActiveWindow(): Promise<ActiveWindowInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<ActiveWindowInfo>('get_active_window', {})
      } catch (err) {
        console.warn('[SidecarManager] getActiveWindow RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      active: false,
      hwnd: 0,
      title: 'Degraded / No Active Window',
      pid: 0,
      process_name: '',
      process_path: ''
    }
  }

  public async getSelectedText(): Promise<SelectedTextInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<SelectedTextInfo>('get_selected_text', {})
      } catch (err) {
        console.warn('[SidecarManager] getSelectedText RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      text: '',
      source: 'degraded_fallback'
    }
  }

  public async getBrowserUrl(): Promise<BrowserUrlInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<BrowserUrlInfo>('get_browser_url', {})
      } catch (err) {
        console.warn('[SidecarManager] getBrowserUrl RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      found: false,
      url: '',
      browser: 'none'
    }
  }

  public async setMockState(state: Record<string, unknown>): Promise<boolean> {
    if (this.uiaccessProcess.state === 'running') {
      return await this.uiaccessProcess.sendRequest<boolean>('set_mock_state', state)
    }
    return false
  }

  public async manageWindow(action: string): Promise<{ success: boolean; action: string; rect?: any; error?: string }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('manage_window', { action })
      } catch (err: any) {
        console.warn('[SidecarManager] manage_window RPC failed:', err)
        return { success: false, action, error: err.message || String(err) }
      }
    }
    return { success: false, action, error: 'UIAccess sidecar is not running' }
  }

  public async setSnippets(snippets: any[]): Promise<any> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('set_snippets', { snippets })
      } catch (err: any) {
        console.warn('[SidecarManager] set_snippets RPC failed:', err)
      }
    }
    return { success: false, count: 0 }
  }

  public async pasteToActive(targetHwnd = 0): Promise<{ success: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean }>('paste_to_active', { target_hwnd: targetHwnd })
      } catch (err: any) {
        console.warn('[SidecarManager] paste_to_active RPC failed:', err)
      }
    }
    return { success: false }
  }

  public async trimProcessMemory(pid = 0): Promise<{ success: boolean; pid: number; trimmed: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean; pid: number; trimmed: boolean }>('trim_process_memory', { pid })
      } catch (err: any) {
        console.warn('[SidecarManager] trim_process_memory RPC failed:', err)
      }
    }
    return { success: false, pid, trimmed: false }
  }

  // --- Indexer Methods with Graceful Degradation ---

  public async searchFiles(query: string, limit = 50): Promise<SearchFilesResult> {
    const trimmed = String(query || '').trim()
    if (trimmed.toLowerCase().startsWith('dir:')) {
      const targetDir = trimmed.slice(4).trim()
      if (targetDir) {
        return await this.scanDirectoryTreeReal(targetDir, limit)
      }
    }

    if (this.indexerProcess.state === 'running') {
      try {
        return await this.indexerProcess.sendRequest<SearchFilesResult>('search_files', { query, limit })
      } catch (err) {
        console.warn('[SidecarManager] searchFiles RPC failed, falling back:', err)
      }
    }

    // Degraded fallback: in-memory JavaScript search
    const t0 = performance.now()
    const qLower = query.toLowerCase()
    const matches: FileRecord[] = []

    for (const f of this.fallbackFiles) {
      if (f.name.toLowerCase().includes(qLower) || f.acronym.includes(qLower)) {
        matches.push(f)
        if (matches.length >= limit) break
      }
    }
    const elapsedMs = performance.now() - t0

    return {
      files: matches,
      count: matches.length,
      total_matches: matches.length,
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: this.fallbackFiles.length,
      degraded: true
    }
  }

  private async scanDirectoryTreeReal(
    rootDir: string,
    limit: number,
    maxEntries = 2000
  ): Promise<SearchFilesResult & { total_bytes?: number; subdirs?: Array<{ name: string; path: string; fileCount: number; sizeBytes: number }> }> {
    const t0 = performance.now()
    const resolvedRoot = path.resolve(rootDir)
    if (!fs.existsSync(resolvedRoot)) {
      return {
        files: [],
        count: 0,
        total_matches: 0,
        total_bytes: 0,
        subdirs: [],
        elapsed_us: 0,
        elapsed_ms: 0,
        total_indexed: 0
      }
    }

    const visitedReal = new Set<string>()
    const subdirStats = new Map<string, { name: string; path: string; fileCount: number; sizeBytes: number; topFiles: FileRecord[] }>()
    const allTopFiles: FileRecord[] = []
    let totalFiles = 0
    let totalBytes = 0
    let visitedCount = 0

    const queue: Array<{ dirPath: string; topSubdir: string; isSymlink?: boolean }> = [
      { dirPath: resolvedRoot, topSubdir: '', isSymlink: true }
    ]

    while (queue.length > 0 && visitedCount < maxEntries) {
      const current = queue.shift()!
      let realCurrent = current.dirPath
      if (current.isSymlink) {
        try {
          realCurrent = await fs.promises.realpath(current.dirPath)
        } catch {
          // keep original path if realpath fails
        }
      }
      const realKey = realCurrent.toLowerCase()
      if (visitedReal.has(realKey)) continue
      visitedReal.add(realKey)

      let entries: fs.Dirent[] = []
      try {
        entries = await fs.promises.readdir(current.dirPath, { withFileTypes: true })
      } catch {
        continue
      }

      for (const ent of entries) {
        visitedCount++
        if (visitedCount > maxEntries) break
        const fullPath = path.join(current.dirPath, ent.name)
        const topSub = current.topSubdir || ent.name

        const isSym = ent.isSymbolicLink()
        let isDir = ent.isDirectory()
        let isFile = ent.isFile()
        let statObj: fs.Stats | null = null

        if (isSym || isFile) {
          try {
            statObj = await fs.promises.stat(fullPath)
            isDir = statObj.isDirectory()
            isFile = statObj.isFile()
          } catch {
            continue
          }
        }

        if (isDir) {
          const lowerName = ent.name.toLowerCase()
          if (
            lowerName === '$recycle.bin' ||
            lowerName === 'system volume information' ||
            lowerName === 'node_modules' ||
            lowerName === '.git'
          ) {
            continue
          }
          if (!current.topSubdir && !subdirStats.has(topSub)) {
            subdirStats.set(topSub, {
              name: topSub,
              path: fullPath,
              fileCount: 0,
              sizeBytes: 0,
              topFiles: []
            })
          }
          queue.push({ dirPath: fullPath, topSubdir: topSub, isSymlink: isSym })
        } else if (isFile && statObj) {
          const sz = Number(statObj.size || 0)
          const mtimeMs = Math.round(Number(statObj.mtimeMs || Date.now()))
          totalFiles++
          totalBytes += sz

          const rec: FileRecord = {
            name: ent.name,
            path: fullPath,
            is_dir: false,
            size: sz,
            mtime: mtimeMs,
            acronym: ent.name.slice(0, 6).toLowerCase(),
            pinyin: ent.name.toLowerCase()
          }

          let subEntry = subdirStats.get(topSub)
          if (!subEntry) {
            subEntry = {
              name: topSub,
              path: path.join(resolvedRoot, topSub),
              fileCount: 0,
              sizeBytes: 0,
              topFiles: []
            }
            subdirStats.set(topSub, subEntry)
          }
          subEntry.fileCount++
          subEntry.sizeBytes += sz
          if (subEntry.topFiles.length < 40) {
            subEntry.topFiles.push(rec)
          } else {
            let minIdx = 0
            for (let i = 1; i < subEntry.topFiles.length; i++) {
              if (subEntry.topFiles[i]!.size < subEntry.topFiles[minIdx]!.size) {
                minIdx = i
              }
            }
            if (sz > subEntry.topFiles[minIdx]!.size) {
              subEntry.topFiles[minIdx] = rec
            }
          }

          if (allTopFiles.length < limit * 2) {
            allTopFiles.push(rec)
          } else if (sz > allTopFiles[allTopFiles.length - 1]!.size) {
            allTopFiles[allTopFiles.length - 1] = rec
            allTopFiles.sort((a, b) => b.size - a.size)
          }
        }
      }
    }

    const mergedMap = new Map<string, FileRecord>()
    const sortedSubdirs = Array.from(subdirStats.values()).sort((a, b) => b.sizeBytes - a.sizeBytes)
    for (const sub of sortedSubdirs) {
      sub.topFiles.sort((a, b) => b.size - a.size)
      for (const f of sub.topFiles.slice(0, 18)) {
        if (mergedMap.size < limit) {
          mergedMap.set(f.path, f)
        }
      }
    }
    allTopFiles.sort((a, b) => b.size - a.size)
    for (const f of allTopFiles) {
      if (mergedMap.size >= limit) break
      mergedMap.set(f.path, f)
    }

    const finalFiles = Array.from(mergedMap.values()).sort((a, b) => b.size - a.size).slice(0, limit)
    const elapsedMs = performance.now() - t0

    return {
      files: finalFiles,
      count: finalFiles.length,
      total_matches: totalFiles,
      total_bytes: totalBytes,
      subdirs: sortedSubdirs.map(({ name, path: p, fileCount, sizeBytes }) => ({
        name,
        path: p,
        fileCount,
        sizeBytes
      })),
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: totalBytes
    }
  }

  public async indexPath(targetPath: string, scanner: 'auto' | 'usn' | 'directory' = 'auto'): Promise<IndexPathResult> {
    if (this.indexerProcess.state === 'running') {
      try {
        return await this.indexerProcess.sendRequest<IndexPathResult>('index_path', { path: targetPath, scanner })
      } catch (err) {
        console.warn('[SidecarManager] indexPath RPC failed, falling back:', err)
      }
    }

    // Degraded fallback
    const t0 = performance.now()
    this.fallbackFiles = []
    try {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true, recursive: true })
      for (const ent of entries) {
        const fullPath = path.join(ent.parentPath || targetPath, ent.name)
        this.fallbackFiles.push({
          name: ent.name,
          path: fullPath,
          is_dir: ent.isDirectory(),
          size: 0,
          mtime: Date.now(),
          acronym: ent.name.slice(0, 4).toLowerCase(),
          pinyin: ent.name.toLowerCase()
        })
      }
    } catch {
      // Ignore readdir error in fallback
    }

    const elapsedMs = performance.now() - t0
    return {
      total_indexed: this.fallbackFiles.length,
      scanner_used: 'node_fs_degraded',
      elapsed_ms: elapsedMs
    }
  }

  public async generateMockDataset(count = 1000000): Promise<MockDatasetResult> {
    if (this.indexerProcess.state === 'running') {
      return await this.indexerProcess.sendRequest<MockDatasetResult>('generate_mock_dataset', { count })
    }
    return {
      total_indexed: 0,
      elapsed_ms: 0
    }
  }

  public async getStats(): Promise<IndexerStatsResult> {
    if (this.indexerProcess.state === 'running') {
      return await this.indexerProcess.sendRequest<IndexerStatsResult>('get_stats', {})
    }
    return {
      total_indexed: this.fallbackFiles.length,
      index_type: 'degraded_in_memory'
    }
  }
}
