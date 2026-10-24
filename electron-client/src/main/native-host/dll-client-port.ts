import type { NativeHostShutdownResult } from './native-host-client.js'

export interface NativeDllInfo {
  pluginName: string
  version: string
  author: string
  description: string
  functions: string[]
  supportsAsync: boolean
  supportsCallback: boolean
  supportsCancel: boolean
  supportsStopManagedProcesses: boolean
}

export interface NativeDllCallResult {
  code: number
  result: string | null
}

export interface NativeDllTaskStatus {
  taskId: string
  mode: 'async' | 'callback'
  status: 'invoking' | 'running' | 'completed' | 'cancelled' | 'error'
  progress: number
  functionName: string
  error: string | null
  resultReady?: boolean
  result?: string | null
  callbackResults?: string[]
}

interface NativeDllEventBase {
  pluginId: string
  dllId: string
  taskId: string
}

export type NativeDllEvent =
  | (NativeDllEventBase & { type: 'progress'; percent: number; message: string })
  | (NativeDllEventBase & { type: 'callback-result'; result: string })
  | (NativeDllEventBase & { type: 'async-return' | 'callback-return'; call: NativeDllCallResult })
  | (NativeDllEventBase & { type: 'cancelled'; code: number })
  | (NativeDllEventBase & { type: 'task-error'; error: string })

export type NativeDllEventListener = (event: NativeDllEvent) => void

export type NativeDllTaskStartOutcome =
  | { kind: 'started' }
  | { kind: 'not-started'; error: Error }
  | { kind: 'host-exited'; error: Error }

export interface NativeDllTaskStartAttempt {
  readonly taskId: string
  /** Resolves from a matching ACK/refusal, an ambiguous response plus task event, or actual Host exit. */
  readonly outcome: Promise<NativeDllTaskStartOutcome>
}

/** Internal identity created by Main from the registered caller, never request parameters. */
export interface NativeDllInvocationContext {
  readonly ownerToken: string
  readonly generation: string
  readonly pluginInstanceId: string
  readonly webContentsId: number
}

/** Ordinary native capability port. Transport framing and process handles stay private. */
export interface NativeDllClientPort {
  releaseOwner?(context: NativeDllInvocationContext): Promise<void>
  onDllEvent(listener: NativeDllEventListener): () => void
  getDllInfo(pluginId: string, dllId: string, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<NativeDllInfo>
  callDll(pluginId: string, dllId: string, functionName: string, params: unknown, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<NativeDllCallResult>
  callDllAsync(pluginId: string, dllId: string, functionName: string, params: unknown, context?: NativeDllInvocationContext, signal?: AbortSignal, preassignedTaskId?: string): Promise<string>
  beginDllAsyncTask(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): NativeDllTaskStartAttempt
  beginDllCallbackTask(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal,
    preassignedTaskId?: string
  ): NativeDllTaskStartAttempt
  callDllWithCallback(pluginId: string, dllId: string, functionName: string, params: unknown, context?: NativeDllInvocationContext, signal?: AbortSignal, preassignedTaskId?: string): Promise<string>
  queryDllTask(pluginId: string, dllId: string, taskId: string, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<NativeDllTaskStatus>
  cancelDllTask(pluginId: string, dllId: string, taskId: string, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<number>
  clearDllTask(pluginId: string, dllId: string, taskId: string, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<void>
}

/** Privileged capabilities never fall back to the ordinary native port. */
export interface PrivilegedDllClientPort {
  readonly diagnostics: { readonly state: string }
  callDll(pluginId: string, dllId: string, functionName: string, params: Record<string, unknown>): Promise<unknown>
}

/** Ordinary DLL lifecycle is independent of optional OS input hooks. */
export interface OrdinaryNativeRuntimePort extends NativeDllClientPort {
  /** Main-only signed catalog lookup; unavailable until the Mac Host is trusted and ready. */
  getApprovedMacComponent?(pluginId: string, componentId: string): {
    readonly relativePath: string
    readonly sha256: string
  } | undefined
  readonly state: string
  readonly diagnostics: {
    state: string
    pid?: number | undefined
    exitCode: number | null
    protocolVersion?: number
    stderr: string
    recovering?: boolean
    restartAttempt?: number
  }
  stop(timeoutMs?: number): Promise<NativeHostShutdownResult>
  acquirePluginMaintenance(pluginId: string): Promise<() => void>
  unloadDll(pluginId: string, dllId: string, context?: NativeDllInvocationContext, signal?: AbortSignal): Promise<void>
}
