import { NativePluginMaintenance } from './plugin-maintenance.js'
import type {
  NativeDllClientPort,
  NativeDllCallResult,
  NativeDllEvent,
  NativeDllEventListener,
  NativeDllInfo,
  NativeDllInvocationContext,
  NativeDllTaskStartAttempt,
  NativeDllTaskStartOutcome,
  NativeDllTaskStatus
} from './dll-client-port.js'
export type {
  NativeDllCallResult,
  NativeDllEvent,
  NativeDllEventListener,
  NativeDllInfo,
  NativeDllTaskStartAttempt,
  NativeDllTaskStartOutcome,
  NativeDllTaskStatus
} from './dll-client-port.js'
import { Buffer } from 'node:buffer'
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithStdioTuple
} from 'node:child_process'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getResolvedLocale, ZTOOLS_LOCALE_ENV_KEY } from '../i18n/index.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  encodeNativeHostFrame,
  MAX_NATIVE_HOST_PAYLOAD_BYTES,
  NativeHostFrameDecoder,
  NativeHostFrameType,
  NATIVE_HOST_NONCE_BYTES,
  NATIVE_HOST_PROOF_BYTES,
  NATIVE_HOST_PROTOCOL_VERSION,
  NATIVE_HOST_SECRET_BYTES,
  type NativeHostFrame
} from './protocol.js'

const CLIENT_DOMAIN = Buffer.from('ztools-native-host-client-v1\0', 'ascii')
const SERVER_DOMAIN = Buffer.from('ztools-native-host-server-v1\0', 'ascii')
const MAX_STDERR_BYTES = 64 * 1024
const MAX_IGNORED_RESPONSES = 1024
const MAX_PENDING_TASK_STARTS = 128
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTART_ATTEMPTS = 3
const RESTART_BASE_DELAY_MS = 250
const RESTART_MAX_DELAY_MS = 4_000

type NativeHostState =
  | 'idle'
  | 'awaiting-hello'
  | 'ready'
  | 'crashed'
  | 'restarting'
  | 'stopping'
  | 'closed'

interface PendingRequest {
  expectedType: NativeHostFrameType
  timer: NodeJS.Timeout | undefined
  resolve: (frame: NativeHostFrame) => void
  reject: (error: Error) => void
}

interface PendingTaskStart {
  child: ChildProcessWithoutNullStreams
  taskId: string
  pluginId: string
  dllId: string
  method: 'dll_call_async' | 'dll_call_with_callback'
  nativeTaskObserved?: boolean
  ambiguousResponseReceived?: boolean
  resolve: (outcome: NativeDllTaskStartOutcome) => void
}

// These errors are returned before StartTask creates its invocation thread.
// DLL_HOST_INTERNAL can also occur while constructing the ACK after launch;
// duplicate/unknown errors cannot prove that the assigned task did not run.
const DEFINITIVE_TASK_START_ERRORS = new Set([
  'INVALID_REQUEST', 'DLL_TASK_LIMIT', 'DLL_ASYNC_UNSUPPORTED', 'DLL_CALLBACK_UNSUPPORTED',
  'HOST_STOPPING', 'DLL_NOT_ALLOWED', 'FUNCTION_NOT_ALLOWED', 'DLL_PATH_INVALID',
  'DLL_UNAVAILABLE', 'DLL_ARCH_INVALID', 'DLL_INTEGRITY', 'DLL_IDENTITY_CHANGED',
  'DLL_BUSY', 'DLL_LOAD_FAILED', 'DLL_EXPORTS_INVALID', 'DLL_INIT_FAILED', 'DLL_INFO_INVALID',
  'MANIFEST_UNAVAILABLE', 'MANIFEST_INTEGRITY', 'MANIFEST_INVALID', 'MANIFEST_UNTRUSTED'
])

export interface NativeHostRequestOptions {
  pluginId?: string
  dllId?: string
  timeoutMs?: number | 'infinite'
  signal?: AbortSignal
}

export interface NativeHostClientOptions {
  pluginRoot?: string
  trustedManifestSha256?: string
  resourcesRoot?: string
  trustedResourcesManifestSha256?: string
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>
  ) => ChildProcessWithoutNullStreams
}

export interface NativeInputInjectionAdapter {
  getForegroundWindow(signal?: AbortSignal): Promise<bigint>
  restoreForegroundWindow(handle: bigint, signal?: AbortSignal): Promise<void>
  injectKeyPress(key: string, signal?: AbortSignal): Promise<void>
  injectKeyCombo(keys: string, signal?: AbortSignal): Promise<void>
  injectText(text: string, signal?: AbortSignal): Promise<void>
  injectMouseMove(x: number, y: number, signal?: AbortSignal): Promise<void>
  injectMouseClick(
    button: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    signal?: AbortSignal
  ): Promise<void>
  injectMouseWheel(delta: number, signal?: AbortSignal): Promise<void>
}

export interface NativeHostShutdownResult {
  completed: boolean
  timedOut: boolean
  forced: boolean
  cancelAttempted: number
  cancelFailed: number
  stopAttempted: number
  stopFailed: number
  tasksCleared: number
  sessionsUnloaded: number
  remainingTasks: number
  remainingActiveInvocations: number
  internalFailures: number
}

export type NativeHostLifecycleEvent =
  | {
      type: 'crashed'
      pid: number | undefined
      exitCode: number | null
      signal: NodeJS.Signals | null
      stderr: string
    }
  | { type: 'restart-scheduled'; attempt: number; delayMs: number }
  | { type: 'restarted'; attempt: number; pid: number | undefined }
  | { type: 'restart-exhausted'; failuresInWindow: number }

export type NativeHostLifecycleEventListener = (event: NativeHostLifecycleEvent) => void

export type NativeMouseButton = 'middle' | 'right' | 'forward' | 'backward'
export type NativeMouseAction = 'press' | 'long'
export type NativeKeyboardModifier = 'ctrl' | 'alt' | 'shift'

export interface NativeMouseTriggerConfig {
  button: NativeMouseButton
  action: NativeMouseAction
  longPressMs: number
  /** 全屏免打扰开关（缺省视为 true） */
  fullscreenDnd?: boolean
}

export type NativeInputEvent =
  | {
      type: 'mouse-trigger'
      config: NativeMouseTriggerConfig
    }
  | {
      type: 'keyboard-double-tap'
      modifier: NativeKeyboardModifier
    }

export type NativeInputEventListener = (event: NativeInputEvent) => void

function hmac(secret: Buffer, parts: readonly Buffer[]): Buffer {
  const value = createHmac('sha256', secret)
  for (const part of parts) value.update(part)
  return value.digest()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyShutdownResult(overrides: Partial<NativeHostShutdownResult> = {}): NativeHostShutdownResult {
  return {
    completed: true,
    timedOut: false,
    forced: false,
    cancelAttempted: 0,
    cancelFailed: 0,
    stopAttempted: 0,
    stopFailed: 0,
    tasksCleared: 0,
    sessionsUnloaded: 0,
    remainingTasks: 0,
    remainingActiveInvocations: 0,
    internalFailures: 0,
    ...overrides
  }
}

function decodeShutdownResult(payload: Buffer): NativeHostShutdownResult {
  let value: unknown
  try {
    value = JSON.parse(decodeUtf8(payload, 'NativeHost32 exit response is not valid UTF-8'))
  } catch (error) {
    if (error instanceof ZToolsError) throw error
    throw new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 exit response is not valid JSON')
  }
  if (!isRecord(value) || typeof value.completed !== 'boolean' ||
      typeof value.timedOut !== 'boolean') {
    throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 exit response')
  }
  const countNames = [
    'cancelAttempted',
    'cancelFailed',
    'stopAttempted',
    'stopFailed',
    'tasksCleared',
    'sessionsUnloaded',
    'remainingTasks',
    'remainingActiveInvocations',
    'internalFailures'
  ] as const
  for (const name of countNames) {
    if (!Number.isSafeInteger(value[name]) || (value[name] as number) < 0) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 exit counts')
    }
  }
  return {
    completed: value.completed,
    timedOut: value.timedOut,
    forced: false,
    cancelAttempted: value.cancelAttempted as number,
    cancelFailed: value.cancelFailed as number,
    stopAttempted: value.stopAttempted as number,
    stopFailed: value.stopFailed as number,
    tasksCleared: value.tasksCleared as number,
    sessionsUnloaded: value.sessionsUnloaded as number,
    remainingTasks: value.remainingTasks as number,
    remainingActiveInvocations: value.remainingActiveInvocations as number,
    internalFailures: value.internalFailures as number
  }
}

