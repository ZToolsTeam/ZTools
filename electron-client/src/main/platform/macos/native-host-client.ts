import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  NativeDllCallResult,
  NativeDllEventListener,
  NativeDllInfo,
  NativeDllInvocationContext,
  NativeDllTaskStartAttempt,
  NativeDllTaskStatus,
  OrdinaryNativeRuntimePort
} from '../../native-host/dll-client-port.js'
import type { NativeHostShutdownResult } from '../../native-host/native-host-client.js'
import type { MacNativeRuntimePolicyV1 } from './native-runtime-policy.js'
import { resolveMacNativeComponentCandidate } from './native-runtime-policy.js'
import {
  decodeMacNativeFrame,
  encodeMacNativeFrame,
  MAC_NATIVE_WIRE_HEADER_BYTES,
  MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES,
  MAC_NATIVE_WIRE_VERSION,
  MacNativeFrameType,
  parseMacNativeOwner
} from './native-wire.js'

export interface MacNativeHostLaunchOptions {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly pluginRoot: string
  readonly processArchitecture: NodeJS.Architecture
  readonly runningUnderTranslation: boolean
}

interface PendingResponse {
  owner: bigint
  generation: bigint
  taskId: bigint
  pluginInstanceId?: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface CodesignResult {
  stdout: string
  stderr: string
}

const HANDSHAKE_TIMEOUT_MS = 5000
const REQUEST_TIMEOUT_MS = 120_000
const STDERR_LIMIT_BYTES = 32 * 1024
const CHILD_STOP_TIMEOUT_MS = 2000
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PLUGIN_INSTANCE_ID_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|main:[1-9]\d{0,15})$/
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

function architectureSlice(value: string): 'arm64' | 'x86_64' | undefined {
  switch (value) {
    case 'arm64': return 'arm64'
    case 'x64': return 'x86_64'
    default: return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  return new Error(fallback)
}

function parseJsonPayload(payload: Buffer): Record<string, unknown> {
  const text = payload.toString('utf8')
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('MAC_NATIVE_RESPONSE_INVALID')
  return value
}

function boundedAppend(current: string, value: Buffer): string {
  const combined = current + value.toString('utf8')
  return Buffer.byteLength(combined, 'utf8') <= STDERR_LIMIT_BYTES
    ? combined
    : Buffer.from(combined, 'utf8').subarray(-STDERR_LIMIT_BYTES).toString('utf8')
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
}

async function runCodesign(args: string[], signal?: AbortSignal): Promise<CodesignResult> {
  if (signal?.aborted) throw new Error('MAC_NATIVE_START_CANCELLED')
  return await new Promise<CodesignResult>((resolve, reject) => {
    const child = spawn('/usr/bin/codesign', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('MAC_CODESIGN_TIMEOUT'))
    }, 15_000)
    const abort = () => {
      child.kill('SIGKILL')
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('MAC_NATIVE_START_CANCELLED'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (code !== 0) reject(new Error(`MAC_CODESIGN_FAILED_${code ?? 'UNKNOWN'}`))
      else resolve({ stdout, stderr })
    })
  })
}

async function codesignMetadata(pathValue: string, signal?: AbortSignal, dynamicProcess = false): Promise<{ teamId: string; identifier: string }> {
  await runCodesign(['--verify', '--strict', ...(dynamicProcess ? ['--verbose=4'] : []), pathValue], signal)
  const details = await runCodesign(['--display', '--verbose=4', pathValue], signal)
  const text = `${details.stdout}\n${details.stderr}`
  const teamId = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1]
  const identifier = /^Identifier=([A-Za-z0-9._-]+)$/m.exec(text)?.[1]
  const flagMatch = /^flags=(0x[0-9a-f]+)\(([^)]+)\)$/im.exec(text)
  const flags = flagMatch?.[2]?.split(',').map((flag) => flag.trim()) ?? []
  if (!teamId || !identifier || !BUNDLE_ID_PATTERN.test(identifier) || !flags?.includes('runtime')) {
    throw new Error('MAC_SIGNED_RUNTIME_IDENTITY_OR_HARDENING_INVALID')
  }
  const entitlements = await runCodesign(['--display', '--entitlements', ':-', pathValue], signal)
  const entitlementText = `${entitlements.stdout}\n${entitlements.stderr}`
  if (entitlementText.includes('com.apple.security.cs.disable-library-validation')) {
    throw new Error('MAC_LIBRARY_VALIDATION_DISABLED')
  }
  return { teamId, identifier }
}

