import type { CallerIdentity } from '../../../../contracts/capabilities.js'
import {
  MEDIA_DOMAIN_ID,
  MEDIA_PRIMITIVE_IDS,
  type MediaPrimitiveId,
  type MediaProbeResponse,
  type MediaTranscodeResponse
} from '../../../../contracts/tool-runtime/domains/media.js'
import type { ToolPrimitiveId } from '../../../../contracts/tool-runtime/registry.js'
import {
  enforceToolRuntimePermission,
  type ToolDomainRegistration,
  type ToolRuntimeCoreContext
} from '../../core/domain-types.js'
import type { MediaDomainDriver, ResolvedMediaTranscodeJob } from './driver.js'
import { validateMediaProbeRequest, validateMediaTranscodeRequest } from './policy.js'

function assertMediaPrimitive(primitiveId: ToolPrimitiveId): MediaPrimitiveId {
  if (primitiveId === MEDIA_PRIMITIVE_IDS.probe || primitiveId === MEDIA_PRIMITIVE_IDS.transcode) {
    return primitiveId
  }
  throw new Error(`Unsupported media primitiveId: ${primitiveId}`)
}

/** 装配媒体能力域 IPC 处理器与域级元数据清单 */
export function createMediaDomainRegistration(
  core: ToolRuntimeCoreContext,
  driver: MediaDomainDriver
): ToolDomainRegistration {
  const handleProbe = async (
    params: unknown,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<MediaProbeResponse> => {
    const auth = await enforceToolRuntimePermission(caller, 'media.read', core.manifests)
    const validated = validateMediaProbeRequest(params)
    const resolvedSlots = await core.pathGuard.resolveSlots(validated.inputs, caller, {
      access: 'read',
      expectKind: 'file',
      allowMissing: false
    })
    const probeFiles = resolvedSlots.map((slot) => ({
      path: slot.resolvedPath,
      displayName: slot.displayName,
      sizeBytes: slot.sizeBytes ?? 0
    }))

    return core.tasks.runManagedTask(
      {
        primitiveId: MEDIA_PRIMITIVE_IDS.probe,
        caller,
        upstreamSignal: signal,
        autoCompleteIfProgressed: true
      },
      async ({ task, emitProgress }) =>
        core.limiter.run(auth.pluginKey, task.signal, async () => {
          const items = await driver.probe(probeFiles, {
            signal: task.signal,
            onProgress: emitProgress,
            onToolUsed: (toolId) => {
              if (auth.pluginId) core.commonLibs.recordLease(toolId, auth.pluginId)
            }
          })
          return { items }
        })
    )
  }

  const handleTranscodeRun = async (
    params: unknown,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<MediaTranscodeResponse> => {
    const auth = await enforceToolRuntimePermission(caller, 'media.process', core.manifests)
    const validated = validateMediaTranscodeRequest(params)
    const resolvedInput = await core.pathGuard.resolveSlot(validated.input, caller, {
      access: 'read',
      expectKind: 'file',
      allowMissing: false
    })
    const resolvedOutput = await core.pathGuard.resolveSlot(validated.output, caller, {
      access: 'write',
      expectKind: 'file',
      allowMissing: true
    })
    const resolvedWatermarkImage = validated.watermark
      ? await core.pathGuard.resolveSlot(validated.watermark.imageSlot, caller, {
          access: 'read',
          expectKind: 'file',
          allowMissing: false
        })
      : undefined

    return core.tasks.runManagedTask(
      {
        ...(validated.taskId !== undefined ? { requestedTaskId: validated.taskId } : {}),
        primitiveId: MEDIA_PRIMITIVE_IDS.transcode,
        caller,
        upstreamSignal: signal
      },
      async ({ task, emitProgress }) => {
        const job: ResolvedMediaTranscodeJob = {
          taskId: task.taskId,
          inputPath: resolvedInput.resolvedPath,
          outputPath: resolvedOutput.resolvedPath,
          overwrite: validated.overwrite === true,
          container: validated.container,
          ...(validated.videoCodec !== undefined ? { videoCodec: validated.videoCodec } : {}),
          ...(validated.audioCodec !== undefined ? { audioCodec: validated.audioCodec } : {}),
          ...(validated.videoBitrateKbps !== undefined ? { videoBitrateKbps: validated.videoBitrateKbps } : {}),
          ...(validated.audioBitrateKbps !== undefined ? { audioBitrateKbps: validated.audioBitrateKbps } : {}),
          ...(validated.frameRate !== undefined ? { frameRate: validated.frameRate } : {}),
          ...(validated.audioSampleRateHz !== undefined ? { audioSampleRateHz: validated.audioSampleRateHz } : {}),
          ...(validated.audioChannels !== undefined ? { audioChannels: validated.audioChannels } : {}),
          extractAudioOnly: validated.extractAudioOnly === true,
          stripAudio: validated.stripAudio === true,
          ...(validated.scale !== undefined ? { scale: validated.scale } : {}),
          ...(validated.trim !== undefined ? { trim: validated.trim } : {}),
          ...(validated.watermark && resolvedWatermarkImage
            ? {
                watermark: {
                  imagePath: resolvedWatermarkImage.resolvedPath,
                  position: validated.watermark.position,
                  ...(validated.watermark.opacity !== undefined ? { opacity: validated.watermark.opacity } : {}),
                  ...(validated.watermark.marginPx !== undefined ? { marginPx: validated.watermark.marginPx } : {})
                }
              }
            : {})
        }

        return core.limiter.run(auth.pluginKey, task.signal, async () =>
          driver.transcode(job, {
            signal: task.signal,
            onProgress: emitProgress,
            onToolUsed: (toolId) => {
              if (auth.pluginId) core.commonLibs.recordLease(toolId, auth.pluginId)
            }
          })
        )
      }
    )
  }

  return {
    domain: MEDIA_DOMAIN_ID,
    primitiveIds: [MEDIA_PRIMITIVE_IDS.probe, MEDIA_PRIMITIVE_IDS.transcode],
    handlers: {
      tool_media_probe: handleProbe,
      tool_media_transcode_run: handleTranscodeRun
    },
    getCapabilityStatus: (primitiveId) => driver.getCapabilityStatus(assertMediaPrimitive(primitiveId)),
    ensureCapability: (primitiveId, signal, onProgress) =>
      driver.ensureCapability(assertMediaPrimitive(primitiveId), signal, onProgress),
    getOptionalExtensions: (primitiveId) =>
      driver.getOptionalExtensions?.(assertMediaPrimitive(primitiveId)) ?? [],
    getStaticToolIds: (primitiveId) => driver.getStaticToolIds(assertMediaPrimitive(primitiveId)),
    ...(driver.stop ? { stop: () => driver.stop?.() } : {})
  }
}
