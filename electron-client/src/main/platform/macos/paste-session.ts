import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { ClipboardMacPasteAdapter } from '../../services/clipboard-service.js'
import { macClipboardExecutable } from './file-clipboard.js'

type HelperSpawner = (executable: string) => ChildProcessWithoutNullStreams
type Reply = { version: 1; id: number; success: boolean; state?: string; error?: string }
const TARGET_UNAVAILABLE_REASONS = new Set(['PASTE_TARGET_UNAVAILABLE', 'PASTE_HOST_NOT_ACTIVE',
  'PASTE_TARGET_APP_UNAVAILABLE', 'PASTE_TARGET_WINDOW_UNAVAILABLE', 'PASTE_TARGET_ELEMENT_UNAVAILABLE',
  'PASTE_FOCUS_OBSERVER_UNAVAILABLE'])
const REJECTED_BEFORE_SEND = new Set(['ACCESSIBILITY_PERMISSION_DENIED', 'PASTE_EVENT_PERMISSION_DENIED', 'PASTE_TARGET_CHANGED',
  ...TARGET_UNAVAILABLE_REASONS, 'PASTE_EVENT_FAILED', 'PASTE_KEYBOARD_LAYOUT_UNSUPPORTED', 'PASTE_SESSION_CLOSED'])

function failure(reason: string): ZToolsError {
  if (reason === 'PASTE_EVENT_PERMISSION_DENIED') return new ZToolsError(errorCodes.permissionDenied,
    '已复制，但系统不允许发送粘贴按键；请手动粘贴，并在系统设置的辅助功能中检查 ZTools 授权', { hostCode: reason })
  if (reason === 'ACCESSIBILITY_PERMISSION_DENIED') return new ZToolsError(errorCodes.permissionDenied,
    '已复制，请在系统设置的辅助功能中授权 ZTools 后再粘贴', { hostCode: reason })
  if (reason === 'PASTE_TARGET_CHANGED' || TARGET_UNAVAILABLE_REASONS.has(reason)) return new ZToolsError(errorCodes.clipboardError,
    '已复制，但无法确认原来的输入位置；请回到目标文档手动粘贴，或重新唤起 ZTools', { hostCode: reason })
  return new ZToolsError(errorCodes.nativeHostUnavailable,
    '已复制，但粘贴辅助进程不可用，请手动粘贴并重新启动客户端', { hostCode: reason })
}

const launch: HelperSpawner = executable => spawn(executable, ['--paste-session'], {
  stdio: ['pipe', 'pipe', 'pipe'], shell: false,
  env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
})

/** 单个宿主拥有一个观察会话。协议错误、取消或超时都会终止子进程，禁止迟到重试。 */
export class MacPasteSession {
  readonly #child: ChildProcessWithoutNullStreams | undefined
  readonly #ready: Promise<void>
  readonly #closed: Promise<void>
  #resolveReady: () => void = () => {}
  #rejectReady: (error: Error) => void = () => {}
  #startupTimer: NodeJS.Timeout | undefined
  #failure: Error | undefined
  #buffer = ''
  #started = false
  #sequence = 0
  #busy = false
  #pasteInFlight = false
  #pending: { id: number; mode: string; finish: (reply: Reply) => void; reject: (error: Error) => void } | undefined