function decodeUtf8(payload: Uint8Array, message: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    throw new ZToolsError(errorCodes.nativeHostProtocol, message)
  }
}

function decodeDllCallResult(response: Buffer): NativeDllCallResult {
  if (response.length < 5) {
    throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL call response')
  }
  const hasResult = response.readUInt8(4)
  if (hasResult > 1 || (hasResult === 0 && response.length !== 5)) {
    throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL call response')
  }
  return {
    code: response.readInt32LE(0),
    result: hasResult === 1
      ? decodeUtf8(response.subarray(5), 'NativeHost32 DLL call result is not valid UTF-8')
      : null
  }
}

const VIRTUAL_KEYS: Record<string, number> = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  CLEAR: 0x0c,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CTRL: 0x11,
  CONTROL: 0x11,
  ALT: 0x12,
  PAUSE: 0x13,
  CAPSLOCK: 0x14,
  ESC: 0x1b,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  INSERT: 0x2d,
  DELETE: 0x2e,
  META: 0x5b,
  WIN: 0x5b,
  LWIN: 0x5b,
  RWIN: 0x5c,
  NUMLOCK: 0x90,
  SCROLLLOCK: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde
}

for (let code = 0; code <= 9; code += 1) VIRTUAL_KEYS[String(code)] = 0x30 + code
for (let code = 0; code < 26; code += 1) VIRTUAL_KEYS[String.fromCharCode(65 + code)] = 0x41 + code
for (let code = 1; code <= 24; code += 1) VIRTUAL_KEYS[`F${code}`] = 0x6f + code

function virtualKey(value: string): number {
  const key = value.trim().toUpperCase()
  const code = VIRTUAL_KEYS[key]
  if (code === undefined) {
    throw new ZToolsError(errorCodes.invalidRequest, `Unsupported key: ${value}`)
  }
  return code
}

function encodeVirtualKey(value: string): Buffer {
  const payload = Buffer.alloc(2)
  payload.writeUInt16LE(virtualKey(value), 0)
  return payload
}

function encodeVirtualKeyCombo(value: string): Buffer {
  const keys = value.split('+').map((item) => item.trim()).filter(Boolean)
  if (keys.length < 1 || keys.length > 32) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid key combination count')
  }
  const payload = Buffer.alloc(1 + keys.length * 2)
  payload[0] = keys.length
  keys.forEach((key, index) => payload.writeUInt16LE(virtualKey(key), 1 + index * 2))
  return payload
}

function assertNativeSuccess(response: Buffer, message: string): void {
  let value: unknown
  try {
    value = JSON.parse(response.toString('utf8'))
  } catch {
    throw new ZToolsError(errorCodes.nativeHostProtocol, message)
  }
  if (!isRecord(value) || value.success !== true || Object.keys(value).some((key) => key !== 'success')) {
    throw new ZToolsError(errorCodes.nativeHostProtocol, message)
  }
}

function requestOptions(signal: AbortSignal | undefined): NativeHostRequestOptions {
  return signal === undefined ? {} : { signal }
}

function encodeDllTaskCall(
  taskId: string,
  functionName: string,
  params: unknown
): Buffer {
  if (!isRecord(params)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 DLL task parameters must be an object')
  }
  let paramsJson: string
  try {
    paramsJson = JSON.stringify({ ...params, taskId })
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 DLL task parameters are not serializable')
  }
  const taskBytes = Buffer.from(taskId, 'utf8')
  const functionBytes = Buffer.from(functionName, 'utf8')
  const paramsBytes = Buffer.from(paramsJson, 'utf8')
  const payload = Buffer.allocUnsafe(4 + taskBytes.length + functionBytes.length + paramsBytes.length)
  payload.writeUInt16LE(taskBytes.length, 0)
  payload.writeUInt16LE(functionBytes.length, 2)
  taskBytes.copy(payload, 4)
  functionBytes.copy(payload, 4 + taskBytes.length)
  paramsBytes.copy(payload, 4 + taskBytes.length + functionBytes.length)
  return payload
}

function clearNativeHostBootstrapEnvironment(environment: NodeJS.ProcessEnv): void {
  const names = new Set([
    'ZTOOLS_NATIVE_HOST_TOKEN',
    'ZTOOLS_NATIVE_PLUGIN_ROOT',
    'ZTOOLS_NATIVE_RESOURCES_ROOT',
    'ZTOOLS_NATIVE_RESOURCES_MANIFEST_SHA256',
    'ZTOOLS_NATIVE_MANIFEST_ROOT',
    'ZTOOLS_NATIVE_MANIFEST_SHA256'
  ])
  for (const name of Object.keys(environment)) {
    if (names.has(name.toLocaleUpperCase('en-US'))) delete environment[name]
  }
}

function decodeHostError(frame: NativeHostFrame): ZToolsError {
  try {
    const value: unknown = JSON.parse(frame.payload.toString('utf8'))
    if (
      typeof value === 'object' && value !== null &&
      'code' in value && typeof value.code === 'string' &&
      'message' in value && typeof value.message === 'string'
    ) {
      const hostCode = value.code
      const code = hostCode === 'INVALID_REQUEST'
        ? errorCodes.invalidRequest
        : ['MANIFEST_UNTRUSTED', 'DLL_NOT_ALLOWED', 'FUNCTION_NOT_ALLOWED'].includes(hostCode)
          ? errorCodes.permissionDenied
        : hostCode === 'HOST_STOPPING'
          ? errorCodes.appStopping
          : hostCode === 'INPUT_UNAVAILABLE' || [
              'DLL_ASYNC_UNSUPPORTED',
              'DLL_CALLBACK_UNSUPPORTED',
              'DLL_CANCEL_UNSUPPORTED'
            ].includes(hostCode)
            ? errorCodes.notSupported
          : hostCode === 'DLL_UNAVAILABLE'
            ? errorCodes.pluginNotFound
          : hostCode.startsWith('MANIFEST_') || [
              'DLL_INTEGRITY',
              'DLL_PATH_INVALID',
              'DLL_ARCH_INVALID',
              'DLL_IDENTITY_CHANGED'
            ].includes(hostCode)
            ? errorCodes.pluginIntegrity
          : [
              'DLL_FUNCTION_NOT_FOUND',
              'DLL_TASK_NOT_FOUND',
              'DLL_TASK_NOT_RUNNING',
              'DLL_TASK_DUPLICATE',
              'DLL_TASK_LIMIT',
              'DLL_BUSY',
              'DLL_CALL_FAILED',
              'DLL_RESPONSE_TOO_LARGE',
              'DLL_RESPONSE_INVALID'
            ].includes(hostCode)
            ? errorCodes.dllError
          : errorCodes.nativeHostProtocol
      return new ZToolsError(code, value.message, { hostCode })
    }
  } catch {
    // Invalid host errors are reduced to a stable public failure.
  }
  return new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 returned an invalid error')
}

