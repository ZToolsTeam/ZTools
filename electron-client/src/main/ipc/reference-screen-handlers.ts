import { validateMethodParams, type ScreenPointParams, type ScreenRectParams } from '../../contracts/method-params.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ScreenService } from '../services/screen-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'
export function createReferenceScreenHandlers(screen: Pick<ScreenService, 'getCursorScreenPoint' | 'getPrimaryDisplay' | 'getAllDisplays' | 'getDisplayNearestPoint' | 'getDisplayMatching'>): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return {
    screen_get_cursor_pos: { execute: async value => { validateMethodParams('screen_get_cursor_pos', value); return screen.getCursorScreenPoint() } },
    screen_get_primary_display: { execute: async value => { validateMethodParams('screen_get_primary_display', value); return screen.getPrimaryDisplay() } },
    screen_get_all_displays: { execute: async value => { validateMethodParams('screen_get_all_displays', value); return screen.getAllDisplays() } },
    screen_get_display_nearest: { execute: async value => { validateMethodParams('screen_get_display_nearest', value); return screen.getDisplayNearestPoint(value as ScreenPointParams) } },
    screen_get_display_matching: { execute: async value => { validateMethodParams('screen_get_display_matching', value); return screen.getDisplayMatching(value as ScreenRectParams) } }
  }
}
