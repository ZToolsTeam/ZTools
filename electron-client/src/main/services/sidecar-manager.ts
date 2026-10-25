import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  scanDirectoryForSearch,
  scanLocalRecentFiles,
  searchFilesOnMacos
} from '../platform/macos/file-indexer.js'
import {
  pasteToActiveWindowOnMac,
  setFrontmostWindowBounds,
  type MacosWindowBounds
} from '../platform/macos/window-controller.js'
import { expandSnippetMacros } from './snippets-service.js'

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
  display_name?: string
  kind?: 'application'
  name: string
  path: string
  is_dir: boolean
  size: number
  mtime: number
  acronym: string
  pinyin: string
}

export interface SubdirStatRecord {
  name: string
  path: string
  fileCount: number
  sizeBytes: number
  file_count?: number | undefined
  total_bytes?: number | undefined
  mtime?: number | undefined
  /** 体积不是完整统计（扫描截断且独立体积统计超时 / 无权限） */
  approximate?: boolean | undefined
}

export interface SearchFilesResult {
  query?: string | undefined
  limit?: number | undefined
  files: FileRecord[]
  count: number
  total_matches: number
  total_bytes?: number | undefined
  subdirs?: SubdirStatRecord[] | undefined
  elapsed_us: number
  elapsed_ms: number
  total_indexed: number
  degraded?: boolean | undefined
  source?: string | undefined
  /** Spotlight 查询超时或被新查询取消，只返回了已读到的部分结果 */
  partial?: boolean | undefined
  /** dir: 扫描达到条目上限停止，files / total_matches 只是已遍历部分 */
  truncated?: boolean | undefined
  /** dir: 扫描体积是近似值（截断后部分子目录体积未能完整统计） */
  approximate?: boolean | undefined
  visited_entries?: number | undefined
  max_entries?: number | undefined
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
    resolve: (res: unknown) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()

  private heartbeatTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
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
    const isWin = process.platform === 'win32'
    const binName = isWin ? `${name}.exe` : name
    const platformDirs = isWin
      ? ['win32-x64']
      : [`darwin-${process.arch}`, 'darwin-universal', 'darwin']
    const candidates: string[] = []
    for (const dir of platformDirs) {
      candidates.push(
        path.join(appRoot, 'out', 'native', dir, 'bin', binName),
        path.join(appRoot, 'resources', 'native', dir, 'bin', binName),
        path.join(process.cwd(), 'out', 'native', dir, 'bin', binName),
        path.join(process.cwd(), 'electron-client', 'out', 'native', dir, 'bin', binName)
      )
    }
    const legacyCandidates = [
      path.join(appRoot, 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(appRoot, 'resources', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(process.cwd(), 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(process.cwd(), 'electron-client', 'out', 'native', 'win32-x64', 'bin', `${name}.exe`)
    ]

    for (const c of [...candidates, ...legacyCandidates]) {
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
            if (this.rl) {
              this.rl.close()
              this.rl = null
            }
            if (this.child && !this.child.killed) {
              this.child.kill('SIGTERM')
              this.child = null
              this.pid = null
            }
            if (!settled) {
              settled = true
              reject(handshakeErr)
            }
          }
        }, 100)
      } catch (err) {
        if (this.rl) {
          this.rl.close()
          this.rl = null
        }
        if (this.child && !this.child.killed) {
          this.child.kill('SIGTERM')
          this.child = null
          this.pid = null
        }
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
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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

  public sendRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
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

      this.pendingRequests.set(id, { resolve: resolve as (res: unknown) => void, reject, timer })

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
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
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
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
      this.child = null
      this.pid = null
    }

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

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
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
  private pastedHistory: string[] = []

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

  public getPastedHistory(): readonly string[] {
    return [...this.pastedHistory]
  }

