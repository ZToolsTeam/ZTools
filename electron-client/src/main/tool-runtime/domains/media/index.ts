import { TOOL_RUNTIME_ERROR_CODES } from '../../../../contracts/tool-runtime/common.js'
import type { MediaPrimitiveId } from '../../../../contracts/tool-runtime/domains/media.js'
import type { ToolDomainRegistration, ToolRuntimeCoreContext } from '../../core/domain-types.js'
import { createToolRuntimeError } from '../../core/errors.js'
import type { MediaDomainDriver } from './driver.js'
import { DarwinMediaDriver } from './drivers/darwin-media.js'
import { Win32MediaDriver } from './drivers/win32-media.js'
import { createMediaDomainRegistration } from './ipc.js'

export interface CreateMediaDomainOptions {
  readonly driver?: MediaDomainDriver
}

class UnsupportedMediaDriver implements MediaDomainDriver {
  readonly platformName = 'other' as const
  readonly #platform: NodeJS.Platform

  constructor(platform: NodeJS.Platform) {
    this.#platform = platform
  }

  getStaticToolIds(): readonly string[] {
    return []
  }

  async getCapabilityStatus(): Promise<'unsupported'> {
    return 'unsupported'
  }

  async ensureCapability(primitiveId: MediaPrimitiveId): Promise<never> {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "${primitiveId}" is not supported on platform "${this.#platform}"`,
      { primitiveId }
    )
  }

  async probe(): Promise<never> {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "media.probe" is not supported on platform "${this.#platform}"`,
      { primitiveId: 'media.probe' }
    )
  }

  async transcode(): Promise<never> {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported,
      `Primitive "media.transcode" is not supported on platform "${this.#platform}"`,
      { primitiveId: 'media.transcode' }
    )
  }
}

/** 按当前平台自动装配媒体能力域 Driver 与 IPC 处理器 */
export function createMediaDomain(
  core: ToolRuntimeCoreContext,
  options: CreateMediaDomainOptions = {}
): ToolDomainRegistration {
  const driver: MediaDomainDriver =
    options.driver ??
    (core.platform === 'darwin'
      ? new DarwinMediaDriver({
          commonLibs: core.commonLibs,
          processRunner: core.processRunner
        })
      : core.platform === 'win32'
        ? new Win32MediaDriver({
            commonLibs: core.commonLibs,
            processRunner: core.processRunner
          })
        : new UnsupportedMediaDriver(core.platform))

  return createMediaDomainRegistration(core, driver)
}

export * from './driver.js'
export * from './policy.js'
export * from './drivers/win32-media.js'
export * from './drivers/darwin-media.js'
export * from './ipc.js'
