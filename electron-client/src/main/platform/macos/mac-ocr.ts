import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { t } from '../../i18n/index.js'
import type { VisionBackend } from './vision-runner.js'

/** 文字识别在 macOS 上使用系统 Vision 在本机识别，不联网 */
export interface MacOcrPorts {
  recognizeLocal(image: Buffer, languages: readonly string[], signal?: AbortSignal): Promise<{ text: string }>
}

const MAX_IMAGE_BYTES = 16 * 1024 * 1024

function invalidResult() {
  return new ZToolsError(errorCodes.fileError, t('macosOcr.error.invalidResult'), {
    i18nKey: 'macosOcr.error.invalidResult'
  })
}

export function createMacOcrPorts(dependencies: { vision: VisionBackend }): MacOcrPorts {
  return {
    async recognizeLocal(image, languages, signal) {
      if (image.length === 0) {
        throw new ZToolsError(errorCodes.invalidRequest, t('macosOcr.error.emptyImage'), {
          i18nKey: 'macosOcr.error.emptyImage'
        })
      }
      if (image.length > MAX_IMAGE_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, t('macosOcr.error.imageTooLarge'), {
          i18nKey: 'macosOcr.error.imageTooLarge'
        })
      }
      const result = await dependencies.vision.run({ version: 1, operation: 'recognize', imageBase64: image.toString('base64'), languages: [...languages] },
        signal ?? new AbortController().signal)
      const text = (result as { text?: unknown } | null)?.text
      if (typeof text !== 'string') throw invalidResult()
      return { text }
    }
  }
}
