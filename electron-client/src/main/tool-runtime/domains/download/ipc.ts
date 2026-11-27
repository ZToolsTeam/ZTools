import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../../../contracts/capabilities.js'
import {
  DOWNLOAD_DOMAIN_ID,
  DOWNLOAD_PRIMITIVE_IDS,
  type DownloadPrimitiveId,
  type DownloadStreamProbeResponse,
  type DownloadStreamRunResponse,
  type DownloadTransferRecord,
  type DownloadTransferStatusResponse
} from '../../../../contracts/tool-runtime/domains/download.js'
import type { ToolPrimitiveId } from '../../../../contracts/tool-runtime/registry.js'
import {
  enforceToolRuntimePermission,
  type ToolDomainRegistration,
  type ToolRuntimeCoreContext
} from '../../core/domain-types.js'
import type { DownloadDomainDriver } from './driver.js'
import {
  DEFAULT_STREAM_RUN_TIMEOUT_MS,
  deriveSafeFileNameFromUrl,
  validateDownloadStreamProbeRequest,
  validateDownloadStreamRunRequest,
  validateDownloadTransferAddRequest,
  validateDownloadTransferControlRequest,
  validateDownloadTransferStatusRequest
} from './policy.js'

function assertDownloadPrimitive(primitiveId: ToolPrimitiveId): DownloadPrimitiveId {
  if (primitiveId === DOWNLOAD_PRIMITIVE_IDS.stream || primitiveId === DOWNLOAD_PRIMITIVE_IDS.transfer) {
    return primitiveId
  }
  throw new Error(`Unsupported download primitiveId: ${primitiveId}`)
}