  public setFallbackFiles(files: readonly FileRecord[]): void {
    this.fallbackFiles = [...files]
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
      title: '',
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

  public async manageWindow(
    action: string,
    bounds?: MacosWindowBounds
  ): Promise<{ success: boolean; action: string; rect?: MacosWindowBounds; error?: string; errorCode?: string }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('manage_window', {
          action,
          ...(bounds ? { bounds } : {})
        })
      } catch (err: unknown) {
        console.warn('[SidecarManager] manage_window RPC failed:', err)
        return { success: false, action, error: err instanceof Error ? err.message : String(err) }
      }
    }

    if (process.platform === 'darwin') {
      const targetBounds = bounds ?? { x: 100, y: 80, width: 1200, height: 800 }
      const macRes = await setFrontmostWindowBounds(targetBounds, action)
      return {
        success: macRes.success,
        action,
        ...(macRes.rect ? { rect: macRes.rect } : bounds ? { rect: bounds } : {}),
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      action,
      ...(bounds ? { rect: bounds } : {}),
      error: 'UIAccess sidecar is not running'
    }
  }

  public async setSnippets(snippets: unknown[]): Promise<unknown> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('set_snippets', { snippets })
      } catch (err: unknown) {
        console.warn('[SidecarManager] set_snippets RPC failed:', err)
      }
    }
    return { success: false, count: Array.isArray(snippets) ? snippets.length : 0 }
  }

  public async pasteToActive(targetHwnd = 0): Promise<{ success: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean }>('paste_to_active', { target_hwnd: targetHwnd })
      } catch (err: unknown) {
        console.warn('[SidecarManager] paste_to_active RPC failed:', err)
      }
    }
    if (process.platform === 'darwin') {
      const lastText = this.pastedHistory[this.pastedHistory.length - 1] ?? ''
      const res = await pasteToActiveWindowOnMac(lastText, 0)
      return { success: res.success }
    }
    return { success: false }
  }

  public async pasteToActiveWindow(
    text: string,
    targetHwnd = 0
  ): Promise<{ success: boolean; pasted: string; error?: string; errorCode?: string }> {
    const safeText = String(text ?? '')
    this.pastedHistory.push(safeText)
    if (this.pastedHistory.length > 200) {
      this.pastedHistory.shift()
    }

    if (this.uiaccessProcess.state === 'running') {
      try {
        const rpcRes = await this.uiaccessProcess.sendRequest<{ success: boolean }>('paste_to_active', {
          text: safeText,
          target_hwnd: targetHwnd
        })
        return { success: Boolean(rpcRes?.success), pasted: safeText }
      } catch (err: unknown) {
        console.warn('[SidecarManager] pasteToActiveWindow RPC failed:', err)
      }
    }

    if (process.platform === 'darwin') {
      const macRes = await pasteToActiveWindowOnMac(safeText, 0)
      return {
        success: macRes.success,
        pasted: safeText,
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      pasted: safeText,
      error: 'UIAccess sidecar is not running'
    }
  }

  public async expandSnippet(
    keyword: string,
    content: string,
    clipboard = ''
  ): Promise<{
    success: boolean
    expanded: string
    backspaces: number
    cursorOffset: number
    error?: string
    errorCode?: string
  }> {
    const { expanded, cursorOffset } = expandSnippetMacros(String(content ?? ''), {
      clipboard,
      now: new Date()
    })
    const backspaces = String(keyword ?? '').length

    this.pastedHistory.push(expanded)
    if (this.pastedHistory.length > 200) {
      this.pastedHistory.shift()
    }

    if (this.uiaccessProcess.state === 'running') {
      try {
        await this.uiaccessProcess.sendRequest('expand_snippet', {
          keyword,
          content: expanded,
          backspaces,
          cursor_offset: cursorOffset
        })
        return { success: true, expanded, backspaces, cursorOffset }
      } catch (err: unknown) {
        console.warn('[SidecarManager] expandSnippet RPC failed:', err)
      }
    }

    if (process.platform === 'darwin') {
      const macRes = await pasteToActiveWindowOnMac(expanded, cursorOffset)
      return {
        success: macRes.success,
        expanded,
        backspaces,
        cursorOffset,
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      expanded,
      backspaces,
      cursorOffset,
      error: 'UIAccess sidecar is not running'
    }
  }

  public async trimProcessMemory(pid = 0): Promise<{ success: boolean; pid: number; trimmed: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean; pid: number; trimmed: boolean }>('trim_process_memory', { pid })
      } catch (err: unknown) {
        console.warn('[SidecarManager] trim_process_memory RPC failed:', err)
      }
    }
    return { success: false, pid, trimmed: false }
  }

  // --- Indexer Methods with Graceful Degradation ---

  public registerFallbackFile(file: FileRecord): void {
    this.fallbackFiles.push(file)
  }

  public async searchFiles(query: string, limit = 50): Promise<SearchFilesResult> {
    const trimmed = String(query || '').trim()
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
    if (trimmed.toLowerCase().startsWith('dir:')) {
      const targetDir = trimmed.slice(4).trim()
      if (targetDir) {
        return await scanDirectoryForSearch(targetDir, safeLimit, this.fallbackFiles)
      }
    }

    // 1. 若外部单测注入了 fallbackFiles，优先匹配 fallbackFiles
    if (this.fallbackFiles.length > 0) {
      const t0 = performance.now()
      const qLower = trimmed.toLowerCase()
      const matches: FileRecord[] = []

      for (const f of this.fallbackFiles) {
        if (
          !qLower ||
          f.name.toLowerCase().includes(qLower) ||
          f.acronym.toLowerCase().includes(qLower) ||
          f.path.toLowerCase().includes(qLower)
        ) {
          matches.push(f)
          if (matches.length >= safeLimit) break
        }
      }
      const elapsedMs = performance.now() - t0
      const totalBytes = matches.reduce((acc, f) => acc + (f.size || 0), 0)

      return {
        query: trimmed,
        limit: safeLimit,
        files: matches,
        count: matches.length,
        total_matches: matches.length,
        total_bytes: totalBytes,
        elapsed_us: Math.round(elapsedMs * 1000),
        elapsed_ms: elapsedMs,
        total_indexed: this.fallbackFiles.length,
        degraded: true,
        source: 'macos-fs'
      }
    }

    // 2. 若 Rust Indexer 侧车运行中且有非空关键词，优先调用硬件级索引
    if (trimmed && this.indexerProcess.state === 'running') {
      try {
        const rpcRes = await this.indexerProcess.sendRequest<SearchFilesResult>('search_files', {
          query: trimmed,
          limit: safeLimit
        })
        if (rpcRes && Array.isArray(rpcRes.files) && (rpcRes.files.length > 0 || (rpcRes.total_indexed ?? 0) > 0)) {
          return rpcRes
        }
      } catch (err) {
        console.warn('[SidecarManager] searchFiles RPC failed, falling back:', err)
      }
    }

    // 3. macOS 走 Spotlight mdfind + 本地用户目录回退
    if (process.platform === 'darwin') {
      return await searchFilesOnMacos(trimmed, safeLimit, this.fallbackFiles)
    }

    // 4. 空查询或 Windows 侧车未返回结果时，扫描本机真实用户目录（Downloads/Desktop/Documents/cwd）
    const t0 = performance.now()
    const local = await scanLocalRecentFiles(trimmed, safeLimit)
    const elapsedMs = performance.now() - t0

    return {
      query: trimmed,
      limit: safeLimit,
      files: local.files,
      count: local.files.length,
      total_matches: local.files.length,
      total_bytes: local.totalBytes,
      subdirs: local.subdirs,
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: local.files.length,
      degraded: this.indexerProcess.state !== 'running',
      source: 'local-fs'
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

    return {
      total_indexed: this.fallbackFiles.length,
      scanner_used: 'degraded_unindexed',
      elapsed_ms: 0
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
