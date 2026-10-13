import type { ReferenceZipExtractionService } from '../services/reference-zip-extraction-service.js'
import type { ReferenceZipCompressionService } from '../services/reference-zip-compression-service.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ReferenceZipService } from '../services/reference-zip-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'
export function createReferenceZipHandlers(zip: ReferenceZipService, compression?: ReferenceZipCompressionService, extraction?: ReferenceZipExtractionService): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return { ...(extraction ? { zip_extract: { execute: (value: unknown, caller, signal) => extraction.extract(value, caller, signal) } satisfies ReferenceHandler } : {}), ...(compression ? { zip_compress: { execute: (value: unknown, caller, signal) => compression.compress(value, caller, signal) } satisfies ReferenceHandler } : {}), zip_list: { execute: (value, caller, signal) => zip.list(value, caller, signal) }, zip_test: { execute: (value, caller, signal) => zip.test(value, caller, signal) } }
}