export class NativeHostClient implements NativeDllClientPort, NativeInputInjectionAdapter {
  readonly #pluginMaintenance = new NativePluginMaintenance()
  #state: NativeHostState = 'idle'
  #child: ChildProcessWithoutNullStreams | null = null
  #sessionId = ''
  #decoder = new NativeHostFrameDecoder()
  #pending = new Map<string, PendingRequest>()
  #pendingTaskStarts = new Map<string, PendingTaskStart>()
  #ignoredResponses = new Set<string>()
  #dllEventListeners = new Set<NativeDllEventListener>()
  #inputEventListeners = new Set<NativeInputEventListener>()
  #lifecycleEventListeners = new Set<NativeHostLifecycleEventListener>()
  #stderr = ''
  #expectedExit = false
  #stopPromise: Promise<NativeHostShutdownResult> | null = null
  #launchGeneration = 0
  #launchInFlight = false
  #restartTimer: NodeJS.Timeout | null = null
  #restartEnabled = false
  #lifecycleSignal: AbortSignal | null = null
  #lifecycleAbortListener: (() => void) | null = null
  #recovering = false
  #restartAttempt = 0
  #lastExitCode: number | null = null
  #crashTimestamps: number[] = []

  constructor(
    private readonly executable: string,
    private readonly options: NativeHostClientOptions = {}
  ) {}

  get state(): NativeHostState {
    return this.#state
  }

  get diagnostics(): {
    state: NativeHostState
    pid: number | undefined
    exitCode: number | null
    stderr: string
    recovering: boolean
    restartAttempt: number
  } {
    return {
      state: this.#state,
      pid: this.#child?.pid,
      exitCode: this.#lastExitCode,
      stderr: this.#stderr,
      recovering: this.#recovering,
      restartAttempt: this.#restartAttempt
    }
  }

  onDllEvent(listener: NativeDllEventListener): () => void {
    this.#dllEventListeners.add(listener)
    return () => this.#dllEventListeners.delete(listener)
  }

  onInputEvent(listener: NativeInputEventListener): () => void {
    this.#inputEventListeners.add(listener)
    return () => this.#inputEventListeners.delete(listener)
  }

  onLifecycleEvent(listener: NativeHostLifecycleEventListener): () => void {
    this.#lifecycleEventListeners.add(listener)
    return () => this.#lifecycleEventListeners.delete(listener)
  }

