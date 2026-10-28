import { execFile } from 'node:child_process'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { ProcessTerminatePidParams } from '../../contracts/method-params.js'

/**
 * 按 pid 结束本机任意进程（process_terminate_pid）。
 *
 * - 保护名单：pid ≤ 1（Windows 另加 4）、宿主自身、宿主祖先链、宿主关键子进程（Electron 子进程、侧车、Native Host）、
 *   系统关键进程名；tree 模式下命中保护的子孙连同其子树跳过，目标本身命中则整体拒绝。
 * - 防 pid 复用：可选 expectedName 与当前快照里的进程名比对。
 * - 只判断「进程是否真的退出」，不解析 taskkill 的本地化输出；graceful 超时不自动升级 force，由调用方决定。
 */

export interface ProcessTreeEntry {
  readonly pid: number
  /** 父进程；未知时为 undefined */
  readonly ppid?: number | undefined
  readonly name: string
  /** 已退出但未被父进程回收（macOS ps stat=Z） */
  readonly zombie?: boolean | undefined
}

export type ProcessSignalSender = (pid: number, signal: NodeJS.Signals | 0) => void

export interface ProcessTerminatorDeps {
  readonly platform: NodeJS.Platform
  snapshot(signal: AbortSignal): Promise<readonly ProcessTreeEntry[]>
  /** 默认 process.kill；测试可注入以模拟 EPERM 等，绝不对真实系统进程发信号 */
  readonly kill?: ProcessSignalSender
  /** Windows：调用 %SystemRoot%\System32\taskkill.exe，参数数组传入不经 shell；ok 表示退出码为 0 */
  readonly runTaskkill?: (args: readonly string[], signal: AbortSignal) => Promise<{ ok: boolean }>
  /** 宿主关键子进程 pid（Electron 子进程、侧车、Native Host 等）；读取失败时拒绝结束（fail closed） */
  readonly protectedPids?: () => Promise<Iterable<number>> | Iterable<number>
  readonly hostPid?: number
  readonly hostPpid?: number
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  readonly pollIntervalMs?: number
}

export interface ProcessTerminateResult {
  readonly success: true
  readonly data: {
    readonly pid: number
    readonly mode: 'graceful' | 'force'
    readonly tree: boolean
    readonly terminated: number[]
  }
}

export const MAX_TERMINATE_TREE_SIZE = 256
const MAX_ANCESTOR_DEPTH = 64
const ZOMBIE_RECHECK_ROUNDS = 10

const WINDOWS_PROTECTED_NAMES = new Set([
  'system', 'system idle process', 'idle', 'registry', 'memcompression',
  'secure system', 'smss', 'csrss', 'wininit', 'services',
  'lsass', 'winlogon', 'fontdrvhost', 'dwm', 'spoolsv'
])
// 结束 loginwindow 会注销当前用户；WindowServer / kernel_task / launchd 普通用户本来也会 EPERM，先拦截给出明确提示
const MACOS_PROTECTED_NAMES = new Set(['launchd', 'kernel_task', 'windowserver', 'loginwindow', 'ztoolspathaccessbroker'])

