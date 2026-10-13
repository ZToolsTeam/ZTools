import { app } from 'electron'
import { resolveRuntimeArchitecture } from '../platform/runtime-architecture.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes } from '../../contracts/errors.js'
import {
  ELECTRON_VERSION,
  NATIVE_HOST_PROTOCOL_VERSION,
  SDK_HOST_MAXIMUM_CONTRACT_VERSION,
  SERVICE_PROTOCOL_VERSION
} from '../../contracts/protocol-versions.js'

export interface RuntimeDiagnostics {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
  arch: string
  nativeOsArch: 'x86' | 'x64' | 'arm64' | 'unknown'
  wow64: boolean | null
  osVersion: string
  sdkContractVersion: number
  nativeHostProtocolVersion: number
  serviceProtocolVersion: number
}

export interface NativeRuntimeDiagnosticsFallback {
  nativeHost: { state: 'closed' | 'unsupported' | 'unknown'; stderr: string }
  service: {
    state: 'closed' | 'unsupported' | 'unknown'
    protocolVersion: number
    pipe: string
    lastError: string
    lastErrorMessage: string
  }
  superPanelInput: { mouseSupported: false; mouseEnabled: false; lastError: string }
}

export interface RuntimeNativeHostDiagnostics {
  state: string
  pid?: number | undefined
  stderr: string
  recovering?: boolean
  restartAttempt?: number
}

export interface RuntimeServiceDiagnostics {
  state: string
  protocolVersion: number
  pipe: string
  lastError: string
  lastErrorMessage: string
}

export interface RuntimeSuperPanelDiagnostics {
  mouseSupported?: boolean
  mouseEnabled: boolean
  lastError: string
}

export interface RuntimeDiagnosticDetails {
  nativeHost: RuntimeNativeHostDiagnostics
  service: RuntimeServiceDiagnostics
  superPanelInput: RuntimeSuperPanelDiagnostics
}

export interface RuntimeDiagnosticFailureInput {
  readonly requestId: unknown
  readonly method: unknown
  readonly failureStage: unknown
  readonly errorCode: unknown
}

export interface RuntimeDiagnosticFailure {
  readonly schemaVersion: 1
  readonly layer: 'main'
  readonly requestId: string
  readonly method: string
  readonly failureStage: string
  readonly errorCode: string
  readonly occurredAt: string
}

interface StoredRuntimeDiagnosticFailure {
  readonly ownerKey: string
  readonly failure: RuntimeDiagnosticFailure
  readonly observedAtMs: number
}

const MAX_RUNTIME_DIAGNOSTIC_FAILURES = 256
const RUNTIME_DIAGNOSTIC_FAILURE_RETENTION_MS = 30 * 60 * 1000
const requestIdPattern = /^[A-Za-z0-9:_-]{1,128}$/
const methodPattern = /^[a-z][a-z0-9_]{0,127}$/
const failureStages = new Set([
  'parse', 'identity', 'authorization', 'validation', 'execute', 'request', 'commit', 'reconcile', 'release',
  'network', 'native', 'unknown'
])

const diagnosticErrorCodes = new Set<string>(Object.values(errorCodes))
const knownNodePlatforms = new Set([
  'aix', 'android', 'cygwin', 'darwin', 'freebsd', 'linux', 'netbsd',
  'openbsd', 'sunos', 'win32'
])

/** In-memory, owner-scoped request failures. It never stores raw messages or request payloads. */
export class RuntimeDiagnosticFailureStore {
  readonly #entries: StoredRuntimeDiagnosticFailure[] = []

  constructor(private readonly now: () => number = Date.now) {}

  record(owner: CallerIdentity | undefined, input: RuntimeDiagnosticFailureInput): void {
    const ownerKey = runtimeDiagnosticOwnerKey(owner)
    const requestId = safeRuntimeRequestId(input?.requestId)
    const method = safeRuntimeMethod(input?.method)
    if (!ownerKey || !requestId || !method) return

    const observedAtMs = safeRuntimeTimestamp(this.now)
    this.#prune(observedAtMs)
    const failure: RuntimeDiagnosticFailure = Object.freeze({
      schemaVersion: 1,
      layer: 'main',
      requestId,
      method,
      failureStage: safeRuntimeFailureStage(input?.failureStage),
      errorCode: safeDiagnosticErrorCode(typeof input?.errorCode === 'string' ? input.errorCode : ''),
      occurredAt: new Date(observedAtMs).toISOString()
    })
    this.#entries.push({ ownerKey, failure, observedAtMs })
    this.#prune(observedAtMs)
  }

  read(owner: CallerIdentity | undefined, requestIds: unknown): readonly RuntimeDiagnosticFailure[] {
    const ownerKey = runtimeDiagnosticOwnerKey(owner)
    if (!ownerKey || !Array.isArray(requestIds) || requestIds.length === 0 || requestIds.length > 64) return Object.freeze([])
    const requested = new Set(requestIds.filter((value): value is string => safeRuntimeRequestId(value) !== undefined))
    if (requested.size === 0) return Object.freeze([])
    this.#prune(safeRuntimeTimestamp(this.now))
    return Object.freeze(this.#entries
      .filter(entry => entry.ownerKey === ownerKey && requested.has(entry.failure.requestId))
      .map(entry => entry.failure))
  }

