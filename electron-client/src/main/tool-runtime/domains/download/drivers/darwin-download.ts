import type { CommonLibsManager } from '../../../core/commonlibs-manager.js'
import type { GuardedProcessRunner } from '../../../core/guarded-process.js'
import {
  DEFAULT_DARWIN_MEDIA_TOOL_ID,
  DEFAULT_DARWIN_MEDIA_TRANSCODE_REL
} from '../../media/drivers/darwin-media.js'
import type { NativeHttpTransferEngine } from './native-http-transfer.js'
import { CommonDownloadDriverBase } from './stream-driver-base.js'

/**
 * macOS 下载能力域异构 Driver：
 * - `download.transfer`：使用平台原生 HTTP Range 分片传输引擎，零外部下载即可 ready；
 * - `download.stream`：按需调度 macOS 独立签名流解析工具包，并在需要混流/音频提取时联动 macOS 媒体工具包（绝不强绑 Windows .exe 名称）。
 */

export const DEFAULT_DARWIN_STREAM_TOOL_ID = 'darwin-stream-downloader-2026.1.0'
export const DEFAULT_DARWIN_STREAM_EXEC_REL = 'bin/stream-dl'

export interface DarwinDownloadDriverOptions {
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  readonly streamToolId?: string
  readonly streamExecRelPath?: string
  readonly mediaToolId?: string
  readonly mediaExecRelPath?: string
  readonly fetchImpl?: typeof fetch
  readonly transferEngine?: NativeHttpTransferEngine
}

export class DarwinDownloadDriver extends CommonDownloadDriverBase {
  constructor(options: DarwinDownloadDriverOptions) {
    super({
      platformName: 'macos',
      tagPrefix: 'darwin.download',
      commonLibs: options.commonLibs,
      processRunner: options.processRunner,
      streamToolId: options.streamToolId ?? DEFAULT_DARWIN_STREAM_TOOL_ID,
      streamExecRelPath: options.streamExecRelPath ?? DEFAULT_DARWIN_STREAM_EXEC_REL,
      mediaToolId: options.mediaToolId ?? DEFAULT_DARWIN_MEDIA_TOOL_ID,
      mediaExecRelPath: options.mediaExecRelPath ?? DEFAULT_DARWIN_MEDIA_TRANSCODE_REL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.transferEngine ? { transferEngine: options.transferEngine } : {})
    })
  }
}
