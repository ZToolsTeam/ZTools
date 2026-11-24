import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { validateKeyboardLockRequest, type KeyboardLockState } from '../../contracts/keyboard-lock.js'
import { t } from '../i18n/index.js'

const errorCodeKeys: Record<string, string> = {
  ACCESSIBILITY_REQUIRED: 'keyboardLock.error.accessibilityRequired',
  SECURE_INPUT_ACTIVE: 'keyboardLock.error.secureInputActive',
  INPUT_FILTER_UNAVAILABLE: 'keyboardLock.error.inputFilterUnavailable',
  INVALID_REQUEST: 'keyboardLock.error.invalidRequest',
  OWNER_PIPE_REQUIRED: 'keyboardLock.error.ownerPipeRequired'
}

function localizedLockError(code: unknown): string {
  const key = typeof code === 'string' && Object.hasOwn(errorCodeKeys, code) ? errorCodeKeys[code] : undefined
  return key ? t(key) : t('keyboardLock.error.startFailed')
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
    if (this.#stopped) throw new Error(t('keyboardLock.error.stopped'))
    const key = owner(caller), job = this.#job
    if (job && (job.owner !== key || job.state.operationId !== value.operationId)) throw new Error(t('keyboardLock.error.inUseByAnotherWindow'))
    if (value.action === 'start') {
      if (job) throw new Error(t('keyboardLock.error.busy'))
      if (this.platform !== 'darwin') throw new Error(t('keyboardLock.error.unsupportedPlatform'))
      const file = fs.lstatSync(this.executable, { throwIfNoEntry: false })
      if (!path.isAbsolute(this.executable) || !file?.isFile() || file.isSymbolicLink()) throw new Error(t('keyboardLock.error.helperNotBuilt'))
      return this.#start(key, value.operationId, value.durationSeconds!, value.lockPointer!, signal)
    }
    if (!job) return this.#last?.owner === key && this.#last.state.operationId === value.operationId ? { ...this.#last.state } : {
      success: true, operationId: value.operationId, status: 'unlocked', remainingSeconds: 0, blockedEvents: 0, lockPointer: false, reason: ''
    }
    if (value.action === 'unlock') { job.terminate(); await job.finished; return { ...this.#last!.state } }
    if (!job.ready || job.stopping) throw new Error(t('keyboardLock.error.transitioning'))
    if (performance.now() - job.lastReport > 1500) { job.terminate(); throw new Error(t('keyboardLock.error.unresponsive')) }
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
    const abort = () => { job.error = new Error(t('keyboardLock.error.startCancelled')); job.terminate() }
    const startup = setTimeout(() => { job.error = new Error(t('keyboardLock.error.startTimeout')); job.terminate() }, 3000)
    const pulse = setInterval(() => {
      if (job.stopping || job.ended) return
      if (job.ready && performance.now() - job.pulse > 1200) { job.reason = 'connection_lost'; job.terminate(); return }
      if (!child.stdin.write('H\n')) { job.error = new Error(t('keyboardLock.error.pipeBlocked')); job.terminate() }
    }, 250)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      try {
        buffer += chunk
        if (buffer.length > 8192) throw new Error(t('keyboardLock.error.responseTooLarge'))
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>; buffer = buffer.slice(newline + 1)
          if (!message || message.version !== 1 || typeof message.event !== 'string') throw new Error(t('keyboardLock.error.invalidResponse'))
          if (message.event === 'error') throw new Error(localizedLockError(message.code))
          if (!['locked', 'status', 'unlocked'].includes(message.event) || !Number.isSafeInteger(message.remainingSeconds) ||
              Number(message.remainingSeconds) < 0 || Number(message.remainingSeconds) > seconds || !Number.isSafeInteger(message.blockedEvents) || Number(message.blockedEvents) < job.state.blockedEvents ||
              typeof message.reason !== 'string' || message.reason.length > 64) throw new Error(t('keyboardLock.error.invalidState'))
          if ((message.event === 'locked' && (job.ready || Number(message.remainingSeconds) === 0)) ||
              (message.event === 'unlocked' && Number(message.remainingSeconds) !== 0)) throw new Error(t('keyboardLock.error.invalidStateOrder'))
          if (message.event === 'locked' && !job.ready && !job.stopping) {
            job.ready = true; clearTimeout(startup); signal.removeEventListener('abort', abort)
          } else if (message.event === 'status' && !job.ready) throw new Error(t('keyboardLock.error.notConfirmed'))
          job.lastReport = performance.now(); job.reason = message.reason
          job.state = { ...job.state, status: message.event === 'unlocked' ? 'unlocked' : 'locked', remainingSeconds: Number(message.remainingSeconds), blockedEvents: Number(message.blockedEvents), reason: job.reason }
          if (message.event === 'locked' && job.ready && !job.stopping) resolveStart({ ...job.state })
        }
      } catch (error) { job.error = error instanceof Error ? error : new Error(String(error)); job.terminate() }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16384) { job.error = new Error(t('keyboardLock.error.stderrOverflow')); job.terminate() } })
    child.stdin.on('error', error => { if (!job.stopping) { job.error = error; job.terminate() } })
    child.on('error', error => { job.error = error; job.terminate() })
    child.once('close', () => {
      job.ended = true; clearTimeout(startup); clearInterval(pulse); clearTimeout(killTimer); signal.removeEventListener('abort', abort)
      job.state = { ...job.state, status: 'unlocked', remainingSeconds: 0, reason: job.error ? 'error' : job.reason || 'process_exit' }
      this.#last = { owner: key, state: job.state }; if (this.#job === job) this.#job = undefined
      if (!job.ready || job.error) rejectStart(job.error || new Error(t('keyboardLock.error.exitedBeforeConfirm')))
      resolveExit()
    })
    if (signal.aborted) abort()
    return started
  }
}