  #prune(now: number): void {
    const cutoff = now - RUNTIME_DIAGNOSTIC_FAILURE_RETENTION_MS
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      if (this.#entries[index]!.observedAtMs < cutoff) this.#entries.splice(index, 1)
    }
    if (this.#entries.length > MAX_RUNTIME_DIAGNOSTIC_FAILURES) {
      this.#entries.splice(0, this.#entries.length - MAX_RUNTIME_DIAGNOSTIC_FAILURES)
    }
  }
}

function runtimeDiagnosticOwnerKey(owner: CallerIdentity | undefined): string | undefined {
  if (!owner || !Number.isSafeInteger(owner.webContentsId) || owner.webContentsId < 0 ||
      (owner.type !== 'main' && owner.type !== 'plugin')) return undefined
  if (owner.type === 'plugin' && (!owner.pluginId || !owner.pluginInstanceId)) return undefined
  return JSON.stringify([owner.type, owner.webContentsId, owner.pluginId ?? '', owner.pluginInstanceId ?? ''])
}

function safeRuntimeRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && requestIdPattern.test(value) ? value : undefined
}

function safeRuntimeMethod(value: unknown): string | undefined {
  return typeof value === 'string' && methodPattern.test(value) ? value : undefined
}

function safeRuntimeFailureStage(value: unknown): string {
  return typeof value === 'string' && failureStages.has(value) ? value : 'unknown'
}

function safeRuntimeTimestamp(now: () => number): number {
  try {
    const value = now()
    return Number.isFinite(value) ? Math.trunc(value) : Date.now()
  } catch { return Date.now() }
}

function redactDiagnosticText(value: string, source: string): string {
  return value ? `${source} 原始错误详情已隐藏` : ''
}

function safeDiagnosticErrorCode(value: string): string {
  return diagnosticErrorCodes.has(value) ? value : errorCodes.internalError
}

export function sanitizeRuntimeDiagnosticDetails(
  details: RuntimeDiagnosticDetails
): RuntimeDiagnosticDetails {
  return {
    nativeHost: {
      ...details.nativeHost,
      stderr: redactDiagnosticText(details.nativeHost.stderr, 'Native Host')
    },
    service: {
      ...details.service,
      pipe: details.service.pipe ? '已配置' : '',
      lastError: details.service.lastError
        ? safeDiagnosticErrorCode(details.service.lastError)
        : '',
      lastErrorMessage: redactDiagnosticText(details.service.lastErrorMessage, 'ZToolsService')
    },
    superPanelInput: {
      ...details.superPanelInput,
      mouseSupported: details.superPanelInput.mouseSupported === true,
      lastError: redactDiagnosticText(details.superPanelInput.lastError, 'SuperPanel 输入')
    }
  }
}

export function createNativeRuntimeDiagnosticsFallback(
  platform: string
): NativeRuntimeDiagnosticsFallback {
  const nativeRuntimeState = platform === 'win32'
    ? 'closed'
    : knownNodePlatforms.has(platform)
      ? 'unsupported'
      : 'unknown'
  return {
    nativeHost: {
      state: nativeRuntimeState,
      stderr: ''
    },
    service: {
      state: nativeRuntimeState,
      protocolVersion: 1,
      pipe: '',
      lastError: '',
      lastErrorMessage: ''
    },
    superPanelInput: {
      mouseSupported: false,
      mouseEnabled: false,
      lastError: platform === 'darwin'
        ? 'Native mouse input unsupported on macOS'
        : nativeRuntimeState === 'unsupported'
          ? 'Native mouse input unsupported on this platform'
          : nativeRuntimeState === 'unknown'
            ? 'Native mouse input status unknown on this platform'
            : 'NativeHost32 unavailable'
    }
  }
}

export function getRuntimeDiagnostics(): RuntimeDiagnostics {
  const architecture = resolveRuntimeArchitecture({
    platform: process.platform,
    processArch: process.arch,
    runningUnderARM64Translation: app.runningUnderARM64Translation,
    processorArchitecture: process.env.PROCESSOR_ARCHITECTURE,
    processorArchitew6432: process.env.PROCESSOR_ARCHITEW6432
  })
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? ELECTRON_VERSION,
    platform: process.platform,
    arch: process.arch,
    ...architecture,
    osVersion: process.getSystemVersion(),
    sdkContractVersion: SDK_HOST_MAXIMUM_CONTRACT_VERSION,
    nativeHostProtocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
    serviceProtocolVersion: SERVICE_PROTOCOL_VERSION
  }
}

export function formatRuntimeDiagnostics(value: RuntimeDiagnostics): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join('\n')
}
