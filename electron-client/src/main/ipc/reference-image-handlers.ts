import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ReferenceGifService } from '../services/reference-gif-service.js'
import type { ReferencePdfService } from '../services/reference-pdf-service.js'
import type { ReferenceImageService } from '../services/reference-image-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'

export function createReferenceImageHandlers(images: ReferenceImageService, pdf?: ReferencePdfService, gif?: ReferenceGifService): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return {
    ...(gif ? { image_preview_gif: { execute: (value: unknown, caller, signal) => gif.preview(value, caller, signal) } satisfies ReferenceHandler, image_to_gif: { execute: (value: unknown, caller, signal) => gif.convert(value, caller, signal) } satisfies ReferenceHandler } : {}),
    ...(pdf ? { image_to_pdf: { execute: (value: unknown, caller, signal) => pdf.convert(value, caller, signal) } satisfies ReferenceHandler } : {}),
    image_preview: { execute: (value, caller, signal) => images.preview(value, caller, signal) },
    image_encode_base64: { execute: (value, caller, signal) => images.encodeBase64(value, caller, signal) },
    image_decode_base64: { execute: (value, caller, signal) => images.decodeBase64(value, caller, signal) },
    image_get_info: { execute: (value, caller, signal) => images.getInfo(value, caller, signal) },
    image_transform: { execute: (value, caller, signal) => images.transform(value, caller, signal) }
  }
}