/** 装配下载能力域全部 7 个薄原语 IPC 处理器与域级清单 */
export function createDownloadDomainRegistration(
  core: ToolRuntimeCoreContext,
  driver: DownloadDomainDriver
): ToolDomainRegistration {
  const handleStreamProbe = async (
    params: unknown,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<DownloadStreamProbeResponse> => {
    const auth = await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadStreamProbeRequest(params)
    return core.tasks.runManagedTask(
      {
        primitiveId: DOWNLOAD_PRIMITIVE_IDS.stream,
        caller,
        upstreamSignal: signal,
        autoCompleteIfProgressed: true
      },
      async ({ task, emitProgress }) =>
        core.limiter.run(auth.pluginKey, task.signal, async () =>
          driver.probeStream(
            {
              url: validated.url,
              timeoutMs: validated.timeoutMs ?? 30_000
            },
            {
              signal: task.signal,
              onProgress: emitProgress,
              onToolUsed: (toolId) => {
                if (auth.pluginId) core.commonLibs.recordLease(toolId, auth.pluginId)
              }
            }
          )
        )
    )
  }

  const handleStreamRun = async (
    params: unknown,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<DownloadStreamRunResponse> => {
    const auth = await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadStreamRunRequest(params)
    const resolvedDir = await core.pathGuard.resolveSlot(validated.outputDir, caller, {
      access: 'write',
      expectKind: 'directory',
      allowMissing: true
    })

    return core.tasks.runManagedTask(
      {
        ...(validated.taskId !== undefined ? { requestedTaskId: validated.taskId } : {}),
        primitiveId: DOWNLOAD_PRIMITIVE_IDS.stream,
        caller,
        upstreamSignal: signal
      },
      async ({ task, emitProgress }) =>
        core.limiter.run(auth.pluginKey, task.signal, async () =>
          driver.runStream(
            {
              taskId: task.taskId,
              url: validated.url,
              outputDir: resolvedDir.resolvedPath,
              ...(validated.fileName !== undefined ? { fileName: validated.fileName } : {}),
              ...(validated.trackId !== undefined ? { trackId: validated.trackId } : {}),
              preferAudioOnly: validated.preferAudioOnly === true,
              ...(validated.audioFormat !== undefined ? { audioFormat: validated.audioFormat } : {}),
              ...(validated.mergeContainer !== undefined
                ? { mergeContainer: validated.mergeContainer }
                : {}),
              ...(validated.maxRateBytesPerSec !== undefined
                ? { maxRateBytesPerSec: validated.maxRateBytesPerSec }
                : {}),
              timeoutMs: validated.timeoutMs ?? DEFAULT_STREAM_RUN_TIMEOUT_MS,
              overwrite: validated.overwrite === true
            },
            {
              signal: task.signal,
              onProgress: emitProgress,
              onToolUsed: (toolId) => {
                if (auth.pluginId) core.commonLibs.recordLease(toolId, auth.pluginId)
              }
            }
          )
        )
    )
  }

  const handleTransferAdd = async (
    params: unknown,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<DownloadTransferRecord> => {
    const auth = await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadTransferAddRequest(params)
    const resolvedDir = await core.pathGuard.resolveSlot(validated.outputDir, caller, {
      access: 'write',
      expectKind: 'directory',
      allowMissing: true
    })

    const taskId = validated.taskId ?? `dl_${randomUUID()}`
    const fileName = validated.fileName ?? deriveSafeFileNameFromUrl(validated.url)
    const task = core.tasks.createTask({
      requestedTaskId: taskId,
      primitiveId: DOWNLOAD_PRIMITIVE_IDS.transfer,
      caller,
      upstreamSignal: signal
    })

    // 监听窗口销毁 / tool_task_cancel，联动取消底层传输任务
    const onAbort = (): void => {
      void driver.cancelTransfer(taskId).catch(() => undefined)
      task.finish()
    }
    task.signal.addEventListener('abort', onAbort, { once: true })

    try {
      const record = await driver.addTransfer(
        {
          taskId,
          url: validated.url,
          outputDir: resolvedDir.resolvedPath,
          fileName,
          maxConnections: validated.maxConnections ?? 4,
          ...(validated.maxRateBytesPerSec !== undefined
            ? { maxRateBytesPerSec: validated.maxRateBytesPerSec }
            : {}),
          overwrite: validated.overwrite === true,
          ...(validated.expectedSha256 !== undefined ? { expectedSha256: validated.expectedSha256 } : {})
        },
        {
          signal: task.signal,
          onProgress: (payload) => {
            task.emitProgress(payload)
            if (payload.phase === 'completed' || payload.phase === 'failed' || payload.phase === 'cancelled') {
              task.signal.removeEventListener('abort', onAbort)
              task.finish()
            }
          },
          onToolUsed: (toolId) => {
            if (auth.pluginId) core.commonLibs.recordLease(toolId, auth.pluginId)
          }
        }
      )
      return record
    } catch (error) {
      task.signal.removeEventListener('abort', onAbort)
      task.finish()
      throw error
    }
  }

  const handleTransferPause = async (
    params: unknown,
    caller: CallerIdentity
  ): Promise<DownloadTransferRecord> => {
    await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadTransferControlRequest(params)
    return driver.pauseTransfer(validated.taskId)
  }

  const handleTransferResume = async (
    params: unknown,
    caller: CallerIdentity
  ): Promise<DownloadTransferRecord> => {
    await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadTransferControlRequest(params)
    return driver.resumeTransfer(validated.taskId)
  }

  const handleTransferCancel = async (
    params: unknown,
    caller: CallerIdentity
  ): Promise<DownloadTransferRecord> => {
    await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadTransferControlRequest(params)
    return driver.cancelTransfer(validated.taskId)
  }

  const handleTransferStatus = async (
    params: unknown,
    caller: CallerIdentity
  ): Promise<DownloadTransferStatusResponse> => {
    await enforceToolRuntimePermission(caller, 'network', core.manifests)
    const validated = validateDownloadTransferStatusRequest(params)
    const tasks = await driver.getTransferStatus(validated.taskId)
    return { tasks }
  }

  return {
    domain: DOWNLOAD_DOMAIN_ID,
    primitiveIds: [DOWNLOAD_PRIMITIVE_IDS.stream, DOWNLOAD_PRIMITIVE_IDS.transfer],
    handlers: {
      tool_download_stream_probe: handleStreamProbe,
      tool_download_stream_run: handleStreamRun,
      tool_download_transfer_add: handleTransferAdd,
      tool_download_transfer_pause: handleTransferPause,
      tool_download_transfer_resume: handleTransferResume,
      tool_download_transfer_cancel: handleTransferCancel,
      tool_download_transfer_status: handleTransferStatus
    },
    getCapabilityStatus: (primitiveId) => driver.getCapabilityStatus(assertDownloadPrimitive(primitiveId)),
    ensureCapability: (primitiveId, signal, onProgress) =>
      driver.ensureCapability(assertDownloadPrimitive(primitiveId), signal, onProgress),
    getOptionalExtensions: (primitiveId) =>
      driver.getOptionalExtensions?.(assertDownloadPrimitive(primitiveId)) ?? [],
    getStaticToolIds: (primitiveId) => driver.getStaticToolIds(assertDownloadPrimitive(primitiveId)),
    ...(driver.stop ? { stop: () => driver.stop?.() } : {})
  }
}