  constructor(executable: string, spawner: HelperSpawner = launch, private readonly timeoutMs = 2000) {
    this.#ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject })
    void this.#ready.catch(() => { /* 启动失败由下一次请求返回，不弹窗也不产生未处理拒绝。 */ })
    try {
      const child = this.#child = spawner(executable)
      this.#closed = new Promise(resolve => child.once('close', () => resolve()))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.#read(chunk))
      child.stderr.resume() // 原生进程不输出用户数据；错误只用稳定协议码返回。
      child.once('error', () => this.#fail(failure('PASTE_HELPER_UNAVAILABLE')))
      child.once('close', () => this.#fail(failure('PASTE_HELPER_EXITED')))
      child.stdin.on('error', () => this.#fail(failure('PASTE_HELPER_UNAVAILABLE')))
      this.#startupTimer = setTimeout(() => this.#fail(failure('PASTE_HELPER_TIMEOUT')), timeoutMs)
      this.#startupTimer.unref()
    } catch {
      this.#closed = Promise.resolve()
      this.#fail(failure('PASTE_HELPER_UNAVAILABLE'))
    }
  }

  async prepare(signal: AbortSignal): Promise<number> {
    const result = await this.#request('prepare', signal)
    return result.id
  }

  async paste(token: number, signal: AbortSignal): Promise<void> {
    if (!Number.isInteger(token) || token <= 0 || token > 2147483647) throw failure('PASTE_TARGET_UNAVAILABLE')
    await this.#request('paste', signal, token)
  }

  async stop(): Promise<void> {
    this.#fail(new ZToolsError(errorCodes.callerDestroyed, '粘贴会话已结束'))
    await this.#closed
  }

  async #request(mode: 'prepare' | 'paste', signal: AbortSignal, token?: number): Promise<Reply> {
    if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '粘贴操作已取消')
    if (this.#failure) { await this.#closed; throw this.#failure }
    if (this.#busy) throw new ZToolsError(errorCodes.clipboardError, '粘贴操作正在进行')
    this.#busy = true
    const abort = () => this.#fail(new ZToolsError(errorCodes.callerDestroyed, '粘贴操作已取消'))
    signal.addEventListener('abort', abort, { once: true })
    let timer: NodeJS.Timeout | undefined
    try {
      await this.#ready
      if (this.#failure) { await this.#closed; throw this.#failure }
      if (++this.#sequence > 2147483647) throw failure('PASTE_SESSION_EXHAUSTED')
      const id = this.#sequence
      const reply = await new Promise<Reply>((resolve, reject) => {
        this.#pending = { id, mode, finish: resolve, reject }
        timer = setTimeout(() => this.#fail(failure('PASTE_HELPER_TIMEOUT')), this.timeoutMs)
        this.#pasteInFlight = mode === 'paste'
        this.#child?.stdin.write(JSON.stringify({ version: 1, id, mode, ...(token ? { token } : {}) }) + '\n')
      })
      if (this.#failure) { await this.#closed; throw this.#failure }
      if (!reply.success) throw failure(reply.error || 'PASTE_PROTOCOL_ERROR')
      if (reply.state !== (mode === 'prepare' ? 'prepared' : 'dispatched')) {
        this.#fail(failure('PASTE_PROTOCOL_ERROR'))
        await this.#closed
        throw this.#failure
      }
      return reply
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.#pending = undefined
      this.#pasteInFlight = false
      this.#busy = false
    }
  }

  #read(chunk: string): void {
    if (this.#failure) return
    this.#buffer += chunk
    if (Buffer.byteLength(this.#buffer) > 4096) return this.#fail(failure('PASTE_PROTOCOL_ERROR'))
    let end: number
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      let value: Record<string, unknown>
      try { value = JSON.parse(line) }
      catch { return this.#fail(failure('PASTE_PROTOCOL_ERROR')) }
      if (!value || value.version !== 1) return this.#fail(failure('PASTE_PROTOCOL_ERROR'))
      if (!this.#started && value.ready === true && Object.keys(value).length === 2) {
        this.#started = true; clearTimeout(this.#startupTimer); this.#resolveReady(); continue
      }
      if (!this.#started || !this.#pending || value.id !== this.#pending.id || typeof value.success !== 'boolean' ||
          (value.success ? typeof value.state !== 'string' : typeof value.error !== 'string' || !REJECTED_BEFORE_SEND.has(value.error))) {
        return this.#fail(failure('PASTE_PROTOCOL_ERROR'))
      }
      this.#pending.finish(value as Reply)
      // 收到第二条相同回执也拒绝，不能跨请求消费旧结果。
      this.#pending = undefined
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return
    const pending = this.#pending
    this.#failure = this.#pasteInFlight
      ? new ZToolsError(errorCodes.clipboardError, '粘贴发送结果未确认，请先检查目标文档，避免重复发送', { hostCode: 'PASTE_RESULT_UNCONFIRMED' })
      : error
    clearTimeout(this.#startupTimer)
    this.#pending = undefined
    this.#child?.kill('SIGKILL')
    // close 之后才释放调用方的剪贴板互斥，避免子进程仍存活时下一次复制覆盖内容。
    void this.#closed.then(() => {
      this.#rejectReady(this.#failure!)
      pending?.reject(this.#failure!)
    })
  }
}

export function createMacPasteAdapter(electron: {
  app: { hide(): void; show(): void; isPackaged: boolean }
  systemPreferences: { isTrustedAccessibilityClient(prompt: boolean): boolean }
}): ClipboardMacPasteAdapter {
  const session = new MacPasteSession(macClipboardExecutable(electron.app.isPackaged, process.resourcesPath))
  return {
    isTrusted: () => electron.systemPreferences.isTrustedAccessibilityClient(false),
    preparePaste: signal => session.prepare(signal),
    hideApplication: () => electron.app.hide(),
    showApplication: () => electron.app.show(),
    sendPaste: (signal, token) => session.paste(token, signal),
    stop: () => session.stop()
  }
}
