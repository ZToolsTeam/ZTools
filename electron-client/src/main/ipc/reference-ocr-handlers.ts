import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ReferenceOcrService } from '../services/reference-ocr-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'
export function createReferenceOcrHandlers(ocr: ReferenceOcrService): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return { ocr_local_languages: { execute: (value, caller, signal) => ocr.languages(value, caller, signal) },
    ocr_recognize_reference: { execute: (value, caller, signal) => ocr.recognize(value, caller, signal) } }
}
