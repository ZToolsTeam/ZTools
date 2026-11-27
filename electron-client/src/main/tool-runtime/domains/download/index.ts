import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolCapabilityStatus,
  type ToolTaskId
} from '../../../../contracts/tool-runtime/common.js'
import type {
  DownloadPrimitiveId,
  DownloadTransferRecord
} from '../../../../contracts/tool-runtime/domains/download.js'
import type { ToolDomainRegistration, ToolRuntimeCoreContext } from '../../core/domain-types.js'
import { createToolRuntimeError } from '../../core/errors.js'
import type {
  DownloadDomainDriver,
  DownloadDriverExecutionContext,
  ResolvedDownloadTransferAddJob
} from './driver.js'
import { DarwinDownloadDriver } from './drivers/darwin-download.js'
import { NativeHttpTransferEngine } from './drivers/native-http-transfer.js'
import { Win32DownloadDriver } from './drivers/win32-download.js'
import { createDownloadDomainRegistration } from './ipc.js'

export interface CreateDownloadDomainOptions {
  readonly driver?: DownloadDomainDriver
}

class UnsupportedDownloadDriver implements DownloadDomainDriver {
  readonly platformName = 'other' as const
  readonly #platform: NodeJS.Platform
  readonly #transferEngine = new NativeHttpTransferEngine()

  constructor(platform: NodeJS.Platform) {
    this.#platform = platform
  }

  getStaticToolIds(): readonly string[] {
    return []
  }

  async getCapabilityStatus(primitiveId: DownloadPrimitiveId): Promise<ToolCapabilityStatus> {
    return primitiveId === 'download.transfer' ? 'ready' : 'unsupported'
  }

  async ensureCapability(
    primitiveId: DownloadPrimitiveId
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }> {
    if (primitiveId === 'download.transfer') {
      return { status: 'ready', provisioned: false }
    }
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "${primitiveId}" is not supported on platform "${this.#platform}"`,
      { primitiveId }
    )
  }

  async probeStream(): Promise<never> {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "download.stream" is not supported on platform "${this.#platform}"`,
      { primitiveId: 'download.stream' }
    )
  }

  async runStream(): Promise<never> {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "download.stream" is not supported on platform "${this.#platform}"`,
      { primitiveId: 'download.stream' }
    )
  }

  addTransfer(
    job: ResolvedDownloadTransferAddJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadTransferRecord> {
    return this.#transferEngine.add(job, context.onProgress)
  }

  pauseTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.pause(taskId)
  }

  resumeTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.resume(taskId)
  }

  cancelTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.cancel(taskId)
  }

  async getTransferStatus(taskId?: ToolTaskId): Promise<readonly DownloadTransferRecord[]> {
    return this.#transferEngine.status(taskId)
  }

  stop(): Promise<void> {
    return this.#transferEngine.stop()
  }
}

/** 按当前平台自动装配下载能力域 Driver 与 IPC 处理器 */
export function createDownloadDomain(
  core: ToolRuntimeCoreContext,
  options: CreateDownloadDomainOptions = {}
): ToolDomainRegistration {
  const driver: DownloadDomainDriver =
    options.driver ??
    (core.platform === 'darwin'
      ? new DarwinDownloadDriver({
          commonLibs: core.commonLibs,
          processRunner: core.processRunner
        })
      : core.platform === 'win32'
        ? new Win32DownloadDriver({
            commonLibs: core.commonLibs,
            processRunner: core.processRunner
          })
        : new UnsupportedDownloadDriver(core.platform))

  return createDownloadDomainRegistration(core, driver)
}

export * from './driver.js'
export * from './policy.js'
export * from './drivers/native-http-transfer.js'
export * from './drivers/win32-download.js'
export * from './drivers/darwin-download.js'
export * from './ipc.js'