  async start(timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
    }
    if (this.#pendingTaskStarts.size > 0) {
      throw new ZToolsError(
        errorCodes.nativeHostUnavailable,
        'NativeHost32 is still confirming the previous callback task start state'
      )
    }
    if (this.#launchInFlight ||
        (this.#state !== 'idle' && this.#state !== 'closed' && this.#state !== 'crashed')) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 state does not allow starting')
    }
    const generation = ++this.#launchGeneration
    this.#launchInFlight = true
    this.#clearRestartTimer()
    this.#releaseLifecycleAbortListener()
    this.#restartEnabled = true
    this.#recovering = false
    this.#restartAttempt = 0
    this.#crashTimestamps = []
    this.#stopPromise = null
    if (signal) {
      this.#lifecycleSignal = signal
      const onAbort = (): void => {
        void this.stop().catch(() => {})
      }
      this.#lifecycleAbortListener = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      await this.#launch(timeoutMs, signal, generation)
    } catch (error) {
      if (generation === this.#launchGeneration) {
        this.#restartEnabled = false
        if (!signal?.aborted) this.#releaseLifecycleAbortListener()
      }
      throw error
    } finally {
      if (generation === this.#launchGeneration) this.#launchInFlight = false
    }
  }

  async #launch(
    timeoutMs: number,
    signal: AbortSignal | null | undefined,
    generation: number
  ): Promise<void> {
    if (signal?.aborted || generation !== this.#launchGeneration) {
      throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
    }
    const resolved = path.resolve(this.executable)
    if (path.basename(resolved).toLocaleLowerCase('en-US') !== 'ztoolsnativehost32.exe') {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 executable path')
    }
    try {
      const stats = await fs.stat(resolved)
      if (!stats.isFile()) throw new Error('not a file')
    } catch {
      if (signal?.aborted || generation !== this.#launchGeneration) {
        throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
      }
      throw new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 executable not found')
    }
    if (signal?.aborted || generation !== this.#launchGeneration) {
      throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
    }

    const configuredRoot = this.options.pluginRoot
    const configuredDigest = this.options.trustedManifestSha256
    const configuredResourcesRoot = this.options.resourcesRoot
    const configuredResourcesDigest = this.options.trustedResourcesManifestSha256
    if (
      (configuredRoot !== undefined && (
        configuredRoot.includes('\0') || !path.isAbsolute(configuredRoot)
      )) ||
      (configuredDigest !== undefined && !/^[a-f0-9]{64}$/i.test(configuredDigest)) ||
      (configuredDigest !== undefined && configuredRoot === undefined) ||
      (configuredResourcesRoot !== undefined && (
        configuredResourcesRoot.includes('\0') || !path.isAbsolute(configuredResourcesRoot)
      )) ||
      (configuredResourcesDigest !== undefined &&
        !/^[a-f0-9]{64}$/i.test(configuredResourcesDigest)) ||
      (configuredResourcesDigest !== undefined && configuredResourcesRoot === undefined) ||
      (configuredResourcesRoot !== undefined && configuredResourcesDigest === undefined)
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 trusted directory configuration')
    }

    this.#state = 'awaiting-hello'
    this.#sessionId = randomUUID()
    this.#decoder = new NativeHostFrameDecoder()
    this.#ignoredResponses.clear()
    this.#stderr = ''
    this.#lastExitCode = null
    this.#expectedExit = false
    const secret = randomBytes(NATIVE_HOST_SECRET_BYTES)
    const clientNonce = randomBytes(NATIVE_HOST_NONCE_BYTES)
    const clientProof = hmac(secret, [CLIENT_DOMAIN, Buffer.from(this.#sessionId, 'utf8'), Buffer.from([0]), clientNonce])
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env }
    clearNativeHostBootstrapEnvironment(childEnvironment)
    if (this.options.resourcesRoot !== undefined) {
      childEnvironment.ZTOOLS_NATIVE_RESOURCES_ROOT = path.resolve(this.options.resourcesRoot)
    }
    if (configuredResourcesDigest !== undefined) {
      childEnvironment.ZTOOLS_NATIVE_RESOURCES_MANIFEST_SHA256 =
        configuredResourcesDigest.toLowerCase()
    }
    if (configuredRoot !== undefined) {
      childEnvironment.ZTOOLS_NATIVE_PLUGIN_ROOT = path.resolve(configuredRoot)
    }
    if (configuredDigest !== undefined) {
      childEnvironment.ZTOOLS_NATIVE_MANIFEST_SHA256 = configuredDigest.toLowerCase()
    }
    childEnvironment.ZTOOLS_NATIVE_HOST_TOKEN = secret.toString('hex')
    childEnvironment[ZTOOLS_LOCALE_ENV_KEY] = getResolvedLocale()
    if (signal?.aborted || generation !== this.#launchGeneration) {
      secret.fill(0)
      clientNonce.fill(0)
      clientProof.fill(0)
      throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
    }
    const spawnOptions: SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'> = {
      env: childEnvironment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }
    const child = (this.options.spawnProcess ?? spawn)(resolved, [], spawnOptions)
    this.#child = child
    this.#bindChild(child)

    try {
      const response = await this.#exchange({
        protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
        type: NativeHostFrameType.Hello,
        sessionId: this.#sessionId,
        requestId: randomUUID(),
        pluginId: '',
        dllId: '',
        method: 'hello',
        payload: Buffer.concat([clientNonce, clientProof])
      }, NativeHostFrameType.HelloAck, timeoutMs)
      if (response.method !== 'hello_ack' || response.payload.length !== NATIVE_HOST_NONCE_BYTES + NATIVE_HOST_PROOF_BYTES) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 handshake response')
      }
      const serverNonce = response.payload.subarray(0, NATIVE_HOST_NONCE_BYTES)
      const suppliedProof = response.payload.subarray(NATIVE_HOST_NONCE_BYTES)
      const expectedProof = hmac(secret, [
        SERVER_DOMAIN,
        Buffer.from(this.#sessionId, 'utf8'),
        Buffer.from([0]),
        clientNonce,
        serverNonce
      ])
      if (!timingSafeEqual(suppliedProof, expectedProof)) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 server authentication failed')
      }
      if (generation !== this.#launchGeneration ||
          this.#child !== child || this.#state !== 'awaiting-hello') {
        throw new ZToolsError(
          this.#recovering ? errorCodes.nativeHostCrashed : errorCodes.nativeHostUnavailable,
          'NativeHost32 exited before completing handshake'
        )
      }
      this.#state = 'ready'
    } catch (error) {
      if (generation === this.#launchGeneration && this.#child === child) {
        this.#terminate(error instanceof Error ? error : new Error('NativeHost32 failed to start'))
      }
      if (signal?.aborted || generation !== this.#launchGeneration) {
        throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 startup cancelled')
      }
      throw error
    } finally {
      secret.fill(0)
      clientNonce.fill(0)
      clientProof.fill(0)
    }
  }

  async request(
    method: string,
    payload: Uint8Array = Buffer.from('{}'),
    options: NativeHostRequestOptions = {}
  ): Promise<Buffer> {
    if (this.#state !== 'ready') {
      if (this.#state === 'stopping') {
        throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 is stopping')
      }
      if (this.#recovering || this.#state === 'crashed' || this.#state === 'restarting') {
        throw new ZToolsError(errorCodes.nativeHostCrashed, 'NativeHost32 has crashed and has not recovered')
      }
      throw new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 is not ready')
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(method)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 method format')
    }
    const identities: ReadonlyArray<readonly [string, string]> = [
      ['pluginId', options.pluginId ?? ''],
      ['dllId', options.dllId ?? '']
    ]
    for (const [name, value] of identities) {
      if (value !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new ZToolsError(errorCodes.invalidRequest, `Invalid NativeHost32 ${name} format`)
      }
    }
    if (payload.byteLength > MAX_NATIVE_HOST_PAYLOAD_BYTES) {
      throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 payload exceeds size limit')
    }
    if (options.signal?.aborted) throw new ZToolsError(errorCodes.callerDestroyed, 'NativeHost32 call was cancelled')

    const requestId = randomUUID()
    const exchange = this.#exchange({
      protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
      type: NativeHostFrameType.Request,
      sessionId: this.#sessionId,
      requestId,
      pluginId: options.pluginId ?? '',
      dllId: options.dllId ?? '',
      method,
      payload: Buffer.from(payload)
    }, NativeHostFrameType.Response, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!options.signal) return (await exchange).payload

    return await new Promise<Buffer>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(requestId)
        if (pending) {
          clearTimeout(pending.timer)
          this.#pending.delete(requestId)
          this.#ignoreResponse(requestId)
          pending.reject(new ZToolsError(errorCodes.callerDestroyed, 'NativeHost32 call was cancelled'))
        }
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      exchange.then(
        (frame) => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve(frame.payload)
        },
        (error: unknown) => {
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }

  async checkDllAccess(pluginId: string, dllId: string, functionName: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(functionName)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 function format')
    }
    const response = await this.request('manifest_check', Buffer.from(functionName, 'utf8'), {
      pluginId,
      dllId
    })
    let value: unknown
    try {
      value = JSON.parse(response.toString('utf8'))
    } catch {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 manifest response')
    }
    if (
      typeof value !== 'object' || value === null ||
      !('success' in value) || value.success !== true || Object.keys(value).length !== 1
    ) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 manifest response')
    }
  }

  async configureMouseTrigger(config: NativeMouseTriggerConfig | null): Promise<void> {
    const buttonValues: Record<NativeMouseButton, number> = {
      middle: 1,
      right: 2,
      forward: 3,
      backward: 4
    }
    const actionValues: Record<NativeMouseAction, number> = { press: 1, long: 2 }
    // 停用发送 5 字节兼容帧；启用时发送 6 字节，第 6 字节携带 fullscreenDnd 标记位
    const payload = config === null ? Buffer.alloc(5) : Buffer.alloc(6)
    if (config !== null) {
      if (!Number.isInteger(config.longPressMs) || config.longPressMs < 200 || config.longPressMs > 500) {
        throw new ZToolsError(errorCodes.invalidRequest, 'Invalid mouse long-press threshold')
      }
      if (config.fullscreenDnd !== undefined && typeof config.fullscreenDnd !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, 'Invalid mouse trigger fullscreen DND configuration')
      }
      payload[0] = 1
      payload[1] = buttonValues[config.button]
      payload[2] = actionValues[config.action]
      payload.writeUInt16LE(config.longPressMs, 3)
      payload[5] = config.fullscreenDnd === false ? 0 : 1
    }
    const response = await this.request('mouse_hook_configure', payload)
    let value: unknown
    try {
      value = JSON.parse(response.toString('utf8'))
    } catch {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 mouse hook response')
    }
    if (!isRecord(value) || value.success !== true || value.enabled !== (config !== null)) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 mouse hook response')
    }
  }

  async configureKeyboardDoubleTap(
    modifiers: readonly NativeKeyboardModifier[],
    fullscreenDnd = true
  ): Promise<void> {
    const values: Record<NativeKeyboardModifier, number> = { ctrl: 1, alt: 2, shift: 4 }
    if (modifiers.length > 3 || new Set(modifiers).size !== modifiers.length) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid keyboard double-tap modifier configuration')
    }
    if (typeof fullscreenDnd !== 'boolean') {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid keyboard double-tap fullscreen DND configuration')
    }
    let mask = 0
    for (const modifier of modifiers) {
      const value = values[modifier]
      if (value === undefined) {
        throw new ZToolsError(errorCodes.invalidRequest, 'Invalid keyboard double-tap modifier')
      }
      mask |= value
    }
    // 停用发送 1 字节兼容帧；启用时发送 2 字节，第 2 字节携带 fullscreenDnd 标记位
    const payload = modifiers.length === 0
      ? Buffer.from([0])
      : Buffer.from([mask, fullscreenDnd ? 1 : 0])
    const response = await this.request('keyboard_hook_configure', payload)
    let value: unknown
    try {
      value = JSON.parse(response.toString('utf8'))
    } catch {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 keyboard hook response')
    }
    if (!isRecord(value) || value.success !== true || value.enabled !== (modifiers.length > 0)) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 keyboard hook response')
    }
  }

  async getForegroundWindow(signal?: AbortSignal): Promise<bigint> {
    const response = await this.request('input_get_foreground', Buffer.alloc(0), requestOptions(signal))
    if (response.length !== 8) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 foreground window response')
    }
    const handle = response.readBigUInt64LE(0)
    if (handle === 0n) throw new ZToolsError(errorCodes.notSupported, 'No available external target window')
    return handle
  }

  async restoreForegroundWindow(handle: bigint, signal?: AbortSignal): Promise<void> {
    if (handle <= 0n || handle > 0xffffffffffffffffn) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid window handle')
    }
    const payload = Buffer.alloc(8)
    payload.writeBigUInt64LE(handle, 0)
    const response = await this.request('input_restore_foreground', payload, requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 foreground window restore response')
  }

  async injectKeyPress(key: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('input_key_press', encodeVirtualKey(key), requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 key injection response')
  }

  async injectKeyCombo(keys: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('input_key_combo', encodeVirtualKeyCombo(keys), requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 key combo injection response')
  }

  async injectText(text: string, signal?: AbortSignal): Promise<void> {
    const payload = Buffer.from(text, 'utf8')
    if (payload.length === 0 || payload.length > 256 * 1024) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid input text length')
    }
    const response = await this.request('input_text', payload, requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 text injection response')
  }

  async injectMouseMove(x: number, y: number, signal?: AbortSignal): Promise<void> {
    const payload = Buffer.alloc(8)
    payload.writeInt32LE(x, 0)
    payload.writeInt32LE(y, 4)
    const response = await this.request('input_mouse_move', payload, requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 mouse move response')
  }

  async injectMouseClick(
    button: 'left' | 'right' | 'middle',
    x?: number,
    y?: number,
    signal?: AbortSignal
  ): Promise<void> {
    const buttonValues = { left: 1, right: 2, middle: 3 } as const
    const hasPosition = x !== undefined || y !== undefined
    if (hasPosition !== (y !== undefined)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Mouse click coordinates x and y must both be provided')
    }
    const payload = Buffer.alloc(hasPosition ? 10 : 2)
    payload[0] = buttonValues[button]
    payload[1] = hasPosition ? 1 : 0
    if (hasPosition) {
      payload.writeInt32LE(x as number, 2)
      payload.writeInt32LE(y as number, 6)
    }
    const response = await this.request('input_mouse_click', payload, requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 mouse click response')
  }

  async injectMouseWheel(delta: number, signal?: AbortSignal): Promise<void> {
    const payload = Buffer.alloc(4)
    payload.writeInt32LE(delta, 0)
    const response = await this.request('input_mouse_wheel', payload, requestOptions(signal))
    assertNativeSuccess(response, 'Invalid NativeHost32 mouse scroll response')
  }

  async getDllInfo(
    pluginId: string,
    dllId: string,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<NativeDllInfo> {
    void context
    const response = await this.request('dll_get_info', Buffer.alloc(0), {
      pluginId,
      dllId,
      ...requestOptions(signal)
    })
    let value: unknown
    try {
      value = JSON.parse(response.toString('utf8'))
    } catch {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL metadata response')
    }
    if (
      !isRecord(value) ||
      typeof value.pluginName !== 'string' || typeof value.version !== 'string' ||
      typeof value.author !== 'string' || typeof value.description !== 'string' ||
      !Array.isArray(value.functions) || !value.functions.every((item) => typeof item === 'string') ||
      typeof value.supportsAsync !== 'boolean' || typeof value.supportsCallback !== 'boolean' ||
      typeof value.supportsCancel !== 'boolean' || typeof value.supportsStopManagedProcesses !== 'boolean'
    ) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL metadata response')
    }
    return value as unknown as NativeDllInfo
  }

  async callDll(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<NativeDllCallResult> {
    void context
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(functionName)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 function format')
    }
    let paramsJson: string | undefined
    try {
      paramsJson = JSON.stringify(params)
    } catch {
      throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 DLL parameters are not serializable')
    }
    if (paramsJson === undefined) {
      throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 DLL parameters are not serializable')
    }
    const functionBytes = Buffer.from(functionName, 'utf8')
    const paramsBytes = Buffer.from(paramsJson, 'utf8')
    const payload = Buffer.allocUnsafe(2 + functionBytes.length + paramsBytes.length)
    payload.writeUInt16LE(functionBytes.length, 0)
    functionBytes.copy(payload, 2)
    paramsBytes.copy(payload, 2 + functionBytes.length)
    // DLL execution may wait for user input. The IPC caller owns its deadline;
    // host shutdown/crash and caller cancellation still release this request.
    const response = await this.request('dll_call', payload, {
      pluginId,
      dllId,
      timeoutMs: 'infinite',
      ...requestOptions(signal)
    })
    return decodeDllCallResult(response)
  }

  async callDllAsync(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): Promise<string> {
    return await this.#awaitTaskStart(this.beginDllAsyncTask(
      pluginId, dllId, functionName, params, context, signal, preassignedTaskId
    ), DEFAULT_TIMEOUT_MS)
  }

  beginDllAsyncTask(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): NativeDllTaskStartAttempt {
    return this.#beginDllTask(
      'dll_call_async', pluginId, dllId, functionName, params, context, signal, preassignedTaskId
    )
  }

  beginDllCallbackTask(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): NativeDllTaskStartAttempt {
    return this.#beginDllTask(
      'dll_call_with_callback', pluginId, dllId, functionName, params, context, signal, preassignedTaskId
    )
  }

  #beginDllTask(
    method: 'dll_call_async' | 'dll_call_with_callback',
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): NativeDllTaskStartAttempt {
    void context
    if (signal?.aborted) {
      throw new ZToolsError(errorCodes.callerDestroyed, 'NativeHost32 call was cancelled')
    }
    if (this.#state !== 'ready') {
      if (this.#state === 'stopping') {
        throw new ZToolsError(errorCodes.appStopping, 'NativeHost32 is stopping')
      }
      if (this.#recovering || this.#state === 'crashed' || this.#state === 'restarting') {
        throw new ZToolsError(errorCodes.nativeHostCrashed, 'NativeHost32 has crashed and has not recovered')
      }
      throw new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 is not ready')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(pluginId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dllId) ||
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(functionName)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 DLL task ID')
    }
    if (this.#pendingTaskStarts.size >= MAX_PENDING_TASK_STARTS) {
      throw new ZToolsError(
        errorCodes.nativeHostUnavailable,
        'NativeHost32 DLL task start queue is full'
      )
    }
    const child = this.#child
    if (!child) {
      throw new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 is not ready')
    }

    const taskId = preassignedTaskId ?? `task_${randomUUID()}`
    this.#validateTaskId(taskId)
    const payload = encodeDllTaskCall(taskId, functionName, params)
    if (payload.byteLength > MAX_NATIVE_HOST_PAYLOAD_BYTES) {
      throw new ZToolsError(errorCodes.invalidRequest, 'NativeHost32 payload exceeds size limit')
    }
    const requestId = randomUUID()
    const frame: NativeHostFrame = {
      protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
      type: NativeHostFrameType.Request,
      sessionId: this.#sessionId,
      requestId,
      pluginId,
      dllId,
      method,
      payload
    }
    const encoded = encodeNativeHostFrame(frame)
    let resolveOutcome!: (outcome: NativeDllTaskStartOutcome) => void
    const outcome = new Promise<NativeDllTaskStartOutcome>((resolve) => {
      resolveOutcome = resolve
    })
    this.#pluginMaintenance.sent(requestId, pluginId, method)
    this.#pendingTaskStarts.set(requestId, { child, taskId, pluginId, dllId, method, resolve: resolveOutcome })
    try {
      child.stdin.write(encoded, (error) => {
        if (error && this.#pendingTaskStarts.has(requestId)) this.#terminate(error)
      })
    } catch (error) {
      this.#terminate(error instanceof Error ? error : new Error('NativeHost32 write failed'))
    }
    return { taskId, outcome }
  }

  async callDllWithCallback(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): Promise<string> {
    const attempt = this.beginDllCallbackTask(
      pluginId, dllId, functionName, params, context, signal, preassignedTaskId
    )
    return await this.#awaitTaskStart(attempt, DEFAULT_TIMEOUT_MS)
  }

  async #awaitTaskStart(
    attempt: NativeDllTaskStartAttempt,
    timeoutMs: number
  ): Promise<string> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ZToolsError(errorCodes.requestTimeout, 'NativeHost32 call timed out'))
      }, timeoutMs)
    })
    let outcome: NativeDllTaskStartOutcome
    try {
      outcome = await Promise.race([attempt.outcome, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (outcome.kind === 'started') return attempt.taskId
    throw outcome.error
  }

  async queryDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<NativeDllTaskStatus> {
    void context
    this.#validateTaskId(taskId)
    const response = await this.request('dll_query_task', Buffer.from(taskId, 'utf8'), {
      pluginId,
      dllId,
      ...requestOptions(signal)
    })
    let value: unknown
    try {
      value = JSON.parse(decodeUtf8(response, 'NativeHost32 DLL task status is not valid UTF-8'))
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL task status')
    }
    const modes = new Set(['async', 'callback'])
    const states = new Set(['invoking', 'running', 'completed', 'cancelled', 'error'])
    if (
      !isRecord(value) || value.taskId !== taskId || !modes.has(String(value.mode)) ||
      !states.has(String(value.status)) || !Number.isInteger(value.progress) ||
      Number(value.progress) < 0 || Number(value.progress) > 100 ||
      typeof value.functionName !== 'string' ||
      (value.error !== null && typeof value.error !== 'string') ||
      (value.result !== undefined && value.result !== null &&
        (typeof value.result !== 'string' ||
          !['completed', 'cancelled', 'error'].includes(String(value.status))))
    ) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL task status')
    }
    if (value.resultReady !== undefined && typeof value.resultReady !== 'boolean') {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL task result status')
    }
    if (value.result !== undefined && value.result !== null && typeof value.result !== 'string') {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL task result')
    }
    return value as unknown as NativeDllTaskStatus
  }

  async cancelDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<number> {
    void context
    this.#validateTaskId(taskId)
    const response = await this.request('dll_cancel_task', Buffer.from(taskId, 'utf8'), {
      pluginId,
      dllId,
      ...requestOptions(signal)
    })
    const call = decodeDllCallResult(response)
    if (call.result !== null) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL cancel response')
    }
    return call.code
  }

  async clearDllTask(
    pluginId: string,
    dllId: string,
    taskId: string,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<void> {
    void context
    this.#validateTaskId(taskId)
    const response = await this.request('dll_clear_task', Buffer.from(taskId, 'utf8'), {
      pluginId,
      dllId,
      ...requestOptions(signal)
    })
    if (response.toString('utf8') !== '{"success":true}') {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL task cleanup response')
    }
  }

  #validateTaskId(taskId: string): void {
    if (!/^task_[A-Za-z0-9_-]{1,123}$/.test(taskId)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 taskId format')
    }
  }

  acquirePluginMaintenance(pluginId: string): Promise<() => void> {
    return this.#pluginMaintenance.acquire(pluginId)
  }

  async unloadDll(
    pluginId: string,
    dllId: string,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<void> {
    void context
    const response = await this.request('dll_unload', Buffer.alloc(0), {
      pluginId,
      dllId,
      ...requestOptions(signal)
    })
    if (response.toString('utf8') !== '{"success":true}') {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL unload response')
    }
  }

  stop(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<NativeHostShutdownResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      return Promise.reject(
        new ZToolsError(errorCodes.invalidRequest, 'Invalid NativeHost32 exit deadline')
      )
    }
    if (this.#stopPromise) return this.#stopPromise
    const hadPendingLaunch = this.#launchInFlight
    this.#launchGeneration++
    this.#launchInFlight = false
    if (hadPendingLaunch && !this.#child && this.#state === 'idle') this.#state = 'closed'
    this.#restartEnabled = false
    this.#releaseLifecycleAbortListener()
    this.#stopPromise = this.#stop(timeoutMs)
    return this.#stopPromise
  }

  async #stop(timeoutMs: number): Promise<NativeHostShutdownResult> {
    this.#restartEnabled = false
    this.#recovering = false
    this.#clearRestartTimer()
    if (this.#state === 'idle' || this.#state === 'closed') return emptyShutdownResult()
    const child = this.#child
    if (!child) {
      this.#state = 'closed'
      this.#dllEventListeners.clear()
      this.#inputEventListeners.clear()
      return emptyShutdownResult()
    }
    if (this.#state !== 'ready') {
      this.#expectedExit = true
      child.kill()
      const exited = await this.#waitForExit(child, timeoutMs)
      this.#state = 'closed'
      this.#child = null
      this.#dllEventListeners.clear()
      this.#inputEventListeners.clear()
      return emptyShutdownResult({ completed: false, timedOut: !exited, forced: true })
    }

    const startedAt = Date.now()
    const exitReserveMs = Math.min(500, Math.max(50, Math.floor(timeoutMs / 10)))
    const hostDeadlineMs = Math.max(50, timeoutMs - exitReserveMs)
    this.#state = 'stopping'
    this.#expectedExit = true
    this.#rejectPendingForStop()
    let report = emptyShutdownResult({ completed: false })
    let shutdownError: unknown
    try {
      const payload = Buffer.allocUnsafe(4)
      payload.writeUInt32LE(hostDeadlineMs)
      const response = await this.#exchange({
        protocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
        type: NativeHostFrameType.Request,
        sessionId: this.#sessionId,
        requestId: randomUUID(),
        pluginId: '',
        dllId: '',
        method: 'shutdown',
        payload
      }, NativeHostFrameType.Response, timeoutMs)
      report = decodeShutdownResult(response.payload)
    } catch (error) {
      shutdownError = error
      report = emptyShutdownResult({
        completed: false,
        timedOut: error instanceof ZToolsError && error.code === errorCodes.requestTimeout,
        forced: true
      })
    } finally {
      child.stdin.end()
      let exited = child.exitCode !== null
      if (!report.completed || report.timedOut) report.forced = true
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
      if (!exited && report.completed && !report.timedOut && remainingMs > 0) {
        exited = await this.#waitForExit(child, remainingMs)
      }
      if (!exited) {
        report.forced = true
        child.kill()
        await this.#waitForExit(child, Math.min(1_000, timeoutMs))
      }
      this.#state = 'closed'
      this.#child = null
      this.#dllEventListeners.clear()
      this.#inputEventListeners.clear()
    }
    if (shutdownError !== undefined &&
        !(shutdownError instanceof ZToolsError && (
          shutdownError.code === errorCodes.requestTimeout ||
          shutdownError.code === errorCodes.appStopping ||
          shutdownError.code === errorCodes.nativeHostUnavailable
        ))) {
      throw shutdownError
    }
    return report
  }

  #bindChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return
      try {
        for (const frame of this.#decoder.push(chunk)) this.#handleFrame(frame)
      } catch (error) {
        this.#terminate(error instanceof Error ? error : new Error('NativeHost32 protocol error'))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.#child !== child) return
      if (this.#stderr.length >= MAX_STDERR_BYTES) return
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(0, MAX_STDERR_BYTES)
    })
    child.once('error', () => {
      if (this.#child !== child) return
      this.#terminate(new ZToolsError(errorCodes.nativeHostUnavailable, 'NativeHost32 failed to start'))
    })
    child.once('exit', (exitCode, signal) => {
      const isCurrentChild = this.#child === child
      const exitError = this.#state === 'stopping'
        ? new ZToolsError(errorCodes.appStopping, 'NativeHost32 is stopping')
        : new ZToolsError(errorCodes.nativeHostCrashed, 'NativeHost32 exited; callback task start state is unknown')
      this.#settleTaskStartsForChild(child, exitError)
      if (isCurrentChild) this.#pluginMaintenance.hostExited()
      if (!isCurrentChild) return
      this.#lastExitCode = exitCode
      const previousState = this.#state
      const unexpected = !this.#expectedExit && previousState !== 'closed' &&
        previousState !== 'stopping'
      const pid = child.pid
      this.#child = null
      if (!unexpected) {
        if (this.#pending.size > 0) {
          this.#rejectAll(new ZToolsError(
            previousState === 'stopping' ? errorCodes.appStopping : errorCodes.nativeHostUnavailable,
            previousState === 'stopping' ? 'NativeHost32 is stopping' : 'NativeHost32 exited'
          ))
        }
        if (previousState !== 'restarting') this.#state = 'closed'
        return
      }
      const error = new ZToolsError(
        previousState === 'ready' || this.#recovering
          ? errorCodes.nativeHostCrashed
          : errorCodes.nativeHostUnavailable,
        previousState === 'ready' || this.#recovering
          ? 'NativeHost32 exited unexpectedly'
          : 'NativeHost32 failed to start'
      )
      this.#state = previousState === 'ready' ? 'crashed' : 'closed'
      this.#rejectAll(error)
      if (previousState === 'ready') {
        this.#recovering = true
        this.#emitLifecycleEvent({
          type: 'crashed',
          pid,
          exitCode,
          signal,
          stderr: this.#stderr
        })
        this.#scheduleRestart()
      }
    })
  }

  #handleFrame(frame: NativeHostFrame): void {
    if (frame.protocolVersion !== NATIVE_HOST_PROTOCOL_VERSION || frame.sessionId !== this.#sessionId) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 protocol or session mismatch')
    }
    if (frame.type === NativeHostFrameType.Event) {
      if (frame.method === 'mouse_trigger' || frame.method === 'keyboard_double_tap') {
        this.#handleInputEvent(frame)
      }
      else this.#handleDllEvent(frame)
      return
    }
    this.#pluginMaintenance.settled(frame.requestId)
    const pendingTaskStart = this.#pendingTaskStarts.get(frame.requestId)
    if (pendingTaskStart) {
      // Host responses identify the authenticated session/request only; they
      // do not echo the request's plugin/DLL. Error frames use method "error".
      const expectedMethod = frame.type === NativeHostFrameType.Error ? 'error' : pendingTaskStart.method
      if (frame.pluginId !== '' || frame.dllId !== '' || frame.method !== expectedMethod) {
        this.#terminate(new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL start response identity'))
        return
      }
      if (frame.type === NativeHostFrameType.Error) {
        const error = decodeHostError(frame)
        const hostCode = error.details?.hostCode
        if (pendingTaskStart.nativeTaskObserved) {
          this.#pendingTaskStarts.delete(frame.requestId)
          pendingTaskStart.resolve({ kind: 'started' })
        } else if (typeof hostCode === 'string' && DEFINITIVE_TASK_START_ERRORS.has(hostCode)) {
          this.#pendingTaskStarts.delete(frame.requestId)
          pendingTaskStart.resolve({ kind: 'not-started', error })
        } else {
          pendingTaskStart.ambiguousResponseReceived = true
        }
        // An ambiguous response needs a matching task event or actual child exit.
        return
      }
      if (frame.type !== NativeHostFrameType.Response) {
        this.#terminate(new ZToolsError(
          errorCodes.nativeHostProtocol,
          'Invalid NativeHost32 callback task start response type'
        ))
        return
      }
      let acknowledgedTaskId: string
      try {
        acknowledgedTaskId = decodeUtf8(
          frame.payload,
          'NativeHost32 DLL task response is not valid UTF-8'
        )
      } catch (error) {
        this.#terminate(error instanceof Error ? error : new Error('Invalid NativeHost32 callback task start response'))
        return
      }
      if (acknowledgedTaskId !== pendingTaskStart.taskId) {
        this.#terminate(new ZToolsError(
          errorCodes.nativeHostProtocol,
          'Invalid NativeHost32 DLL task response'
        ))
        return
      }
      this.#pendingTaskStarts.delete(frame.requestId)
      pendingTaskStart.resolve({ kind: 'started' })
      return
    }
    const pending = this.#pending.get(frame.requestId)
    if (!pending) {
      if (this.#ignoredResponses.delete(frame.requestId)) return
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'NativeHost32 returned an unknown request ID')
    }
    clearTimeout(pending.timer)
    this.#pending.delete(frame.requestId)
    if (frame.type === NativeHostFrameType.Error) {
      pending.reject(decodeHostError(frame))
      return
    }
    if (frame.type !== pending.expectedType) {
      pending.reject(new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 response type'))
      return
    }
    pending.resolve(frame)
  }

  #handleInputEvent(frame: NativeHostFrame): void {
    if (frame.method === 'keyboard_double_tap') {
      if (
        frame.requestId !== 'keyboard_double_tap' || frame.pluginId !== '' || frame.dllId !== '' ||
        frame.payload.length !== 1
      ) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 keyboard event identity')
      }
      const modifiers: Record<number, NativeKeyboardModifier | undefined> = {
        1: 'ctrl',
        2: 'alt',
        3: 'shift'
      }
      const modifier = modifiers[frame.payload[0] ?? 0]
      if (!modifier) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 keyboard event payload')
      }
      const event: NativeInputEvent = { type: 'keyboard-double-tap', modifier }
      for (const listener of this.#inputEventListeners) {
        try {
          listener(event)
        } catch {
          // Input consumers cannot corrupt the authenticated Host transport.
        }
      }
      return
    }
    const buttons: Record<number, NativeMouseButton | undefined> = {
      1: 'middle',
      2: 'right',
      3: 'forward',
      4: 'backward'
    }
    const actions: Record<number, NativeMouseAction | undefined> = { 1: 'press', 2: 'long' }
    if (
      frame.requestId !== 'mouse_trigger' || frame.pluginId !== '' || frame.dllId !== '' ||
      frame.payload.length !== 4
    ) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 mouse event identity')
    }
    const buttonValue = frame.payload[0]
    const actionValue = frame.payload[1]
    const threshold = frame.payload.readUInt16LE(2)
    const button = buttonValue === undefined ? undefined : buttons[buttonValue]
    const action = actionValue === undefined ? undefined : actions[actionValue]
    if (!button || !action || threshold < 200 || threshold > 500) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 mouse event payload')
    }
    const event: NativeInputEvent = {
      type: 'mouse-trigger',
      config: { button, action, longPressMs: threshold }
    }
    for (const listener of this.#inputEventListeners) {
      try {
        listener(event)
      } catch {
        // Input consumers cannot corrupt the authenticated Host transport.
      }
    }
  }

  #handleDllEvent(frame: NativeHostFrame): void {
    if (!/^task_[A-Za-z0-9_-]{1,123}$/.test(frame.requestId)) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL event taskId')
    }
    if (frame.pluginId.length === 0 || frame.dllId.length === 0) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL event identity')
    }
    const base = { pluginId: frame.pluginId, dllId: frame.dllId, taskId: frame.requestId }
    let event: NativeDllEvent
    if (frame.method === 'dll_progress') {
      if (frame.payload.length < 4) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL progress event')
      }
      const percent = frame.payload.readInt32LE(0)
      if (percent < -1 || percent > 100) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL progress range')
      }
      event = {
        ...base,
        type: 'progress',
        percent,
        message: decodeUtf8(frame.payload.subarray(4), 'NativeHost32 DLL progress message is not valid UTF-8')
      }
    } else if (frame.method === 'dll_callback_result') {
      event = {
        ...base,
        type: 'callback-result',
        result: decodeUtf8(frame.payload, 'NativeHost32 DLL callback result is not valid UTF-8')
      }
    } else if (frame.method === 'dll_async_return' || frame.method === 'dll_callback_return') {
      event = {
        ...base,
        type: frame.method === 'dll_async_return' ? 'async-return' : 'callback-return',
        call: decodeDllCallResult(frame.payload)
      }
    } else if (frame.method === 'dll_cancelled') {
      const call = decodeDllCallResult(frame.payload)
      if (call.result !== null) {
        throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL cancel event')
      }
      event = { ...base, type: 'cancelled', code: call.code }
    } else if (frame.method === 'dll_task_error') {
      event = {
        ...base,
        type: 'task-error',
        error: decodeUtf8(frame.payload, 'NativeHost32 DLL task error is not valid UTF-8')
      }
    } else {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 DLL event type')
    }
    for (const [requestId, pending] of this.#pendingTaskStarts) {
      if (pending.child !== this.#child || pending.taskId !== event.taskId ||
          pending.pluginId !== event.pluginId || pending.dllId !== event.dllId) continue
      pending.nativeTaskObserved = true
      if (pending.ambiguousResponseReceived) {
        this.#pendingTaskStarts.delete(requestId)
        pending.resolve({ kind: 'started' })
      }
      // A task event without a response does not release the response tracker.
      break
    }
    for (const listener of this.#dllEventListeners) {
      try {
        listener(event)
      } catch {
        // Event consumers cannot corrupt the authenticated Host transport.
      }
    }
  }

  async #exchange(
    frame: NativeHostFrame,
    expectedType: NativeHostFrameType,
    timeoutMs: number | 'infinite'
  ): Promise<NativeHostFrame> {
    const child = this.#child
    if (!child || (timeoutMs !== 'infinite' &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000))) {
      throw new ZToolsError(errorCodes.nativeHostProtocol, 'Invalid NativeHost32 request state or timeout')
    }
    const encoded = encodeNativeHostFrame(frame)
    this.#pluginMaintenance.sent(frame.requestId, frame.pluginId, frame.method)
    const response = new Promise<NativeHostFrame>((resolve, reject) => {
      const timer = timeoutMs === 'infinite' ? undefined : setTimeout(() => {
        this.#pending.delete(frame.requestId)
        this.#ignoreResponse(frame.requestId)
        reject(new ZToolsError(errorCodes.requestTimeout, 'NativeHost32 call timed out'))
      }, timeoutMs)
      this.#pending.set(frame.requestId, { expectedType, timer, resolve, reject })
    })
    // Observe the response immediately: stop/timeout can reject it before the
    // pipe write callback runs (or while the pipe is backpressured).
    void new Promise<void>((resolve, reject) => {
      child.stdin.write(encoded, (error) => error ? reject(error) : resolve())
    }).catch((error: unknown) => {
      const pending = this.#pending.get(frame.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.#pending.delete(frame.requestId)
        pending.reject(error instanceof Error ? error : new Error('NativeHost32 write failed'))
      }
    })
    return await response
  }

  #terminate(error: Error): void {
    this.#expectedExit = true
    this.#child?.kill()
    this.#state = 'closed'
    this.#rejectAll(error)
  }

  #scheduleRestart(): void {
    if (!this.#restartEnabled) {
      this.#state = 'closed'
      this.#recovering = false
      return
    }
    const now = Date.now()
    this.#crashTimestamps = this.#crashTimestamps.filter(
      (timestamp) => now - timestamp < RESTART_WINDOW_MS
    )
    this.#crashTimestamps.push(now)
    if (this.#crashTimestamps.length > MAX_RESTART_ATTEMPTS) {
      this.#state = 'crashed'
      this.#recovering = false
      this.#restartAttempt = MAX_RESTART_ATTEMPTS
      this.#emitLifecycleEvent({
        type: 'restart-exhausted',
        failuresInWindow: this.#crashTimestamps.length
      })
      return
    }

    const attempt = this.#crashTimestamps.length
    const delayMs = Math.min(
      RESTART_BASE_DELAY_MS * (2 ** (attempt - 1)),
      RESTART_MAX_DELAY_MS
    )
    this.#restartAttempt = attempt
    this.#state = 'restarting'
    this.#emitLifecycleEvent({ type: 'restart-scheduled', attempt, delayMs })
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      if (!this.#restartEnabled || !this.#recovering || this.#state !== 'restarting') return
      const generation = this.#launchGeneration
      void this.#launch(DEFAULT_TIMEOUT_MS, this.#lifecycleSignal, generation).then(() => {
        if (!this.#restartEnabled || generation !== this.#launchGeneration || this.#state !== 'ready') return
        this.#recovering = false
        this.#emitLifecycleEvent({ type: 'restarted', attempt, pid: this.#child?.pid })
      }).catch(() => {
        if (!this.#restartEnabled || this.#state === 'stopping') return
        this.#recovering = true
        this.#scheduleRestart()
      })
    }, delayMs)
  }

  #clearRestartTimer(): void {
    if (!this.#restartTimer) return
    clearTimeout(this.#restartTimer)
    this.#restartTimer = null
  }

  #releaseLifecycleAbortListener(): void {
    const signal = this.#lifecycleSignal
    const listener = this.#lifecycleAbortListener
    this.#lifecycleSignal = null
    this.#lifecycleAbortListener = null
    if (signal && listener) signal.removeEventListener('abort', listener)
  }

  #emitLifecycleEvent(event: NativeHostLifecycleEvent): void {
    for (const listener of this.#lifecycleEventListeners) {
      try {
        listener(event)
      } catch {
        // Lifecycle observers cannot alter Host recovery state.
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #settleTaskStartsForChild(
    child: ChildProcessWithoutNullStreams,
    error: Error
  ): void {
    for (const [requestId, pending] of this.#pendingTaskStarts) {
      if (pending.child !== child) continue
      this.#pendingTaskStarts.delete(requestId)
      pending.resolve({ kind: 'host-exited', error })
    }
  }

  #rejectPendingForStop(): void {
    const error = new ZToolsError(errorCodes.appStopping, 'NativeHost32 is stopping')
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#ignoreResponse(requestId)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #ignoreResponse(requestId: string): void {
    if (this.#ignoredResponses.size >= MAX_IGNORED_RESPONSES) {
      const oldest = this.#ignoredResponses.values().next().value
      if (typeof oldest === 'string') this.#ignoredResponses.delete(oldest)
    }
    this.#ignoredResponses.add(requestId)
  }

  async #waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolve(false)
      }, timeoutMs)
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  }
}
