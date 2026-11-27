import type { CommonLibsManager } from '../../../core/commonlibs-manager.js'
import type { GuardedProcessRunner } from '../../../core/guarded-process.js'
import {
  DEFAULT_WIN32_MEDIA_TOOL_ID,
  DEFAULT_WIN32_MEDIA_TRANSCODE_REL
} from '../../media/drivers/win32-media.js'
import type { NativeHttpTransferEngine } from './native-http-transfer.js'
import {
  buildSafeStreamProbeArgv,
  buildSafeStreamRunArgv,
  CommonDownloadDriverBase,
  parseReportedOutputPath,
  parseStreamProbeOutput
} from './stream-driver-base.js'

/**
 * Windows 下载能力域 Driver：
 * - `download.stream`：经 CommonLibsManager 定位 Windows 签名流解析工具包，并在需要混流/纯音频提取时联动媒体工具包；
 * - `download.transfer`：由原生 HTTP Range 多连接断点续传引擎直接承接。
 */

export const DEFAULT_WIN32_STREAM_TOOL_ID = 'stream-downloader-2026.1.0'
export const DEFAULT_WIN32_STREAM_EXEC_REL = 'bin/yt-dlp.exe'

export interface Win32DownloadDriverOptions {
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  readonly streamToolId?: string
  readonly streamExecRelPath?: string
  readonly mediaToolId?: string
  readonly mediaExecRelPath?: string
  readonly fetchImpl?: typeof fetch
  readonly transferEngine?: NativeHttpTransferEngine
}

export { buildSafeStreamProbeArgv, buildSafeStreamRunArgv, parseReportedOutputPath, parseStreamProbeOutput }

export class Win32DownloadDriver extends CommonDownloadDriverBase {
  constructor(options: Win32DownloadDriverOptions) {
    super({
      platformName: 'windows',
      tagPrefix: 'download',
      commonLibs: options.commonLibs,
      processRunner: options.processRunner,
      streamToolId: options.streamToolId ?? DEFAULT_WIN32_STREAM_TOOL_ID,
      streamExecRelPath: options.streamExecRelPath ?? DEFAULT_WIN32_STREAM_EXEC_REL,
      mediaToolId: options.mediaToolId ?? DEFAULT_WIN32_MEDIA_TOOL_ID,
      mediaExecRelPath: options.mediaExecRelPath ?? DEFAULT_WIN32_MEDIA_TRANSCODE_REL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.transferEngine ? { transferEngine: options.transferEngine } : {})
    })
  }
}