/** 进程名规范化：去掉路径、忽略大小写，Windows 忽略 .exe；process_list 与结束进程共用 */
export function normalizeProcessName(name: string, platform: NodeJS.Platform): string {
  const raw = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  const base = (platform === 'win32' ? path.win32.basename(raw) : path.posix.basename(raw)).toLocaleLowerCase('en-US')
  return platform === 'win32' && base.endsWith('.exe') ? base.slice(0, -4) : base
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function abortFailure(signal: AbortSignal): ZToolsError {
  if (signal.reason === errorCodes.requestTimeout) return new ZToolsError(errorCodes.requestTimeout, '调用超时')
  if (signal.reason === errorCodes.appStopping) return new ZToolsError(errorCodes.appStopping, '应用正在退出')
  return new ZToolsError(errorCodes.cancelled, '结束进程已取消（信号已发出则不撤销）')
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortFailure(signal))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortFailure(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultRunTaskkill(args: readonly string[], signal: AbortSignal): Promise<{ ok: boolean }> {
  const taskkill = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise((resolve) => {
    execFile(taskkill, [...args], { encoding: 'utf8', timeout: 5_000, windowsHide: true, signal }, (error) => {
      resolve({ ok: !error })
    })
  })
}

type Liveness = 'alive' | 'exited' | 'denied'

export class ProcessTerminator {
  readonly #kill: ProcessSignalSender
  readonly #runTaskkill: (args: readonly string[], signal: AbortSignal) => Promise<{ ok: boolean }>
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #pollIntervalMs: number
  readonly #hostPid: number
  readonly #hostPpid: number | undefined

  constructor(private readonly deps: ProcessTerminatorDeps) {
    this.#kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal) })
    this.#runTaskkill = deps.runTaskkill ?? defaultRunTaskkill
    this.#now = deps.now ?? Date.now
    this.#sleep = deps.sleep ?? defaultSleep
    this.#pollIntervalMs = deps.pollIntervalMs ?? 50
    this.#hostPid = deps.hostPid ?? process.pid
    this.#hostPpid = deps.hostPpid ?? process.ppid
  }

  async terminate(params: ProcessTerminatePidParams, signal: AbortSignal, beforeSignal?: (pid: number) => Promise<void>): Promise<ProcessTerminateResult> {
    const { pid, mode } = params
    const tree = params.tree === true
    if (!Number.isInteger(pid) || pid < 2 || pid > 0xffff_ffff) {
      throw new ZToolsError(errorCodes.invalidRequest, 'pid 无效')
    }
    if (mode !== 'graceful' && mode !== 'force') throw new ZToolsError(errorCodes.invalidRequest, 'mode 无效')
    const timeoutMs = params.timeoutMs ?? (mode === 'graceful' ? 3_000 : 2_000)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
      throw new ZToolsError(errorCodes.invalidRequest, 'timeoutMs 无效')
    }
    if (signal.aborted) throw abortFailure(signal)
    const platform = this.deps.platform
    // Darwin pid_t 是有符号 32 位；更大的 pid 不可能存在
    if (platform !== 'win32' && pid > 0x7fff_ffff) throw new ZToolsError(errorCodes.processNotFound, '进程不存在')

    // 1. 系统进程与宿主自身：不需要快照即可判定
    if (platform === 'win32' && pid === 4) this.#protected('system', pid)
    if (pid === this.#hostPid) this.#protected('host-self', pid)
    if (pid === this.#hostPpid) this.#protected('host-ancestor', pid)

    // 2. 存在性 / 权限预检
    const initial = this.#probe(pid)
    if (initial === 'exited') throw new ZToolsError(errorCodes.processNotFound, '进程已不存在')
    if (initial === 'denied') {
      throw new ZToolsError(errorCodes.processAccessDenied, '没有结束该进程的权限（通常需要管理员权限）')
    }

    // 3. 快照：父子关系与名称；失败时绝不盲目发信号
    let snapshot: readonly ProcessTreeEntry[]
    try {
      snapshot = await this.deps.snapshot(signal)
    } catch (error) {
      if (signal.aborted) throw abortFailure(signal)
      if (error instanceof ZToolsError && error.code !== errorCodes.processError) throw error
      throw new ZToolsError(errorCodes.processError, '读取进程快照失败，未执行结束')
    }
    if (!Array.isArray(snapshot)) throw new ZToolsError(errorCodes.processError, '进程快照无效，未执行结束')
    const byPid = new Map<number, ProcessTreeEntry>()
    for (const entry of snapshot) {
      if (entry && Number.isInteger(entry.pid) && entry.pid > 0 && !byPid.has(entry.pid)) byPid.set(entry.pid, entry)
    }
    const target = byPid.get(pid)
    if (!target) {
      if (this.#probe(pid) === 'exited') throw new ZToolsError(errorCodes.processNotFound, '进程已不存在')
      throw new ZToolsError(errorCodes.processError, '进程快照中找不到目标进程，未执行结束')
    }
    if (target.zombie) throw new ZToolsError(errorCodes.processNotFound, '进程已退出')

    let hostChildren: Set<number>
    try {
      hostChildren = new Set([...(await (this.deps.protectedPids?.() ?? []))].filter(Number.isInteger))
    } catch {
      throw new ZToolsError(errorCodes.processError, '读取宿主进程保护名单失败，未执行结束')
    }
    const ancestors = this.#ancestors(byPid)
    const protectionOf = (entry: ProcessTreeEntry): string | undefined => {
      if (entry.pid <= 1 || (platform === 'win32' && entry.pid === 4)) return 'system'
      if (entry.pid === this.#hostPid) return 'host-self'
      if (ancestors.has(entry.pid)) return 'host-ancestor'
      if (hostChildren.has(entry.pid)) return 'host-child'
      const name = normalizeProcessName(entry.name, platform)
      const protectedNames = platform === 'win32' ? WINDOWS_PROTECTED_NAMES : MACOS_PROTECTED_NAMES
      return protectedNames.has(name) ? 'system' : undefined
    }
    const targetProtection = protectionOf(target)
    if (targetProtection) this.#protected(targetProtection, pid)

    // 4. pid 复用：调用方看到的进程名与当前不一致
    if (params.expectedName !== undefined &&
        normalizeProcessName(params.expectedName, platform) !== normalizeProcessName(target.name, platform)) {
      throw new ZToolsError(errorCodes.processIdentityMismatch, '进程已变化（pid 可能被复用），未执行结束')
    }

    // 5. 目标集合：先子后父
    const order = tree ? this.#descendants(pid, byPid, protectionOf) : []
    order.push(pid)

    // 6. 发信号
    const exited: number[] = []
    const waiting = new Set<number>()
    let taskkillRejected = false
    if (platform === 'win32') {
      const pids = order.filter(item => !byPid.get(item)?.zombie)
      const args = [...(mode === 'force' ? ['/F'] : []), ...pids.flatMap(item => ['/PID', String(item)])]
      for (const item of pids) await beforeSignal?.(item)
      if (signal.aborted) throw abortFailure(signal)
      const outcome = await this.#runTaskkill(args, signal)
      taskkillRejected = !outcome.ok
      for (const item of pids) waiting.add(item)
    } else {
      const posixSignal: NodeJS.Signals = mode === 'force' ? 'SIGKILL' : 'SIGTERM'
      for (const item of order) {
        if (signal.aborted) throw abortFailure(signal)
        if (byPid.get(item)?.zombie) {
          exited.push(item)
          continue
        }
        // 内部调用方可在实际发信号前复核启动身份和目标占用；不接受 Renderer 提供回调。
        await beforeSignal?.(item)
        if (signal.aborted) throw abortFailure(signal)
        try {
          this.#kill(item, posixSignal)
          waiting.add(item)
        } catch (error) {
          const code = errnoCode(error)
          if (code === 'ESRCH') {
            exited.push(item)
          } else if (item === pid) {
            if (code === 'EPERM') throw new ZToolsError(errorCodes.processAccessDenied, '没有结束该进程的权限（通常需要管理员权限）')
            throw new ZToolsError(errorCodes.processError, '向进程发送结束信号失败')
          }
          // 子孙无权限 / 失败：不计入结果，也不等待
        }
      }
    }

    // 7. 等待真正退出
    const deadline = this.#now() + timeoutMs
    let round = 0
    for (;;) {
      for (const item of [...waiting]) {
        const state = this.#probe(item)
        if (state === 'exited') {
          waiting.delete(item)
          exited.push(item)
        }
      }
      if (waiting.size === 0) break
      if (platform === 'win32' && taskkillRejected && round === 0 && waiting.has(pid)) {
        // taskkill 立即失败且目标仍在：force ⇒ 无权限；graceful ⇒ 程序拒绝关闭（如控制台程序）
        if (mode === 'force') {
          throw new ZToolsError(errorCodes.processAccessDenied, '没有结束该进程的权限（通常需要管理员权限）')
        }
        throw new ZToolsError(errorCodes.processTerminateTimeout, '进程拒绝正常关闭', {
          public: { reason: 'graceful-rejected', stillRunning: [...waiting] }
        })
      }
      if (this.#now() >= deadline) break
      round += 1
      if (platform !== 'win32' && round % ZOMBIE_RECHECK_ROUNDS === 0) await this.#dropZombies(waiting, exited, signal)
      if (waiting.size === 0) break
      await this.#sleep(this.#pollIntervalMs, signal)
    }
    if (waiting.size > 0 && platform !== 'win32') await this.#dropZombies(waiting, exited, signal)
    if (waiting.has(pid) || waiting.size > 0) {
      throw new ZToolsError(errorCodes.processTerminateTimeout, '信号已发出，但进程在超时前仍未退出', {
        public: { stillRunning: [...waiting].sort((left, right) => left - right) }
      })
    }
    return { success: true, data: { pid, mode, tree, terminated: exited } }
  }

  #protected(reason: string, pid: number): never {
    const messages: Record<string, string> = {
      system: '系统关键进程受保护，禁止结束',
      'host-self': 'ZTools 自身进程受保护，禁止结束',
      'host-ancestor': 'ZTools 的父进程受保护，禁止结束',
      'host-child': 'ZTools 的关键子进程受保护，禁止结束'
    }
    throw new ZToolsError(errorCodes.processProtected, messages[reason] ?? '进程受保护，禁止结束', {
      public: { reason, pid }
    })
  }

  #probe(pid: number): Liveness {
    try {
      this.#kill(pid, 0)
      return 'alive'
    } catch (error) {
      const code = errnoCode(error)
      if (code === 'ESRCH') return 'exited'
      if (code === 'EPERM') return 'denied'
      // 其他错误（例如 pid 超出平台范围）：无法确认存在，按已不存在处理不会误杀
      return code === undefined ? 'exited' : 'alive'
    }
  }

  #ancestors(byPid: ReadonlyMap<number, ProcessTreeEntry>): Set<number> {
    const result = new Set<number>()
    if (this.#hostPpid !== undefined && this.#hostPpid > 0) result.add(this.#hostPpid)
    let current = byPid.get(this.#hostPid)?.ppid
    for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current !== undefined && current > 1; depth += 1) {
      if (result.has(current) && current !== this.#hostPpid) break
      result.add(current)
      current = byPid.get(current)?.ppid
    }
    return result
  }

  #descendants(
    root: number,
    byPid: ReadonlyMap<number, ProcessTreeEntry>,
    protectionOf: (entry: ProcessTreeEntry) => string | undefined
  ): number[] {
    const children = new Map<number, number[]>()
    for (const entry of byPid.values()) {
      if (entry.ppid === undefined || entry.ppid === entry.pid) continue
      const list = children.get(entry.ppid) ?? []
      list.push(entry.pid)
      children.set(entry.ppid, list)
    }
    const visited = new Set<number>([root])
    const bfs: number[] = []
    const queue = [...(children.get(root) ?? [])]
    while (queue.length > 0) {
      const next = queue.shift() as number
      if (visited.has(next)) continue
      visited.add(next)
      const entry = byPid.get(next)
      // 受保护的子孙连同其子树跳过
      if (!entry || protectionOf(entry)) continue
      bfs.push(next)
      if (bfs.length > MAX_TERMINATE_TREE_SIZE) {
        throw new ZToolsError(errorCodes.invalidRequest, `子进程过多（超过 ${MAX_TERMINATE_TREE_SIZE} 个），请先结束部分子进程`)
      }
      queue.push(...(children.get(next) ?? []))
    }
    // BFS 中父先于子，反转后子先于父
    return bfs.reverse()
  }

  async #dropZombies(waiting: Set<number>, exited: number[], signal: AbortSignal): Promise<void> {
    let snapshot: readonly ProcessTreeEntry[]
    try {
      snapshot = await this.deps.snapshot(signal)
    } catch {
      if (signal.aborted) throw abortFailure(signal)
      return
    }
    const byPid = new Map(snapshot.map(entry => [entry.pid, entry]))
    for (const item of [...waiting]) {
      if (byPid.get(item)?.zombie) {
        waiting.delete(item)
        exited.push(item)
      }
    }
  }
}
