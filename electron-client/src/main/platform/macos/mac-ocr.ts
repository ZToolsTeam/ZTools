import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { VisionBackend } from './vision-runner.js'

/** 文字识别在 macOS 上使用系统 Vision 在本机识别，不联网 */
export interface MacOcrPorts {
  recognizeLocal(image: Buffer, languages: readonly string[], signal?: AbortSignal): Promise<{ text: string }>
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024

function invalidResult() { return new ZToolsError(errorCodes.fileError, '本地文字识别返回了无效结果') }

export function createMacOcrPorts(dependencies: { vision: VisionBackend }): MacOcrPorts {
  return {
    async recognizeLocal(image, languages, signal) {
      if (image.length === 0) throw new ZToolsError(errorCodes.invalidRequest, '图片内容为空')
      if (image.length > MAX_IMAGE_BYTES) throw new ZToolsError(errorCodes.fileTooLarge, '图片超过 16 MB，无法识别')
      const result = await dependencies.vision.run({ version: 1, operation: 'recognize', imageBase64: image.toString('base64'), languages: [...languages] },
        signal ?? new AbortController().signal)
      const text = (result as { text?: unknown } | null)?.text
      if (typeof text !== 'string') throw invalidResult()
      return { text }
    }
  }
}
