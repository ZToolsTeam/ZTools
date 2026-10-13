import { validateMethodParams } from '../../contracts/method-params.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ClipboardService } from '../services/clipboard-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'
export function createReferenceClipboardHandlers(clipboard: Pick<ClipboardService, 'copyImageReference' | 'readText' | 'clear'>): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return {
    clipboard_copy_image: { execute: (value, caller, signal) => clipboard.copyImageReference(value, caller, signal) },
    clipboard_read_text: { execute: async value => { validateMethodParams('clipboard_read_text', value); return clipboard.readText() } },
    clipboard_clear: { execute: async value => { validateMethodParams('clipboard_clear', value); return clipboard.clear() } }
  }
}