function assertNoSymlinkedFile(pathValue: string): fs.Stats {
  const info = fs.lstatSync(pathValue)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('MAC_NATIVE_RESOURCE_NOT_REGULAR_FILE')
  return info
}

function validInvocation(context: NativeDllInvocationContext | undefined):
  | { owner: bigint; generation: bigint; pluginInstanceId: string }
  | undefined {
  if (!context || typeof context.pluginInstanceId !== 'string' || !PLUGIN_INSTANCE_ID_PATTERN.test(context.pluginInstanceId) ||
      !Number.isSafeInteger(context.webContentsId) || context.webContentsId <= 0) return undefined
  const owner = parseMacNativeOwner(context.ownerToken)
  const generation = parseMacNativeOwner(context.generation)
  if (owner === undefined || generation === undefined) return undefined
  return { owner, generation, pluginInstanceId: context.pluginInstanceId }
}

function objectResult(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function resolveApprovedMacComponent(policy: MacNativeRuntimePolicyV1, state: string,
                                            pluginId: string, componentId: string): {
  readonly relativePath: string
  readonly sha256: string
} | undefined {
  if (state !== 'ready' || !PLUGIN_ID_PATTERN.test(pluginId) || !PLUGIN_ID_PATTERN.test(componentId)) {
    return undefined
  }
  const component = policy.components.find((candidate) =>
    candidate.pluginId === pluginId && candidate.dllId === componentId)
  if (!component) return undefined
  return Object.freeze({ relativePath: component.relativePath, sha256: component.sha256 })
}

export function createMacNativePluginReleasePayload(pluginId: string): Readonly<{
  operation: 'releasePlugin'
  pluginId: string
}> {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('MAC_NATIVE_PLUGIN_ID_INVALID')
  return Object.freeze({ operation: 'releasePlugin', pluginId })
}

export class MacNativeHostClient implements OrdinaryNativeRuntimePort {
  #state = 'unavailable'
  #exitCode: number | null = null
  #stderr = ''
  #child: ChildProcessWithoutNullStreams | null = null
  #buffer = Buffer.alloc(0)
  #pending = new Map<string, PendingResponse>()
  #listeners = new Set<NativeDllEventListener>()
  #requestSequence = 0n
  #taskSequence = 0n
  #startup: Promise<void> | null = null
  #shutdown: Promise<NativeHostShutdownResult> | null = null
  #maintenance = new Map<string, number>()
  #processArchitecture: string
  #unexpectedReadyHostExit = false
  #plannedShutdown = false

  constructor(
    readonly options: MacNativeHostLaunchOptions,
    readonly policy: MacNativeRuntimePolicyV1
  ) {
    this.#processArchitecture = architectureSlice(options.processArchitecture) ?? 'unknown'
  }

  get state(): string { return this.#state }

  get diagnostics(): OrdinaryNativeRuntimePort['diagnostics'] {
    const result: OrdinaryNativeRuntimePort['diagnostics'] = {
      state: this.#state,
      exitCode: this.#exitCode,
      stderr: this.#stderr
    }
    if (this.#child?.pid !== undefined) result.pid = this.#child.pid
    if (this.#state === 'ready') result.protocolVersion = MAC_NATIVE_WIRE_VERSION
    return result
  }

  getApprovedMacComponent(pluginId: string, componentId: string): {
    readonly relativePath: string
    readonly sha256: string
  } | undefined {
    return resolveApprovedMacComponent(this.policy, this.#state, pluginId, componentId)
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.#state === 'ready') return
    if (this.#startup) return await this.#startup
    this.#startup = this.#start(signal)
    try {
      await this.#startup
    } finally {
      this.#startup = null
    }
  }

  async #start(signal?: AbortSignal): Promise<void> {
    if (this.#state === 'stopped') throw new Error('MAC_NATIVE_HOST_STOPPED')
    if (process.platform !== 'darwin' || !this.options.isPackaged) {
      this.#state = 'unavailable'
      throw new Error('MAC_NATIVE_HOST_REQUIRES_PACKAGED_DARWIN')
    }
    const architecture = architectureSlice(this.options.processArchitecture)
    if (!architecture || architecture !== this.#processArchitecture || !this.policy.architectures.includes(architecture)) {
      this.#state = 'unavailable'
      throw new Error('MAC_NATIVE_PROCESS_ARCHITECTURE_UNAPPROVED')
    }
    this.#state = 'starting'
    const bundlePath = path.resolve(this.options.resourcesPath, '..', '..')
    const expectedResources = path.join(bundlePath, 'Contents', 'Resources')
    const packagedApplicationPaths = [
      path.join(this.options.resourcesPath, 'app.asar'),
      path.join(this.options.resourcesPath, 'app')
    ]
    if (path.resolve(this.options.resourcesPath) !== expectedResources ||
        !packagedApplicationPaths.includes(path.resolve(this.options.appPath)) || !bundlePath.endsWith('.app')) {
      this.#state = 'unavailable'
      throw new Error('MAC_NATIVE_APP_BUNDLE_LAYOUT_INVALID')
    }
    const hostPath = path.join(this.options.resourcesPath, 'native', 'ZToolsMacNativeHost')
    const workerPath = path.join(this.options.resourcesPath, 'native', 'ZToolsMacNativeWorker')
    const hostBefore = assertNoSymlinkedFile(hostPath)
    const workerBefore = assertNoSymlinkedFile(workerPath)
    try {
      await runCodesign(['--verify', '--deep', '--strict', bundlePath], signal)
      const appIdentity = await codesignMetadata(bundlePath, signal)
      const hostIdentity = await codesignMetadata(hostPath, signal)
      const workerIdentity = await codesignMetadata(workerPath, signal)
      if (appIdentity.teamId !== this.policy.teamId || appIdentity.identifier !== this.policy.appBundleId ||
          hostIdentity.teamId !== this.policy.teamId || hostIdentity.identifier !== this.policy.hostBundleId ||
          workerIdentity.teamId !== this.policy.teamId || workerIdentity.identifier !== this.policy.workerBundleId) {
        throw new Error('MAC_NATIVE_CODE_IDENTITY_MISMATCH')
      }
    } catch (error) {
      this.#state = 'unavailable'
      throw asError(error, 'MAC_NATIVE_CODE_SIGNATURE_INVALID')
    }
    const hostAfter = assertNoSymlinkedFile(hostPath)
    const workerAfter = assertNoSymlinkedFile(workerPath)
    if (!sameFileSnapshot(hostBefore, hostAfter) || !sameFileSnapshot(workerBefore, workerAfter)) {
      this.#state = 'unavailable'
      throw new Error('MAC_NATIVE_EXECUTABLE_CHANGED_DURING_PREFLIGHT')
    }
    this.#spawn(hostPath, workerPath)
    try {
      const child = this.#child
      if (!child) throw new Error('MAC_NATIVE_HOST_NOT_STARTED')
      if (!child.pid) {
        await new Promise<void>((resolve, reject) => {
          const spawned = () => { cleanup(); resolve() }
          const failed = (error: Error) => { cleanup(); reject(error) }
          const cleanup = () => {
            child.removeListener('spawn', spawned)
            child.removeListener('error', failed)
          }
          child.once('spawn', spawned)
          child.once('error', failed)
          if (child.pid) spawned()
        })
      }
      if (!child.pid) throw new Error('MAC_NATIVE_HOST_PID_UNAVAILABLE')
      const processIdentity = await codesignMetadata(`+${child.pid}`, signal, true)
      if (processIdentity.teamId !== this.policy.teamId || processIdentity.identifier !== this.policy.hostBundleId) {
        throw new Error('MAC_NATIVE_HOST_PROCESS_IDENTITY_MISMATCH')
      }
    } catch (error) {
      await this.#forceStop(CHILD_STOP_TIMEOUT_MS)
      this.#state = 'unavailable'
      throw asError(error, 'MAC_NATIVE_HOST_PROCESS_VALIDATION_FAILED')
    }
    const handshake = await this.#waitForHandshake(signal)
    if (handshake.status !== 'ready' || handshake.wireVersion !== MAC_NATIVE_WIRE_VERSION ||
        handshake.abiVersion !== 1 || handshake.architecture !== architecture ||
        handshake.teamId !== this.policy.teamId || handshake.identifier !== this.policy.hostBundleId ||
        handshake.hardenedRuntime !== true || handshake.libraryValidation !== true) {
      await this.#forceStop(CHILD_STOP_TIMEOUT_MS)
      this.#state = 'unavailable'
      throw new Error('MAC_NATIVE_HOST_HANDSHAKE_INVALID')
    }
    this.#state = 'ready'
  }

  #spawn(hostPath: string, workerPath: string): void {
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }
    if (typeof process.env.TMPDIR === 'string' && path.isAbsolute(process.env.TMPDIR)) environment.TMPDIR = process.env.TMPDIR
    const child = spawn(hostPath, [
      '--resources', this.options.resourcesPath,
      '--plugin-root', this.options.pluginRoot,
      '--architecture', this.#processArchitecture,
      '--worker', workerPath
    ], {
      cwd: this.options.resourcesPath,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    this.#child = child
    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => { this.#stderr = boundedAppend(this.#stderr, chunk) })
    child.once('error', (error) => this.#onExit(error))
    child.once('close', (code) => this.#onExit(undefined, code))
  }

  async #waitForHandshake(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const child = this.#child
    if (!child) throw new Error('MAC_NATIVE_HOST_NOT_STARTED')
    const framePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('MAC_NATIVE_HOST_HANDSHAKE_TIMEOUT'))
      }, HANDSHAKE_TIMEOUT_MS)
      const abort = () => {
        cleanup()
        reject(new Error('MAC_NATIVE_START_CANCELLED'))
      }
      const onFrame = (frame: ReturnType<typeof decodeMacNativeFrame>) => {
        if (frame.type !== MacNativeFrameType.handshake || frame.owner !== 1n || frame.generation !== 1n || frame.taskId !== 0n) {
          cleanup()
          reject(new Error('MAC_NATIVE_HOST_HANDSHAKE_FRAME_INVALID'))
          return
        }
        try {
          cleanup()
          resolve(parseJsonPayload(frame.payload))
        } catch (error) {
          reject(asError(error, 'MAC_NATIVE_HOST_HANDSHAKE_INVALID'))
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.#handshakeFrame = undefined
      }
      this.#handshakeFrame = onFrame
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    return await framePromise
  }

  #handshakeFrame: ((frame: ReturnType<typeof decodeMacNativeFrame>) => void) | undefined

  #onStdout(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= MAC_NATIVE_WIRE_HEADER_BYTES) {
      if (this.#buffer.toString('ascii', 0, 4) !== 'ZTMN') {
        this.#failAll(new Error('MAC_NATIVE_HOST_FRAME_MAGIC_INVALID'))
        this.#forceStop(CHILD_STOP_TIMEOUT_MS).catch(() => undefined)
        return
      }
      const payloadLength = this.#buffer.readUInt32LE(8)
      if (payloadLength > MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) {
        this.#failAll(new Error('MAC_NATIVE_HOST_FRAME_SIZE_INVALID'))
        this.#forceStop(CHILD_STOP_TIMEOUT_MS).catch(() => undefined)
        return
      }
      const frameLength = MAC_NATIVE_WIRE_HEADER_BYTES + payloadLength
      if (this.#buffer.length < frameLength) return
      const bytes = this.#buffer.subarray(0, frameLength)
      this.#buffer = this.#buffer.subarray(frameLength)
      let frame: ReturnType<typeof decodeMacNativeFrame>
      try {
        frame = decodeMacNativeFrame(bytes)
      } catch (error) {
        this.#failAll(asError(error, 'MAC_NATIVE_HOST_FRAME_INVALID'))
        this.#forceStop(CHILD_STOP_TIMEOUT_MS).catch(() => undefined)
        return
      }
      if (this.#handshakeFrame) {
        const receive = this.#handshakeFrame
        this.#handshakeFrame = undefined
        receive(frame)
        continue
      }
      this.#onFrame(frame)
    }
  }

  #onFrame(frame: ReturnType<typeof decodeMacNativeFrame>): void {
    if (frame.type === MacNativeFrameType.progress || frame.type === MacNativeFrameType.callback ||
        frame.type === MacNativeFrameType.cancelled) {
      return
    }
    if (frame.type !== MacNativeFrameType.response && frame.type !== MacNativeFrameType.error) {
      this.#failAll(new Error('MAC_NATIVE_HOST_RESPONSE_TYPE_INVALID'))
      this.#forceStop(CHILD_STOP_TIMEOUT_MS).catch(() => undefined)
      return
    }
    let response: Record<string, unknown>
    try {
      response = parseJsonPayload(frame.payload)
    } catch (error) {
      this.#failAll(asError(error, 'MAC_NATIVE_HOST_RESPONSE_INVALID'))
      return
    }
    const requestId = typeof response.requestId === 'string' ? response.requestId : undefined
    const pending = requestId ? this.#pending.get(requestId) : undefined
    if (!pending) return
    this.#pending.delete(requestId!)
    clearTimeout(pending.timer)
    if (pending.owner !== frame.owner || pending.generation !== frame.generation || pending.taskId !== frame.taskId) {
      pending.reject(new Error('MAC_NATIVE_HOST_RESPONSE_IDENTITY_MISMATCH'))
      return
    }
    if (frame.type === MacNativeFrameType.error || response.ok !== true) {
      const message = typeof response.error === 'string' && response.error.length <= 256
        ? response.error
        : 'MAC_NATIVE_OPERATION_FAILED'
      pending.reject(new Error(message))
      return
    }
    pending.resolve(response.result)
  }

  #onExit(error?: Error, code?: number | null): void {
    if (this.#child === null) return
    if (this.#state === 'ready' && !this.#plannedShutdown) this.#unexpectedReadyHostExit = true
    this.#exitCode = typeof code === 'number' ? code : null
    this.#child = null
    this.#state = 'unavailable'
    this.#failAll(error ?? new Error(`MAC_NATIVE_HOST_EXITED_${code ?? 'UNKNOWN'}`))
  }

  #failAll(error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(requestId)
    }
  }

  #sendRequest(
    owner: bigint,
    generation: bigint,
    type: number,
    payload: Record<string, unknown>,
    taskId = 0n,
    pluginInstanceId?: string
  ): Promise<unknown> {
    if (this.#state !== 'ready' || !this.#child?.stdin.writable) {
      return Promise.reject(new Error('MAC_NATIVE_HOST_UNAVAILABLE'))
    }
    this.#requestSequence += 1n
    const requestId = this.#requestSequence.toString(10)
    let encoded: Buffer
    try {
      const json = Buffer.from(JSON.stringify({
        ...payload,
        ...(pluginInstanceId ? { pluginInstanceId } : {}),
        requestId
      }), 'utf8')
      if (json.length > MAC_NATIVE_WIRE_MAX_PAYLOAD_BYTES) throw new Error('MAC_NATIVE_REQUEST_TOO_LARGE')
      encoded = encodeMacNativeFrame({
        version: MAC_NATIVE_WIRE_VERSION,
        type,
        owner,
        generation,
        taskId,
        payload: json
      })
    } catch (error) {
      return Promise.reject(asError(error, 'MAC_NATIVE_REQUEST_INVALID'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new Error('MAC_NATIVE_REQUEST_TIMEOUT'))
        if (taskId !== 0n) {
          this.#sendRequest(owner, generation, MacNativeFrameType.cancel, {
            operation: 'cancel', pluginId: payload.pluginId, targetTaskId: taskId.toString(10)
          }, taskId, pluginInstanceId).catch(() => undefined)
        }
      }, REQUEST_TIMEOUT_MS)
      this.#pending.set(requestId, {
        owner, generation, taskId,
        ...(pluginInstanceId === undefined ? {} : { pluginInstanceId }),
        resolve, reject, timer
      })
      this.#child!.stdin.write(encoded, (error) => {
        if (!error) return
        const pending = this.#pending.get(requestId)
        if (pending) {
          this.#pending.delete(requestId)
          clearTimeout(pending.timer)
          pending.reject(error)
        }
      })
    })
  }

  #assertComponent(pluginId: string, dllId: string): void {
    if (!PLUGIN_ID_PATTERN.test(pluginId) || !PLUGIN_ID_PATTERN.test(dllId)) throw new Error('MAC_NATIVE_COMPONENT_ID_INVALID')
    if (!resolveMacNativeComponentCandidate(this.policy, this.options.pluginRoot, pluginId, dllId,
      this.options.processArchitecture)) throw new Error('MAC_NATIVE_COMPONENT_NOT_IN_SEALED_CATALOG')
  }

  #assertMaintenanceOpen(pluginId: string): void {
    if ((this.#maintenance.get(pluginId) ?? 0) > 0) throw new Error('MAC_NATIVE_PLUGIN_UNDER_MAINTENANCE')
  }

  onDllEvent(listener: NativeDllEventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async getDllInfo(pluginId: string, dllId: string, context?: NativeDllInvocationContext): Promise<NativeDllInfo> {
    this.#assertComponent(pluginId, dllId)
    const identity = validInvocation(context)
    if (!identity) throw new Error('MAC_NATIVE_OWNER_CONTEXT_REQUIRED')
    this.#assertMaintenanceOpen(pluginId)
    const value = await this.#sendRequest(identity.owner, identity.generation, MacNativeFrameType.info,
      { operation: 'info', pluginId, dllId }, 0n, identity.pluginInstanceId)
    const info = objectResult(value)
    if (!info || typeof info.pluginName !== 'string' || typeof info.version !== 'string' ||
        typeof info.author !== 'string' || typeof info.description !== 'string' ||
        !Array.isArray(info.functions) || info.functions.some((item) => typeof item !== 'string')) {
      throw new Error('MAC_NATIVE_DLL_INFO_INVALID')
    }
    return {
      pluginName: info.pluginName,
      version: info.version,
      author: info.author,
      description: info.description,
      functions: info.functions as string[],
      supportsAsync: false,
      supportsCallback: false,
      supportsCancel: false,
      supportsStopManagedProcesses: false
    }
  }

  async callDll(pluginId: string, dllId: string, functionName: string, params: unknown,
                context?: NativeDllInvocationContext): Promise<NativeDllCallResult> {
    this.#assertComponent(pluginId, dllId)
    const identity = validInvocation(context)
    if (!identity) throw new Error('MAC_NATIVE_OWNER_CONTEXT_REQUIRED')
    this.#assertMaintenanceOpen(pluginId)
    if (typeof functionName !== 'string' || functionName.length === 0 || functionName.length > 256) {
      throw new Error('MAC_NATIVE_FUNCTION_NAME_INVALID')
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(functionName)) {
      throw new Error('MAC_NATIVE_FUNCTION_NAME_INVALID')
    }
    const taskId = ++this.#taskSequence
    const value = await this.#sendRequest(identity.owner, identity.generation, MacNativeFrameType.call,
      { operation: 'call', pluginId, dllId, functionName, params }, taskId, identity.pluginInstanceId)
    const result = objectResult(value)
    if (!result || !Number.isInteger(result.code) ||
        !(result.result === null || typeof result.result === 'string')) throw new Error('MAC_NATIVE_CALL_RESULT_INVALID')
    return { code: result.code as number, result: result.result as string | null }
  }

  async callDllAsync(): Promise<string> {
    throw new Error('MAC_NATIVE_ASYNC_ABI_UNSUPPORTED')
  }

  beginDllAsyncTask(): NativeDllTaskStartAttempt {
    return {
      taskId: `mac-${++this.#taskSequence}`,
      outcome: Promise.resolve({ kind: 'not-started', error: new Error('MAC_NATIVE_ASYNC_ABI_UNSUPPORTED') })
    }
  }

  beginDllCallbackTask(): NativeDllTaskStartAttempt {
    const taskId = `mac-${++this.#taskSequence}`
    return {
      taskId,
      outcome: Promise.resolve({ kind: 'not-started', error: new Error('MAC_NATIVE_CALLBACK_ABI_UNSUPPORTED') })
    }
  }

  async callDllWithCallback(): Promise<string> {
    throw new Error('MAC_NATIVE_CALLBACK_ABI_UNSUPPORTED')
  }

  async queryDllTask(pluginId: string, dllId: string, taskId: string): Promise<NativeDllTaskStatus> {
    return {
      taskId,
      mode: 'async',
      status: 'error',
      progress: 0,
      functionName: '',
      error: `MAC_NATIVE_TASK_UNSUPPORTED:${pluginId}:${dllId}`
    }
  }

  async cancelDllTask(): Promise<number> { return 1 }

  async clearDllTask(): Promise<void> {}

  async releaseOwner(context: NativeDllInvocationContext): Promise<void> {
    const identity = validInvocation(context)
    if (!identity) return
    if (this.#state !== 'ready') {
      if (this.#unexpectedReadyHostExit) throw new Error('MAC_NATIVE_OWNER_RELEASE_HOST_STATE_UNKNOWN')
      return
    }
    await this.#sendRequest(identity.owner, identity.generation, MacNativeFrameType.destroy,
      { operation: 'releaseOwner' }, 0n, identity.pluginInstanceId)
  }

  async acquirePluginMaintenance(pluginId: string): Promise<() => void> {
    const releasePayload = createMacNativePluginReleasePayload(pluginId)
    this.#maintenance.set(pluginId, (this.#maintenance.get(pluginId) ?? 0) + 1)
    try {
      if (this.#startup) {
        try { await this.#startup } catch {}
      }
      if (this.#unexpectedReadyHostExit || (this.#child !== null && this.#state !== 'ready')) {
        throw new Error('MAC_NATIVE_PLUGIN_MAINTENANCE_HOST_STATE_UNKNOWN')
      }
      if (this.#state === 'ready') {
        const result = objectResult(await this.#sendRequest(1n, 1n, MacNativeFrameType.destroy,
          releasePayload))
        if (!result || result.released !== true) throw new Error('MAC_NATIVE_PLUGIN_WORKER_RELEASE_FAILED')
      }
    } catch (error) {
      const count = this.#maintenance.get(pluginId) ?? 0
      if (count <= 1) this.#maintenance.delete(pluginId)
      else this.#maintenance.set(pluginId, count - 1)
      throw asError(error, 'MAC_NATIVE_PLUGIN_MAINTENANCE_FAILED')
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.#maintenance.get(pluginId) ?? 0
      if (count <= 1) this.#maintenance.delete(pluginId)
      else this.#maintenance.set(pluginId, count - 1)
    }
  }

  async unloadDll(pluginId: string, dllId: string, context?: NativeDllInvocationContext): Promise<void> {
    this.#assertComponent(pluginId, dllId)
    const identity = validInvocation(context)
    if (!identity) throw new Error('MAC_NATIVE_OWNER_CONTEXT_REQUIRED')
    await this.#sendRequest(identity.owner, identity.generation, MacNativeFrameType.destroy,
      { operation: 'unload', pluginId, dllId }, 0n, identity.pluginInstanceId)
  }

  async stop(timeoutMs = 5000): Promise<NativeHostShutdownResult> {
    if (this.#shutdown) return await this.#shutdown
    this.#shutdown = this.#stop(timeoutMs)
    try {
      return await this.#shutdown
    } finally {
      this.#shutdown = null
    }
  }

  async #stop(timeoutMs: number): Promise<NativeHostShutdownResult> {
    if (!this.#child) {
      this.#state = 'stopped'
      return {
        completed: true, timedOut: false, forced: false, cancelAttempted: 0, cancelFailed: 0,
        stopAttempted: 0, stopFailed: 0, tasksCleared: 0, sessionsUnloaded: 0,
        remainingTasks: 0, remainingActiveInvocations: 0, internalFailures: 0
      }
    }
    const child = this.#child
    this.#plannedShutdown = true
    let graceful = false
    try {
      const result = await this.#sendRequest(1n, 1n, MacNativeFrameType.shutdown, { operation: 'shutdown' })
      graceful = isRecord(result) && result.stopped === true
    } catch {}
    this.#state = 'stopping'
    const stopped = await this.#waitChildClose(child, Math.max(1, Math.min(timeoutMs, 30_000)))
    let forced = false
    if (!stopped) {
      forced = true
      child.kill('SIGKILL')
      await this.#waitChildClose(child, CHILD_STOP_TIMEOUT_MS)
    }
    if (!graceful) this.#unexpectedReadyHostExit = true
    this.#state = 'stopped'
    return {
      completed: stopped || forced,
      timedOut: !stopped,
      forced,
      cancelAttempted: 0,
      cancelFailed: 0,
      stopAttempted: 1,
      stopFailed: graceful ? 0 : 1,
      tasksCleared: this.#pending.size,
      sessionsUnloaded: 0,
      remainingTasks: this.#pending.size,
      remainingActiveInvocations: 0,
      internalFailures: 0
    }
  }

  async #forceStop(timeoutMs: number): Promise<void> {
    const child = this.#child
    if (!child) return
    child.kill('SIGTERM')
    if (!(await this.#waitChildClose(child, timeoutMs))) {
      child.kill('SIGKILL')
      await this.#waitChildClose(child, CHILD_STOP_TIMEOUT_MS)
    }
  }

  async #waitChildClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => finish(false), timeoutMs)
      const close = () => finish(true)
      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('close', close)
        resolve(value)
      }
      child.once('close', close)
    })
  }
}

export function macNativeRuntimeHostPaths(resourcesPath: string): { hostPath: string; workerPath: string } {
  return {
    hostPath: path.join(resourcesPath, 'native', 'ZToolsMacNativeHost'),
    workerPath: path.join(resourcesPath, 'native', 'ZToolsMacNativeWorker')
  }
}
