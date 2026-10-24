import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import { validateMethodParams, type ScreenCaptureParams } from '../../contracts/method-params.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { PathReferenceDialogs } from '../services/path-reference-dialogs.js'
import type { ReferenceClipboardFilesService } from '../services/reference-clipboard-files-service.js'
import type { ClipboardService } from '../services/clipboard-service.js'
import type { ScreenService } from '../services/screen-service.js'
import type { PathGrantService } from '../services/path-grant-service.js'
import type { ReferenceRegionCaptureService } from '../services/reference-region-capture-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'

function empty(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length) {
    throw new ZToolsError(errorCodes.invalidRequest, '此文件请求不接受参数')
  }
}
/** Source composition for reference-producing dialogs/clipboard/capture; no legacy path fallback. */
export function createReferenceProducerHandlers(services: {
  dialogs: Pick<PathReferenceDialogs, 'show'>
  clipboardFiles: Pick<ReferenceClipboardFilesService, 'read'>
  clipboard: Pick<ClipboardService, 'copyTextReference' | 'readImageReference'>
  screen: Pick<ScreenService, 'captureReference'>
  region?: Pick<ReferenceRegionCaptureService, 'capture'>
  grants: Pick<PathGrantService, 'revoke'>
}): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  const disposeUndelivered = async (value: unknown, caller: CallerIdentity) => {
    if (!value || typeof value !== 'object') throw new ZToolsError(errorCodes.fileError, '未交付响应无效')
    const result = value as { reference?: unknown; references?: unknown; files?: unknown }
    const refs = result.reference ? [result.reference] : result.references ?? result.files ?? []
    if (!Array.isArray(refs) || refs.length > 256) throw new ZToolsError(errorCodes.fileError, '未交付引用超出上限')
    const ids = [...new Set(refs.map(ref => grantId((ref as { grantId?: unknown })?.grantId)))]
    const settled = await Promise.allSettled(ids.map(id => services.grants.revoke(caller.webContentsId, id)))
    if (settled.some(item => item.status === 'rejected')) throw new ZToolsError(errorCodes.fileError, '未交付引用释放未确认')
  }
  const producer = (execute: ReferenceHandler['execute']): ReferenceHandler => ({ execute, disposeUndelivered })
  const dialog = (mode: 'open' | 'save' | 'folder') => producer(async (value, caller, signal) =>
    ({ success: true, ...await services.dialogs.show(mode, value, caller, signal) }))
  return {
    window_show_open_dialog: dialog('open'), window_show_save_dialog: dialog('save'), window_show_select_folder_dialog: dialog('folder'),
    clipboard_read_files: producer(async (value, caller, signal) => { empty(value); return services.clipboardFiles.read(caller, signal) }),
    clipboard_read_image: producer(async (value, caller, signal) => { empty(value); return services.clipboard.readImageReference(caller, signal) }),
    clipboard_copy_text: { execute: (value, caller, signal) => services.clipboard.copyTextReference(value, caller, signal) },
    ...(services.region ? { screen_capture_region: producer((value, caller, signal) => services.region!.capture(value, caller, signal)) } : {}),
    screen_capture: producer(async (value, caller, signal) => {
      validateMethodParams('screen_capture', value)
      return services.screen.captureReference(value as ScreenCaptureParams, caller, signal)
    })
  }
}
