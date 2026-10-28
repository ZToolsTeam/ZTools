import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { validateKeyboardLockRequest, type KeyboardLockState } from '../../contracts/keyboard-lock.js'

const errors: Record<string, string> = {
  ACCESSIBILITY_REQUIRED: '请在系统设置的“隐私与安全性 → 辅助功能”中允许 ZTools，然后重新打开客户端',
  SECURE_INPUT_ACTIVE: '系统当前正在安全输入（例如密码框），请离开密码输入界面后重试',
  INPUT_FILTER_UNAVAILABLE: '系统未允许输入拦截，键盘没有锁定；请检查辅助功能权限',
  INVALID_REQUEST: '输入锁组件与客户端协议不一致', OWNER_PIPE_REQUIRED: '输入锁未能建立安全退出通道'
}
export function macInputLockPath(isPackaged: boolean, resourcesPath: string) {
  return isPackaged ? path.join(resourcesPath, 'native', 'ZToolsMacInputLock') : path.resolve(__dirname, '../../mac-input-lock-native/native/ZToolsMacInputLock')
}
function owner(caller: CallerIdentity) { return JSON.stringify([caller.webContentsId, caller.pluginId, caller.pluginInstanceId, caller.attributedPlugin?.sessionId]) }
type LockJob = {
  owner: string; state: KeyboardLockState; child: ChildProcessWithoutNullStreams; pulse: number
  ready: boolean; ended: boolean; stopping: boolean; reason: string; error: Error | undefined; lastReport: number
  started: Promise<KeyboardLockState>; finished: Promise<void>; terminate: () => void
}
export class KeyboardLockService {
  #job: LockJob | undefined
  #last: { owner: string; state: KeyboardLockState } | undefined
  #stopped = false
  constructor(private readonly executable: string, private readonly platform = process.platform) {}
  async stop() { this.#stopped = true; const job = this.#job; if (job) { job.terminate(); await job.finished } }
  async handle(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<KeyboardLockState> {
    validateKeyboardLockRequest(value); signal.throwIfAborted()
    if (this.#stopped) throw new Error('键盘锁服务已停止')
    const key = owner(caller), job = this.#job
    if (job && (job.owner !== key || job.state.operationId !== value.operationId)) throw new Error('另一个窗口正在使用键盘清洁锁')
    if (value.action === 'start') {
      if (job) throw new Error('键盘锁正在运行或退出，请稍后重试')
      if (this.platform !== 'darwin') throw new Error('当前系统尚未接入此系统输入锁，请勿依赖页面提示进行清洁')
      const file = fs.lstatSync(this.executable, { throwIfNoEntry: false })
      if (!path.isAbsolute(this.executable) || !file?.isFile() || file.isSymbolicLink()) throw new Error('输入锁组件尚未构建，请更新客户端或构建原生组件')
      return this.#start(key, value.operationId, value.durationSeconds!, value.lockPointer!, signal)
    }
    if (!job) return this.#last?.owner === key && this.#last.state.operationId === value.operationId ? { ...this.#last.state } : {
      success: true, operationId: value.operationId, status: 'unlocked', remainingSeconds: 0, blockedEvents: 0, lockPointer: false, reason: ''
    }
    if (value.action === 'unlock') { job.terminate(); await job.finished; return { ...this.#last!.state } }
    if (!job.ready || job.stopping) throw new Error('输入锁正在切换状态，请稍候')
    if (performance.now() - job.lastReport > 1500) { job.terminate(); throw new Error('输入锁失去响应，正在解除，请等待输入恢复') }
    job.pulse = performance.now()
    return { ...job.state }
  }
  #start(key: string, id: string, seconds: number, pointer: boolean, signal: AbortSignal): Promise<KeyboardLockState> {
    const child = spawn(this.executable, ['--lock', String(seconds), pointer ? '1' : '0'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let resolveStart!: (value: KeyboardLockState) => void, rejectStart!: (error: Error) => void, resolveExit!: () => void
    const started = new Promise<KeyboardLockState>((resolve, reject) => { resolveStart = resolve; rejectStart = reject })
    const finished = new Promise<void>(resolve => { resolveExit = resolve })
    const job: LockJob = { owner: key, state: { success: true, operationId: id, status: 'unlocked', remainingSeconds: 0, blockedEvents: 0, lockPointer: pointer, reason: '' },
      child, ready: false, ended: false, stopping: false, pulse: performance.now(), lastReport: 0, reason: '', error: undefined, started, finished, terminate: () => {} }
    this.#job = job
    let killTimer: ReturnType<typeof setTimeout> | undefined, buffer = '', stderrBytes = 0
    job.terminate = () => {
      if (job.stopping || job.ended) return
      job.stopping = true
      child.stdin.end('U\n')
      killTimer = setTimeout(() => { if (!job.ended) child.kill('SIGKILL') }, 300)
    }
    const abort = () => { job.error = new Error('键盘锁启动已取消'); job.terminate() }
    const startup = setTimeout(() => { job.error = new Error('系统未确认输入锁，已取消启动'); job.terminate() }, 3000)
    const pulse = setInterval(() => {
      if (job.stopping || job.ended) return
      if (job.ready && performance.now() - job.pulse > 1200) { job.reason = 'connection_lost'; job.terminate(); return }
      if (!child.stdin.write('H\n')) { job.error = new Error('输入锁通信通道阻塞'); job.terminate() }
    }, 250)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try {
        buffer += chunk
        if (buffer.length > 8192) throw new Error('输入锁响应超限')
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>; buffer = buffer.slice(newline + 1)
          if (!message || message.version !== 1 || typeof message.event !== 'string') throw new Error('输入锁响应无效')
          if (message.event === 'error') throw new Error(errors[String(message.code)] || '系统输入锁未能启动')
          if (!['locked', 'status', 'unlocked'].includes(message.event) || !Number.isSafeInteger(message.remainingSeconds) ||
              Number(message.remainingSeconds) < 0 || Number(message.remainingSeconds) > seconds || !Number.isSafeInteger(message.blockedEvents) || Number(message.blockedEvents) < job.state.blockedEvents ||
              typeof message.reason !== 'string' || message.reason.length > 64) throw new Error('输入锁状态无效')
          if ((message.event === 'locked' && (job.ready || Number(message.remainingSeconds) === 0)) ||
              (message.event === 'unlocked' && Number(message.remainingSeconds) !== 0)) throw new Error('输入锁状态顺序无效')
          if (message.event === 'locked' && !job.ready && !job.stopping) {
            job.ready = true; clearTimeout(startup); signal.removeEventListener('abort', abort)
          } else if (message.event === 'status' && !job.ready) throw new Error('系统尚未确认锁定')
          job.lastReport = performance.now(); job.reason = message.reason
          job.state = { ...job.state, status: message.event === 'unlocked' ? 'unlocked' : 'locked', remainingSeconds: Number(message.remainingSeconds), blockedEvents: Number(message.blockedEvents), reason: job.reason }
          if (message.event === 'locked' && job.ready && !job.stopping) resolveStart({ ...job.state })
        }
      } catch (error) { job.error = error instanceof Error ? error : new Error(String(error)); job.terminate() }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) { job.error = new Error('输入锁异常输出过多'); job.terminate() } })
    child.stdin.on('error', error => { if (!job.stopping) { job.error = error; job.terminate() } })
    child.on('error', error => { job.error = error; job.terminate() })
    child.once('close', () => {
      job.ended = true; clearTimeout(startup); clearInterval(pulse); clearTimeout(killTimer); signal.removeEventListener('abort', abort)
      job.state = { ...job.state, status: 'unlocked', remainingSeconds: 0, reason: job.error ? 'error' : job.reason || 'process_exit' }
      this.#last = { owner: key, state: job.state }; if (this.#job === job) this.#job = undefined
      if (!job.ready || job.error) rejectStart(job.error || new Error('系统未确认锁定，输入锁已退出'))
      resolveExit()
    })
    if (signal.aborted) abort()
    return started
  }
}
